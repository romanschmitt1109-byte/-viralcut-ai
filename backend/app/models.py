"""Modèles de données (SQLAlchemy 2.x). Compatibles PostgreSQL et SQLite."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def _uuid() -> str:
    return uuid.uuid4().hex


def now() -> datetime:
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    display_name: Mapped[str] = mapped_column(String(120), default="")
    plan: Mapped[str] = mapped_column(String(20), default="free")
    default_subtitle_style: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)

    projects: Mapped[list[Project]] = relationship(back_populates="user", cascade="all, delete-orphan")


class Project(Base):
    __tablename__ = "projects"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(300))
    # draft | awaiting_upload | queued | processing | ready | failed
    status: Mapped[str] = mapped_column(String(30), default="draft")
    language: Mapped[str] = mapped_column(String(10), default="auto")  # auto | fr | en | ...
    clip_count: Mapped[int] = mapped_column(Integer, default=5)
    min_duration: Mapped[float] = mapped_column(Float, default=15.0)
    max_duration: Mapped[float] = mapped_column(Float, default=60.0)
    remove_silences: Mapped[bool] = mapped_column(Boolean, default=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)

    user: Mapped[User] = relationship(back_populates="projects")
    source: Mapped[VideoSource | None] = relationship(back_populates="project", uselist=False, cascade="all, delete-orphan")
    transcript: Mapped[Transcript | None] = relationship(back_populates="project", uselist=False, cascade="all, delete-orphan")
    clips: Mapped[list[Clip]] = relationship(back_populates="project", cascade="all, delete-orphan", order_by="Clip.start")
    jobs: Mapped[list[Job]] = relationship(back_populates="project", cascade="all, delete-orphan")


class VideoSource(Base):
    __tablename__ = "video_sources"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), unique=True)
    kind: Mapped[str] = mapped_column(String(20))  # upload | youtube_reference
    youtube_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    original_filename: Mapped[str | None] = mapped_column(String(500), nullable=True)
    storage_key: Mapped[str | None] = mapped_column(String(500), nullable=True)
    thumbnail_key: Mapped[str | None] = mapped_column(String(500), nullable=True)
    thumbnail_url: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    size_bytes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    duration: Mapped[float | None] = mapped_column(Float, nullable=True)
    width: Mapped[int | None] = mapped_column(Integer, nullable=True)
    height: Mapped[int | None] = mapped_column(Integer, nullable=True)
    fps: Mapped[float | None] = mapped_column(Float, nullable=True)
    rotation: Mapped[int] = mapped_column(Integer, default=0)
    # Déclaration explicite de l'utilisateur : il détient les droits de traitement.
    rights_confirmed: Mapped[bool] = mapped_column(Boolean, default=False)
    rights_confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)

    project: Mapped[Project] = relationship(back_populates="source")


class Transcript(Base):
    __tablename__ = "transcripts"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), unique=True)
    language: Mapped[str] = mapped_column(String(10))
    provider: Mapped[str] = mapped_column(String(40))
    # [{"w": "mot", "s": 1.23, "e": 1.56}]
    words: Mapped[list] = mapped_column(JSON)
    text: Mapped[str] = mapped_column(Text)
    # Silences détectés par FFmpeg : [[start, end], ...]
    silences: Mapped[list | None] = mapped_column(JSON, nullable=True)
    timing_is_approximate: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)

    project: Mapped[Project] = relationship(back_populates="transcript")


class Clip(Base):
    __tablename__ = "clips"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    start: Mapped[float] = mapped_column(Float)
    end: Mapped[float] = mapped_column(Float)
    title: Mapped[str] = mapped_column(String(300))
    title_options: Mapped[list] = mapped_column(JSON, default=list)
    hooks: Mapped[list] = mapped_column(JSON, default=list)
    description: Mapped[str] = mapped_column(Text, default="")
    hashtags: Mapped[list] = mapped_column(JSON, default=list)
    keywords: Mapped[list] = mapped_column(JSON, default=list)
    score: Mapped[float] = mapped_column(Float, default=0.0)  # 0..100, estimation
    score_breakdown: Mapped[dict] = mapped_column(JSON, default=dict)
    reason: Mapped[str] = mapped_column(Text, default="")
    selection_method: Mapped[str] = mapped_column(String(40), default="")  # anthropic | openai | heuristic | manual
    thumbnail_time: Mapped[float | None] = mapped_column(Float, nullable=True)
    crop_x: Mapped[float | None] = mapped_column(Float, nullable=True)  # centre horizontal 0..1 ; None = auto
    crop_auto: Mapped[bool] = mapped_column(Boolean, default=True)
    crop_shots: Mapped[list | None] = mapped_column(JSON, nullable=True)  # [[t_clip, centre_x]] calculés au rendu
    # draft | queued | rendering | ready | failed
    status: Mapped[str] = mapped_column(String(20), default="draft")
    export_key: Mapped[str | None] = mapped_column(String(500), nullable=True)
    srt_key: Mapped[str | None] = mapped_column(String(500), nullable=True)
    thumbnail_key: Mapped[str | None] = mapped_column(String(500), nullable=True)
    rendered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)

    project: Mapped[Project] = relationship(back_populates="clips")
    segments: Mapped[list[TimeSegment]] = relationship(back_populates="clip", cascade="all, delete-orphan", order_by="TimeSegment.position")
    subtitles: Mapped[SubtitleTrack | None] = relationship(back_populates="clip", uselist=False, cascade="all, delete-orphan")
    export_settings: Mapped[ExportSettings | None] = relationship(back_populates="clip", uselist=False, cascade="all, delete-orphan")


class TimeSegment(Base):
    """Portions de la source conservées dans le clip (après suppression des silences)."""

    __tablename__ = "time_segments"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    clip_id: Mapped[str] = mapped_column(ForeignKey("clips.id", ondelete="CASCADE"), index=True)
    position: Mapped[int] = mapped_column(Integer)
    start: Mapped[float] = mapped_column(Float)
    end: Mapped[float] = mapped_column(Float)

    clip: Mapped[Clip] = relationship(back_populates="segments")


class SubtitleTrack(Base):
    __tablename__ = "subtitle_tracks"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    clip_id: Mapped[str] = mapped_column(ForeignKey("clips.id", ondelete="CASCADE"), unique=True)
    # Mots en temps SOURCE (absolu) : [{"w","s","e"}] ; éditables par l'utilisateur
    words: Mapped[list] = mapped_column(JSON)
    edited: Mapped[bool] = mapped_column(Boolean, default=False)
    style: Mapped[dict] = mapped_column(JSON, default=dict)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)

    clip: Mapped[Clip] = relationship(back_populates="subtitles")


class ExportSettings(Base):
    __tablename__ = "export_settings"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    clip_id: Mapped[str] = mapped_column(ForeignKey("clips.id", ondelete="CASCADE"), unique=True)
    width: Mapped[int] = mapped_column(Integer, default=1080)
    height: Mapped[int] = mapped_column(Integer, default=1920)
    burn_subtitles: Mapped[bool] = mapped_column(Boolean, default=True)
    normalize_audio: Mapped[bool] = mapped_column(Boolean, default=True)
    target_lufs: Mapped[float] = mapped_column(Float, default=-14.0)
    remove_silences: Mapped[bool] = mapped_column(Boolean, default=True)

    clip: Mapped[Clip] = relationship(back_populates="export_settings")


class Job(Base):
    __tablename__ = "jobs"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    clip_id: Mapped[str | None] = mapped_column(ForeignKey("clips.id", ondelete="CASCADE"), nullable=True)
    kind: Mapped[str] = mapped_column(String(20))  # analyze | render
    # queued | running | succeeded | failed | cancelled
    status: Mapped[str] = mapped_column(String(20), default="queued", index=True)
    step: Mapped[str] = mapped_column(String(40), default="queued")
    progress: Mapped[float] = mapped_column(Float, default=0.0)  # 0..100
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    max_attempts: Mapped[int] = mapped_column(Integer, default=3)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    logs: Mapped[list] = mapped_column(JSON, default=list)
    worker_id: Mapped[str | None] = mapped_column(String(80), nullable=True)
    heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    run_after: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)  # délai avant nouvelle tentative
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    project: Mapped[Project] = relationship(back_populates="jobs")


class UsageRecord(Base):
    """Consommation de services (minutes vidéo, ASR, tokens LLM) et coût estimé."""

    __tablename__ = "usage_records"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    project_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    kind: Mapped[str] = mapped_column(String(30))  # video_minutes | asr_minutes | llm_tokens_in | llm_tokens_out
    provider: Mapped[str] = mapped_column(String(40), default="")
    amount: Mapped[float] = mapped_column(Float)
    cost_eur: Mapped[float] = mapped_column(Float, default=0.0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, index=True)
