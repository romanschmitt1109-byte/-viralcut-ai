"""Rendu d'un Short : montage des segments, cadrage 9:16, sous-titres, audio."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from ..config import settings
from .framing import crop_x_expression
from .media import run_ffmpeg

OUT_W, OUT_H = 1080, 1920


@dataclass
class RenderSpec:
    source: Path
    src_width: int  # dimensions affichées (après rotation)
    src_height: int
    fps: float
    segments: list[tuple[float, float]]  # en temps source
    shots: list[tuple[float, float]]  # [(t_clip, centre_x 0..1)]
    ass_file: Path | None
    output: Path
    normalize_audio: bool = True
    target_lufs: float = -14.0
    width: int = OUT_W
    height: int = OUT_H


def _filter_path(p: Path) -> str:
    """Échappe un chemin pour l'utiliser comme option d'un filtre FFmpeg."""
    return str(p).replace("\\", "/").replace(":", "\\:").replace("'", "\\'")


def build_filtergraph(spec: RenderSpec, seek0: float) -> str:
    n = len(spec.segments)
    W, H = spec.width, spec.height
    parts = [f"[0:v]split={n}" + "".join(f"[vs{k}]" for k in range(n)),
             f"[0:a]asplit={n}" + "".join(f"[as{k}]" for k in range(n))]
    for k, (s, e) in enumerate(spec.segments):
        a, b = s - seek0, e - seek0
        parts.append(f"[vs{k}]trim=start={a:.3f}:end={b:.3f},setpts=PTS-STARTPTS[v{k}]")
        parts.append(f"[as{k}]atrim=start={a:.3f}:end={b:.3f},asetpts=PTS-STARTPTS[a{k}]")
    parts.append("".join(f"[v{k}][a{k}]" for k in range(n)) + f"concat=n={n}:v=1:a=1[vc][ac]")

    target_ratio = W / H
    src_ratio = spec.src_width / spec.src_height
    if src_ratio > target_ratio + 0.01:
        crop_w = int(round(spec.src_height * target_ratio / 2) * 2)
        x = crop_x_expression(spec.shots or [(0.0, 0.5)], spec.src_width, crop_w)
        parts.append(f"[vc]crop=w={crop_w}:h={spec.src_height}:x='{x}':y=0,scale={W}:{H}:flags=lanczos,setsar=1[vf]")
    else:
        # source déjà verticale ou plus étroite : fond flouté + vidéo centrée
        parts.append("[vc]split[bg][fg]")
        parts.append(f"[bg]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},boxblur=20:2,eq=brightness=-0.08[bgb]")
        parts.append(f"[fg]scale={W}:{H}:force_original_aspect_ratio=decrease:flags=lanczos[fgs]")
        parts.append("[bgb][fgs]overlay=(W-w)/2:(H-h)/2,setsar=1[vf]")

    if spec.ass_file:
        fonts = f":fontsdir='{_filter_path(settings.fonts_dir)}'" if settings.fonts_dir.is_dir() else ""
        parts.append(f"[vf]ass=filename='{_filter_path(spec.ass_file)}'{fonts}[vout]")
    else:
        parts.append("[vf]null[vout]")

    if spec.normalize_audio:
        parts.append(f"[ac]loudnorm=I={spec.target_lufs}:TP=-1.5:LRA=11,aresample=48000[aout]")
    else:
        parts.append("[ac]aresample=48000[aout]")
    return ";".join(parts)


def render(spec: RenderSpec, on_progress: Callable[[float], None] | None = None) -> Path:
    if not spec.segments:
        raise ValueError("Aucun segment à rendre")
    seek0 = max(0.0, spec.segments[0][0])
    span = spec.segments[-1][1] - seek0 + 0.5
    total = sum(e - s for s, e in spec.segments)
    graph = build_filtergraph(spec, seek0)
    spec.output.parent.mkdir(parents=True, exist_ok=True)
    args = [
        "-ss", f"{seek0:.3f}", "-t", f"{span:.3f}", "-i", str(spec.source),
        "-filter_complex", graph, "-map", "[vout]", "-map", "[aout]",
        "-c:v", "libx264", "-preset", settings.x264_preset, "-crf", str(settings.x264_crf),
        "-pix_fmt", "yuv420p", "-profile:v", "high",
    ]
    if spec.fps > 60.5:
        args += ["-r", "60"]
    args += ["-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", str(spec.output)]
    run_ffmpeg(args, duration=total, on_progress=on_progress)
    return spec.output
