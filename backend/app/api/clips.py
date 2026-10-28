from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import FileResponse, RedirectResponse
from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..jobs import enqueue
from ..models import Clip, ExportSettings, Job, Project, SubtitleTrack, TimeSegment, User
from ..pipeline.orchestrator import recompute_segments
from ..pipeline.subtitles import SubtitleStyle
from ..pipeline.transcription import clean_words
from ..security import current_user, decode_token
from ..storage import get_storage
from .serializers import clip_detail, clip_summary, job_out

router = APIRouter(prefix="/api", tags=["clips"])


def own_clip(db: Session, user: User, clip_id: str) -> Clip:
    c = db.get(Clip, clip_id)
    if c is None or c.project.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Clip introuvable")
    return c


@router.get("/clips")
def list_clips(
    user: User = Depends(current_user), db: Session = Depends(get_db),
    project_id: str | None = None,
    status_: str | None = Query(None, alias="status"),
    min_score: float | None = None, max_score: float | None = None,
    min_duration: float | None = None, max_duration: float | None = None,
    date_from: datetime | None = None, date_to: datetime | None = None,
    sort: str = Query("-created_at", pattern=r"^-?(created_at|score|duration)$"),
):
    q = select(Clip).join(Project).where(Project.user_id == user.id)
    if project_id:
        q = q.where(Clip.project_id == project_id)
    if status_:
        q = q.where(Clip.status.in_(status_.split(",")))
    if min_score is not None:
        q = q.where(Clip.score >= min_score)
    if max_score is not None:
        q = q.where(Clip.score <= max_score)
    if date_from:
        q = q.where(Clip.created_at >= date_from)
    if date_to:
        q = q.where(Clip.created_at <= date_to)
    clips = [clip_summary(c, user.id) for c in db.scalars(q).all()]
    if min_duration is not None:
        clips = [c for c in clips if c["duration"] >= min_duration]
    if max_duration is not None:
        clips = [c for c in clips if c["duration"] <= max_duration]
    key = sort.lstrip("-")
    clips.sort(key=lambda c: c[key], reverse=sort.startswith("-"))
    return clips


