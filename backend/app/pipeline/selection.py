"""Sélection des meilleurs passages.

Le modèle de langage reçoit la transcription découpée en phrases NUMÉROTÉES avec
leurs horodatages. Il répond par des indices de phrases (jamais par des
horodatages libres), via une sortie structurée validée par Pydantic. Le serveur
convertit ensuite les indices en temps et vérifie les contraintes
(voir segmentation.validate_selections).

Fournisseurs : `anthropic`, `openai`, `heuristic` (règles explicables, sans IA,
utilisable hors ligne). Le mode utilisé est enregistré sur chaque clip.
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from typing import Protocol

from pydantic import BaseModel, Field, ValidationError

from ..config import settings
from . import scoring
from .segmentation import Sentence


class SelectionError(Exception):
    def __init__(self, msg: str, retryable: bool = False):
        super().__init__(msg)
        self.retryable = retryable  # erreur réseau/API transitoire


class SubScores(BaseModel):
    hook: float = Field(ge=0, le=10, description="Force de l'accroche des 3 premières secondes")
    clarity: float = Field(ge=0, le=10, description="Compréhensible sans contexte")
    interest: float = Field(ge=0, le=10, description="Intérêt du sujet, surprise, émotion, utilité")
    payoff: float = Field(ge=0, le=10, description="Qualité de la conclusion / chute")


class ClipProposal(BaseModel):
    start_sentence: int = Field(ge=0)
    end_sentence: int = Field(ge=0)
    title_options: list[str] = Field(min_length=1, max_length=3)
    hooks: list[str] = Field(default_factory=list, max_length=3)
    description: str = ""
    hashtags: list[str] = Field(default_factory=list, max_length=8)
    keywords: list[str] = Field(default_factory=list, max_length=8, description="Mots exacts de la transcription à mettre en évidence")
    thumbnail_sentence: int | None = None
    scores: SubScores
    reason: str


class SelectionOutput(BaseModel):
    clips: list[ClipProposal]


@dataclass
class SelectionResult:
    proposals: list[dict]
    provider: str
    usage: dict = field(default_factory=dict)


class Selector(Protocol):
    name: str

    def select(self, sentences: list[Sentence], words: list[dict], language: str, count: int,
               min_d: float, max_d: float) -> SelectionResult: ...


# --------------------------------------------------------------------------- prompt
def _fmt_t(t: float) -> str:
    m, s = divmod(t, 60)
    h, m = divmod(int(m), 60)
    return f"{h:d}:{m:02d}:{s:04.1f}"


def render_transcript(sentences: list[Sentence]) -> str:
    return "\n".join(f"[{s.idx}] {_fmt_t(s.start)}–{_fmt_t(s.end)} ({s.duration:.1f}s) {s.text}" for s in sentences)


SYSTEM_PROMPT = """Tu es éditeur vidéo spécialisé en formats courts (YouTube Shorts, TikTok, Reels).
Tu reçois la transcription d'une vidéo longue, découpée en phrases numérotées avec horodatages.
Ta tâche : choisir les passages qui feront les meilleurs Shorts autonomes.

Critères :
- Accroche forte dès la première phrase (question, affirmation surprenante, enjeu clair).
- Compréhensible SANS le reste de la vidéo : pas de début par « et », « donc », « comme je disais », pas de pronom qui renvoie à un élément absent.
- Une seule idée ou histoire, avec une conclusion ou une chute (pas de coupure au milieu d'une phrase ou d'un raisonnement).
- Moments surprenants, conseils utiles, émotions, débats, révélations, humour.

