"""Bout en bout : import → transcription (SRT) → sélection → rendu FFmpeg réel → export."""
from __future__ import annotations

import io
import zipfile

from app.config import settings
from app.pipeline import media
from app.storage import get_storage
from app.worker import run_once
from conftest import upload


def _setup_project(client, auth, video, srt, **kw):
    body = {"title": "Budget", "language": "fr", "clip_count": 2, "min_duration": 15, "max_duration": 30, **kw}
    p = client.post("/api/projects", json=body, headers=auth).json()
    r = upload(client, auth, p["id"], video)
    assert r.status_code == 200, r.text
    r = client.post(f"/api/projects/{p['id']}/transcript-file", files={"file": ("subs.srt", srt.encode(), "text/plain")}, headers=auth)
    assert r.status_code == 200, r.text
    return p["id"]


def test_full_pipeline_generates_vertical_subtitled_shorts(client, auth, sample_video, sample_srt):
    pid = _setup_project(client, auth, sample_video, sample_srt)
    r = client.post(f"/api/projects/{pid}/analyze", json={}, headers=auth)
    assert r.status_code == 202
    n = run_once()
    assert n >= 2  # analyse + au moins un rendu

    proj = client.get(f"/api/projects/{pid}", headers=auth).json()
    assert proj["status"] == "ready", proj["error"]
    clips = proj["clips"]
    assert 1 <= len(clips) <= 2
    for c in clips:
        assert c["status"] == "ready", c["error"]
        assert 0 <= c["score"] <= 100
        detail = client.get(f"/api/clips/{c['id']}", headers=auth).json()
        assert detail["selection_method"] == "heuristic"
        assert detail["reason"]
        assert "pace" in detail["score_breakdown"]["subscores"]
        # le fichier exporté est un vrai MP4 vertical 1080x1920 avec audio
        path = get_storage().local_path(_key(detail["export_url"]))
        info = media.probe(path)
        assert (info.width, info.height) == (1080, 1920)
        assert info.has_audio
        expected = sum(e - s for s, e in detail["segments"])
        assert abs(info.duration - expected) < 0.35, (info.duration, expected)
        # la piste AUDIO doit couvrir toute l'image (horodatages corrects)
        v_dur, a_dur = _stream_durations(path)
        assert abs(a_dur - v_dur) < 0.15, (v_dur, a_dur)
        # le lecteur peut charger le fichier (requête Range partielle)
        rr = client.get(detail["export_url"], headers={"Range": "bytes=0-99"})
        assert rr.status_code == 206 and len(rr.content) == 100
        srt = client.get(detail["srt_url"]).text
        assert "-->" in srt

    # les passages commençant par un connecteur dépendant du contexte ne sont pas retenus en ouverture
    starts = [client.get(f"/api/clips/{c['id']}", headers=auth).json()["subtitles"]["words"][0]["w"].lower() for c in clips]
    assert not any(s.startswith(("alors", "et", "donc")) for s in starts)

    # export groupé
    z = client.get(f"/api/projects/{pid}/export.zip", headers=auth)
    assert z.status_code == 200
    names = zipfile.ZipFile(io.BytesIO(z.content)).namelist()
    assert sum(n.endswith(".mp4") for n in names) == len(clips)

    # nettoyage des fichiers temporaires de travail
    assert not any((settings.work_dir / "jobs").glob("*/*"))


def test_edit_and_rerender_without_burned_subtitles(client, auth, sample_video, sample_srt):
    pid = _setup_project(client, auth, sample_video, sample_srt, clip_count=1)
    client.post(f"/api/projects/{pid}/analyze", json={}, headers=auth)
    run_once()
    clip = client.get(f"/api/projects/{pid}", headers=auth).json()["clips"][0]
    d = client.get(f"/api/clips/{clip['id']}", headers=auth).json()
    words = d["subtitles"]["words"]
    words[0]["w"] = "CORRIGÉ"
    r = client.patch(f"/api/clips/{clip['id']}", json={
        "end": d["end"] - 2, "words": words, "crop_x": 0.2,
        "subtitle_style": {**d["subtitles"]["style"], "mode": "word", "highlight_color": "#22D3EE"},
        "export_settings": {"burn_subtitles": False},
    }, headers=auth)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "draft"
    assert r.json()["crop_auto"] is False
    assert client.post(f"/api/clips/{clip['id']}/render", headers=auth).status_code == 202
    run_once()
    d2 = client.get(f"/api/clips/{clip['id']}", headers=auth).json()
    assert d2["status"] == "ready", d2["error"]
    assert d2["subtitles"]["words"][0]["w"] == "CORRIGÉ"
    assert "CORRIGÉ" in client.get(d2["srt_url"]).text
    info = media.probe(get_storage().local_path(_key(d2["export_url"])))
    assert (info.width, info.height) == (1080, 1920)


def test_vertical_source_uses_blurred_background(client, auth, vertical_video, sample_srt):
    pid = _setup_project(client, auth, vertical_video, sample_srt, clip_count=1)
    client.post(f"/api/projects/{pid}/analyze", json={}, headers=auth)
    run_once()
    c = client.get(f"/api/projects/{pid}", headers=auth).json()["clips"][0]
    assert c["status"] == "ready", c["error"]


def test_duplicate_and_delete_clip(client, auth, sample_video, sample_srt):
    pid = _setup_project(client, auth, sample_video, sample_srt, clip_count=1)
    client.post(f"/api/projects/{pid}/analyze", json={}, headers=auth)
    run_once()
    c = client.get(f"/api/projects/{pid}", headers=auth).json()["clips"][0]
    dup = client.post(f"/api/clips/{c['id']}/duplicate", headers=auth)
    assert dup.status_code == 201 and dup.json()["status"] == "draft"
    assert client.delete(f"/api/clips/{dup.json()['id']}", headers=auth).status_code == 204
    assert len(client.get("/api/clips", headers=auth).json()) == 1


def test_manual_clip_aligned_on_sentences(client, auth, sample_video, sample_srt):
    pid = _setup_project(client, auth, sample_video, sample_srt)
    r = client.post(f"/api/projects/{pid}/clips", json={"start": 10.2, "end": 30.4, "title": "Mon passage"}, headers=auth)
    assert r.status_code == 201, r.text
    c = r.json()
    assert c["selection_method"] == "manual"
    assert c["subtitles"]["words"][0]["w"][0].isupper()  # commence en début de phrase


def _stream_durations(path) -> tuple[float, float]:
    import subprocess
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,duration", "-of", "csv=p=0", str(path)],
                         capture_output=True, text=True, check=True).stdout.split()
    d = dict(line.split(",") for line in out)
    return float(d["video"]), float(d["audio"])


def _key(url: str) -> str:
    import jwt
    token = url.split("t=")[1]
    return jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])["key"]
