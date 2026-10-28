"""Configuration centralisée, lue depuis les variables d'environnement.

Aucune valeur sensible n'est codée en dur : en production, JWT_SECRET doit être
défini, sinon le démarrage échoue (voir `Settings.validate`).
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _load_dotenv() -> None:
    """Charge un fichier .env (racine du dépôt ou dossier courant) sans écraser
    les variables déjà définies. Pratique en développement local."""
    for candidate in (Path.cwd() / ".env", Path(__file__).resolve().parents[2] / ".env"):
        if candidate.is_file():
            for line in candidate.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, _, v = line.partition("=")
                v = v.strip().strip('"').strip("'")
                if v:
                    os.environ.setdefault(k.strip(), v)
            break


if not os.getenv("VIRALCUT_SKIP_DOTENV"):
    _load_dotenv()


def _bool(name: str, default: bool) -> bool:
    v = os.getenv(name)
    if v is None:
        return default
    return v.strip().lower() in {"1", "true", "yes", "on"}


def _int(name: str, default: int) -> int:
    return int(os.getenv(name, default))


def _float(name: str, default: float) -> float:
    return float(os.getenv(name, default))


@dataclass
class PlanLimits:
    name: str
    monthly_video_minutes: int
    max_upload_mb: int
    max_video_minutes: int
    max_clips_per_video: int
    batch_processing: bool


PLANS: dict[str, PlanLimits] = {
    "free": PlanLimits("free", 60, 1024, 30, 5, False),
    "pro": PlanLimits("pro", 600, 4096, 120, 20, False),
    "studio": PlanLimits("studio", 3000, 8192, 240, 50, True),
}


@dataclass
class Settings:
    env: str = field(default_factory=lambda: os.getenv("APP_ENV", "development"))
    database_url: str = field(default_factory=lambda: os.getenv("DATABASE_URL", "sqlite:///./viralcut.db"))
    jwt_secret: str = field(default_factory=lambda: os.getenv("JWT_SECRET", ""))
    jwt_ttl_hours: int = field(default_factory=lambda: _int("JWT_TTL_HOURS", 72))
    media_token_ttl_s: int = field(default_factory=lambda: _int("MEDIA_TOKEN_TTL_S", 3600))
    cors_origins: list[str] = field(default_factory=lambda: [o.strip() for o in os.getenv("CORS_ORIGINS", "http://localhost:5173").split(",") if o.strip()])

    # Stockage
    storage_backend: str = field(default_factory=lambda: os.getenv("STORAGE_BACKEND", "local"))  # local | s3
    storage_dir: Path = field(default_factory=lambda: Path(os.getenv("STORAGE_DIR", "./storage")).resolve())
    work_dir: Path = field(default_factory=lambda: Path(os.getenv("WORK_DIR", "./work")).resolve())
    s3_bucket: str = field(default_factory=lambda: os.getenv("S3_BUCKET", ""))
    s3_endpoint_url: str | None = field(default_factory=lambda: os.getenv("S3_ENDPOINT_URL") or None)
    s3_region: str | None = field(default_factory=lambda: os.getenv("S3_REGION") or None)

    # Transcription : faster_whisper | openai
    transcription_provider: str = field(default_factory=lambda: os.getenv("TRANSCRIPTION_PROVIDER", "faster_whisper"))
    whisper_model: str = field(default_factory=lambda: os.getenv("WHISPER_MODEL", "small"))
    whisper_device: str = field(default_factory=lambda: os.getenv("WHISPER_DEVICE", "auto"))
    whisper_compute_type: str = field(default_factory=lambda: os.getenv("WHISPER_COMPUTE_TYPE", "default"))
    openai_api_key: str = field(default_factory=lambda: os.getenv("OPENAI_API_KEY", ""))
    openai_transcribe_model: str = field(default_factory=lambda: os.getenv("OPENAI_TRANSCRIBE_MODEL", "whisper-1"))

    # Sélection IA : auto | anthropic | openai | heuristic
    llm_provider: str = field(default_factory=lambda: os.getenv("LLM_PROVIDER", "auto"))
    anthropic_api_key: str = field(default_factory=lambda: os.getenv("ANTHROPIC_API_KEY", ""))
    anthropic_model: str = field(default_factory=lambda: os.getenv("ANTHROPIC_MODEL", "claude-sonnet-5-5"))
    openai_model: str = field(default_factory=lambda: os.getenv("OPENAI_MODEL", "gpt-4.1-mini"))
    llm_max_output_tokens: int = field(default_factory=lambda: _int("LLM_MAX_OUTPUT_TOKENS", 8000))

    # Coûts estimés (EUR) pour le suivi de consommation — à ajuster selon vos contrats
    cost_per_asr_minute: float = field(default_factory=lambda: _float("COST_PER_ASR_MINUTE", 0.006))
    cost_per_1k_llm_input_tokens: float = field(default_factory=lambda: _float("COST_PER_1K_LLM_INPUT", 0.003))
    cost_per_1k_llm_output_tokens: float = field(default_factory=lambda: _float("COST_PER_1K_LLM_OUTPUT", 0.015))

    # YouTube (métadonnées uniquement — aucun téléchargement)
    youtube_api_key: str = field(default_factory=lambda: os.getenv("YOUTUBE_API_KEY", ""))

    # Rendu
    ffmpeg_bin: str = field(default_factory=lambda: os.getenv("FFMPEG_BIN", "ffmpeg"))
    ffprobe_bin: str = field(default_factory=lambda: os.getenv("FFPROBE_BIN", "ffprobe"))
    x264_preset: str = field(default_factory=lambda: os.getenv("X264_PRESET", "veryfast"))
    x264_crf: int = field(default_factory=lambda: _int("X264_CRF", 20))
    fonts_dir: Path = field(default_factory=lambda: Path(os.getenv("FONTS_DIR", str(Path(__file__).parent / "assets" / "fonts"))).resolve())

    # File de tâches
    worker_poll_s: float = field(default_factory=lambda: _float("WORKER_POLL_S", 1.0))
    job_stale_after_s: int = field(default_factory=lambda: _int("JOB_STALE_AFTER_S", 120))
    job_max_attempts: int = field(default_factory=lambda: _int("JOB_MAX_ATTEMPTS", 3))

    allowed_extensions: tuple[str, ...] = (".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi")

    @property
    def resolved_llm_provider(self) -> str:
        """LLM_PROVIDER=auto (défaut) : Anthropic si clé, sinon OpenAI si clé, sinon heuristique."""
        p = self.llm_provider
        if p == "auto":
            if self.anthropic_api_key:
                return "anthropic"
            if self.openai_api_key:
                return "openai"
            return "heuristic"
        return p

    def validate(self) -> None:
        if not self.jwt_secret:
            if self.env == "production":
                raise RuntimeError("JWT_SECRET doit être défini en production")
            self.jwt_secret = "dev-only-insecure-secret-change-me"
        self.storage_dir.mkdir(parents=True, exist_ok=True)
        self.work_dir.mkdir(parents=True, exist_ok=True)


settings = Settings()
settings.validate()