Règles strictes :
- Réponds UNIQUEMENT avec l'outil fourni.
- start_sentence et end_sentence sont des indices de la liste ; le passage couvre toutes les phrases entre les deux, incluses.
- Respecte la durée demandée en additionnant les durées indiquées.
- Les passages ne doivent pas se chevaucher.
- Titres : 3 propositions, max 70 caractères, qui suscitent la curiosité SANS mentir ni promettre ce que le passage ne contient pas.
- Accroches (hooks) : 3 courtes phrases d'accroche écrites pour l'écran ou la description, fidèles au propos. N'invente aucune citation : n'attribue pas à l'orateur des mots qu'il n'a pas dits.
- Description : 1 à 2 phrases, puis pas de bourrage de mots-clés.
- Hashtags : 3 à 6, pertinents, sans « # » en double, incluant #shorts.
- keywords : 2 à 6 mots EXACTEMENT présents dans le passage, à mettre en couleur dans les sous-titres.
- thumbnail_sentence : la phrase dont l'image ferait la meilleure miniature (moment expressif).
- scores : notes de 0 à 10, honnêtes. reason : 1 à 2 phrases expliquant le choix.
- Écris titres, accroches et description dans la langue de la vidéo."""


def user_prompt(sentences: list[Sentence], language: str, count: int, min_d: float, max_d: float) -> str:
    return (
        f"Langue de la vidéo : {language}\n"
        f"Propose {count} passages, chacun d'une durée totale comprise entre {min_d:.0f} et {max_d:.0f} secondes, "
        f"classés du meilleur au moins bon.\n\nTranscription :\n{render_transcript(sentences)}"
    )


def _inline_refs(schema: dict) -> dict:
    """Résout les $ref Pydantic pour obtenir un schéma JSON autonome."""
    defs = schema.pop("$defs", {})

    def walk(node):
        if isinstance(node, dict):
            if "$ref" in node:
                return walk(dict(defs[node["$ref"].split("/")[-1]]))
            return {k: walk(v) for k, v in node.items()}
        if isinstance(node, list):
            return [walk(v) for v in node]
        return node

    return walk(schema)


TOOL_SCHEMA = _inline_refs(SelectionOutput.model_json_schema())


def _chunks(sentences: list[Sentence], max_sent: int = 700, overlap: int = 8) -> list[list[Sentence]]:
    if len(sentences) <= max_sent:
        return [sentences]
    out, i = [], 0
    while i < len(sentences):
        out.append(sentences[i : i + max_sent])
        i += max_sent - overlap
    return out


def _parse(raw: dict) -> list[dict]:
    try:
        return [p.model_dump() for p in SelectionOutput.model_validate(raw).clips]
    except ValidationError as e:
        raise SelectionError(f"Réponse IA invalide : {e.errors()[:3]}") from e


# --------------------------------------------------------------------------- Anthropic
class AnthropicSelector:
    name = "anthropic"

    def select(self, sentences, words, language, count, min_d, max_d):
        if not settings.anthropic_api_key:
            raise SelectionError("ANTHROPIC_API_KEY manquante pour LLM_PROVIDER=anthropic")
        import anthropic

        client = anthropic.Anthropic(api_key=settings.anthropic_api_key)
        proposals: list[dict] = []
        usage = {"in": 0, "out": 0}
        parts = _chunks(sentences)
        per = max(2, math.ceil((count + 3) / len(parts)))
        for part in parts:
            messages = [{"role": "user", "content": user_prompt(part, language, per, min_d, max_d)}]
            for attempt in range(2):
                try:
                    resp = client.messages.create(
                        model=settings.anthropic_model,
                        max_tokens=settings.llm_max_output_tokens,
                        system=SYSTEM_PROMPT,
                        messages=messages,
                        tools=[{"name": "submit_clips", "description": "Soumet les passages sélectionnés.", "input_schema": TOOL_SCHEMA}],
                        tool_choice={"type": "tool", "name": "submit_clips"},
                    )
                except Exception as e:
                    raise SelectionError(f"Échec de l'appel à l'API Anthropic : {e}", retryable=True) from e
                usage["in"] += resp.usage.input_tokens
                usage["out"] += resp.usage.output_tokens
                block = next((b for b in resp.content if getattr(b, "type", "") == "tool_use"), None)
                try:
                    if block is None:
                        raise SelectionError("Le modèle n'a pas utilisé l'outil de sortie structurée")
                    proposals += _parse(block.input)
                    break
                except SelectionError as e:
                    if attempt == 1:
                        raise
                    messages += [
                        {"role": "assistant", "content": resp.content},
                        {"role": "user", "content": [{"type": "tool_result", "tool_use_id": block.id, "is_error": True,
                                                      "content": f"{e}. Corrige et renvoie un résultat valide."}]}
                        if block else {"role": "user", "content": "Utilise l'outil submit_clips."},
                    ]
        return SelectionResult(proposals, self.name, usage)


# --------------------------------------------------------------------------- OpenAI
class OpenAISelector:
    name = "openai"

    def select(self, sentences, words, language, count, min_d, max_d):
        if not settings.openai_api_key:
            raise SelectionError("OPENAI_API_KEY manquante pour LLM_PROVIDER=openai")
        from openai import OpenAI

        client = OpenAI(api_key=settings.openai_api_key)
        proposals: list[dict] = []
        usage = {"in": 0, "out": 0}
        parts = _chunks(sentences)
        per = max(2, math.ceil((count + 3) / len(parts)))
        for part in parts:
            try:
                resp = client.chat.completions.create(
                    model=settings.openai_model,
                    max_tokens=settings.llm_max_output_tokens,
                    messages=[{"role": "system", "content": SYSTEM_PROMPT},
                              {"role": "user", "content": user_prompt(part, language, per, min_d, max_d)}],
                    response_format={"type": "json_schema", "json_schema": {"name": "submit_clips", "schema": TOOL_SCHEMA}},
                )
            except Exception as e:
                raise SelectionError(f"Échec de l'appel à l'API OpenAI : {e}", retryable=True) from e
            if resp.usage:
                usage["in"] += resp.usage.prompt_tokens
                usage["out"] += resp.usage.completion_tokens
            try:
                proposals += _parse(json.loads(resp.choices[0].message.content or "{}"))
            except json.JSONDecodeError as e:
                raise SelectionError("Réponse OpenAI non JSON") from e
        return SelectionResult(proposals, self.name, usage)


# --------------------------------------------------------------------------- Heuristique
class HeuristicSelector:
    """Sélection sans IA générative : fenêtres de phrases notées par des règles
    explicables. Titres et accroches sont EXTRAITS du texte (aucune invention)."""

    name = "heuristic"

    def select(self, sentences, words, language, count, min_d, max_d):
        cands: list[dict] = []
        n = len(sentences)
        for a in range(n):
            if sentences[a].text.split()[0].lower().strip(",.") in scoring.CONNECTIVE_START:
                continue
            b = a
            while b < n:
                d = sentences[b].end - sentences[a].start
                if d > max_d:
                    break
                if d >= min_d:
                    sub, notes = scoring.heuristic_subscores(sentences, a, b)
                    pace, _ = scoring.measured_pace(words, sentences[a].start, sentences[b].end)
                    total = scoring.combine({**sub, "pace": pace})
                    cands.append({"a": a, "b": b, "sub": sub, "notes": notes, "score": total})
                b += 1
        cands.sort(key=lambda c: -c["score"])
        picked: list[dict] = []
        for c in cands:
            if any(not (c["b"] < p["a"] or c["a"] > p["b"]) for p in picked):
                continue
            picked.append(c)
            if len(picked) >= count + 3:
                break
        out = []
        for c in picked:
            sents = sentences[c["a"] : c["b"] + 1]
            body = " ".join(s.text for s in sents)
            kws = scoring.top_keywords(body, 4)
            ranked = sorted(sents, key=lambda s: -scoring.heuristic_subscores(sentences, s.idx, s.idx)[0]["hook"])
            titles = []
            for s in [sents[0], *ranked]:
                t = _shorten(s.text)
                if t not in titles:
                    titles.append(t)
            reason = "Sélection heuristique : " + (", ".join(dict.fromkeys(c["notes"])) or "bon équilibre accroche/rythme/conclusion") + "."
            out.append({
                "start_sentence": c["a"], "end_sentence": c["b"],
                "title_options": titles[:3],
                "hooks": [_shorten(s.text, 90) for s in ranked[:3]],
                "description": _shorten(" ".join(s.text for s in sents[:2]), 200),
                "hashtags": ["#shorts", *[f"#{k}" for k in kws[:3]]],
                "keywords": kws,
                "thumbnail_sentence": ranked[0].idx,
                "scores": c["sub"],
                "reason": reason,
            })
        return SelectionResult(out, self.name, {})


def _shorten(text: str, n: int = 70) -> str:
    text = text.strip()
    if len(text) <= n:
        return text
    cut = text[: n - 1].rsplit(" ", 1)[0]
    return cut.rstrip(",;:") + "…"


def get_selector(name: str | None = None) -> Selector:
    name = name or settings.resolved_llm_provider
    cls = {"anthropic": AnthropicSelector, "openai": OpenAISelector, "heuristic": HeuristicSelector}.get(name)
    if cls is None:
        raise SelectionError(f"Fournisseur IA inconnu : {name}")
    return cls()
