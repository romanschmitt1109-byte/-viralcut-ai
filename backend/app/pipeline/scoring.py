"""Score de potentiel explicable.

Le score (0-100) est une ESTIMATION fondée sur des critères éditoriaux
(accroche, clarté, rythme, intérêt, conclusion). Il ne prédit pas le nombre de
vues. Le rythme est toujours mesuré sur les données réelles (débit de parole,
proportion de silence) ; les autres critères viennent soit du modèle de langage,
soit des règles heuristiques ci-dessous.
"""
from __future__ import annotations

import re
from collections import Counter

from .segmentation import Sentence, is_filler

WEIGHTS = {"hook": 0.30, "clarity": 0.20, "pace": 0.15, "interest": 0.20, "payoff": 0.15}
LABELS = {"hook": "Accroche", "clarity": "Clarté", "pace": "Rythme", "interest": "Intérêt", "payoff": "Conclusion"}

STOP = set("""
le la les un une des de du d l et ou mais donc or ni car que qui quoi dont où ce cet cette ces se sa son ses
leur leurs je tu il elle on nous vous ils elles me te lui y en ne pas plus très bien est sont était être avoir a ai
as avons avez ont fait faire comme pour par sur dans avec sans sous entre chez à au aux c ça cela ceci si oui non
alors aussi tout tous toute toutes même encore déjà juste vraiment voilà là ici qu j s n m t
the a an and or but so of to in on at for with by from as is are was were be been being have has had do does did
it its this that these those i you he she we they me him her us them my your his our their not no yes just very
really what which who whom when where why how all any some than then there here also can could would should will
chaque pourquoi comment quand parce puis après avant depuis pendant toujours rien quelque quelques autre autres
leurs notre votre vos nos mes tes ses dont celui celle ceux elles ainsi assez beaucoup peu trop fois chose choses
faut veux peux peut doit dit dire vois voir sais savoir allez aller vais suis sommes êtes était étaient serait
about after again against because before being below between both down during each further into more most other
over same such them through under until while your yours just like know think going want get got thing things
""".split())

HOOK_WORDS = set("""
secret secrets erreur erreurs jamais personne incroyable vrai vérité problème pourquoi comment arrêtez arrête
attention choc surprise interdit personne jamais meilleur pire seul unique gratuit argent million milliard mort peur
mistake mistakes never nobody secret truth why how stop worst best only free money million billion dead fear crazy
insane shocking surprising nobody actually wrong lie lies hidden
""".split())

CONNECTIVE_START = {"et", "mais", "donc", "puis", "parce", "car", "ensuite", "and", "but", "so", "because", "then", "also"}
BACKREF_START = {"il", "elle", "ils", "elles", "ça", "ce", "cela", "celui", "celle", "it", "this", "that", "they", "he", "she", "those", "these"}
PAYOFF_MARKERS = ["donc", "en fait", "c'est pour ça", "c'est pourquoi", "finalement", "résultat", "la leçon", "au final",
                  "retenez", "so ", "that's why", "the lesson", "in the end", "turns out", "the point is", "bottom line"]


def tokens(text: str) -> list[str]:
    return re.findall(r"[\wÀ-ÿ']+", text.lower())


def content_words(text: str) -> list[str]:
    out = []
    for t in tokens(text):
        t = re.split(r"[’']", t)[-1]  # qu'ils → ils, l'argent → argent
        if t not in STOP and len(t) > 3 and not t.isdigit():
            out.append(t)
    return out


def measured_pace(words: list[dict], start: float, end: float) -> tuple[float, dict]:
    """Note de rythme (0-10) mesurée : débit de parole et part de silence."""
    inside = [w for w in words if w["s"] >= start and w["e"] <= end + 0.01]
    dur = max(end - start, 1e-6)
    if not inside:
        return 0.0, {"words_per_second": 0, "silence_ratio": 1}
    speech = sum(w["e"] - w["s"] for w in inside)
    gaps = sum(max(0.0, b["s"] - a["e"]) for a, b in zip(inside, inside[1:]) if b["s"] - a["e"] > 0.4)
    wps = len(inside) / dur
    silence_ratio = min(1.0, gaps / dur)
    fillers = sum(1 for w in inside if is_filler(w["w"]))
    # débit idéal ~2.4-3.8 mots/s pour un Short parlé
    if 2.4 <= wps <= 3.8:
        rate = 10.0
    elif wps < 2.4:
        rate = max(0.0, 10 - (2.4 - wps) * 6)
    else:
        rate = max(0.0, 10 - (wps - 3.8) * 4)
    score = rate - silence_ratio * 12 - min(3.0, fillers * 0.5)
    return round(max(0.0, min(10.0, score)), 1), {
        "words_per_second": round(wps, 2), "silence_ratio": round(silence_ratio, 2),
        "fillers": fillers, "speech_seconds": round(speech, 1),
    }


def combine(sub: dict[str, float]) -> float:
    return round(sum(WEIGHTS[k] * max(0.0, min(10.0, float(sub.get(k, 0)))) for k in WEIGHTS) * 10, 1)


def heuristic_subscores(sentences: list[Sentence], a: int, b: int) -> tuple[dict[str, float], list[str]]:
    first = sentences[a].text
    last = sentences[b].text
    body = " ".join(s.text for s in sentences[a : b + 1])
    ft = tokens(first)
    notes: list[str] = []

    hook = 3.0
    if "?" in first:
        hook += 2.5; notes.append("ouvre sur une question")
    if re.search(r"\d", first):
        hook += 1.5; notes.append("chiffre dès l'accroche")
    if any(t in HOOK_WORDS for t in ft):
        hook += 2.0; notes.append("mot à fort impact dans la première phrase")
    if {"vous", "tu", "you", "votre", "ton", "your"} & set(ft):
        hook += 1.0; notes.append("s'adresse directement au spectateur")
    if len(ft) <= 14:
        hook += 1.0
    if ft and ft[0] in CONNECTIVE_START:
        hook -= 3.0; notes.append("commence par un connecteur (dépend du contexte)")

    clarity = 7.5
    if ft and ft[0] in BACKREF_START:
        clarity -= 2.5; notes.append("première phrase renvoie à un élément précédent")
    if ft and ft[0] in CONNECTIVE_START:
        clarity -= 1.5
    n_tok = max(1, len(tokens(body)))
    fill = sum(1 for t in tokens(body) if t in {"euh", "heu", "um", "uh", "hum"})
    clarity -= min(3.0, fill / n_tok * 60)

    cw = content_words(body)
    density = len(cw) / n_tok
    distinct = len(set(cw)) / max(1, len(cw))
    interest = 2.0 + density * 8 + distinct * 2
    hits = sum(1 for t in tokens(body) if t in HOOK_WORDS)
    interest += min(2.0, hits * 0.5)
    if re.search(r"\d", body):
        interest += 0.5

    payoff = 4.0
    if re.search(r"[.!?…][\"»”)]*$", last.strip()):
        payoff += 2.5
    else:
        notes.append("se termine sans phrase complète")
    low = " " + last.lower()
    if any(m in low for m in PAYOFF_MARKERS):
        payoff += 2.5; notes.append("conclusion explicite")
    if "!" in last:
        payoff += 1.0

    sub = {k: round(max(0.0, min(10.0, v)), 1) for k, v in
           {"hook": hook, "clarity": clarity, "interest": interest, "payoff": payoff}.items()}
    return sub, notes


def top_keywords(text: str, n: int = 5) -> list[str]:
    c = Counter(content_words(text))
    return [w for w, _ in c.most_common(n)]
