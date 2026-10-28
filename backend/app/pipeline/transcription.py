"""Transcription avec horodatage mot par mot.

Fournisseurs interchangeables :
- `faster_whisper` : modèle Whisper local (CPU/GPU), aucun coût d'API.
- `openai`         : API OpenAI (whisper-1, granularité mot).
- `subtitles`      : import d'un fichier SRT/VTT fourni par l'utilisateur
                     (horodatage par mot interpolé → marqué « approximatif »).

Format commun d'un mot : {"w": str, "s": float, "e": float} en secondes source.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Protocol

from ..config import settings
from .media import extract_audio, run_ffmpeg

Progress = Callable[[float], None]


class TranscriptionError(Exception):
    def __init__(self, msg: str, retryable: bool = False):
        super().__init__(msg)
        self.retryable = retryable  # erreur réseau/API transitoire


@dataclass
class TranscriptResult:
    words: list[dict]
    language: str
    provider: str
    duration: float
    approximate: bool = False
    usage: dict = field(default_factory=dict)

    @property
    def text(self) -> str:
        return " ".join(w["w"] for w in self.words)


class Transcriber(Protocol):
    name: str

    def transcribe(self, audio_wav: Path, language: str | None, duration: float, on_progress: Progress) -> TranscriptResult: ...


def clean_words(words: list[dict]) -> list[dict]:
    """Normalise : supprime mots vides, garantit s<e, ordre croissant, monotonie."""
    out: list[dict] = []
    last_end = 0.0
    for w in words:
        text = (w.get("w") or "").strip()
        if not text:
            continue
        s = max(float(w["s"]), last_end - 0.05, 0.0)
        e = max(float(w["e"]), s + 0.05)
        out.append({"w": text, "s": round(s, 3), "e": round(e, 3)})
        last_end = e
    if not out:
        raise TranscriptionError("Aucune parole détectée dans la vidéo.")
    return out


# --------------------------------------------------------------------------- faster-whisper
class FasterWhisperTranscriber:
    name = "faster_whisper"
    _model = None

    def _load(self):
        if FasterWhisperTranscriber._model is None:
            try:
                from faster_whisper import WhisperModel
            except ImportError as e:  # pragma: no cover
                raise TranscriptionError("faster-whisper n'est pas installé (pip install faster-whisper)") from e
            try:
                FasterWhisperTranscriber._model = WhisperModel(
                    settings.whisper_model, device=settings.whisper_device, compute_type=settings.whisper_compute_type
                )
            except Exception as e:
                raise TranscriptionError(
                    f"Impossible de charger le modèle Whisper « {settings.whisper_model} » : {e}. "
                    "Le premier lancement télécharge le modèle depuis Hugging Face (accès réseau requis)."
                ) from e
        return FasterWhisperTranscriber._model

    def transcribe(self, audio_wav, language, duration, on_progress):
        model = self._load()
        segments, info = model.transcribe(
            str(audio_wav), language=language, word_timestamps=True, vad_filter=True, beam_size=5
        )
        words: list[dict] = []
        for seg in segments:
            for w in seg.words or []:
                words.append({"w": w.word.strip(), "s": w.start, "e": w.end})
            on_progress(min(1.0, seg.end / max(duration, 1e-6)))
        return TranscriptResult(clean_words(words), info.language, self.name, duration, usage={"asr_minutes": duration / 60})


# --------------------------------------------------------------------------- OpenAI
def _norm(t: str) -> str:
    t = unicodedata.normalize("NFKD", t.lower())
    return re.sub(r"[^\w]", "", "".join(c for c in t if not unicodedata.combining(c)))


def merge_punctuation(words: list[dict], segments: list[dict]) -> list[dict]:
    """L'API renvoie des mots sans ponctuation ; on la récupère depuis le texte des segments."""
    out = [dict(w) for w in words]
    i = 0
    for seg in segments:
        for tok in seg.get("text", "").split():
            nt = _norm(tok)
            if not nt:
                continue
            # cherche le prochain mot correspondant dans une petite fenêtre
            for j in range(i, min(i + 4, len(out))):
                if _norm(out[j]["w"]) == nt:
                    out[j]["w"] = tok
                    i = j + 1
                    break
    return out


