"""Application FastAPI : `uvicorn app.main:app --reload`"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .api import auth, clips, projects
from .config import settings
from .db import init_db

log = logging.getLogger("viralcut")


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    yield


app = FastAPI(title="ViralCut AI", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware, allow_origins=settings.cors_origins, allow_credentials=False,
    allow_methods=["*"], allow_headers=["*"],
)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    resp = await call_next(request)
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("Referrer-Policy", "same-origin")
    return resp


@app.exception_handler(Exception)
async def unhandled(request: Request, exc: Exception):
    log.exception("Erreur non gérée sur %s", request.url.path)
    return JSONResponse({"detail": "Erreur interne du serveur"}, status_code=500)


app.include_router(auth.router)
app.include_router(projects.router)
app.include_router(clips.router)


@app.get("/api/health")
def health():
    return {"ok": True}


# En production, le frontend compilé (frontend/dist) peut être servi par l'API.
_DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if _DIST.is_dir():
    app.mount("/assets", StaticFiles(directory=_DIST / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        f = _DIST / path
        if path and f.is_file() and _DIST in f.resolve().parents:
            return FileResponse(f)
        return FileResponse(_DIST / "index.html")
