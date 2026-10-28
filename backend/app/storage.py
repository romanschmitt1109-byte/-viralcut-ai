"""Stockage objet : système de fichiers local (dev) ou S3/compatible (prod).

Les clés sont de la forme `users/<uid>/projects/<pid>/...`. Le worker manipule
toujours des fichiers locaux : `local_copy()` télécharge depuis S3 si besoin.
"""
from __future__ import annotations

import shutil
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, Protocol

from .config import settings


class Storage(Protocol):
    def put_file(self, local_path: Path, key: str, content_type: str | None = None) -> None: ...
    def delete(self, key: str) -> None: ...
    def delete_prefix(self, prefix: str) -> None: ...
    def exists(self, key: str) -> bool: ...
    @contextmanager
    def local_copy(self, key: str) -> Iterator[Path]: ...
    def local_path(self, key: str) -> Path | None: ...
    def presigned_url(self, key: str, expires: int) -> str | None: ...


def _safe_key(key: str) -> str:
    if ".." in key.split("/") or key.startswith("/"):
        raise ValueError("Clé de stockage invalide")
    return key


class LocalStorage:
    def __init__(self, root: Path):
        self.root = root
        root.mkdir(parents=True, exist_ok=True)

    def _p(self, key: str) -> Path:
        p = (self.root / _safe_key(key)).resolve()
        if self.root not in p.parents:
            raise ValueError("Clé hors du stockage")
        return p

    def put_file(self, local_path: Path, key: str, content_type: str | None = None) -> None:
        dest = self._p(key)
        dest.parent.mkdir(parents=True, exist_ok=True)
        if Path(local_path).resolve() != dest:
            shutil.copyfile(local_path, dest)

    def delete(self, key: str) -> None:
        self._p(key).unlink(missing_ok=True)

    def delete_prefix(self, prefix: str) -> None:
        p = self._p(prefix.rstrip("/"))
        if p.is_dir():
            shutil.rmtree(p, ignore_errors=True)

    def exists(self, key: str) -> bool:
        return self._p(key).exists()

    @contextmanager
    def local_copy(self, key: str) -> Iterator[Path]:
        yield self._p(key)

    def local_path(self, key: str) -> Path | None:
        return self._p(key)

    def presigned_url(self, key: str, expires: int) -> str | None:
        return None  # servi par /api/media avec jeton signé


class S3Storage:
    def __init__(self) -> None:
        import boto3

        if not settings.s3_bucket:
            raise RuntimeError("S3_BUCKET est requis quand STORAGE_BACKEND=s3")
        self.bucket = settings.s3_bucket
        self.client = boto3.client("s3", endpoint_url=settings.s3_endpoint_url, region_name=settings.s3_region)

    def put_file(self, local_path: Path, key: str, content_type: str | None = None) -> None:
        extra = {"ContentType": content_type} if content_type else None
        self.client.upload_file(str(local_path), self.bucket, _safe_key(key), ExtraArgs=extra)

    def delete(self, key: str) -> None:
        self.client.delete_object(Bucket=self.bucket, Key=_safe_key(key))

    def delete_prefix(self, prefix: str) -> None:
        paginator = self.client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.bucket, Prefix=_safe_key(prefix)):
            objs = [{"Key": o["Key"]} for o in page.get("Contents", [])]
            if objs:
                self.client.delete_objects(Bucket=self.bucket, Delete={"Objects": objs})

    def exists(self, key: str) -> bool:
        try:
            self.client.head_object(Bucket=self.bucket, Key=key)
            return True
        except Exception:
            return False

    @contextmanager
    def local_copy(self, key: str) -> Iterator[Path]:
        cache = settings.work_dir / "s3cache" / _safe_key(key)
        cache.parent.mkdir(parents=True, exist_ok=True)
        if not cache.exists():
            tmp = cache.with_suffix(cache.suffix + ".part")
            self.client.download_file(self.bucket, key, str(tmp))
            tmp.rename(cache)
        yield cache

    def local_path(self, key: str) -> Path | None:
        return None

    def presigned_url(self, key: str, expires: int) -> str | None:
        return self.client.generate_presigned_url("get_object", Params={"Bucket": self.bucket, "Key": key}, ExpiresIn=expires)


_storage: Storage | None = None


def get_storage() -> Storage:
    global _storage
    if _storage is None:
        _storage = S3Storage() if settings.storage_backend == "s3" else LocalStorage(settings.storage_dir)
    return _storage


def reset_storage() -> None:
    global _storage
    _storage = None


def project_prefix(user_id: str, project_id: str) -> str:
    return f"users/{user_id}/projects/{project_id}"
