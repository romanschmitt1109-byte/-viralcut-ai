/**
 * Portage TypeScript de backend/app/pipeline/{segmentation,scoring,selection(heuristique),subtitles}.py
 * pour le mode navigateur. Même règles, mêmes résultats.
 */
import type { SubtitleStyle, Word } from "../types";
import { groupWords, norm } from "../subtitles";

export type Sentence = { idx: number; w0: number; w1: number; start: number; end: number; text: string };

const END_PUNCT = /[.?!…]+["»”)]*$/;
const FILLERS = new Set(["euh", "heu", "hum", "hmm", "uh", "um", "erm", "ehm", "bah", "mmh"]);
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export function isFiller(w: string) {
  return FILLERS.has(w.toLowerCase().replace(/[^\p{L}\p{N}_]/gu, ""));
}

export function cleanWords(words: Word[]): Word[] {
  const out: Word[] = [];
  let last = 0;
  for (const w of words) {
    const t = (w.w ?? "").trim();
    if (!t) continue;
    const s = Math.max(w.s, last - 0.05, 0);
    const e = Math.max(w.e, s + 0.05);
    out.push({ w: t, s: r3(s), e: r3(e) });
    last = e;
  }
  if (!out.length) throw new Error("Aucune parole détectée dans la vidéo.");
  return out;
}

export function splitSentences(words: Word[], gapBreak = 0.9, maxLen = 20): Sentence[] {
  const out: Sentence[] = [];
  let cur: number[] = [];
  const flush = () => {
    if (!cur.length) return;
    const ws = cur.map((i) => words[i]);
    out.push({ idx: out.length, w0: cur[0], w1: cur[cur.length - 1], start: ws[0].s, end: ws[ws.length - 1].e, text: ws.map((w) => w.w).join(" ") });
    cur = [];
  };
  words.forEach((w, i) => {
    cur.push(i);
    const nxt = words[i + 1];
    const dur = w.e - words[cur[0]].s;
    if (!nxt || END_PUNCT.test(w.w) || nxt.s - w.e >= gapBreak) flush();
    else if (dur >= maxLen && (/[,;:]$/.test(w.w) || nxt.s - w.e > 0.35)) flush();
    else if (dur >= maxLen * 1.5) flush();
  });
  flush();
  return out;
}

export function boundsFor(s: Sentence[], words: Word[], a: number, b: number, mediaDur: number): [number, number] {
  const s0 = s[a], s1 = s[b];
  const prevEnd = s0.w0 > 0 ? words[s0.w0 - 1].e : 0;
  const nextStart = s1.w1 + 1 < words.length ? words[s1.w1 + 1].s : mediaDur;
  return [r3(Math.max(prevEnd, s0.start - 0.15, 0)), r3(Math.min(nextStart, s1.end + 0.35, mediaDur))];
}

export function keepSegments(words: Word[], start: number, end: number, remove = true, maxGap = 0.6, pad = 0.18): [number, number][] {
  if (!remove) return [[start, end]];
  const speech = words.filter((w) => w.s >= start - 0.01 && w.e <= end + 0.01 && !isFiller(w.w));
  if (!speech.length) return [[start, end]];
  const groups: Word[][] = [[speech[0]]];
  for (let i = 1; i < speech.length; i++) {
    if (speech[i].s - speech[i - 1].e > maxGap) groups.push([speech[i]]);
    else groups[groups.length - 1].push(speech[i]);
  }
  const merged: [number, number][] = [];
  for (const g of groups) {
    const seg: [number, number] = [Math.max(start, g[0].s - pad), Math.min(end, g[g.length - 1].e + pad)];
    const last = merged[merged.length - 1];
    if (last && seg[0] <= last[1]) last[1] = Math.max(last[1], seg[1]);
    else merged.push(seg);
  }
  return merged.filter(([a, b]) => b - a > 0.05).map(([a, b]) => [r3(a), r3(b)]);
}

export function remapWords(words: Word[], segs: [number, number][]): Word[] {
  const out: Word[] = [];
  let off = 0;
  for (const [s, e] of segs) {
    for (const w of words) {
      const mid = (w.s + w.e) / 2;
      if ((s <= mid && mid < e) || (s <= w.s && w.s < e)) {
        out.push({ w: w.w, s: r3(Math.max(0, off + Math.max(w.s, s) - s)), e: r3(off + Math.min(w.e, e) - s) });
      }
    }
    off += e - s;
  }
  const dedup: Word[] = [];
  for (const w of out) {
    const l = dedup[dedup.length - 1];
    if (l && l.w === w.w && Math.abs(l.e - w.s) < 0.02) l.e = w.e;
    else dedup.push(w);
  }
  return dedup;
}

// ----------------------------------------------------------------------------- score
export const WEIGHTS = { hook: 0.3, clarity: 0.2, pace: 0.15, interest: 0.2, payoff: 0.15 } as const;
const STOP = new Set(`le la les un une des de du d l et ou mais donc or ni car que qui quoi dont où ce cet cette ces se sa son ses
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
over same such them through under until while your yours just like know think going want get got thing things`.split(/\s+/));
const HOOK = new Set(`secret secrets erreur erreurs jamais personne incroyable vrai vérité problème pourquoi comment arrêtez arrête
attention choc surprise interdit meilleur pire seul unique gratuit argent million milliard mort peur
mistake mistakes never nobody truth why how stop worst best only free money million billion dead fear crazy
insane shocking surprising actually wrong lie lies hidden`.split(/\s+/));
export const CONNECTIVE = new Set(["et", "mais", "donc", "puis", "parce", "car", "ensuite", "and", "but", "so", "because", "then", "also"]);
const BACKREF = new Set(["il", "elle", "ils", "elles", "ça", "ce", "cela", "celui", "celle", "it", "this", "that", "they", "he", "she", "those", "these"]);
const PAYOFF = ["donc", "en fait", "c'est pour ça", "c'est pourquoi", "finalement", "résultat", "la leçon", "au final", "retenez",
  "so ", "that's why", "the lesson", "in the end", "turns out", "the point is", "bottom line"];

export const tokens = (t: string) => t.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
export function contentWords(t: string) {
  return tokens(t).map((x) => x.split(/['’]/).pop()!).filter((x) => !STOP.has(x) && x.length > 3 && !/^\d+$/.test(x));
}
export function topKeywords(t: string, n = 5) {
  const c = new Map<string, number>();
  for (const w of contentWords(t)) c.set(w, (c.get(w) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([w]) => w);
}
const clamp = (v: number) => Math.max(0, Math.min(10, v));

export function measuredPace(words: Word[], start: number, end: number): [number, Record<string, number>] {
  const inside = words.filter((w) => w.s >= start && w.e <= end + 0.01);
  const dur = Math.max(end - start, 1e-6);
  if (!inside.length) return [0, { words_per_second: 0, silence_ratio: 1 }];
  let gaps = 0;
  for (let i = 1; i < inside.length; i++) { const g = inside[i].s - inside[i - 1].e; if (g > 0.4) gaps += g; }
  const wps = inside.length / dur;
  const silence = Math.min(1, gaps / dur);
  const fillers = inside.filter((w) => isFiller(w.w)).length;
  const rate = wps >= 2.4 && wps <= 3.8 ? 10 : wps < 2.4 ? Math.max(0, 10 - (2.4 - wps) * 6) : Math.max(0, 10 - (wps - 3.8) * 4);
  const score = Math.round(clamp(rate - silence * 12 - Math.min(3, fillers * 0.5)) * 10) / 10;
  return [score, { words_per_second: Math.round(wps * 100) / 100, silence_ratio: Math.round(silence * 100) / 100, fillers }];
}

export function combine(sub: Record<string, number>) {
  return Math.round(Object.entries(WEIGHTS).reduce((a, [k, w]) => a + w * clamp(sub[k] ?? 0), 0) * 100) / 10;
}

export function heuristicSubscores(s: Sentence[], a: number, b: number): [Record<string, number>, string[]] {
  const first = s[a].text, last = s[b].text;
  const body = s.slice(a, b + 1).map((x) => x.text).join(" ");
  const ft = tokens(first);
  const notes: string[] = [];
  let hook = 3;
  if (first.includes("?")) { hook += 2.5; notes.push("ouvre sur une question"); }
  if (/\d/.test(first)) { hook += 1.5; notes.push("chiffre dès l'accroche"); }
  if (ft.some((t) => HOOK.has(t))) { hook += 2; notes.push("mot à fort impact dans la première phrase"); }
  if (ft.some((t) => ["vous", "tu", "you", "votre", "ton", "your"].includes(t))) { hook += 1; notes.push("s'adresse directement au spectateur"); }
  if (ft.length <= 14) hook += 1;
  if (ft[0] && CONNECTIVE.has(ft[0])) { hook -= 3; notes.push("commence par un connecteur (dépend du contexte)"); }
  let clarity = 7.5;
  if (ft[0] && BACKREF.has(ft[0])) { clarity -= 2.5; notes.push("première phrase renvoie à un élément précédent"); }
  if (ft[0] && CONNECTIVE.has(ft[0])) clarity -= 1.5;
  const all = tokens(body);
  const n = Math.max(1, all.length);
  clarity -= Math.min(3, (all.filter((t) => ["euh", "heu", "um", "uh", "hum"].includes(t)).length / n) * 60);
  const cw = contentWords(body);
  let interest = 2 + (cw.length / n) * 8 + (new Set(cw).size / Math.max(1, cw.length)) * 2;
  interest += Math.min(2, all.filter((t) => HOOK.has(t)).length * 0.5);
  if (/\d/.test(body)) interest += 0.5;
  let payoff = 4;
  if (/[.!?…]["»”)]*$/.test(last.trim())) payoff += 2.5; else notes.push("se termine sans phrase complète");
  if (PAYOFF.some((m) => (" " + last.toLowerCase()).includes(m))) { payoff += 2.5; notes.push("conclusion explicite"); }
  if (last.includes("!")) payoff += 1;
  const r = (v: number) => Math.round(clamp(v) * 10) / 10;
  return [{ hook: r(hook), clarity: r(clarity), interest: r(interest), payoff: r(payoff) }, notes];
}

const shorten = (t: string, n = 70) => {
  t = t.trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n - 1);
  return cut.slice(0, cut.lastIndexOf(" ") > 0 ? cut.lastIndexOf(" ") : cut.length).replace(/[,;:]$/, "") + "…";
};

export type Proposal = {
  a: number; b: number; start: number; end: number;
  title_options: string[]; hooks: string[]; description: string; hashtags: string[]; keywords: string[];
  thumbnail_sentence: number; scores: Record<string, number>; reason: string;
};

/** Sélection heuristique + validation (mêmes règles que le serveur). */
export function selectPassages(s: Sentence[], words: Word[], count: number, minD: number, maxD: number, mediaDur: number): Proposal[] {
  type C = { a: number; b: number; sub: Record<string, number>; notes: string[]; score: number };
  const cands: C[] = [];
  for (let a = 0; a < s.length; a++) {
    const first = (s[a].text.split(" ")[0] ?? "").toLowerCase().replace(/[,.]/g, "");
    if (CONNECTIVE.has(first)) continue;
    for (let b = a; b < s.length; b++) {
      const d = s[b].end - s[a].start;
      if (d > maxD) break;
      if (d >= minD) {
        const [sub, notes] = heuristicSubscores(s, a, b);
        const [pace] = measuredPace(words, s[a].start, s[b].end);
        cands.push({ a, b, sub, notes, score: combine({ ...sub, pace }) });
      }
    }
  }
  cands.sort((x, y) => y.score - x.score);
  const picked: C[] = [];
  for (const c of cands) {
    if (picked.some((p) => !(c.b < p.a || c.a > p.b))) continue;
    picked.push(c);
    if (picked.length >= count) break;
  }
  return picked.filter((c) => boundsFor(s, words, c.a, c.b, mediaDur)[1] - boundsFor(s, words, c.a, c.b, mediaDur)[0] >= Math.min(3, minD)).map((c) => {
    const sents = s.slice(c.a, c.b + 1);
    const body = sents.map((x) => x.text).join(" ");
    const kws = topKeywords(body, 4);
    const ranked = [...sents].sort((x, y) => heuristicSubscores(s, y.idx, y.idx)[0].hook - heuristicSubscores(s, x.idx, x.idx)[0].hook);
    const titles: string[] = [];
    for (const x of [sents[0], ...ranked]) { const t = shorten(x.text); if (!titles.includes(t)) titles.push(t); }
    const [start, end] = boundsFor(s, words, c.a, c.b, mediaDur);
    return {
      a: c.a, b: c.b, start, end,
      title_options: titles.slice(0, 3),
      hooks: ranked.slice(0, 3).map((x) => shorten(x.text, 90)),
      description: shorten(sents.slice(0, 2).map((x) => x.text).join(" "), 200),
      hashtags: ["#shorts", ...kws.slice(0, 3).map((k) => "#" + k)],
      keywords: kws,
      thumbnail_sentence: ranked[0].idx,
      scores: c.sub,
      reason: "Sélection heuristique : " + ([...new Set(c.notes)].join(", ") || "bon équilibre accroche/rythme/conclusion") + ".",
    };
  });
}

// ----------------------------------------------------------------------------- sous-titres
const assColor = (hex: string, alpha = 0) => `&H${alpha.toString(16).padStart(2, "0")}${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}`.toUpperCase();
const assTime = (t: number) => {
  let cs = Math.round(Math.max(0, t) * 100);
  const h = Math.floor(cs / 360000); cs -= h * 360000;
  const m = Math.floor(cs / 6000); cs -= m * 6000;
  const s = Math.floor(cs / 100); cs -= s * 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
};
const srtTime = (t: number) => {
  let ms = Math.round(Math.max(0, t) * 1000);
  const h = Math.floor(ms / 3600000); ms -= h * 3600000;
  const m = Math.floor(ms / 60000); ms -= m * 60000;
  const s = Math.floor(ms / 1000); ms -= s * 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
};
const esc = (t: string) => t.replace(/\\/g, "/").replace(/\{/g, "(").replace(/\}/g, ")");

export function buildAss(words: Word[], st: SubtitleStyle, W = 1080, H = 1920): string {
  const k = H / 1920;
  const y = Math.round(st.position * H);
  const kw = new Set(st.keywords.map(norm).filter(Boolean));
  const head = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${st.font},${Math.round(st.size * k)},${assColor(st.text_color)},${assColor(st.highlight_color)},${assColor(st.outline_color)},${assColor("#000000", 0x80)},${st.bold ? -1 : 0},0,0,0,100,100,0,0,1,${(st.outline * k).toFixed(1)},${(st.shadow * k).toFixed(1)},5,60,60,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const size = st.mode === "word" ? 1 : st.group_size;
  const lines: string[] = [];
  for (const g of groupWords(words, size)) {
    const gEnd = g[g.length - 1].e;
    g.forEach((w, i) => {
      const start = i === 0 ? g[0].s : w.s;
      const end = i + 1 < g.length ? g[i + 1].s : gEnd;
      if (end - start < 0.02) return;
      const parts = g.map((x, j) => {
        const t = esc(st.uppercase ? x.w.toUpperCase() : x.w);
        if (j === i && st.highlight_active && size > 1) return `{\\c${assColor(st.highlight_color)}}${t}{\\r}`;
        if (kw.has(norm(x.w))) return `{\\c${assColor(st.keyword_color)}}${t}{\\r}`;
        return t;
      });
      const pop = i === 0 || size === 1 ? "{\\fscx108\\fscy108\\t(0,80,\\fscx100\\fscy100)}" : "";
      lines.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Default,,0,0,0,,{\\an5\\pos(${W / 2},${y})}${pop}${parts.join(" ")}`);
    });
  }
  return head + lines.join("\n") + "\n";
}

export function buildSrt(words: Word[]): string {
  return groupWords(words, 7, 42).map((g, i) => `${i + 1}\n${srtTime(g[0].s)} --> ${srtTime(g[g.length - 1].e)}\n${g.map((w) => w.w).join(" ")}\n`).join("\n");
}

/** SRT/VTT → mots avec horodatage interpolé (approximatif). */
export function parseSubtitles(content: string): Word[] {
  const ts = (x: string) => {
    const m = x.match(/(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/);
    if (!m) throw new Error(`Horodatage invalide : ${x}`);
    return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, "0")) / 1000;
  };
  const words: Word[] = [];
  for (const block of content.replace(/\r\n/g, "\n").replace(/﻿/g, "").trim().split(/\n\s*\n/)) {
    const lines = block.split("\n").filter((l) => l.trim());
    const idx = lines.findIndex((l) => l.includes("-->"));
    if (idx < 0) continue;
    const [a, z] = lines[idx].split("-->");
    const start = ts(a), end = ts(z);
    const toks = lines.slice(idx + 1).join(" ").replace(/<[^>]+>/g, "").replace(/\{[^}]*\}/g, "").trim().split(/\s+/).filter(Boolean);
    if (!toks.length || end <= start) continue;
    const total = toks.reduce((s, t) => s + t.length + 1, 0);
    let t = start;
    for (const tok of toks) {
      const d = ((end - start) * (tok.length + 1)) / total;
      words.push({ w: tok, s: t, e: t + d * 0.92 });
      t += d;
    }
  }
  if (!words.length) throw new Error("Le fichier de sous-titres ne contient aucune réplique exploitable.");
  return cleanWords(words);
}

// ----------------------------------------------------------------------------- silences (audio réel)
/** Silences détectés sur le volume réel (fenêtres de 20 ms), seuil adapté au bruit de fond.
 *  Équivalent navigateur du `silencedetect` de FFmpeg utilisé côté serveur. */
export function detectSilences(audio: Float32Array, sr = 16000, minDur = 0.45): [number, number][] {
  const hop = Math.round(sr * 0.02);
  const db: number[] = [];
  for (let i = 0; i + hop <= audio.length; i += hop) {
    let sum = 0;
    for (let k = i; k < i + hop; k++) sum += audio[k] * audio[k];
    db.push(10 * Math.log10(sum / hop + 1e-10));
  }
  if (!db.length) return [];
  const sorted = [...db].sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.1)];
  const speech = sorted[Math.floor(sorted.length * 0.7)];
  // seuil entre le bruit de fond et la parole, borné à [-50, -28] dBFS
  const thr = Math.max(-50, Math.min(-28, floor + (speech - floor) * 0.3));
  const out: [number, number][] = [];
  let start = -1;
  db.forEach((v, i) => {
    if (v < thr) { if (start < 0) start = i; }
    else if (start >= 0) {
      if ((i - start) * 0.02 >= minDur) out.push([r3(start * 0.02), r3(i * 0.02)]);
      start = -1;
    }
  });
  if (start >= 0 && (db.length - start) * 0.02 >= minDur) out.push([r3(start * 0.02), r3(db.length * 0.02)]);
  return out;
}

/** Retire uniquement les silences RÉELS (volume bas) de plus de `maxGap` s,
 *  en gardant `pad` s de respiration : la parole n'est jamais coupée, même si la
 *  transcription a manqué des mots. */
export function keepSegmentsBySilence(silences: [number, number][], start: number, end: number, remove = true, maxGap = 0.6, pad = 0.15): [number, number][] {
  if (!remove) return [[start, end]];
  const cuts = silences
    .map(([a, b]) => [Math.max(a, start), Math.min(b, end)] as [number, number])
    .filter(([a, b]) => b - a > maxGap)
    .map(([a, b]) => [a === start ? a : a + pad, b === end ? b : b - pad] as [number, number]);
  const segs: [number, number][] = [];
  let cur = start;
  for (const [a, b] of cuts) {
    if (a > cur + 0.05) segs.push([r3(cur), r3(a)]);
    cur = Math.max(cur, b);
  }
  if (end > cur + 0.05) segs.push([r3(cur), r3(end)]);
  return segs.length ? segs : [[start, end]];
}

/** Découpe l'audio en fenêtres d'environ 1 à 2 min, coupées au milieu d'un silence
 *  pour ne jamais trancher un mot entre deux passes de Whisper. */
export function audioWindows(silences: [number, number][], total: number, min = 60, max = 120): [number, number][] {
  const out: [number, number][] = [];
  let s = 0;
  while (total - s > max) {
    const gap = silences.find(([a, b]) => (a + b) / 2 > s + min && (a + b) / 2 < s + max);
    const cut = gap ? (gap[0] + gap[1]) / 2 : s + max;
    out.push([s, cut]);
    s = cut;
  }
  out.push([s, total]);
  return out;
}
