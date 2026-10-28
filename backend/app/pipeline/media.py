"""Outils FFmpeg/FFprobe : inspection, extraction audio, silences, vignettes."""
from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from ..config import settings


class MediaError(Exception):
    pass


@dataclass
class MediaInfo:
    duration: float
    width: int
    height: int
    fps: float
    rotation: int
    has_audio: bool
    video_codec: str
    format_name: str

    @property
    def display_size(self) -> tuple[int, int]:
        """Taille affichée, en tenant compte d'une rotation (vidéos de téléphone)."""
        if self.rotation in (90, 270, -90, -270):
            return self.height, self.width
        return self.width, self.height


def probe(path: Path) -> MediaInfo:
    cmd = [settings.ffprobe_bin, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=60, check=True).stdout
    except subprocess.CalledProcessError as e:
        raise MediaError("Fichier illisible : ce n'est pas une vidéo valide ou il est corrompu.") from e
    except subprocess.TimeoutExpired as e:
        raise MediaError("Analyse du fichier trop longue (timeout).") from e
    data = json.loads(out or "{}")
    streams = data.get("streams", [])
    v = next((s for s in streams if s.get("codec_type") == "video" and s.get("disposition", {}).get("attached_pic", 0) == 0), None)
    a = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if v is None:
        raise MediaError("Aucune piste vidéo trouvée dans le fichier.")
    duration = float(data.get("format", {}).get("duration") or v.get("duration") or 0)
    if duration <= 0:
        raise MediaError("Durée de la vidéo introuvable.")
    num, _, den = (v.get("avg_frame_rate") or v.get("r_frame_rate") or "30/1").partition("/")
    try:
        fps = float(num) / float(den or 1)
    except (ValueError, ZeroDivisionError):
        fps = 30.0
    rotation = 0
    for sd in v.get("side_data_list", []) or []:
        if "rotation" in sd:
            rotation = int(sd["rotation"])
    if "rotate" in (v.get("tags") or {}):
        rotation = int(v["tags"]["rotate"])
    return MediaInfo(
        duration=duration,
        width=int(v["width"]),
        height=int(v["height"]),
        fps=fps if fps > 0 else 30.0,
        rotation=rotation,
        has_audio=a is not None,
        video_codec=v.get("codec_name", ""),
        format_name=data.get("format", {}).get("format_name", ""),
    )


_TIME_RE = re.compile(r"out_time_us=(\d+)")


def run_ffmpeg(args: list[str], duration: float | None = None, on_progress: Callable[[float], None] | None = None, timeout: int = 3600) -> None:
    """Lance FFmpeg et remonte la progression réelle (0..1) via -progress."""
    cmd = [settings.ffmpeg_bin, "-hide_banner", "-nostdin", "-y", "-progress", "pipe:1", "-nostats", *args]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert proc.stdout is not None
    try:
        for line in proc.stdout:
            if on_progress and duration:
                m = _TIME_RE.match(line.strip())
                if m:
                    on_progress(min(1.0, int(m.group(1)) / 1e6 / duration))
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        raise MediaError("FFmpeg a dépassé le délai imparti")
    stderr = proc.stderr.read() if proc.stderr else ""
    if proc.returncode != 0:
        tail = "\n".join(stderr.strip().splitlines()[-8:])
        raise MediaError(f"FFmpeg a échoué (code {proc.returncode}) : {tail}")


def extract_audio(src: Path, dest: Path, fmt: str = "wav", on_progress=None, duration: float | None = None) -> Path:
    """Audio mono 16 kHz pour la transcription (wav) ou mp3 compact (API)."""
    if fmt == "wav":
        args = ["-i", str(src), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(dest)]
    else:
        args = ["-i", str(src), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "48k", str(dest)]
    run_ffmpeg(args, duration=duration, on_progress=on_progress)
    return dest


_SIL_START = re.compile(r"silence_start: (-?[\d.]+)")
_SIL_END = re.compile(r"silence_end: (-?[\d.]+)")


def detect_silences(audio: Path, noise_db: float = -35.0, min_silence: float = 0.5) -> list[list[float]]:
    cmd = [settings.ffmpeg_bin, "-hide_banner", "-nostdin", "-i", str(audio), "-af",
           f"silencedetect=noise={noise_db}dB:d={min_silence}", "-f", "null", "-"]
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
    if res.returncode != 0:
        raise MediaError("Détection des silences impossible")
    out: list[list[float]] = []
    start: float | None = None
    for line in res.stderr.splitlines():
        if (m := _SIL_START.search(line)):
            start = max(0.0, float(m.group(1)))
        elif (m := _SIL_END.search(line)) and start is not None:
            out.append([round(start, 3), round(float(m.group(1)), 3)])
            start = None
    return out


def extract_frame(src: Path, t: float, dest: Path, vf: str | None = None) -> Path:
    args = ["-ss", f"{max(0.0, t):.3f}", "-i", str(src), "-frames:v", "1"]
    if vf:
        args += ["-vf", vf]
    args += ["-q:v", "3", str(dest)]
    run_ffmpeg(args)
    return dest
