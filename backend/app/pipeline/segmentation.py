"""Découpage de la transcription en phrases, validation des passages choisis et
calcul des segments conservés (suppression des silences et hésitations)."""
from __future__ import annotations

import re
from dataclasses import dataclass

END_PUNCT = re.compile(r"[.?!…]+[\"»”)]*$")
FILLERS = {"euh", "heu", "hum", "hmm", "uh", "um", "erm", "ehm", "bah", "mmh"}


@dataclass
class Sentence:
    idx: int
    w0: int  # index du premier mot
    w1: int  # index du dernier mot (inclus)
    start: float
    end: float
    text: str

    @property
    def duration(self) -> float:
        return self.end - self.start


def split_sentences(words: list[dict], gap_break: float = 0.9, max_len: float = 20.0) -> list[Sentence]:
    sentences: list[Sentence] = []
    cur: list[int] = []

    def flush():
        if cur:
            ws = [words[i] for i in cur]
            sentences.append(Sentence(len(sentences), cur[0], cur[-1], ws[0]["s"], ws[-1]["e"], " ".join(w["w"] for w in ws)))
            cur.clear()

    for i, w in enumerate(words):
        cur.append(i)
        nxt = words[i + 1] if i + 1 < len(words) else None
        dur = w["e"] - words[cur[0]]["s"]
        if nxt is None or END_PUNCT.search(w["w"]) or (nxt["s"] - w["e"]) >= gap_break:
            flush()
        elif dur >= max_len and (w["w"].endswith((",", ";", ":")) or (nxt["s"] - w["e"]) > 0.35):
            flush()
        elif dur >= max_len * 1.5:
            flush()
    flush()
    return sentences


def is_filler(word: str) -> bool:
    return re.sub(r"[^\w]", "", word.lower()) in FILLERS


@dataclass
class Selection:
    start_sentence: int
    end_sentence: int
    start: float
    end: float
    payload: dict  # titres, score, etc. fournis par le sélecteur

    @property
    def duration(self) -> float:
        return self.end - self.start


def bounds_for(sentences: list[Sentence], words: list[dict], a: int, b: int, media_duration: float) -> tuple[float, float]:
    """Bornes temporelles d'un passage avec une petite marge, sans mordre sur les mots voisins."""
    s0, s1 = sentences[a], sentences[b]
    prev_end = words[s0.w0 - 1]["e"] if s0.w0 > 0 else 0.0
    next_start = words[s1.w1 + 1]["s"] if s1.w1 + 1 < len(words) else media_duration
    start = max(prev_end, s0.start - 0.15, 0.0)
    end = min(next_start, s1.end + 0.35, media_duration)
    return round(start, 3), round(end, 3)


def _overlap(a: tuple[float, float], b: tuple[float, float]) -> float:
    inter = max(0.0, min(a[1], b[1]) - max(a[0], b[0]))
    return inter / max(1e-6, min(a[1] - a[0], b[1] - b[0]))


def validate_selections(
    raw: list[dict],
    sentences: list[Sentence],
    words: list[dict],
    min_d: float,
    max_d: float,
    media_duration: float,
    limit: int,
) -> tuple[list[Selection], list[str]]:
    """Vérifie et corrige les passages proposés (par l'IA ou l'heuristique).

    Règles : indices valides, durée dans [min_d, max_d] (ajustée phrase par phrase
    si possible, sinon rejetée), pas de chevauchement > 30 %, tri par score.
    Retourne les sélections valides et la liste des rejets expliqués.
    """
    rejected: list[str] = []
    valid: list[Selection] = []
    n = len(sentences)
    for item in sorted(raw, key=lambda r: -float(r.get("score", 0))):
        try:
            a, b = int(item["start_sentence"]), int(item["end_sentence"])
        except (KeyError, TypeError, ValueError):
            rejected.append("indices de phrases manquants")
            continue
        if not (0 <= a <= b < n):
            rejected.append(f"indices hors limites ({a}-{b})")
            continue
        start, end = bounds_for(sentences, words, a, b, media_duration)
        # trop long : retire des phrases à la fin tant que possible
        while end - start > max_d and b > a:
            b -= 1
            start, end = bounds_for(sentences, words, a, b, media_duration)
        # trop court : ajoute des phrases à la fin tant que la limite haute le permet
        while end - start < min_d and b + 1 < n:
            ns, ne = bounds_for(sentences, words, a, b + 1, media_duration)
            if ne - ns > max_d:
                break
            b += 1
            start, end = ns, ne
        d = end - start
        if d > max_d + 0.5 or d < min_d - 0.5:
            rejected.append(f"durée {d:.1f}s hors de [{min_d:.0f}, {max_d:.0f}] s (phrases {a}-{b})")
            continue
        if any(_overlap((start, end), (v.start, v.end)) > 0.3 for v in valid):
            rejected.append(f"chevauche un passage mieux noté (phrases {a}-{b})")
            continue
        valid.append(Selection(a, b, start, end, item))
        if len(valid) >= limit:
            break
    return valid, rejected


def keep_segments(
    words: list[dict], start: float, end: float, remove_silences: bool = True,
    max_gap: float = 0.6, pad: float = 0.18, remove_fillers: bool = True,
) -> list[tuple[float, float]]:
    """Segments de la source à conserver entre start et end.

    Les pauses supérieures à `max_gap` et les hésitations (« euh », « um »…) sont
    retirées en gardant `pad` secondes de respiration autour de la parole.
    """
    if not remove_silences:
        return [(start, end)]
    inside = [w for w in words if w["s"] >= start - 0.01 and w["e"] <= end + 0.01]
    speech = [w for w in inside if not (remove_fillers and is_filler(w["w"]))]
    if not speech:
        return [(start, end)]
    groups: list[list[dict]] = [[speech[0]]]
    for prev, w in zip(speech, speech[1:]):
        if w["s"] - prev["e"] > max_gap:
            groups.append([w])
        else:
            groups[-1].append(w)
    segs = [[max(start, g[0]["s"] - pad), min(end, g[-1]["e"] + pad)] for g in groups]
    # un « euh » isolé entre deux mots proches crée une coupe inutile : on fusionne
    merged: list[list[float]] = []
    for s in segs:
        if merged and s[0] <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], s[1])
        else:
            merged.append(s)
    return [(round(a, 3), round(b, 3)) for a, b in merged if b - a > 0.05]


def remap_words(words: list[dict], segments: list[tuple[float, float]]) -> list[dict]:
    """Convertit des mots en temps source vers la timeline du clip monté."""
    out: list[dict] = []
    offset = 0.0
    for s, e in segments:
        for w in words:
            mid = (w["s"] + w["e"]) / 2
            if s <= mid < e or (s <= w["s"] < e):
                out.append({"w": w["w"], "s": round(max(0.0, offset + max(w["s"], s) - s), 3),
                            "e": round(offset + min(w["e"], e) - s, 3)})
        offset += e - s
    # dédoublonnage (un mot à cheval sur deux segments)
    dedup: list[dict] = []
    for w in out:
        if dedup and dedup[-1]["w"] == w["w"] and abs(dedup[-1]["e"] - w["s"]) < 0.02:
            dedup[-1]["e"] = w["e"]
            continue
        dedup.append(w)
    return dedup


def total_duration(segments: list[tuple[float, float]]) -> float:
    return sum(e - s for s, e in segments)