class OpenAITranscriber:
    name = "openai"
    CHUNK_S = 20 * 60  # garde chaque envoi sous la limite de 25 Mo

    def transcribe(self, audio_wav, language, duration, on_progress):
        if not settings.openai_api_key:
            raise TranscriptionError("OPENAI_API_KEY manquante pour TRANSCRIPTION_PROVIDER=openai")
        from openai import OpenAI

        client = OpenAI(api_key=settings.openai_api_key)
        words: list[dict] = []
        detected = language or ""
        n_chunks = max(1, int((duration + self.CHUNK_S - 1) // self.CHUNK_S))
        for k in range(n_chunks):
            offset = k * self.CHUNK_S
            chunk = audio_wav.with_name(f"chunk_{k}.mp3")
            run_ffmpeg(["-ss", str(offset), "-t", str(self.CHUNK_S), "-i", str(audio_wav), "-ac", "1", "-c:a", "libmp3lame", "-b:a", "48k", str(chunk)])
            with chunk.open("rb") as f:
                kwargs = dict(model=settings.openai_transcribe_model, file=f, response_format="verbose_json",
                              timestamp_granularities=["word", "segment"])
                if language:
                    kwargs["language"] = language
                try:
                    resp = client.audio.transcriptions.create(**kwargs)
                except Exception as e:
                    raise TranscriptionError(f"Échec de l'API de transcription OpenAI : {e}", retryable=True) from e
            chunk.unlink(missing_ok=True)
            data = resp.model_dump() if hasattr(resp, "model_dump") else dict(resp)
            cw = [{"w": w["word"], "s": w["start"] + offset, "e": w["end"] + offset} for w in data.get("words") or []]
            words += merge_punctuation(cw, data.get("segments") or [])
            detected = detected or data.get("language", "")
            on_progress((k + 1) / n_chunks)
        lang = _lang_code(detected)
        return TranscriptResult(clean_words(words), lang, self.name, duration, usage={"asr_minutes": duration / 60})


_LANG_NAMES = {"french": "fr", "english": "en", "spanish": "es", "german": "de", "italian": "it", "portuguese": "pt"}


def _lang_code(v: str) -> str:
    v = (v or "").lower()
    return _LANG_NAMES.get(v, v[:2] or "und")


# --------------------------------------------------------------------------- SRT / VTT
_TS = re.compile(r"(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})")


def _ts(s: str) -> float:
    m = _TS.search(s)
    if not m:
        raise TranscriptionError(f"Horodatage invalide : {s!r}")
    h, mnt, sec, ms = m.groups()
    return int(h or 0) * 3600 + int(mnt) * 60 + int(sec) + int(ms.ljust(3, "0")) / 1000


def parse_subtitles(content: str) -> list[dict]:
    """Analyse SRT ou WebVTT et répartit le temps de chaque réplique entre ses mots
    proportionnellement à leur longueur (horodatage approximatif)."""
    content = content.replace("\r\n", "\n").replace("﻿", "")
    blocks = re.split(r"\n\s*\n", content.strip())
    words: list[dict] = []
    for b in blocks:
        lines = [l for l in b.split("\n") if l.strip()]
        idx = next((i for i, l in enumerate(lines) if "-->" in l), None)
        if idx is None:
            continue
        a, _, z = lines[idx].partition("-->")
        start, end = _ts(a), _ts(z)
        text = re.sub(r"<[^>]+>", "", " ".join(lines[idx + 1 :]))
        text = re.sub(r"\{[^}]*\}", "", text).strip()
        toks = text.split()
        if not toks or end <= start:
            continue
        total = sum(len(t) + 1 for t in toks)
        t = start
        for tok in toks:
            d = (end - start) * (len(tok) + 1) / total
            words.append({"w": tok, "s": t, "e": t + d * 0.92})
            t += d
    if not words:
        raise TranscriptionError("Le fichier de sous-titres ne contient aucune réplique exploitable.")
    return clean_words(words)


def get_transcriber(name: str | None = None) -> Transcriber:
    name = name or settings.transcription_provider
    if name == "openai":
        return OpenAITranscriber()
    if name == "faster_whisper":
        return FasterWhisperTranscriber()
    raise TranscriptionError(f"Fournisseur de transcription inconnu : {name}")


def prepare_audio(src: Path, workdir: Path, duration: float, on_progress: Progress) -> Path:
    workdir.mkdir(parents=True, exist_ok=True)
    return extract_audio(src, workdir / "audio.wav", "wav", on_progress=on_progress, duration=duration)
