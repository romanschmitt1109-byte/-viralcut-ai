from __future__ import annotations

import re
import shutil
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request, UploadFile, status
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import quotas
from ..config import settings
from ..db import get_db
from ..jobs import enqueue
from ..models import Clip, Project, Transcript, User, VideoSource
from ..pipeline import media, segmentation
from ..pipeline.orchestrator import create_clip_from_selection, default_style
from ..pipeline.transcription import TranscriptionError, parse_subtitles
from ..security import current_user
from ..storage import get_storage, project_prefix
from .serializers import job_out, project_out

router = APIRouter(prefix="/api", tags=["projects"])

YT_RE = re.compile(r"^(https?://)?(www\.|m\.)?(youtube\.com/(watch\?v=|shorts/|live/)|youtu\.be/)[\w-]{6,}")


def own_project(db: Session, user: User, project_id: str) -> Project:
    p = db.get(Project, project_id)
    if p is None or p.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Projet introuvable")
    return p


class ProjectIn(BaseModel):
    title: str = Field("Nouveau projet", min_length=1, max_length=300)
    language: str = Field("auto", pattern=r"^(auto|[a-z]{2})$")
    clip_count: int = Field(5, ge=1, le=50)
    min_duration: float = Field(15, ge=5, le=170)
    max_duration: float = Field(60, ge=10, le=180)
    remove_silences: bool = True
    youtube_url: str | None = None

    @model_validator(mode="after")
    def _check(self):
        if self.min_duration >= self.max_duration:
            raise ValueError("La durée minimale doit être inférieure à la durée maximale")
        if self.youtube_url and not YT_RE.match(self.youtube_url.strip()):
            raise ValueError("URL YouTube invalide")
        return self


class ProjectPatch(BaseModel):
    title: str | None = Field(None, min_length=1, max_length=300)
    language: str | None = Field(None, pattern=r"^(auto|[a-z]{2})$")
    clip_count: int | None = Field(None, ge=1, le=50)
    min_duration: float | None = Field(None, ge=5, le=170)
    max_duration: float | None = Field(None, ge=10, le=180)
    remove_silences: bool | None = None


@router.get("/projects")
def list_projects(user: User = Depends(current_user), db: Session = Depends(get_db)):
    ps = db.scalars(select(Project).where(Project.user_id == user.id).order_by(Project.created_at.desc())).all()
    return [project_out(p, user.id) for p in ps]


def fetch_youtube_metadata(url: str) -> dict:
    """Métadonnées publiques via oEmbed (+ durée via l'API Data v3 si une clé est fournie).
    Aucun téléchargement de média n'est effectué."""
    if not YT_RE.match(url.strip()):
        raise HTTPException(422, "URL YouTube invalide")
    try:
        r = httpx.get("https://www.youtube.com/oembed", params={"url": url, "format": "json"}, timeout=10)
    except httpx.HTTPError:
        raise HTTPException(502, "YouTube est injoignable pour le moment")
    if r.status_code in (401, 403):
        raise HTTPException(403, "Vidéo privée ou dont l'intégration est désactivée")
    if r.status_code == 404:
        raise HTTPException(404, "Vidéo introuvable")
    if r.status_code != 200:
        raise HTTPException(502, f"Réponse YouTube inattendue ({r.status_code})")
    data = r.json()
    out = {"title": data.get("title"), "author": data.get("author_name"), "thumbnail_url": data.get("thumbnail_url"), "duration": None}
    m = re.search(r"(?:v=|youtu\.be/|shorts/|live/)([\w-]{6,})", url)
    if settings.youtube_api_key and m:
        try:
            d = httpx.get("https://www.googleapis.com/youtube/v3/videos",
                          params={"id": m.group(1), "part": "contentDetails", "key": settings.youtube_api_key}, timeout=10).json()
            iso = d["items"][0]["contentDetails"]["duration"]
            h, mi, s = (re.search(r"(\d+)H", iso), re.search(r"(\d+)M", iso), re.search(r"(\d+)S", iso))
            out["duration"] = sum(int(x.group(1)) * k for x, k in ((h, 3600), (mi, 60), (s, 1)) if x)
        except Exception:
            pass
    return out


