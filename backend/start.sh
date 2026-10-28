#!/bin/sh
# Démarrage « tout-en-un » (Railway, Render, Fly…) : API + worker dans le même conteneur.
# Mettez EMBEDDED_WORKER=0 si vous lancez des workers séparés (docker-compose le fait).
set -e
mkdir -p "${STORAGE_DIR:-/data/storage}" "${WORK_DIR:-/data/work}"
if [ "${EMBEDDED_WORKER:-1}" = "1" ]; then
  python -m app.worker &
fi
exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}" --proxy-headers --forwarded-allow-ips='*'
