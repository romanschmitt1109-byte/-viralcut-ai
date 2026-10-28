"""File de tâches persistante adossée à la base de données.

- Pas de dépendance supplémentaire (Redis…) : la table `jobs` sert de file.
- Réservation atomique (UPDATE conditionnel ; SKIP LOCKED sous PostgreSQL).
- Battement de cœur : une tâche dont le worker a disparu (crash, redémarrage)
  est remise en file automatiquement, jusqu'à `max_attempts`.
- Les étapes du pipeline sont idempotentes (une transcription déjà faite n'est
  pas refaite lors d'une reprise).
"""
from __future__ import annotations

import os
import socket
import time
from datetime import datetime, timedelta, timezone

from sqlalchemy import or_, select, update
from sqlalchemy.orm import Session

from .config import settings
from .models import Job, now

WORKER_ID = f"{socket.gethostname()}-{os.getpid()}"


class JobCancelled(Exception):
    pass


def enqueue(db: Session, *, user_id: str, project_id: str, kind: str, clip_id: str | None = None) -> Job:
    # évite les doublons : une seule tâche active par (type, projet, clip)
    existing = db.scalar(select(Job).where(
        Job.kind == kind, Job.project_id == project_id, Job.clip_id == clip_id,
        Job.status.in_(["queued", "running"]),
    ))
    if existing:
        return existing
    job = Job(user_id=user_id, project_id=project_id, clip_id=clip_id, kind=kind,
              max_attempts=settings.job_max_attempts, logs=[])
    db.add(job)
    db.commit()
    return job


def recover_stale(db: Session) -> int:
    """Remet en file les tâches « running » dont le battement de cœur a expiré."""
    limit = datetime.now(timezone.utc) - timedelta(seconds=settings.job_stale_after_s)
    stale = db.scalars(select(Job).where(Job.status == "running", or_(Job.heartbeat_at.is_(None), Job.heartbeat_at < limit))).all()
    n = 0
    for job in stale:
        hb = job.heartbeat_at
        if hb is not None and hb.tzinfo is None:
            hb = hb.replace(tzinfo=timezone.utc)
        if hb is not None and hb >= limit:
            continue
        msg = "Tâche interrompue (worker arrêté) — "
        if job.attempts >= job.max_attempts:
            job.status, job.error, job.finished_at = "failed", msg + "nombre maximal de tentatives atteint.", now()
            _log(job, job.error, "error")
        else:
            job.status, job.worker_id = "queued", None
            _log(job, msg + "remise en file pour reprise.", "warning")
        n += 1
    db.commit()
    return n


def claim_next(db: Session) -> Job | None:
    q = select(Job.id).where(Job.status == "queued", or_(Job.run_after.is_(None), Job.run_after <= now())).order_by(Job.created_at).limit(1)
    if db.bind is not None and db.bind.dialect.name == "postgresql":
        q = q.with_for_update(skip_locked=True)
    job_id = db.scalar(q)
    if job_id is None:
        return None
    res = db.execute(
        update(Job).where(Job.id == job_id, Job.status == "queued").values(
            status="running", worker_id=WORKER_ID, attempts=Job.attempts + 1,
            started_at=now(), heartbeat_at=now(), error=None,
        )
    )
    db.commit()
    if res.rowcount != 1:
        return None  # un autre worker l'a prise
    return db.get(Job, job_id)


def _log(job: Job, message: str, level: str = "info") -> None:
    job.logs = [*(job.logs or []), {"t": datetime.now(timezone.utc).isoformat(timespec="seconds"), "level": level, "msg": message}][-200:]


class JobReporter:
    """Met à jour la progression réelle d'une tâche (limité à ~2 écritures/s)."""

    def __init__(self, db: Session, job: Job):
        self.db, self.job = db, job
        self._last = 0.0

    def log(self, message: str, level: str = "info") -> None:
        _log(self.job, message, level)
        self.db.commit()

    def step(self, name: str, progress: float, message: str | None = None) -> None:
        self.job.step = name
        self.job.progress = round(progress, 1)
        self.job.heartbeat_at = now()
        if message:
            _log(self.job, message)
        self.db.commit()
        self._check_cancel()

    def sub(self, lo: float, hi: float):
        def cb(frac: float) -> None:
            t = time.monotonic()
            if t - self._last < 0.5 and frac < 1:
                return
            self._last = t
            self.job.progress = round(lo + (hi - lo) * max(0.0, min(1.0, frac)), 1)
            self.job.heartbeat_at = now()
            self.db.commit()
        return cb

    def _check_cancel(self) -> None:
        self.db.refresh(self.job, ["status"])
        if self.job.status == "cancelled":
            raise JobCancelled()