class YoutubeIn(BaseModel):
    url: str


@router.post("/youtube/metadata")
def youtube_metadata(body: YoutubeIn, user: User = Depends(current_user)):
    return fetch_youtube_metadata(body.url)


@router.post("/projects", status_code=201)
def create_project(body: ProjectIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    plan = quotas.plan_of(user)
    if body.clip_count > plan.max_clips_per_video:
        raise HTTPException(422, f"L'offre {plan.name} permet au maximum {plan.max_clips_per_video} clips par vidéo")
    p = Project(user_id=user.id, title=body.title, language=body.language, clip_count=body.clip_count,
                min_duration=body.min_duration, max_duration=body.max_duration, remove_silences=body.remove_silences,
                status="awaiting_upload")
    db.add(p)
    db.flush()
    if body.youtube_url:
        meta = fetch_youtube_metadata(body.youtube_url)
        db.add(VideoSource(project_id=p.id, kind="youtube_reference", youtube_url=body.youtube_url.strip(),
                           thumbnail_url=meta.get("thumbnail_url"), duration=meta.get("duration")))
        if body.title == "Nouveau projet" and meta.get("title"):
            p.title = meta["title"][:300]
    db.commit()
    db.refresh(p)
    return project_out(p, user.id)


@router.get("/projects/{project_id}")
def get_project(project_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return project_out(own_project(db, user, project_id), user.id, with_clips=True)


@router.patch("/projects/{project_id}")
def patch_project(project_id: str, body: ProjectPatch, user: User = Depends(current_user), db: Session = Depends(get_db)):
    p = own_project(db, user, project_id)
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(p, k, v)
    if p.min_duration >= p.max_duration:
        raise HTTPException(422, "La durée minimale doit être inférieure à la durée maximale")
    db.commit()
    return project_out(p, user.id)


@router.delete("/projects/{project_id}", status_code=204)
def delete_project(project_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    p = own_project(db, user, project_id)
    for j in p.jobs:
        if j.status in ("queued", "running"):
            j.status = "cancelled"
    db.commit()
    get_storage().delete_prefix(project_prefix(user.id, p.id))
    db.delete(p)
    db.commit()


@router.put("/projects/{project_id}/upload")
async def upload_video(
    project_id: str, request: Request,
    filename: str = Query(..., max_length=300),
    rights_confirmed: bool = Query(False),
    user: User = Depends(current_user), db: Session = Depends(get_db),
):
    """Import en flux (corps brut) : la limite de taille est appliquée pendant la
    réception, sans mettre le fichier entier en mémoire."""
    p = own_project(db, user, project_id)
    if not rights_confirmed:
        raise HTTPException(422, "Vous devez confirmer détenir les droits de traitement de cette vidéo.")
    ext = Path(filename).suffix.lower()
    if ext not in settings.allowed_extensions:
        raise HTTPException(415, f"Format non pris en charge ({ext or 'inconnu'}). Formats acceptés : {', '.join(settings.allowed_extensions)}")
    if any(j.status in ("queued", "running") and j.kind == "analyze" for j in p.jobs):
        raise HTTPException(409, "Une analyse est en cours sur ce projet")
    plan = quotas.plan_of(user)
    max_bytes = plan.max_upload_mb * 1024 * 1024
    declared = int(request.headers.get("content-length") or 0)
    if declared > max_bytes:
        raise HTTPException(413, f"Fichier trop volumineux : limite {plan.max_upload_mb} Mo pour l'offre {plan.name}")

    tmp_dir = settings.work_dir / "uploads"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkstemp(dir=tmp_dir, suffix=ext)[1])
    size = 0
    try:
        with tmp.open("wb") as f:
            async for chunk in request.stream():
                size += len(chunk)
                if size > max_bytes:
                    raise HTTPException(413, f"Fichier trop volumineux : limite {plan.max_upload_mb} Mo")
                f.write(chunk)
        if size == 0:
            raise HTTPException(422, "Fichier vide")
        # sondage, vignette et copie vers le stockage : opérations bloquantes → pool de threads
        return await run_in_threadpool(_finalize_upload, db, user, p, tmp, filename, ext, size)
    finally:
        tmp.unlink(missing_ok=True)
        tmp.with_suffix(".jpg").unlink(missing_ok=True)




def _finalize_upload(db: Session, user: User, p: Project, tmp: Path, filename: str, ext: str, size: int) -> dict:
    try:
        info = media.probe(tmp)
    except media.MediaError as e:
        raise HTTPException(422, str(e))
    if not info.has_audio:
        raise HTTPException(422, "La vidéo n'a pas de piste audio : la transcription est impossible.")
    try:
        quotas.check_video_quota(db, user, info.duration)
    except quotas.QuotaExceeded as e:
        raise HTTPException(402, str(e))

    store = get_storage()
    prefix = project_prefix(user.id, p.id)
    key = f"{prefix}/source{ext}"
    thumb_key = f"{prefix}/source_thumb.jpg"
    thumb = tmp.with_suffix(".jpg")
    try:
        media.extract_frame(tmp, min(info.duration * 0.1, 10), thumb, "scale=640:-2")
    except media.MediaError:
        thumb = None
    # remplace une éventuelle source précédente (et ses clips / transcription)
    for c in list(p.clips):
        p.clips.remove(c)
    if p.transcript:
        db.delete(p.transcript)
    store.delete_prefix(f"{prefix}/clips")
    store.put_file(tmp, key)
    if thumb:
        store.put_file(thumb, thumb_key, "image/jpeg")
    dw, dh = info.display_size
    src = p.source or VideoSource(project_id=p.id, kind="upload")
    if p.source is None:
        db.add(src)
    src.kind = "upload"  # le lien YouTube éventuel reste conservé comme référence
    src.original_filename, src.storage_key, src.size_bytes = filename, key, size
    src.duration, src.width, src.height, src.fps, src.rotation = info.duration, dw, dh, info.fps, info.rotation
    src.thumbnail_key = thumb_key if thumb else None
    src.rights_confirmed, src.rights_confirmed_at = True, datetime.now(timezone.utc)
    p.status = "draft"
    if p.title == "Nouveau projet":
        p.title = Path(filename).stem[:300]
    db.commit()
    db.refresh(p)
    return project_out(p, user.id)


@router.post("/projects/{project_id}/transcript-file")
async def upload_transcript(project_id: str, file: UploadFile, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Utilise un fichier SRT/VTT existant au lieu de la transcription automatique."""
    p = own_project(db, user, project_id)
    if p.source is None or not p.source.storage_key:
        raise HTTPException(409, "Importez d'abord la vidéo")
    raw = await file.read(5 * 1024 * 1024 + 1)
    if len(raw) > 5 * 1024 * 1024:
        raise HTTPException(413, "Fichier de sous-titres trop volumineux (5 Mo max)")
    try:
        words = parse_subtitles(raw.decode("utf-8", errors="replace"))
    except TranscriptionError as e:
        raise HTTPException(422, str(e))
    if words[-1]["e"] > (p.source.duration or 0) + 2:
        raise HTTPException(422, "Les horodatages dépassent la durée de la vidéo")
    if p.transcript:
        db.delete(p.transcript)
        db.flush()
    lang = p.language if p.language != "auto" else "und"
    db.add(Transcript(project_id=p.id, language=lang, provider="subtitles", words=words,
                      text=" ".join(w["w"] for w in words), timing_is_approximate=True))
    quotas.record(db, user.id, "video_minutes", (p.source.duration or 0) / 60, "subtitles", p.id)
    db.commit()
    return {"words": len(words), "approximate": True}


class AnalyzeIn(BaseModel):
    retranscribe: bool = False


@router.post("/projects/{project_id}/analyze", status_code=202)
def analyze(project_id: str, body: AnalyzeIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    p = own_project(db, user, project_id)
    if p.source is None or not p.source.storage_key:
        raise HTTPException(409, "Importez d'abord un fichier vidéo dont vous détenez les droits.")
    if body.retranscribe and p.transcript:
        db.delete(p.transcript)
    if p.transcript is None:
        try:
            quotas.check_video_quota(db, user, p.source.duration or 0)
        except quotas.QuotaExceeded as e:
            raise HTTPException(402, str(e))
    p.status, p.error = "queued", None
    db.commit()
    job = enqueue(db, user_id=user.id, project_id=p.id, kind="analyze")
    return job_out(job)


@router.get("/projects/{project_id}/transcript")
def get_transcript(project_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    p = own_project(db, user, project_id)
    if p.transcript is None:
        raise HTTPException(404, "Pas encore de transcription")
    t = p.transcript
    sents = segmentation.split_sentences(t.words)
    return {"language": t.language, "provider": t.provider, "approximate": t.timing_is_approximate,
            "sentences": [{"idx": s.idx, "start": s.start, "end": s.end, "text": s.text} for s in sents],
            "words": t.words, "silences": t.silences}


@router.get("/projects/{project_id}/jobs")
def project_jobs(project_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    p = own_project(db, user, project_id)
    return [job_out(j) for j in sorted(p.jobs, key=lambda j: j.created_at, reverse=True)[:50]]


class ManualClipIn(BaseModel):
    start: float = Field(ge=0)
    end: float = Field(gt=0)
    title: str = Field("Clip manuel", max_length=300)


@router.post("/projects/{project_id}/clips", status_code=201)
def create_manual_clip(project_id: str, body: ManualClipIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Crée un clip à partir d'une plage choisie par l'utilisateur (aligné sur les phrases)."""
    p = own_project(db, user, project_id)
    if p.transcript is None:
        raise HTTPException(409, "La transcription est nécessaire pour créer un clip")
    if body.end - body.start < 3 or body.end - body.start > 180:
        raise HTTPException(422, "Un clip doit durer entre 3 et 180 secondes")
    words, sents = p.transcript.words, segmentation.split_sentences(p.transcript.words)
    a = next((s.idx for s in sents if s.end > body.start), 0)
    b = max((s.idx for s in sents if s.start < body.end), default=a)
    start, end = segmentation.bounds_for(sents, words, a, b, p.source.duration or body.end)
    sel = segmentation.Selection(a, b, start, end, {"title_options": [body.title], "scores": {}, "reason": "Passage choisi manuellement."})
    from ..pipeline import scoring
    sub, _ = scoring.heuristic_subscores(sents, a, b)
    sel.payload["scores"] = sub
    sel.payload["keywords"] = scoring.top_keywords(" ".join(s.text for s in sents[a : b + 1]), 4)
    clip = create_clip_from_selection(db, p, p.transcript, sents, sel, "manual", default_style(user))
    db.commit()
    from .serializers import clip_detail
    return clip_detail(clip, user.id)


@router.get("/projects/{project_id}/export.zip")
def export_zip(project_id: str, background: BackgroundTasks, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Export groupé de tous les Shorts rendus (MP4 + SRT + métadonnées)."""
    p = own_project(db, user, project_id)
    ready = [c for c in p.clips if c.status == "ready" and c.export_key]
    if not ready:
        raise HTTPException(409, "Aucun clip rendu à exporter")
    store = get_storage()
    tmp = Path(tempfile.mkstemp(dir=settings.work_dir, suffix=".zip")[1])
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_STORED) as z:
        for i, c in enumerate(sorted(ready, key=lambda c: -c.score), 1):
            slug = re.sub(r"[^\w-]+", "_", c.title)[:50].strip("_") or "clip"
            with store.local_copy(c.export_key) as f:
                z.write(f, f"{i:02d}_{slug}.mp4")
            if c.srt_key:
                with store.local_copy(c.srt_key) as f:
                    z.write(f, f"{i:02d}_{slug}.srt")
            meta = [f"Titre : {c.title}", "Autres titres : " + " | ".join(c.title_options), "",
                    c.description, "", " ".join(c.hashtags), "",
                    f"Score estimatif : {c.score:.0f}/100 (estimation, pas une prédiction de vues)", f"Raison : {c.reason}"]
            z.writestr(f"{i:02d}_{slug}.txt", "\n".join(meta))
    background.add_task(tmp.unlink, missing_ok=True)
    name = re.sub(r"[^\w-]+", "_", p.title)[:60] or "shorts"
    return FileResponse(tmp, media_type="application/zip", filename=f"{name}.zip")
