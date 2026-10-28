import type { SubtitleStyle, Word } from "./types";

/** Même règle de regroupement que le serveur (pipeline/subtitles.py → group_words). */
export function groupWords(words: Word[], size: number, maxChars = 24): Word[][] {
  const groups: Word[][] = [];
  let cur: Word[] = [];
  for (const w of words) {
    if (cur.length) {
      const last = cur[cur.length - 1];
      const chars = cur.reduce((a, x) => a + x.w.length + 1, 0) + w.w.length;
      if (cur.length >= size || w.s - last.e > 0.5 || chars > maxChars || /[.?!…]$/.test(last.w)) {
        groups.push(cur);
        cur = [];
      }
    }
    cur.push(w);
  }
  if (cur.length) groups.push(cur);
  return groups;
}

export function norm(w: string): string {
  return w.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}_]/gu, "");
}

export type ActiveCaption = { words: Word[]; active: number } | null;

export function captionAt(groups: Word[][], t: number): ActiveCaption {
  for (const g of groups) {
    if (t >= g[0].s && t < g[g.length - 1].e) {
      let active = 0;
      g.forEach((w, i) => { if (w.s <= t) active = i; });
      return { words: g, active };
    }
  }
  return null;
}

export function captionStyle(style: SubtitleStyle, containerH: number): React.CSSProperties {
  const k = containerH / 1920;
  return {
    fontFamily: `"${style.font}", Inter, system-ui, sans-serif`,
    fontSize: `${style.size * k}px`,
    fontWeight: style.bold ? 800 : 500,
    textTransform: style.uppercase ? "uppercase" : "none",
    color: style.text_color,
    WebkitTextStroke: `${style.outline * k * 2}px ${style.outline_color}`,
    paintOrder: "stroke fill",
    textShadow: style.shadow ? `${style.shadow * k}px ${style.shadow * k}px 0 rgba(0,0,0,0.5)` : "none",
    lineHeight: 1.15,
    top: `${style.position * 100}%`,
  };
}
