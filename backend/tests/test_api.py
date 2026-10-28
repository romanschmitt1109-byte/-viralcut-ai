"""Import, sécurité des accès, quotas, file de tâches et interruptions."""
from __future__ import annotations

from datetime import timedelta

from app.config import PLANS
from app.db import SessionLocal
from app.jobs import claim_next, enqueue, recover_stale
from app.models import Job, Project, UsageRecord, now
from app.worker import run_once
from conftest import register, upload


def _project(client, auth, **kw):
    r = client.post("/api/projects", json={"title": "T", **kw}, headers=auth)
    assert r.status_code == 201, r.text
    return r.json()["id"]


# --------------------------------------------------------------------------- import
def test_upload_valid_video(client, auth, sample_video):
    pid = _project(client, auth)
    r = upload(client, auth, pid, sample_video)
    assert r.status_code == 200, r.text
    src = r.json()["source"]
    assert src["duration"] > 60 and src["width"] == 1280 and src["rights_confirmed"]
    assert src["thumbnail_url"] and client.get(src["thumbnail_url"]).status_code == 200


def test_upload_requires_rights_confirmation(client, auth, sample_video):
    pid = _project(client, auth)
    assert upload(client, auth, pid, sample_video, rights=False).status_code == 422


def test_upload_rejects_bad_extension_and_fake_video(client, auth, tmp_path):
    pid = _project(client, auth)
    txt = tmp_path / "notes.txt"
    txt.write_text("bonjour")
    assert upload(client, auth, pid, txt).status_code == 415
    fake = tmp_path / "fake.mp4"
    fake.write_bytes(b"\x00" * 4096)
    r = upload(client, auth, pid, fake)
    assert r.status_code == 422 and "valide" in r.json()["detail"]


def test_upload_rejects_video_without_audio(client, auth, silent_video):
    pid = _project(client, auth)
    r = upload(client, auth, pid, silent_video)
    assert r.status_code == 422 and "audio" in r.json()["detail"]


def test_upload_size_limit(client, auth, sample_video, monkeypatch):
    monkeypatch.setattr(PLANS["free"], "max_upload_mb", 0)
    pid = _project(client, auth)
    assert upload(client, auth, pid, sample_video).status_code == 413


def test_upload_empty_file(client, auth, tmp_path):
    pid = _project(client, auth)
    empty = tmp_path / "e.mp4"
    empty.write_bytes(b"")
    assert upload(client, auth, pid, empty).status_code in (413, 422)


def test_analyze_requires_uploaded_file(client, auth):
    pid = _project(client, auth)
    r = client.post(f"/api/projects/{pid}/analyze", json={}, headers=auth)
    assert r.status_code == 409


def test_project_validation(client, auth):
    r = client.post("/api/projects", json={"min_duration": 60, "max_duration": 30}, headers=auth)
    assert r.status_code == 422
    r = client.post("/api/projects", json={"youtube_url": "https://example.com/video"}, headers=auth)
    assert r.status_code == 422
    r = client.post("/api/projects", json={"clip_count": 40}, headers=auth)
    assert r.status_code == 422  # au-delà de l'offre gratuite


# --------------------------------------------------------------------------- sécurité
def test_auth_required_and_wrong_password(client):
    assert client.get("/api/projects").status_code == 401
    assert client.get("/api/projects", headers={"Authorization": "Bearer faux"}).status_code == 401
    register(client, "bob@example.com")
    r = client.post("/api/auth/login", json={"email": "bob@example.com", "password": "mauvaismdp"})
    assert r.status_code == 401
    assert client.post("/api/auth/register", json={"email": "bob@example.com", "password": "motdepasse123"}).status_code == 409


def test_users_cannot_access_each_other(client, auth, sample_video):
    pid = _project(client, auth)
    r = upload(client, auth, pid, sample_video)
    video_url = r.json()["source"]["video_url"]
    other = register(client, "mallory@example.com")
    assert client.get(f"/api/projects/{pid}", headers=other).status_code == 404
    assert client.delete(f"/api/projects/{pid}", headers=other).status_code == 404
    assert upload(client, other, pid, sample_video).status_code == 404
    assert client.get("/api/clips", headers=other).json() == []
    # jeton média : non transférable vers une autre clé
    import jwt
    from app.config import settings
    payload = jwt.decode(video_url.split("t=")[1], settings.jwt_secret, algorithms=["HS256"])
    forged = jwt.encode({**payload, "key": "users/autre/projects/x/source.mp4"}, "mauvaise-cle-mauvaise-cle-mauvaise-cle", algorithm="HS256")
    assert client.get(f"/api/media?t={forged}").status_code == 401
    access = client.post("/api/auth/login", json={"email": "alice@example.com", "password": "motdepasse123"}).json()["token"]
    assert client.get(f"/api/media?t={access}").status_code == 401  # un jeton d'accès n'est pas un jeton média