@router.get("/clips/{clip_id}")
def get_clip(clip_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return clip_detail(own_clip(db, user, clip_id), user.id)


class WordIn(BaseModel):
    w: str = Field(min_length=1, max_length=80)
    s: float = Field(ge=0)
    e: float = Field(ge=0)


class ExportIn(BaseModel):
    burn_subtitles: bool | None = None
    normalize_audio: bool | None = None
    target_lufs: float | None = Field(None, ge=-30, le=-6)
    remove_silences: bool | None = None


class ClipPatch(BaseModel):
    start: float | None = Field(None, ge=0)
    end: float | None = Field(None, gt=0)
    title: str | None = Field(None, max_length=300)
    description: str | None = Field(None, max_length=5000)
    hashtags: list[str] | None = Field(None, max_length=15)
    crop_x: float | None = Field(None, ge=0, le=1)
    crop_auto: bool | None = None
    thumbnail_time: float | None = Field(None, ge=0)
    subtitle_style: dict | None = None
    words: list[WordIn] | None = Field(None, max_length=2000)
    export_settings: ExportIn | None = None


@router.patch("/clips/{clip_id}")
def patch_clip(clip_id: str, body: ClipPatch, user: User = Depends(current_user), db: Session = Depends(get_db)):
    c = own_clip(db, user, clip_id)
    p = c.project
    changed_render = False
    if body.words is not None:
        ws = [w.model_dump() for w in body.words]
        for w in ws:
            if w["e"] < w["s"]:
                raise HTTPException(422, f"Horodatage de mot invalide : « {w['w']} »")
        ws = [w for w in ws if w["s"] >= c.start - 0.5 and w["e"] <= c.end + 0.5]
        try:
            cleaned = clean_words(ws)
        except Exception:
            cleaned = []
        if c.subtitles is None:
            c.subtitles = SubtitleTrack(clip_id=c.id, words=cleaned, style=SubtitleStyle().model_dump())
        else:
            c.subtitles.words = cleaned
        c.subtitles.edited = True
        changed_render = True
    if body.start is not None or body.end is not None:
        start = body.start if body.start is not None else c.start
        end = body.end if body.end is not None else c.end
        dur = p.source.duration if p.source and p.source.duration else end
        if not (0 <= start < end <= dur + 0.01):
            raise HTTPException(422, "Bornes du clip invalides")
        if not (3 <= end - start <= 180):
            raise HTTPException(422, "Un clip doit durer entre 3 et 180 secondes")
        c.start, c.end = round(start, 3), round(end, 3)
        # resynchronise les sous-titres sur la nouvelle plage en conservant les corrections
        if p.transcript and c.subtitles:
            edits = {round(w["s"], 2): w["w"] for w in c.subtitles.words}
            c.subtitles.words = [
                {**w, "w": edits.get(round(w["s"], 2), w["w"])}
                for w in p.transcript.words if w["s"] >= c.start - 0.01 and w["e"] <= c.end + 0.01
            ]
        changed_render = True
    if body.title is not None:
        c.title = body.title
    if body.description is not None:
        c.description = body.description
    if body.hashtags is not None:
        c.hashtags = ["#" + h.lstrip("#").replace(" ", "") for h in body.hashtags if h.strip("# ")]
    if body.crop_auto is not None:
        c.crop_auto = body.crop_auto
        changed_render = True
    if body.crop_x is not None:
        c.crop_x, c.crop_auto = body.crop_x, False if body.crop_auto is None else body.crop_auto
        changed_render = True
    if body.thumbnail_time is not None:
        if not (c.start <= body.thumbnail_time <= c.end):
            raise HTTPException(422, "Le moment de la miniature doit être dans le clip")
        c.thumbnail_time = body.thumbnail_time
        changed_render = True
    if body.subtitle_style is not None:
        try:
            st = SubtitleStyle(**body.subtitle_style).model_dump()
        except ValidationError as e:
            raise HTTPException(422, f"Style de sous-titres invalide : {e.errors()[0]['loc']} {e.errors()[0]['msg']}")
        if c.subtitles is None:
            c.subtitles = SubtitleTrack(clip_id=c.id, words=[], style=st)
        else:
            c.subtitles.style = st
        changed_render = True
    if body.export_settings is not None:
        es = c.export_settings or ExportSettings(clip_id=c.id)
        if c.export_settings is None:
            c.export_settings = es
        for k, v in body.export_settings.model_dump(exclude_none=True).items():
            setattr(es, k, v)
        changed_render = True
    if changed_render:
        db.flush()
        recompute_segments(db, c)
        if c.status in ("ready", "failed"):
            c.status = "draft"  # modifié depuis le dernier rendu
    db.commit()
    db.refresh(c)
    return clip_detail(c, user.id)


@router.post("/clips/{clip_id}/render", status_code=202)
def render_clip(clip_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    c = own_clip(db, user, clip_id)
    if c.project.source is None or not c.project.source.storage_key:
        raise HTTPException(409, "Vidéo source manquante")
    c.status, c.error = "queued", None
    db.commit()
    return job_out(enqueue(db, user_id=user.id, project_id=c.project_id, kind="render", clip_id=c.id))


@router.post("/clips/{clip_id}/duplicate", status_code=201)
def duplicate_clip(clip_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    c = own_clip(db, user, clip_id)
    n = Clip(
        project_id=c.project_id, start=c.start, end=c.end, title=f"{c.title} (copie)"[:300],
        title_options=list(c.title_options), hooks=list(c.hooks), description=c.description,
        hashtags=list(c.hashtags), keywords=list(c.keywords), score=c.score,
        score_breakdown=dict(c.score_breakdown), reason=c.reason, selection_method=c.selection_method,
        thumbnail_time=c.thumbnail_time, crop_x=c.crop_x, crop_auto=c.crop_auto, status="draft",
    )
    db.add(n)
    db.flush()
    if c.subtitles:
        db.add(SubtitleTrack(clip_id=n.id, words=list(c.subtitles.words), style=dict(c.subtitles.style), edited=c.subtitles.edited))
    es = c.export_settings
    db.add(ExportSettings(clip_id=n.id, **({k: getattr(es, k) for k in ("width", "height", "burn_subtitles", "normalize_audio", "target_lufs", "remove_silences")} if es else {})))
    for s in c.segments:
        db.add(TimeSegment(clip_id=n.id, position=s.position, start=s.start, end=s.end))
    db.commit()
    db.refresh(n)
    return clip_detail(n, user.id)


@router.delete("/clips/{clip_id}", status_code=204)
def delete_clip(clip_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    c = own_clip(db, user, clip_id)
    store = get_storage()
    for k in (c.export_key, c.srt_key, c.thumbnail_key):
        if k:
            store.delete(k)
    for j in db.scalars(select(Job).where(Job.clip_id == c.id, Job.status.in_(["queued", "running"]))):
        j.status = "cancelled"
    db.delete(c)
    db.commit()


# --------------------------------------------------------------------------- tâches
def own_job(db: Session, user: User, job_id: str) -> Job:
    j = db.get(Job, job_id)
    if j is None or j.user_id != user.id:
        raise HTTPException(404, "Tâche introuvable")
    return j


@router.get("/jobs/{job_id}")
def get_job(job_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return job_out(own_job(db, user, job_id))


@router.post("/jobs/{job_id}/cancel")
def cancel_job(job_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    j = own_job(db, user, job_id)
    if j.status in ("queued", "running"):
        j.status = "cancelled"
        if j.clip_id and (c := db.get(Clip, j.clip_id)) and c.status in ("queued", "rendering"):
            c.status = "draft"
        db.commit()
    return job_out(j)


@router.post("/jobs/{job_id}/retry", status_code=202)
def retry_job(job_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    j = own_job(db, user, job_id)
    if j.status not in ("failed", "cancelled"):
        raise HTTPException(409, "Seule une tâche échouée ou annulée peut être relancée")
    return job_out(enqueue(db, user_id=user.id, project_id=j.project_id, kind=j.kind, clip_id=j.clip_id))


# --------------------------------------------------------------------------- médias
_MIME = {".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska",
         ".m4v": "video/mp4", ".avi": "video/x-msvideo", ".jpg": "image/jpeg", ".srt": "application/x-subrip"}


@router.get("/media")
def media_file(t: str, download: bool = False, db: Session = Depends(get_db)):
    """Sert un fichier via un jeton signé limité à cette ressource (utilisable dans <video src>).
    Les requêtes Range sont prises en charge (lecture et déplacement dans la vidéo)."""
    payload = decode_token(t, "media")
    key: str = payload["key"]
    if not key.startswith(f"users/{payload['sub']}/"):
        raise HTTPException(403, "Accès refusé")
    if ".." in key.split("/"):
        raise HTTPException(400, "Chemin invalide")
    store = get_storage()
    url = store.presigned_url(key, settings.media_token_ttl_s)
    if url:
        return RedirectResponse(url)
    path = store.local_path(key)
    if path is None or not path.exists():
        raise HTTPException(404, "Fichier introuvable")
    ext = path.suffix.lower()
    return FileResponse(path, media_type=_MIME.get(ext, "application/octet-stream"),
                        filename=path.name if download else None,
                        content_disposition_type="attachment" if download else "inline")
