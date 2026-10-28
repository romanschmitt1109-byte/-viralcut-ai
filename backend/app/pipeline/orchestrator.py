"""Enchaînement des étapes : analyse (transcription → sélection → clips) et rendu."""
from __future__ import annotations

import shutil
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy.orm import Session

from .. import quotas
from ..config import settings
from ..jobs import JobReporter, enqueue
from ..models import Clip, ExportSettings, Job, Project, SubtitleTrack, TimeSegment, Transcript, User
from ..storage import get_storage, project_prefix
from . import framing, media, scoring, segmentation, selection, subtitles, transcription
from .render import RenderSpec, render


class PipelineError(Exception):
    """Erreur attendue, affichée telle quelle à l'utilisateur."""


def _workdir(job: Job) -> Path:
    d = settings.work_dir / "jobs" / job.id
    d.mkdir(parents=True, exist_ok=True)
    return d


def default_style(user: User) -> dict:
    base = subtitles.SubtitleStyle().model_dump()
    if user.default_subtitle_style:
        base.update(user.default_subtitle_style)
    return subtitles.SubtitleStyle(**base).model_dump()


# =========================================================================== ANALYSE
def run_analysis(db: Session, job: Job, rep: JobReporter) -> None:
    project = db.get(Project, job.project_id)
    if project is None or project.source is None or not project.source.storage_key:
        raise PipelineError("Aucune vidéo importée pour ce projet.")
    user = db.get(User, project.user_id)
    src = project.source
    store = get_storage()
    wd = _workdir(job)
    project.status, project.error = "processing", None
    db.commit()

    try:
        with store.local_copy(src.storage_key) as video:
            duration = src.duration or media.probe(video).duration

            # 1-3. Transcription (idempotente : réutilisée lors d'une reprise)
            tr = project.transcript
            if tr is None:
                quotas.check_video_quota(db, user, duration)
                rep.step("extract_audio", 2, "Extraction de la piste audio")
                audio = transcription.prepare_audio(video, wd, duration, rep.sub(2, 10))
                rep.step("transcribe", 10, f"Transcription ({settings.transcription_provider})")
                lang = None if project.language == "auto" else project.language
                result = transcription.get_transcriber().transcribe(audio, lang, duration, rep.sub(10, 60))
                rep.step("silences", 60, "Détection des silences")
                silences = media.detect_silences(audio)
                tr = Transcript(project_id=project.id, language=result.language, provider=result.provider,
                                words=result.words, text=result.text, silences=silences,
                                timing_is_approximate=result.approximate)
                db.add(tr)
                quotas.record(db, user.id, "video_minutes", duration / 60, "", project.id)
                quotas.record(db, user.id, "asr_minutes", duration / 60, result.provider, project.id)
                db.commit()
                rep.log(f"{len(result.words)} mots transcrits, langue détectée : {result.language}")
            else:
                rep.step("transcribe", 60, "Transcription existante réutilisée")

            # 4. Sélection des passages
            words = tr.words
            sentences = segmentation.split_sentences(words)
            if not sentences:
                raise PipelineError("La transcription ne contient aucune phrase exploitable.")
            total_speech = sentences[-1].end - sentences[0].start
            if total_speech < project.min_duration:
                raise PipelineError(f"La vidéo contient seulement {total_speech:.0f} s de parole : trop court pour la durée minimale demandée.")
            provider = settings.resolved_llm_provider
            rep.step("analyze", 63, f"Analyse du contenu ({provider}) sur {len(sentences)} phrases")
            sel = selection.get_selector(provider).select(sentences, words, tr.language, project.clip_count,
                                                          project.min_duration, project.max_duration)
            if sel.usage:
                quotas.record(db, user.id, "llm_tokens_in", sel.usage.get("in", 0), sel.provider, project.id)
                quotas.record(db, user.id, "llm_tokens_out", sel.usage.get("out", 0), sel.provider, project.id)

            # 5. Vérification serveur des horodatages et durées
            rep.step("validate", 85, f"{len(sel.proposals)} propositions reçues, vérification")
            valid, rejected = segmentation.validate_selections(
                sel.proposals, sentences, words, project.min_duration, project.max_duration, duration, project.clip_count)
            for r in rejected:
                rep.log(f"Passage rejeté : {r}", "warning")
            if not valid:
                raise PipelineError("Aucun passage ne respecte les contraintes de durée. Essayez d'élargir la plage de durée.")

            # 6. Création des clips (les anciens clips automatiques sont remplacés)
            for old in [c for c in project.clips if c.selection_method != "manual"]:
                if old.export_key:
                    store.delete_prefix(f"{project_prefix(user.id, project.id)}/clips/{old.id}")
                project.clips.remove(old)
            db.flush()
            style = default_style(user)
            for v in valid:
                create_clip_from_selection(db, project, tr, sentences, v, sel.provider, style)
            project.status = "ready"
            db.commit()
            rep.step("done", 100, f"{len(valid)} clips créés")

        # 7. Rendu automatique de chaque clip (tâches séparées, parallélisables)
        db.expire(project, ["clips"])
        for c in project.clips:
            if c.status == "draft":
                c.status = "queued"
                db.commit()
                enqueue(db, user_id=user.id, project_id=project.id, kind="render", clip_id=c.id)
    except Exception as e:
        project.status = "failed"
        project.error = str(e)
        db.commit()
        raise
    finally:
        shutil.rmtree(wd, ignore_errors=True)


