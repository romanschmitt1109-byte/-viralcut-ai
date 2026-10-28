"""Worker de traitement vidéo : `python -m app.worker`

Lancez-en plusieurs pour paralléliser les rendus (chaque tâche est réservée de
façon atomique). Arrêt propre sur SIGINT/SIGTERM : la tâche en cours se termine.
"""
from __future__ import annotations

import logging
import signal
import threading
import time
import traceback
from datetime import timedelta

from .config import settings
from .db import SessionLocal, init_db
from .jobs import WORKER_ID, JobCancelled, JobReporter, _log, claim_next, recover_stale
from .models import Job, now
from .pipeline.media import MediaError
from .pipeline.orchestrator import PipelineError, run_analysis, run_render
from .quotas import QuotaExceeded

log = logging.getLogger("viralcut.worker")
_stop = threading.Event()


def _heartbeat(job_id: str, done: threading.Event) -> None:
    """Battement de cœur indépendant : les étapes longues (appel IA, modèle
    Whisper) ne font pas passer la tâche pour abandonnée."""
    while not done.wait(15):
        with SessionLocal() as db:
            job = db.get(Job, job_id)
            if job and job.status == "running":
                job.heartbeat_at = now()
                db.commit()


def is_retryable(exc: Exception) -> bool:
    if isinstance(exc, (PipelineError, QuotaExceeded, MediaError, JobCancelled)):
        return False
    return getattr(exc, "retryable", True)


def process(job: Job, db) -> None:
    rep = JobReporter(db, job)
    done = threading.Event()
    hb = threading.Thread(target=_heartbeat, args=(job.id, done), daemon=True)
    hb.start()
    try:
        rep.log(f"Démarrage (tentative {job.attempts}/{job.max_attempts}) sur {WORKER_ID}")
        if job.kind == "analyze":
            run_analysis(db, job, rep)
        elif job.kind == "render":
            run_render(db, job, rep)
        else:
            raise PipelineError(f"Type de tâche inconnu : {job.kind}")
        job.status, job.progress, job.finished_at = "succeeded", 100.0, now()
        db.commit()
    except JobCancelled:
        db.rollback()
        job.finished_at = now()
        _log(job, "Tâche annulée par l'utilisateur", "warning")
        db.commit()
    except Exception as e:  # noqa: BLE001
        db.rollback()
        log.error("Tâche %s échouée : %s", job.id, e)
        retry = is_retryable(e) and job.attempts < job.max_attempts
        _log(job, f"{type(e).__name__}: {e}", "error")
        if not isinstance(e, (PipelineError, QuotaExceeded, MediaError)):
            _log(job, traceback.format_exc(limit=3)[-1500:], "debug")
        if retry:
            delay = 10 * job.attempts ** 2
            job.status, job.worker_id = "queued", None
            job.run_after = now() + timedelta(seconds=delay)
            _log(job, f"Nouvelle tentative programmée dans {delay} s", "warning")
        else:
            job.status, job.error, job.finished_at = "failed", str(e), now()
        db.commit()
    finally:
        done.set()


def run_forever() -> None:
    init_db()
    log.info("Worker %s démarré", WORKER_ID)
    last_recover = 0.0
    while not _stop.is_set():
        with SessionLocal() as db:
            if time.monotonic() - last_recover > 30:
                n = recover_stale(db)
                if n:
                    log.warning("%d tâche(s) interrompue(s) remise(s) en file", n)
                last_recover = time.monotonic()
            job = claim_next(db)
            if job is None:
                pass
            else:
                log.info("Tâche %s (%s) prise en charge", job.id, job.kind)
                process(job, db)
                continue
        _stop.wait(settings.worker_poll_s)


def run_once(max_jobs: int = 100) -> int:
    """Traite toutes les tâches en file puis rend la main (tests, scripts)."""
    n = 0
    while n < max_jobs:
        with SessionLocal() as db:
            job = claim_next(db)
            if job is None:
                return n
            process(job, db)
            n += 1
    return n


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: _stop.set())
    run_forever()


if __name__ == "__main__":
    main()
