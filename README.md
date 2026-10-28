# ViralCut AI

Transforme une vidéo longue en plusieurs **YouTube Shorts / TikTok verticaux** (MP4 1080×1920), sous-titrés mot par mot, recadrés sur le locuteur et prêts à publier.

```
Import (fichier dont vous avez les droits)
  → Transcription horodatée au mot (Whisper)
  → Découpage en phrases + détection des silences (FFmpeg)
  → Sélection des passages par IA (Claude / OpenAI) ou heuristique explicable
  → Vérification serveur (indices, durées, chevauchements)
  → Montage : suppression des silences, recadrage 9:16 suivant le visage, sous-titres ASS, audio −14 LUFS
  → Export MP4 + SRT + vignette, édition, re-rendu, export groupé .zip
```

## Architecture

| Couche | Choix | Rôle |
|---|---|---|
| Frontend | React 19 + TypeScript + Tailwind 4 (Vite) | 7 pages : accueil, tableau de bord, import, analyse, clips, éditeur, paramètres |
| API | FastAPI (Python 3.12+) | Auth JWT, projets, import en flux, clips, tâches, médias signés |
| Base | PostgreSQL (SQLite en dev/tests) via SQLAlchemy 2 | Modèles décrits plus bas |
| File de tâches | Table `jobs` + worker(s) `python -m app.worker` | Réservation atomique (`SKIP LOCKED`), battement de cœur, reprise après crash, nouvelles tentatives avec délai |
| Stockage | Disque local ou S3 (MinIO, R2, Scaleway…) | Sources, exports, SRT, vignettes |
| Vidéo | FFmpeg + libass | Découpe, concaténation, recadrage dynamique, incrustation, loudnorm |
| Transcription | faster-whisper (local) ou API OpenAI | Horodatage mot par mot ; import SRT/VTT possible |
| IA | Anthropic (outil à schéma) / OpenAI (`json_schema`) | Sortie structurée validée par Pydantic |
| Visages | OpenCV (cascade de Haar, sans GPU) | Plans à cadrage fixe, pas de tremblement |

Pas de Redis ni de Celery : la file repose sur la base, ce qui suffit pour des dizaines de workers. Les étapes sont idempotentes (une transcription n'est jamais refaite lors d'une reprise).

### Arborescence

```
backend/
  app/
    main.py            application FastAPI (sert aussi frontend/dist en production)
    worker.py          worker de traitement
    config.py          configuration (variables d'environnement, offres)
    models.py          modèles SQLAlchemy
    security.py        scrypt, JWT d'accès, jetons média signés
    storage.py         stockage local / S3
    quotas.py          quotas mensuels et suivi des coûts
    jobs.py            file de tâches persistante
    api/               routes (auth, projects, clips, media)
    pipeline/
      media.py         ffprobe, extraction audio, silences, vignettes
      transcription.py faster-whisper, OpenAI, import SRT/VTT
      segmentation.py  phrases, validation des passages, coupes, remappage
      scoring.py       score explicable
      selection.py     Anthropic / OpenAI / heuristique
      framing.py       suivi du visage → plans → expression de recadrage
      subtitles.py     ASS (mot actif, mots-clés) et SRT
      render.py        graphe de filtres FFmpeg
      orchestrator.py  enchaînement analyse / rendu
  tests/               44 tests pytest (dont rendu FFmpeg réel)
frontend/src/
  pages/               Landing, Login, Dashboard, Import, Analysis, ProjectClips, Editor, Settings
  components/          Layout, ClipCard, ClipLibrary, VerticalPreview, ScoreBreakdown, ui
  lib/                 api (fetch + import XHR avec progression), auth, types, sous-titres
```

## Démarrage rapide (Docker)

```bash
cp .env.example .env
# Renseignez au minimum JWT_SECRET (python -c "import secrets;print(secrets.token_urlsafe(48))")
# et, pour la sélection par IA, ANTHROPIC_API_KEY ou OPENAI_API_KEY
docker compose up --build
```

Ouvrez http://localhost:8000. L'image contient l'API, le frontend compilé et le worker (même image, commande différente). Pour paralléliser les rendus : `docker compose up --scale worker=3`.

Au premier lancement avec `TRANSCRIPTION_PROVIDER=faster_whisper`, le worker télécharge le modèle Whisper depuis Hugging Face (≈ 500 Mo pour `small`) : prévoyez l'accès réseau.

## Développement local

Prérequis : Python 3.12+, Node 20+, **FFmpeg compilé avec libass** (`ffmpeg -filters | grep ass`), fontconfig.

```bash
# Backend
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
cp ../.env.example ../.env          # chargé automatiquement ; SQLite si DATABASE_URL est vide
# remplacez APP_ENV=production par development pour un essai rapide
uvicorn app.main:app --reload --port 8000

# Worker (autre terminal, même venv)
cd backend && python -m app.worker

# Frontend (autre terminal) — Vite redirige /api vers :8000
cd frontend && npm install && npm run dev     # http://localhost:5173
```

