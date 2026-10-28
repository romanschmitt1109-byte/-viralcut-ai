"""Génère les données de la démo statique (GitHub Pages) avec le VRAI pipeline.

Une vidéo de test est créée par FFmpeg, transcrite via un SRT, analysée
(mode heuristique) puis rendue par le worker. Les réponses de l'API et les
fichiers produits sont copiés dans frontend/public/demo/.

    python scripts/build_demo.py
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "frontend" / "public" / "demo"
TMP = Path(tempfile.mkdtemp(prefix="viralcut-demo-"))
os.environ.update({
    "VIRALCUT_SKIP_DOTENV": "1", "DATABASE_URL": f"sqlite:///{TMP / 'demo.db'}",
    "STORAGE_DIR": str(TMP / "storage"), "WORK_DIR": str(TMP / "work"),
    "JWT_SECRET": "demo-secret-0123456789abcdef0123456789abcdef",
    "LLM_PROVIDER": "heuristic", "X264_CRF": "30", "X264_PRESET": "medium",
})
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "backend" / "tests"))

import jwt  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402
from app.storage import get_storage  # noqa: E402
from app.worker import run_once  # noqa: E402
from conftest import FR_SENTENCES, make_srt  # noqa: E402


def key_of(url: str | None) -> str | None:
    if not url:
        return None
    return jwt.decode(url.split("t=")[1], options={"verify_signature": False})["key"]


def main() -> None:
    src = TMP / "source.mp4"
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=960x540:rate=25:duration=72",
                    "-f", "lavfi", "-i", "sine=frequency=220:duration=72", "-c:v", "libx264", "-crf", "32",
                    "-c:a", "aac", "-b:a", "64k", "-shortest", str(src)], check=True)
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)
    with TestClient(app) as c:
        tok = c.post("/api/auth/register", json={"email": "demo@example.com", "password": "demodemo123", "display_name": "Démo"}).json()["token"]
        h = {"Authorization": f"Bearer {tok}"}
        p = c.post("/api/projects", json={"title": "Budget : les 3 erreurs qui coûtent cher", "language": "fr",
                                           "clip_count": 3, "min_duration": 15, "max_duration": 30}, headers=h).json()
        c.put(f"/api/projects/{p['id']}/upload", params={"filename": "budget-conference.mp4", "rights_confirmed": "true"},
              content=src.read_bytes(), headers=h).raise_for_status()
        c.post(f"/api/projects/{p['id']}/transcript-file", files={"file": ("s.srt", make_srt(FR_SENTENCES)[0].encode())}, headers=h).raise_for_status()
        c.post(f"/api/projects/{p['id']}/analyze", json={}, headers=h).raise_for_status()
        run_once()
        store = get_storage()
        files: dict[str, str] = {}

        def publish(url: str | None, name: str) -> str | None:
            k = key_of(url)
            if not k:
                return None
            if k not in files:
                shutil.copyfile(store.local_path(k), OUT / name)
                files[k] = f"demo/{name}"
            return files[k]

        def rewrite(obj, prefix=""):
            """Remplace les URL signées par les fichiers copiés."""
            if isinstance(obj, dict):
                return {k: rewrite(v, k) for k, v in obj.items()}
            if isinstance(obj, list):
                return [rewrite(v, prefix) for v in obj]
            if isinstance(obj, str) and obj.startswith("/api/media?t="):
                k = key_of(obj)
                ext = Path(k).suffix
                return publish(obj, f"{Path(k).parent.name}_{Path(k).stem.split('_')[0]}{ext}")
            return obj

        project = rewrite(c.get(f"/api/projects/{p['id']}", headers=h).json())
        clips = [rewrite(c.get(f"/api/clips/{cl['id']}", headers=h).json()) for cl in project["clips"]]
        data = {
            "user": c.get("/api/auth/me", headers=h).json(),
            "usage": c.get("/api/usage", headers=h).json(),
            "system": c.get("/api/system/status", headers=h).json(),
            "project": project, "clips": clips,
            "jobs": c.get(f"/api/projects/{p['id']}/jobs", headers=h).json(),
            "transcript": c.get(f"/api/projects/{p['id']}/transcript", headers=h).json(),
        }
        (OUT / "demo.json").write_text(json.dumps(data, ensure_ascii=False, default=str), encoding="utf-8")
    print("Démo générée :", sorted(f.name for f in OUT.iterdir()))
    shutil.rmtree(TMP, ignore_errors=True)


if __name__ == "__main__":
    main()
