"""Conversion des modèles en JSON pour l'API (URLs média signées incluses)."""
from __future__ import annotations

from ..config import settings
from ..models import Clip, Job, Project, VideoSource
from ..security import create_media_token
from ..storage import get_storage


def media_url(user_id: str, key: str | None) -> str | None:
    if not key:
        return None
    url = get_storage().presigned_url(key, settings.media_token_ttl_s)
    if url:
        return url
    return f"/api/media?t={create_media_token(user_id, key)}"


def source_out(src: VideoSource | None, user_id: str) -> dict | None:
    if src is None:
        return None
    return {
        "kind": src.kind, "youtube_url": src.youtube_url, "original_filename": src.original_filename,
        "duration": src.duration, "width": src.width, "height": src.height, "fps": src.fps,
        "size_bytes": src.size_bytes, "rights_confirmed": src.rights_confirmed,
        "has_file": bool(src.storage_key),
        "thumbnail_url": media_url(user_id, src.thumbnail_key) or src.thumbnail_url,
        "video_url": media_url(user_id, src.storage_key),
    }


def job_out(j: Job) -> dict:
    return {
        "id": j.id, "kind": j.kind, "status": j.status, "step": j.step, "progress": j.progress,
        "attempts": j.attempts, "max_attempts": j.max_attempts, "error": j.error, "clip_id": j.clip_id,
        "project_id": j.project_id, "logs": (j.logs or [])[-50:],
        "created_at": j.created_at, "started_at": j.started_at, "finished_at": j.finished_at,
    }


def clip_summary(c: Clip, user_id: str) -> dict:
    out_duration = sum(s.end - s.start for s in c.segments) if c.segments else c.end - c.start
    return {
        "id": c.id, "project_id": c.project_id, "project_title": c.project.title if c.project else None,
        "start": c.start, "end": c.end, "duration": round(out_duration, 2), "source_duration": round(c.end - c.start, 2),
        "title": c.title, "score": c.score, "status": c.status, "selection_method": c.selection_method,
        "error": c.error, "created_at": c.created_at, "updated_at": c.updated_at, "rendered_at": c.rendered_at,
        "export_url": media_url(user_id, c.export_key), "thumbnail_url": media_url(user_id, c.thumbnail_key),
        "srt_url": media_url(user_id, c.srt_key),
    }


def clip_detail(c: Clip, user_id: str) -> dict:
    d = clip_summary(c, user_id)
    es = c.export_settings
    d.update({
        "title_options": c.title_options, "hooks": c.hooks, "description": c.description, "hashtags": c.hashtags,
        "keywords": c.keywords, "score_breakdown": c.score_breakdown, "reason": c.reason,
        "thumbnail_time": c.thumbnail_time, "crop_x": c.crop_x, "crop_auto": c.crop_auto, "crop_shots": c.crop_shots,
        "segments": [[s.start, s.end] for s in c.segments],
        "subtitles": {"words": c.subtitles.words, "style": c.subtitles.style, "edited": c.subtitles.edited} if c.subtitles else None,
        "export_settings": {
            "width": es.width, "height": es.height, "burn_subtitles": es.burn_subtitles,
            "normalize_audio": es.normalize_audio, "target_lufs": es.target_lufs, "remove_silences": es.remove_silences,
        } if es else None,
        "source": source_out(c.project.source, user_id) if c.project else None,
        "score_disclaimer": "Estimation éditoriale (accroche, clarté, rythme, intérêt, conclusion). Ce score ne prédit pas le nombre de vues.",
    })
    return d


def project_out(p: Project, user_id: str, with_clips: bool = False) -> dict:
    active = [j for j in p.jobs if j.status in ("queued", "running")]
    d = {
        "id": p.id, "title": p.title, "status": p.status, "language": p.language, "clip_count": p.clip_count,
        "min_duration": p.min_duration, "max_duration": p.max_duration, "remove_silences": p.remove_silences,
        "error": p.error, "created_at": p.created_at, "updated_at": p.updated_at,
        "source": source_out(p.source, user_id),
        "has_transcript": p.transcript is not None,
        "transcript_provider": p.transcript.provider if p.transcript else None,
        "n_clips": len(p.clips), "n_ready": sum(1 for c in p.clips if c.status == "ready"),
        "active_jobs": [job_out(j) for j in active],
    }
    if with_clips:
        d["clips"] = [clip_summary(c, user_id) for c in sorted(p.clips, key=lambda c: -c.score)]
    return d