def create_clip_from_selection(db, project, tr, sentences, v: segmentation.Selection, method: str, style: dict) -> Clip:
    p = v.payload
    words = tr.words
    pace, pace_details = scoring.measured_pace(words, v.start, v.end)
    sub = dict(p.get("scores") or {})
    sub["pace"] = pace  # le rythme est toujours MESURÉ, jamais estimé par le modèle
    score = scoring.combine(sub)
    thumb_idx = p.get("thumbnail_sentence")
    thumb_t = sentences[thumb_idx].start + 0.3 if isinstance(thumb_idx, int) and v.start_sentence <= thumb_idx <= v.end_sentence else v.start + 1.0
    titles = [t for t in (p.get("title_options") or []) if t][:3]
    hashtags = []
    for h in p.get("hashtags") or []:
        h = "#" + h.lstrip("#").replace(" ", "")
        if len(h) > 1 and h.lower() not in [x.lower() for x in hashtags]:
            hashtags.append(h)
    clip = Clip(
        project_id=project.id, start=v.start, end=v.end,
        title=titles[0] if titles else "Clip", title_options=titles, hooks=p.get("hooks") or [],
        description=p.get("description") or "", hashtags=hashtags[:8], keywords=p.get("keywords") or [],
        score=score, score_breakdown={"subscores": sub, "weights": scoring.WEIGHTS, "pace_measures": pace_details},
        reason=p.get("reason") or "", selection_method=method, thumbnail_time=thumb_t, status="draft",
    )
    db.add(clip)
    db.flush()
    clip_words = [w for w in words if w["s"] >= v.start - 0.01 and w["e"] <= v.end + 0.01]
    st = dict(style)
    st["keywords"] = clip.keywords
    db.add(SubtitleTrack(clip_id=clip.id, words=clip_words, style=st))
    db.add(ExportSettings(clip_id=clip.id, remove_silences=project.remove_silences))
    for i, (s, e) in enumerate(segmentation.keep_segments(words, v.start, v.end, project.remove_silences)):
        db.add(TimeSegment(clip_id=clip.id, position=i, start=s, end=e))
    return clip


def recompute_segments(db: Session, clip: Clip) -> list[tuple[float, float]]:
    """Recalcule les segments après une modification des bornes ou des réglages."""
    words = clip.subtitles.words if clip.subtitles else []
    es = clip.export_settings
    segs = segmentation.keep_segments(words, clip.start, clip.end, es.remove_silences if es else True)
    for s in list(clip.segments):
        db.delete(s)
    db.flush()
    for i, (s, e) in enumerate(segs):
        db.add(TimeSegment(clip_id=clip.id, position=i, start=s, end=e))
    return segs


