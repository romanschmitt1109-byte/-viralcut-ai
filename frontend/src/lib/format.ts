import { useEffect, useRef } from "react";

export function fmtTime(t: number | null | undefined, precise = false): string {
  if (t == null || !isFinite(t)) return "–";
  const neg = t < 0;
  t = Math.abs(t);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const ss = precise ? s.toFixed(1).padStart(4, "0") : Math.floor(s).toString().padStart(2, "0");
  return (neg ? "-" : "") + (h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`);
}

export function fmtBytes(b: number | null | undefined): string {
  if (!b) return "–";
  const u = ["o", "Ko", "Mo", "Go"];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) {
    b /= 1024;
    i++;
  }
  return `${b.toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" });
}

export const STEP_LABELS: Record<string, string> = {
  queued: "En file d'attente",
  extract_audio: "Extraction de l'audio",
  transcribe: "Transcription",
  silences: "Détection des silences",
  analyze: "Analyse IA du contenu",
  validate: "Vérification des passages",
  segments: "Découpage",
  framing: "Recadrage vertical",
  subtitles: "Sous-titres",
  encode: "Rendu vidéo",
  verify: "Vérification du fichier",
  upload: "Enregistrement",
  done: "Terminé",
};

export const CLIP_STATUS: Record<string, { label: string; cls: string }> = {
  draft: { label: "À rendre", cls: "bg-amber-500/15 text-amber-300 ring-amber-500/30" },
  queued: { label: "En file", cls: "bg-sky-500/15 text-sky-300 ring-sky-500/30" },
  rendering: { label: "Rendu…", cls: "bg-violet-500/15 text-violet-300 ring-violet-500/30" },
  ready: { label: "Prêt", cls: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30" },
  failed: { label: "Échec", cls: "bg-rose-500/15 text-rose-300 ring-rose-500/30" },
};

export const PROJECT_STATUS: Record<string, { label: string; cls: string }> = {
  awaiting_upload: { label: "Fichier attendu", cls: "bg-amber-500/15 text-amber-300 ring-amber-500/30" },
  draft: { label: "Prêt à analyser", cls: "bg-sky-500/15 text-sky-300 ring-sky-500/30" },
  queued: { label: "En file", cls: "bg-sky-500/15 text-sky-300 ring-sky-500/30" },
  processing: { label: "Analyse…", cls: "bg-violet-500/15 text-violet-300 ring-violet-500/30" },
  ready: { label: "Clips générés", cls: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30" },
  failed: { label: "Échec", cls: "bg-rose-500/15 text-rose-300 ring-rose-500/30" },
};

export const METHOD_LABEL: Record<string, string> = {
  anthropic: "IA (Claude)",
  openai: "IA (OpenAI)",
  heuristic: "Heuristique",
  manual: "Manuel",
};

/** Exécute `fn` à intervalle régulier tant que `active` est vrai. */
export function usePoll(fn: () => void, active: boolean, ms = 1500) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => ref.current(), ms);
    return () => clearInterval(id);
  }, [active, ms]);
}