## Variables d'environnement

| Variable | Défaut | Description |
|---|---|---|
| `APP_ENV` | `development` | En `production`, le démarrage échoue si `JWT_SECRET` est vide |
| `JWT_SECRET` | — | Clé de signature des jetons (≥ 32 caractères) |
| `DATABASE_URL` | `sqlite:///./viralcut.db` | `postgresql+psycopg://…` en production |
| `CORS_ORIGINS` | `http://localhost:5173` | Origines autorisées, séparées par des virgules |
| `TRANSCRIPTION_PROVIDER` | `faster_whisper` | `faster_whisper` ou `openai` |
| `WHISPER_MODEL` / `WHISPER_DEVICE` / `WHISPER_COMPUTE_TYPE` | `small` / `auto` / `default` | Sur CPU, `int8` est nettement plus rapide |
| `LLM_PROVIDER` | `auto` | `auto`, `anthropic`, `openai`, `heuristic` |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | — / `claude-sonnet-5-5` | Sélection par Claude |
| `OPENAI_API_KEY` / `OPENAI_MODEL` / `OPENAI_TRANSCRIBE_MODEL` | — / `gpt-4.1-mini` / `whisper-1` | Sélection et/ou transcription OpenAI |
| `YOUTUBE_API_KEY` | — | Facultatif : ajoute la durée aux métadonnées d'un lien |
| `STORAGE_BACKEND` | `local` | `local` ou `s3` (+ `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT_URL`, identifiants AWS standards) |
| `STORAGE_DIR` / `WORK_DIR` | `./storage` / `./work` | Fichiers persistants / temporaires (nettoyés après chaque tâche) |
| `X264_PRESET` / `X264_CRF` | `veryfast` / `20` | Compromis vitesse / qualité de l'encodage |
| `JOB_MAX_ATTEMPTS` / `JOB_STALE_AFTER_S` | `3` / `120` | Reprise des tâches interrompues |
| `COST_PER_*` | voir `.env.example` | Tarifs utilisés pour estimer les coûts d'API |
| `FONTS_DIR` | `backend/app/assets/fonts` | Polices supplémentaires pour les sous-titres |

## Configurer les services externes

**Anthropic (recommandé pour la sélection)** — créez une clé sur https://console.anthropic.com → *API Keys*, puis `ANTHROPIC_API_KEY=…`. Le modèle reçoit les phrases numérotées et répond via un outil `submit_clips` dont le schéma JSON est généré depuis Pydantic ; une réponse invalide est renvoyée une fois au modèle avec l'erreur, puis rejetée.

**OpenAI** — clé sur https://platform.openai.com/api-keys. Sert à la sélection (`LLM_PROVIDER=openai`) et/ou à la transcription (`TRANSCRIPTION_PROVIDER=openai`, découpage automatique en blocs de 20 min pour respecter la limite de 25 Mo).

**Whisper local** — aucune clé. GPU NVIDIA : `WHISPER_DEVICE=cuda` (CUDA 12 + cuDNN requis par CTranslate2). CPU : `WHISPER_COMPUTE_TYPE=int8`.

**YouTube** — seules les métadonnées publiques (oEmbed : titre, auteur, miniature) sont lues. Pour la durée, activez *YouTube Data API v3* dans Google Cloud et définissez `YOUTUBE_API_KEY`. **Aucun téléchargement n'est effectué** : l'utilisateur importe le fichier original (par exemple depuis YouTube Studio pour sa propre chaîne).

**S3** — `STORAGE_BACKEND=s3`, `S3_BUCKET`, `S3_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` ; `S3_ENDPOINT_URL` pour un service compatible. Les médias sont alors servis par URL présignée.

Sans aucune clé IA, l'application fonctionne en **mode heuristique** (affiché dans Paramètres et sur chaque clip) : passages notés par des règles explicables, titres et accroches **extraits** du texte, jamais inventés.

## Score de potentiel

Score sur 100 = moyenne pondérée de cinq notes sur 10 : accroche (30 %), clarté (20 %), intérêt (20 %), conclusion (15 %), rythme (15 %). Le **rythme est toujours mesuré** (mots/s, part de silence, hésitations) ; les autres notes viennent du modèle ou des règles. Le détail est affiché sur chaque clip avec la mention qu'il s'agit d'une estimation, pas d'une prédiction de vues.

## API (extrait)

