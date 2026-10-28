from __future__ import annotations

import shutil

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, EmailStr, Field, ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import quotas
from ..config import PLANS, settings
from ..db import get_db
from ..models import User
from ..pipeline.subtitles import SubtitleStyle, available_fonts
from ..security import create_access_token, current_user, hash_password, verify_password
from ..storage import get_storage

router = APIRouter(prefix="/api", tags=["auth"])


class Credentials(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=200)


class RegisterIn(Credentials):
    display_name: str = Field("", max_length=120)


class ProfileIn(BaseModel):
    display_name: str | None = Field(None, max_length=120)
    default_subtitle_style: dict | None = None


def user_out(u: User) -> dict:
    return {"id": u.id, "email": u.email, "display_name": u.display_name, "plan": u.plan,
            "default_subtitle_style": u.default_subtitle_style, "created_at": u.created_at}


@router.post("/auth/register", status_code=201)
def register(body: RegisterIn, db: Session = Depends(get_db)):
    email = body.email.lower()
    if db.scalar(select(User).where(User.email == email)):
        raise HTTPException(status.HTTP_409_CONFLICT, "Un compte existe déjà avec cet e-mail")
    u = User(email=email, password_hash=hash_password(body.password), display_name=body.display_name)
    db.add(u)
    db.commit()
    return {"token": create_access_token(u.id), "user": user_out(u)}


@router.post("/auth/login")
def login(body: Credentials, db: Session = Depends(get_db)):
    u = db.scalar(select(User).where(User.email == body.email.lower()))
    if not u or not verify_password(body.password, u.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "E-mail ou mot de passe incorrect")
    return {"token": create_access_token(u.id), "user": user_out(u)}


@router.get("/auth/me")
def me(user: User = Depends(current_user)):
    return user_out(user)


@router.patch("/auth/me")
def update_me(body: ProfileIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    if body.display_name is not None:
        user.display_name = body.display_name
    if body.default_subtitle_style is not None:
        try:
            user.default_subtitle_style = SubtitleStyle(**body.default_subtitle_style).model_dump(exclude={"keywords"})
        except ValidationError as e:
            raise HTTPException(422, f"Style invalide : {e.errors()[0]['msg']}")
    db.commit()
    return user_out(user)


@router.delete("/auth/me", status_code=204)
def delete_me(user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Suppression du compte et de TOUTES les données associées (fichiers inclus)."""
    get_storage().delete_prefix(f"users/{user.id}")
    db.delete(user)
    db.commit()


@router.get("/usage")
def usage(user: User = Depends(current_user), db: Session = Depends(get_db)):
    plan = quotas.plan_of(user)
    u = quotas.usage_this_month(db, user.id)
    return {
        "plan": plan.__dict__, "plans": {k: v.__dict__ for k, v in PLANS.items()},
        "video_minutes_used": round(u.get("video_minutes", 0), 2),
        "asr_minutes": round(u.get("asr_minutes", 0), 2),
        "llm_tokens_in": int(u.get("llm_tokens_in", 0)), "llm_tokens_out": int(u.get("llm_tokens_out", 0)),
        "estimated_cost_eur": round(u.get("cost_eur", 0), 4),
        "billing_enabled": False,
    }


@router.get("/system/status")
def system_status():
    """État réel de la configuration (aucune intégration n'est déclarée active si elle ne l'est pas)."""
    llm = settings.resolved_llm_provider
    return {
        "ffmpeg": shutil.which(settings.ffmpeg_bin) is not None,
        "transcription_provider": settings.transcription_provider,
        "transcription_configured": settings.transcription_provider == "faster_whisper" or bool(settings.openai_api_key),
        "whisper_model": settings.whisper_model if settings.transcription_provider == "faster_whisper" else settings.openai_transcribe_model,
        "llm_provider": llm,
        "llm_model": {"anthropic": settings.anthropic_model, "openai": settings.openai_model}.get(llm),
        "storage": settings.storage_backend,
        "youtube_metadata": True, "youtube_duration": bool(settings.youtube_api_key),
        "fonts": available_fonts(),
        "default_subtitle_style": SubtitleStyle().model_dump(),
    }