# =========================================================================== RENDU
def run_render(db: Session, job: Job, rep: JobReporter) -> None:
    clip = db.get(Clip, job.clip_id)
    if clip is None:
        raise PipelineError("Clip introuvable.")
    project = clip.project
    src = project.source
    store = get_storage()
    wd = _workdir(job)
    clip.status, clip.error = "rendering", None
    db.commit()
    try:
        with store.local_copy(src.storage_key) as video:
            info = media.probe(video)
            dw, dh = info.display_size
            es = clip.export_settings or ExportSettings(clip_id=clip.id)
            rep.step("segments", 3, "Calcul des segments conservés")
            segs = recompute_segments(db, clip)
            db.commit()

            # Cadrage
            if clip.crop_auto or clip.crop_x is None:
                rep.step("framing", 6, "Suivi du visage du locuteur")
                samples = framing.sample_face_centers(video, segs)
                shots = framing.plan_shots(samples)
                detected = sum(1 for _, c in samples if c is not None)
                rep.log(f"Visage détecté sur {detected}/{len(samples)} images échantillonnées, {len(shots)} plan(s)")
            else:
                shots = [(0.0, float(clip.crop_x))]
            clip.crop_shots = [list(s) for s in shots]

            # Sous-titres
            rep.step("subtitles", 25, "Génération des sous-titres")
            style = subtitles.SubtitleStyle(**(clip.subtitles.style if clip.subtitles else {}))
            out_words = segmentation.remap_words(clip.subtitles.words if clip.subtitles else [], segs)
            ass_path = None
            if es.burn_subtitles and out_words:
                ass_path = wd / "subs.ass"
                ass_path.write_text(subtitles.build_ass(out_words, style, es.width, es.height), encoding="utf-8")
            srt_path = wd / "subs.srt"
            srt_path.write_text(subtitles.build_srt(out_words), encoding="utf-8")

            # Encodage
            rep.step("encode", 28, "Encodage 1080×1920")
            out = wd / "short.mp4"
            render(RenderSpec(
                source=video, src_width=dw, src_height=dh, fps=info.fps, segments=segs, shots=shots,
                ass_file=ass_path, output=out, normalize_audio=es.normalize_audio, target_lufs=es.target_lufs,
                width=es.width, height=es.height,
            ), on_progress=rep.sub(28, 94))

            # Vérification du fichier produit
            rep.step("verify", 94, "Vérification du fichier exporté")
            check = media.probe(out)
            if (check.width, check.height) != (es.width, es.height) or not check.has_audio:
                raise PipelineError(f"Fichier exporté non conforme ({check.width}×{check.height}, audio={check.has_audio}).")

            # Vignette suggérée : image au moment choisi, dans la timeline du clip
            thumb = wd / "thumb.jpg"
            t_out = _map_time(clip.thumbnail_time or clip.start + 1, segs)
            media.extract_frame(out, min(t_out, max(0.0, check.duration - 0.1)), thumb)

            rep.step("upload", 97, "Enregistrement")
            base = f"{project_prefix(project.user_id, project.id)}/clips/{clip.id}"
            stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
            old = [clip.export_key, clip.srt_key, clip.thumbnail_key]
            clip.export_key = f"{base}/short_{stamp}.mp4"
            clip.srt_key = f"{base}/subs_{stamp}.srt"
            clip.thumbnail_key = f"{base}/thumb_{stamp}.jpg"
            store.put_file(out, clip.export_key, "video/mp4")
            store.put_file(srt_path, clip.srt_key, "application/x-subrip")
            store.put_file(thumb, clip.thumbnail_key, "image/jpeg")
            for k in old:
                if k:
                    store.delete(k)
            clip.status, clip.rendered_at = "ready", datetime.now(timezone.utc)
            db.commit()
            rep.step("done", 100, f"Short exporté ({check.duration:.1f} s)")
    except Exception as e:
        clip.status, clip.error = "failed", str(e)
        db.commit()
        raise
    finally:
        shutil.rmtree(wd, ignore_errors=True)


def _map_time(t: float, segs: list[tuple[float, float]]) -> float:
    off = 0.0
    for s, e in segs:
        if s <= t < e:
            return off + t - s
        off += e - s
    return 0.5
