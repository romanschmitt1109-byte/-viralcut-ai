"""Sous-titres dynamiques : génération ASS (incrustation libass) et SRT."""
from __future__ import annotations

import re
import subprocess
import unicodedata
from functools import lru_cache
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from ..config import settings

HEX = re.compile(r"^#[0-9a-fA-F]{6}$")


class SubtitleStyle(BaseModel):
    font: str = "Inter"
    size: int = Field(78, ge=24, le=200)
    bold: bool = True
    uppercase: bool = True
    mode: Literal["word", "group"] = "group"
    group_size: int = Field(3, ge=1, le=8)
    text_color: str = "#FFFFFF"
    highlight_color: str = "#A78BFA"  # mot en cours de prononciation
    keyword_color: str = "#FACC15"  # mots-clés mis en évidence
    highlight_active: bool = True
    outline_color: str = "#000000"
    outline: float = Field(6, ge=0, le=20)
    shadow: float = Field(2, ge=0, le=20)
    position: float = Field(0.70, ge=0.05, le=0.95)  # centre vertical, fraction de la hauteur
    keywords: list[str] = Field(default_factory=list)

    @field_validator("text_color", "highlight_color", "keyword_color", "outline_color")
    @classmethod
    def _hex(cls, v: str) -> str:
        if not HEX.match(v):
            raise ValueError("couleur attendue au format #RRGGBB")
        return v.upper()


def ass_color(hex_rgb: str, alpha: int = 0) -> str:
    r, g, b = hex_rgb[1:3], hex_rgb[3:5], hex_rgb[5:7]
    return f"&H{alpha:02X}{b}{g}{r}".upper()


def ass_time(t: float) -> str:
    t = max(0.0, t)
    cs = int(round(t * 100))
    h, cs = divmod(cs, 360000)
    m, cs = divmod(cs, 6000)
    s, cs = divmod(cs, 100)
    return f"{h:d}:{m:02d}:{s:02d}.{cs:02d}"


def srt_time(t: float) -> str:
    ms = int(round(max(0.0, t) * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _norm(w: str) -> str:
    w = unicodedata.normalize("NFKD", w.lower())
    return re.sub(r"[^\w]", "", "".join(c for c in w if not unicodedata.combining(c)))


def _escape(text: str) -> str:
    return text.replace("\\", "/").replace("{", "(").replace("}", ")").replace("\n", " ")


def group_words(words: list[dict], size: int, max_chars: int = 24) -> list[list[dict]]:
    groups: list[list[dict]] = []
    cur: list[dict] = []
    for i, w in enumerate(words):
        if cur:
            gap = w["s"] - cur[-1]["e"]
            chars = sum(len(x["w"]) + 1 for x in cur) + len(w["w"])
            if len(cur) >= size or gap > 0.5 or chars > max_chars or re.search(r"[.?!…]$", cur[-1]["w"]):
                groups.append(cur)
                cur = []
        cur.append(w)
    if cur:
        groups.append(cur)
    return groups


def build_ass(words: list[dict], style: SubtitleStyle, width: int = 1080, height: int = 1920) -> str:
    """`words` doivent être en temps du clip monté (voir segmentation.remap_words)."""
    scale = height / 1920
    size = int(style.size * scale)
    y = int(style.position * height)
    kw = {_norm(k) for k in style.keywords if _norm(k)}
    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,{style.font},{size},{ass_color(style.text_color)},{ass_color(style.highlight_color)},{ass_color(style.outline_color)},{ass_color('#000000', 0x80)},{-1 if style.bold else 0},0,0,0,100,100,0,0,1,{style.outline * scale:.1f},{style.shadow * scale:.1f},5,60,60,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    lines: list[str] = []
    size_ = 1 if style.mode == "word" else style.group_size
    for group in group_words(words, size_):
        g_end = group[-1]["e"]
        for i, w in enumerate(group):
            start = group[0]["s"] if i == 0 else w["s"]
            end = group[i + 1]["s"] if i + 1 < len(group) else g_end
            if end - start < 0.02:
                continue
            parts = []
            for j, x in enumerate(group):
                t = _escape(x["w"].upper() if style.uppercase else x["w"])
                if j == i and style.highlight_active and size_ > 1:
                    parts.append(f"{{\\c{ass_color(style.highlight_color)}}}{t}{{\\r}}")
                elif _norm(x["w"]) in kw:
                    parts.append(f"{{\\c{ass_color(style.keyword_color)}}}{t}{{\\r}}")
                else:
                    parts.append(t)
            pop = "{\\fscx108\\fscy108\\t(0,80,\\fscx100\\fscy100)}" if (i == 0 or size_ == 1) else ""
            text = f"{{\\an5\\pos({width // 2},{y})}}{pop}" + " ".join(parts)
            lines.append(f"Dialogue: 0,{ass_time(start)},{ass_time(end)},Default,,0,0,0,,{text}")
    return header + "\n".join(lines) + "\n"


def build_srt(words: list[dict], max_words: int = 7, max_chars: int = 42) -> str:
    out = []
    for n, g in enumerate(group_words(words, max_words, max_chars), 1):
        out.append(f"{n}\n{srt_time(g[0]['s'])} --> {srt_time(g[-1]['e'])}\n{' '.join(w['w'] for w in g)}\n")
    return "\n".join(out)


@lru_cache(maxsize=1)
def available_fonts() -> list[str]:
    fams: set[str] = set()
    try:
        res = subprocess.run(["fc-list", ":", "family"], capture_output=True, text=True, timeout=10)
        for line in res.stdout.splitlines():
            fams.add(line.split(",")[0].strip())
    except Exception:
        pass
    if settings.fonts_dir.is_dir():
        for f in settings.fonts_dir.glob("*.[ot]tf"):
            fams.add(f.stem.split("-")[0])
    preferred = ["Inter", "Montserrat", "Poppins", "Anton", "Bebas Neue", "Roboto", "Open Sans", "DejaVu Sans", "Liberation Sans", "FreeSans"]
    return [f for f in preferred if f in fams] + sorted(f for f in fams if f not in preferred and f)[:30]
