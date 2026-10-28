# --- 1. Frontend -------------------------------------------------------------
FROM node:22-slim AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# --- 2. API + worker (même image, commande différente) -------------------------
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg fontconfig fonts-inter fonts-dejavu-core fonts-liberation \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app/backend
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/ ./
COPY --from=web /web/dist /app/frontend/dist
RUN useradd -m viralcut && mkdir -p /data/storage /data/work && chown -R viralcut /data
USER viralcut
# Valeurs par défaut prêtes pour un test sur un seul service (toutes surchargeables)
ENV STORAGE_DIR=/data/storage WORK_DIR=/data/work HF_HOME=/data/hf \
    DATABASE_URL=sqlite:////data/viralcut.db \
    WHISPER_MODEL=base WHISPER_COMPUTE_TYPE=int8 \
    EMBEDDED_WORKER=1
EXPOSE 8000
CMD ["./start.sh"]