def test_media_key_traversal_blocked(client, auth):
    from app.security import create_media_token
    me = client.get("/api/auth/me", headers=auth).json()
    t = create_media_token(me["id"], "users/someone-else/projects/p/source.mp4")
    assert client.get(f"/api/media?t={t}").status_code == 403
    t2 = create_media_token(me["id"], f"users/{me['id']}/../../etc/passwd")
    assert client.get(f"/api/media?t={t2}").status_code in (400, 403, 404, 500)


def test_account_deletion_removes_data(client, auth, sample_video):
    pid = _project(client, auth)
    upload(client, auth, pid, sample_video)
    assert client.delete("/api/auth/me", headers=auth).status_code == 204
    with SessionLocal() as db:
        assert db.get(Project, pid) is None


# --------------------------------------------------------------------------- quotas
def test_monthly_quota_blocks_upload_and_analysis(client, auth, sample_video):
    me = client.get("/api/auth/me", headers=auth).json()
    with SessionLocal() as db:
        db.add(UsageRecord(user_id=me["id"], kind="video_minutes", amount=PLANS["free"].monthly_video_minutes - 0.5))
        db.commit()
    pid = _project(client, auth)
    r = upload(client, auth, pid, sample_video)
    assert r.status_code == 402 and "Quota" in r.json()["detail"]
    usage = client.get("/api/usage", headers=auth).json()
    assert usage["video_minutes_used"] > 59 and usage["billing_enabled"] is False


# --------------------------------------------------------------------------- tâches
def _job_for(client, auth):
    pid = _project(client, auth)
    me = client.get("/api/auth/me", headers=auth).json()
    with SessionLocal() as db:
        return enqueue(db, user_id=me["id"], project_id=pid, kind="analyze").id, pid


def test_claim_is_exclusive_and_dedup(client, auth):
    jid, pid = _job_for(client, auth)
    with SessionLocal() as db:
        me = db.get(Job, jid)
        assert enqueue(db, user_id=me.user_id, project_id=pid, kind="analyze").id == jid  # pas de doublon
        assert claim_next(db).id == jid
        assert claim_next(db) is None


def test_interrupted_job_is_requeued_then_failed(client, auth):
    jid, _ = _job_for(client, auth)
    with SessionLocal() as db:
        claim_next(db)
        j = db.get(Job, jid)
        j.heartbeat_at = now() - timedelta(minutes=10)  # worker disparu
        db.commit()
        assert recover_stale(db) == 1
        db.refresh(j)
        assert j.status == "queued" and any("interrompue" in l["msg"] for l in j.logs)
        j.status, j.attempts, j.heartbeat_at = "running", j.max_attempts, now() - timedelta(minutes=10)
        db.commit()
        recover_stale(db)
        db.refresh(j)
        assert j.status == "failed"


def test_failed_job_reports_clear_error_and_can_retry(client, auth):
    jid, pid = _job_for(client, auth)  # aucun fichier importé → échec explicite, non réessayé
    run_once()
    j = client.get(f"/api/jobs/{jid}", headers=auth).json()
    assert j["status"] == "failed" and "Aucune vidéo" in j["error"] and j["attempts"] == 1
    r = client.post(f"/api/jobs/{jid}/retry", headers=auth)
    assert r.status_code == 202 and r.json()["status"] == "queued"


def test_cancel_job(client, auth):
    jid, _ = _job_for(client, auth)
    r = client.post(f"/api/jobs/{jid}/cancel", headers=auth)
    assert r.json()["status"] == "cancelled"
    assert run_once() == 0


def test_system_status_reports_real_configuration(client):
    s = client.get("/api/system/status").json()
    assert s["ffmpeg"] is True and s["llm_provider"] == "heuristic"
    assert "Inter" in s["fonts"] or s["fonts"]
