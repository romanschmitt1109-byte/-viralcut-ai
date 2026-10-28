"""Environnement de test isolé : SQLite + stockage local temporaires.

Les médias de test sont générés par FFmpeg (mire + son) ; aucune donnée fictive
n'est injectée dans le pipeline : la transcription de test est un vrai fichier
SRT importé par la route prévue à cet effet.
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

_TMP = Path(tempfile.mkdtemp(prefix="viralcut-tests-"))
os.environ.update({
    "DATABASE_URL": f"sqlite:///{_TMP / 'test.db'}",
    "STORAGE_DIR": str(_TMP / "storage"),
    "WORK_DIR": str(_TMP / "work"),
    "VIRALCUT_SKIP_DOTENV": "1",
    "JWT_SECRET": "test-secret-0123456789abcdef0123456789abcdef",
    "LLM_PROVIDER": "heuristic",
    "TRANSCRIPTION_PROVIDER": "faster_whisper",
    "X264_PRESET": "ultrafast",
    "ANTHROPIC_API_KEY": "", "OPENAI_API_KEY": "",
})
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient  # noqa: E402

from app.db import Base, engine, init_db  # noqa: E402
from app.main import app  # noqa: E402

FR_SENTENCES = [
    "Pourquoi la plupart des gens échouent avec leur budget ?",
    "Parce qu'ils ne mesurent jamais ce qu'ils dépensent vraiment.",
    "J'ai fait l'expérience pendant trente jours.",
    "Chaque café, chaque abonnement, chaque petit achat.",
    "Le résultat m'a choqué : quatre cents euros partaient sans que je le sache.",
    "Donc voici la leçon que j'en tire.",
    "Notez tout pendant un mois, et vous verrez la vérité.",
    "Euh, bon, on passe à autre chose.",
    "Alors, et donc, comme je disais tout à l'heure.",
    "Le deuxième secret, c'est d'automatiser votre épargne.",
    "Le jour où le salaire arrive, un virement part tout seul.",
    "Vous ne voyez jamais cet argent, donc vous ne le dépensez pas.",
    "En un an, j'ai mis de côté trois mille euros sans effort.",
    "C'est pour ça que l'automatisation bat la volonté.",
    "Et ensuite il y a eu cette histoire avec mon banquier.",
    "Il m'a proposé un placement incroyable.",
    "Sauf que les frais cachés mangeaient tout le rendement.",
    "Retenez ceci : demandez toujours le total des frais par écrit.",
]


def make_srt(sentences: list[str], start: float = 1.0, gap: float = 0.35) -> tuple[str, float]:
    t, out = start, []
    for i, s in enumerate(sentences, 1):
        d = max(1.6, len(s.split()) * 0.36)
        if i == 9:
            t += 2.5  # longue pause, doit être retirée au montage
        out.append(f"{i}\n{_ts(t)} --> {_ts(t + d)}\n{s}\n")
        t += d + gap
    return "\n".join(out), t


def _ts(t: float) -> str:
    ms = int(t * 1000)
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


def ffmpeg(*args: str) -> None:
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args], check=True)


@pytest.fixture(scope="session")
def sample_video() -> Path:
    """Vidéo 16:9 de 70 s avec piste audio (mire + tonalité)."""
    p = _TMP / "sample.mp4"
    if not p.exists():
        ffmpeg("-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=25:duration=70",
               "-f", "lavfi", "-i", "sine=frequency=330:duration=70:sample_rate=48000",
               "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", str(p))
    return p


@pytest.fixture(scope="session")
def silent_video() -> Path:
    p = _TMP / "silent.mp4"
    if not p.exists():
        ffmpeg("-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25:duration=5", "-c:v", "libx264", "-preset", "ultrafast", str(p))
    return p


@pytest.fixture(scope="session")
def vertical_video() -> Path:
    p = _TMP / "vertical.mp4"
    if not p.exists():
        ffmpeg("-f", "lavfi", "-i", "testsrc2=size=720x1280:rate=30:duration=70",
               "-f", "lavfi", "-i", "sine=frequency=440:duration=70",
               "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", str(p))
    return p


@pytest.fixture(scope="session")
def sample_srt() -> str:
    return make_srt(FR_SENTENCES)[0]


@pytest.fixture(autouse=True)
def fresh_db():
    Base.metadata.drop_all(engine)
    init_db()
    yield


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def register(client, email="alice@example.com", password="motdepasse123"):
    r = client.post("/api/auth/register", json={"email": email, "password": password})
    assert r.status_code == 201, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


@pytest.fixture
def auth(client):
    return register(client)


def upload(client, headers, project_id, path: Path, rights=True, filename=None):
    return client.put(
        f"/api/projects/{project_id}/upload",
        params={"filename": filename or path.name, "rights_confirmed": str(rights).lower()},
        content=path.read_bytes(), headers=headers,
    )