| Méthode | Route | Usage |
|---|---|---|
| POST | `/api/auth/register`, `/api/auth/login` | Compte, jeton |
| GET/PATCH/DELETE | `/api/auth/me` | Profil, style par défaut, suppression du compte et des données |
| GET | `/api/usage`, `/api/system/status` | Quotas, coûts, configuration réelle |
| POST | `/api/youtube/metadata` | Métadonnées d'un lien |
| GET/POST/PATCH/DELETE | `/api/projects[/{id}]` | Projets |
| PUT | `/api/projects/{id}/upload?filename=&rights_confirmed=true` | Import en flux (corps brut), limite de taille appliquée pendant la réception |
| POST | `/api/projects/{id}/transcript-file` | Import SRT/VTT |
| POST | `/api/projects/{id}/analyze` | Lance l'analyse (`retranscribe` facultatif) |
| GET | `/api/projects/{id}/transcript`, `/jobs`, `/export.zip` | Transcription, tâches, export groupé |
| POST | `/api/projects/{id}/clips` | Clip manuel (aligné sur les phrases) |
| GET | `/api/clips?status=&min_score=&min_duration=&max_duration=&date_from=&date_to=&sort=` | Liste filtrée |
| GET/PATCH/DELETE | `/api/clips/{id}` | Détail, édition (bornes, mots, style, cadrage, export…) |
| POST | `/api/clips/{id}/render`, `/duplicate` | Rendu, duplication |
| GET/POST | `/api/jobs/{id}`, `/cancel`, `/retry` | Suivi des tâches |
| GET | `/api/media?t=<jeton>` | Fichier via jeton signé limité à une ressource (Range pris en charge) |

Documentation interactive : http://localhost:8000/docs

## Modèles de données

`User`, `Project`, `VideoSource` (avec déclaration de droits horodatée), `Transcript` (mots horodatés, silences), `Clip` (bornes, titres, accroches, description, hashtags, mots-clés, score et détail, raison, méthode, cadrage, statut, clés des fichiers exportés), `TimeSegment` (portions conservées après coupe des silences), `SubtitleTrack` (mots éditables + style), `ExportSettings`, `Job` (étape, progression, tentatives, journal, battement de cœur), `UsageRecord` (minutes vidéo, minutes ASR, tokens IA, coût estimé).

Les tables sont créées au démarrage (`create_all`). Pour faire évoluer le schéma en production, ajoutez Alembic (`alembic init`, `target_metadata = Base.metadata`).

## Tests

```bash
cd backend && pytest -q
```

44 tests, dont un pipeline complet qui génère une vraie vidéo avec FFmpeg, importe un SRT, lance l'analyse et le rendu par le worker, puis vérifie le fichier produit (1080×1920, audio présent, durée = somme des segments, lecture partielle Range, SRT, export .zip, nettoyage des fichiers temporaires). Couverture : import (format, faux fichier, sans audio, taille, droits), validation des horodatages, coupes et remappage, sous-titres ASS/SRT, erreurs de transcription, sortie IA structurée (client simulé) et rejet des réponses invalides, recadrage dynamique rendu par FFmpeg, file de tâches (réservation exclusive, worker disparu, abandon après N tentatives, annulation, relance), quotas, cloisonnement entre utilisateurs et jetons média.

## Déploiement

- **Une machine** : `docker compose up -d --build` derrière un reverse proxy HTTPS (Caddy, Traefik, Nginx). Pour Nginx, autorisez de gros corps de requête (`client_max_body_size 8g;`, `proxy_request_buffering off;`).
- **Cloud** : API sur Cloud Run / Fly.io / Render, workers sur des machines avec CPU (ou GPU pour Whisper), PostgreSQL managé, stockage S3. Les workers peuvent être mis à l'échelle indépendamment.
- Montez un volume persistant pour `HF_HOME` afin de ne pas retélécharger le modèle Whisper.

## Ce qui a été vérifié, et ce qui ne l'a pas été

Vérifié dans l'environnement de développement : suite de tests complète, rendu FFmpeg réel (format, sous-titres incrustés visibles, loudness mesurée à −14,0 LUFS), parcours complet dans un navigateur headless (inscription, import de 140 Mo avec progression, analyse, rendu, liste des clips, éditeur, mobile).

**Non testé ici** (accès réseau indisponible dans l'environnement de construction) :
- la transcription réelle par faster-whisper (téléchargement du modèle bloqué) et par l'API OpenAI ;
- les appels réels aux API Anthropic et OpenAI (testés avec un client simulé respectant leur format) ;
- la détection de visage sur de vraies personnes (testée uniquement sans visage ; la logique de plans est testée unitairement) ;
- le stockage S3, PostgreSQL et l'image Docker (pas de démon Docker disponible).

Testez ces intégrations avec vos clés avant toute mise en production.

## Feuille de route

- **Phase 2** : recadrage multi-locuteurs (diarisation), éditeur de timeline avancé, régénération des titres seuls, équipes et partage.
- **Phase 3** : traitement par lots (offre Studio — déjà prévu dans les limites d'offre), facturation Stripe (le champ `plan` et le suivi des coûts sont en place ; aucun paiement n'est simulé), statistiques de performance via l'API YouTube Analytics, ajustement des pondérations du score à partir des résultats réels.
