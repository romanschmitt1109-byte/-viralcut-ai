/**
 * « Serveur » exécuté dans le navigateur (mode GitHub Pages).
 *
 * Il répond aux mêmes routes que l'API FastAPI, pour que les pages restent
 * identiques. Le traitement est réel : FFmpeg (WebAssembly) pour l'audio et le
 * rendu, Whisper (transformers.js) pour la transcription, et la même sélection
 * heuristique que le serveur. Tout reste dans l'onglet : rien n'est envoyé en
 * ligne, et tout disparaît au rechargement de la page.
 */
import type { ClipDetail, ClipSummary, Job, Project, SubtitleStyle, Word } from "../types";
import { extractAudio, FONT_NAME, probe, renderShort, thumbnail, type Probe } from "./media";
import {
  buildAss, buildSrt, cleanWords, combine, keepSegments, measuredPace, parseSubtitles, remapWords, selectPassages,
  splitSentences, WEIGHTS,
} from "./text";

export class LocalError extends Error {}

type LProject = Project & { file?: File; probe?: Probe; transcript?: Transcript; example?: boolean };
type Transcript = { language: string; provider: string; approximate: boolean; words: Word[]; raw?: unknown };

const EXT = [".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi"];
const MAX_MINUTES = 30;
const WHISPER_MODEL = "base";
const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID().replace(/-/g, "");

const projects = new Map<string, LProject>();
const clips = new Map<string, ClipDetail>();
const jobs: Job[] = [];
let user: Record<string, unknown> = { id: "local", email: "vous@navigateur", display_name: "", plan: "free", default_subtitle_style: null };
let usage: Record<string, unknown> = {};
let system: Record<string, unknown> = {};
let defaultStyle: SubtitleStyle;
let seeded: Promise<void> | null = null;

/** Charge le projet d'exemple (produit par le vrai pipeline serveur, voir scripts/build_demo.py). */
function seed(): Promise<void> {
  seeded ??= fetch("demo/demo.json").then((r) => r.json()).then((d) => {
    user = { ...d.user, display_name: "", email: "vous@navigateur" };
    usage = d.usage;
    system = {
      ...d.system, fonts: [FONT_NAME], transcription_provider: "navigateur", transcription_configured: true,
      whisper_model: `Whisper ${WHISPER_MODEL} (dans le navigateur)`, llm_provider: "heuristic", llm_model: null, storage: "navigateur",
    };
    defaultStyle = { ...d.system.default_subtitle_style, font: FONT_NAME };
    const p: LProject = { ...d.project, title: `${d.project.title} (exemple)`, example: true, active_jobs: [] };
    p.transcript = { language: "fr", provider: "subtitles", approximate: true, words: [], raw: d.transcript };
    delete (p as Partial<Project>).clips;
    projects.set(p.id, p);
    for (const c of d.clips as ClipDetail[]) clips.set(c.id, { ...c, project_title: p.title });
    jobs.push(...(d.jobs as Job[]));
  });
  return seeded;
}

// --------------------------------------------------------------------------- sérialisation
function summary(c: ClipDetail): ClipSummary {
  const { id, project_id, project_title, start, end, duration, source_duration, title, score, status, selection_method,
    error, created_at, updated_at, rendered_at, export_url, thumbnail_url, srt_url } = c;
  return { id, project_id, project_title, start, end, duration, source_duration, title, score, status, selection_method,
    error, created_at, updated_at, rendered_at, export_url, thumbnail_url, srt_url };
}
const projectClips = (pid: string) => [...clips.values()].filter((c) => c.project_id === pid);

function projectOut(p: LProject, withClips = false): Project {
  const cs = projectClips(p.id);
  const out: Project = {
    id: p.id, title: p.title, status: p.status, language: p.language, clip_count: p.clip_count,
    min_duration: p.min_duration, max_duration: p.max_duration, remove_silences: p.remove_silences, error: p.error,
    created_at: p.created_at, updated_at: p.updated_at, source: p.source, has_transcript: !!p.transcript,
    transcript_provider: p.transcript?.provider ?? null, n_clips: cs.length, n_ready: cs.filter((c) => c.status === "ready").length,
    active_jobs: jobs.filter((j) => j.project_id === p.id && (j.status === "queued" || j.status === "running")).map((j) => ({ ...j })),
  };
  if (withClips) out.clips = cs.sort((a, b) => b.score - a.score).map(summary);
  return out;
}

// --------------------------------------------------------------------------- file de tâches
let queue: Promise<void> = Promise.resolve();

function log(j: Job, msg: string, level = "info") {
  j.logs = [...j.logs, { t: now(), level, msg }].slice(-100);
}

function enqueue(kind: "analyze" | "render", project_id: string, clip_id: string | null = null): Job {
  const existing = jobs.find((j) => j.kind === kind && j.project_id === project_id && j.clip_id === clip_id && (j.status === "queued" || j.status === "running"));
  if (existing) return existing;
  const j: Job = { id: uid(), kind, status: "queued", step: "queued", progress: 0, attempts: 0, max_attempts: 1, error: null,
    clip_id, project_id, logs: [], created_at: now(), started_at: null, finished_at: null };
  jobs.unshift(j);
  queue = queue.then(() => execute(j));
  return j;
}

async function execute(j: Job) {
  if (j.status === "cancelled") return;
  j.status = "running"; j.attempts = 1; j.started_at = now();
  try {
    if (j.kind === "analyze") await runAnalysis(j);
    else await runRender(j);
    j.status = "succeeded"; j.progress = 100; j.step = "done";
  } catch (e) {
    if ((j.status as Job["status"]) !== "cancelled") {
      j.status = "failed"; j.error = (e as Error).message;
      log(j, j.error, "error");
      const p = projects.get(j.project_id);
      if (j.kind === "analyze" && p) { p.status = "failed"; p.error = j.error; }
      const c = j.clip_id ? clips.get(j.clip_id) : undefined;
      if (c) { c.status = "failed"; c.error = j.error; }
    }
  } finally {
    j.finished_at = now();
  }
}

const step = (j: Job, name: string, progress: number, msg?: string) => {
  if (j.status === "cancelled") throw new LocalError("Tâche annulée");
  j.step = name; j.progress = progress;
  if (msg) log(j, msg);
};
const sub = (j: Job, lo: number, hi: number) => (f: number) => { j.progress = Math.round((lo + (hi - lo) * f) * 10) / 10; };

// --------------------------------------------------------------------------- transcription
let whisper: Worker | null = null;
function transcribe(j: Job, audio: Float32Array, language: string | null): Promise<{ words: Word[]; approximate: boolean }> {
  whisper ??= new Worker(new URL("./whisper.worker.ts", import.meta.url), { type: "module" });
  return new Promise((resolve, reject) => {
    let lastDl = -1;
    whisper!.onmessage = (e) => {
      const m = e.data;
      if (m.type === "download") {
        const pct = Math.round(m.value * 100);
        if (pct !== lastDl && pct % 10 === 0) { lastDl = pct; log(j, `Téléchargement du modèle Whisper : ${pct} %`); }
        j.step = "transcribe";
      } else if (m.type === "ready") log(j, m.wordLevel ? "Modèle prêt (horodatage mot à mot)" : "Modèle prêt (horodatage par phrase, mots interpolés)");
      else if (m.type === "progress") sub(j, 10, 60)(m.value);
      else if (m.type === "done") resolve({ words: m.words, approximate: m.approximate });
      else if (m.type === "error") reject(new LocalError(`Échec de la transcription : ${m.message}. Le premier usage télécharge le modèle (≈ 80 Mo) : vérifiez la connexion.`));
    };
    whisper!.onerror = (e) => reject(new LocalError(`Échec du module de transcription : ${e.message}`));
    whisper!.postMessage({ audio, language, model: WHISPER_MODEL }, [audio.buffer]);
  });
}

// --------------------------------------------------------------------------- analyse
async function runAnalysis(j: Job) {
  const p = projects.get(j.project_id);
  if (!p?.file || !p.probe) throw new LocalError("Aucune vidéo importée pour ce projet.");
  p.status = "processing"; p.error = null;
  const duration = p.probe.duration;
  if (!p.transcript) {
    step(j, "extract_audio", 2, "Chargement de FFmpeg et extraction de l'audio");
    const audio = await extractAudio(p.file, duration, sub(j, 2, 10));
    step(j, "transcribe", 10, `Transcription (Whisper ${WHISPER_MODEL}, dans le navigateur)`);
    const lang = p.language === "auto" ? null : p.language;
    const res = await transcribe(j, audio, lang);
    const words = cleanWords(res.words);
    p.transcript = { language: lang ?? "auto", provider: "whisper-navigateur", approximate: res.approximate, words };
    log(j, `${words.length} mots transcrits`);
  } else step(j, "transcribe", 60, "Transcription existante réutilisée");

  const words = p.transcript.words.filter((w) => w.e <= duration + 0.05);
  const sents = splitSentences(words);
  if (!sents.length) throw new LocalError("La transcription ne contient aucune phrase exploitable.");
  if (sents[sents.length - 1].end - sents[0].start < p.min_duration) throw new LocalError("Pas assez de parole pour la durée minimale demandée.");
  step(j, "analyze", 63, `Analyse du contenu (heuristique) sur ${sents.length} phrases`);
  const props = selectPassages(sents, words, p.clip_count, p.min_duration, p.max_duration, duration);
  step(j, "validate", 85, `${props.length} passage(s) retenu(s)`);
  if (!props.length) throw new LocalError("Aucun passage ne respecte les contraintes de durée. Essayez d'élargir la plage de durée.");

  for (const c of projectClips(p.id)) if (c.selection_method !== "manual") clips.delete(c.id);
  const style = { ...defaultStyle, ...((user.default_subtitle_style as object) ?? {}) } as SubtitleStyle;
  for (const pr of props) {
    const [pace, measures] = measuredPace(words, pr.start, pr.end);
    const subs = { ...pr.scores, pace };
    const segs = keepSegments(words, pr.start, pr.end, p.remove_silences);
    const id = uid();
    clips.set(id, {
      id, project_id: p.id, project_title: p.title, start: pr.start, end: pr.end,
      duration: Math.round(segs.reduce((a, [s, e]) => a + e - s, 0) * 100) / 100, source_duration: Math.round((pr.end - pr.start) * 100) / 100,
      title: pr.title_options[0] ?? "Clip", score: combine(subs), status: "queued", selection_method: "heuristic", error: null,
      created_at: now(), updated_at: now(), rendered_at: null, export_url: null, thumbnail_url: null, srt_url: null,
      title_options: pr.title_options, hooks: pr.hooks, description: pr.description, hashtags: pr.hashtags, keywords: pr.keywords,
      score_breakdown: { subscores: subs, weights: { ...WEIGHTS }, pace_measures: measures }, reason: pr.reason,
      thumbnail_time: sents[pr.thumbnail_sentence].start + 0.3, crop_x: null, crop_auto: true, crop_shots: null, segments: segs,
      subtitles: { words: words.filter((w) => w.s >= pr.start - 0.01 && w.e <= pr.end + 0.01), style: { ...style, keywords: pr.keywords }, edited: false },
      export_settings: { width: 1080, height: 1920, burn_subtitles: true, normalize_audio: true, target_lufs: -14, remove_silences: p.remove_silences },
      source: p.source, score_disclaimer: "Estimation éditoriale (accroche, clarté, rythme, intérêt, conclusion). Ce score ne prédit pas le nombre de vues.",
    });
  }
  p.status = "ready";
  step(j, "done", 100, `${props.length} clips créés`);
  for (const c of projectClips(p.id)) if (c.status === "queued") enqueue("render", p.id, c.id);
}

// --------------------------------------------------------------------------- rendu
async function runRender(j: Job) {
  const c = clips.get(j.clip_id ?? "");
  const p = c && projects.get(c.project_id);
  if (!c || !p) throw new LocalError("Clip introuvable.");
  if (!p.file || !p.probe) throw new LocalError("La vidéo source n'est plus disponible (page rechargée ?). Réimportez-la.");
  c.status = "rendering"; c.error = null;
  const es = c.export_settings!;
  step(j, "segments", 3, "Calcul des segments conservés");
  const segs = keepSegments(c.subtitles?.words ?? [], c.start, c.end, es.remove_silences);
  c.segments = segs;
  step(j, "framing", 6, c.crop_auto ? "Cadrage centré (le suivi du visage n'est disponible que sur le serveur)" : "Cadrage manuel");
  step(j, "subtitles", 25, "Génération des sous-titres");
  const outWords = remapWords(c.subtitles?.words ?? [], segs);
  const ass = es.burn_subtitles && outWords.length ? buildAss(outWords, c.subtitles!.style) : null;
  step(j, "encode", 28, "Encodage 1080×1920 dans le navigateur");
  const thumbAt = c.thumbnail_time != null && c.thumbnail_time >= c.start && c.thumbnail_time < c.end ? c.thumbnail_time : segs[0][0] + 0.5;
  const out = await renderShort({
    file: p.file, srcW: p.probe.width, srcH: p.probe.height, segments: segs, cropX: c.crop_auto || c.crop_x == null ? 0.5 : c.crop_x,
    ass, normalize: es.normalize_audio, lufs: es.target_lufs, thumbAt,
  }, sub(j, 28, 97));
  for (const u of [c.export_url, c.thumbnail_url, c.srt_url]) if (u?.startsWith("blob:")) URL.revokeObjectURL(u);
  c.export_url = URL.createObjectURL(out.mp4);
  c.thumbnail_url = URL.createObjectURL(out.thumb);
  c.srt_url = URL.createObjectURL(new Blob([buildSrt(outWords)], { type: "text/plain" }));
  c.duration = Math.round(out.duration * 100) / 100;
  c.status = "ready"; c.rendered_at = now(); c.updated_at = now();
  step(j, "done", 100, `Short rendu (${(out.mp4.size / 1e6).toFixed(1)} Mo)`);
}

// --------------------------------------------------------------------------- import
export async function localUpload(projectId: string, file: File, onProgress: (l: number, t: number) => void) {
  await seed();
  const p = projects.get(projectId);
  if (!p) throw new LocalError("Projet introuvable");
  const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
  if (!EXT.includes(ext)) throw new LocalError(`Format non pris en charge (${ext}).`);
  onProgress(file.size * 0.5, file.size);
  const info = await probe(file);
  if (!info.hasAudio) throw new LocalError("La vidéo n'a pas de piste audio : la transcription est impossible.");
  if (info.duration / 60 > MAX_MINUTES) throw new LocalError(`Vidéo de ${Math.round(info.duration / 60)} min : le mode navigateur accepte au maximum ${MAX_MINUTES} min.`);
  const thumb = await thumbnail(file, Math.min(info.duration * 0.1, 10)).catch(() => null);
  onProgress(file.size, file.size);
  p.file = file; p.probe = info; p.transcript = undefined;
  for (const c of projectClips(p.id)) clips.delete(c.id);
  p.source = {
    kind: "upload", youtube_url: null, original_filename: file.name, duration: info.duration, width: info.width, height: info.height,
    fps: info.fps, size_bytes: file.size, rights_confirmed: true, has_file: true,
    thumbnail_url: thumb ? URL.createObjectURL(thumb) : null, video_url: URL.createObjectURL(file),
  };
  p.status = "draft";
  if (p.title === "Nouveau projet") p.title = file.name.replace(/\.[^.]+$/, "");
  return projectOut(p);
}

// --------------------------------------------------------------------------- routes
const NEEDS_SERVER = "Indisponible en mode navigateur : cette fonction nécessite le serveur.";

export async function localApi(path: string, method: string, json: unknown, body: BodyInit | null | undefined): Promise<unknown> {
  await seed();
  const url = new URL(path, "http://local");
  const pth = url.pathname, q = url.searchParams;
  const b = (json ?? {}) as Record<string, unknown>;
  let m: RegExpMatchArray | null;

  if (pth === "/api/auth/me" && method === "PATCH") {
    if (b.default_subtitle_style) user.default_subtitle_style = b.default_subtitle_style;
    if (typeof b.display_name === "string") user.display_name = b.display_name;
    return user;
  }
  if (pth === "/api/auth/me") return user;
  if (pth === "/api/auth/login" || pth === "/api/auth/register") return { token: "local", user };
  if (pth === "/api/usage") {
    const used = [...projects.values()].filter((p) => !p.example && p.transcript).reduce((a, p) => a + (p.probe?.duration ?? 0) / 60, 0);
    return { ...usage, video_minutes_used: Math.round(used * 100) / 100, estimated_cost_eur: 0 };
  }
  if (pth === "/api/system/status") return system;

  if (pth === "/api/projects" && method === "GET")
    return [...projects.values()].sort((a, b2) => (a.created_at < b2.created_at ? 1 : -1)).map((p) => projectOut(p));
  if (pth === "/api/projects" && method === "POST") {
    const p: LProject = {
      id: uid(), title: (b.title as string) || "Nouveau projet", status: "awaiting_upload", language: (b.language as string) ?? "auto",
      clip_count: (b.clip_count as number) ?? 5, min_duration: (b.min_duration as number) ?? 15, max_duration: (b.max_duration as number) ?? 60,
      remove_silences: (b.remove_silences as boolean) ?? true, error: null, created_at: now(), updated_at: now(), source: null,
      has_transcript: false, transcript_provider: null, n_clips: 0, n_ready: 0, active_jobs: [],
    };
    if (p.min_duration >= p.max_duration) throw new LocalError("La durée minimale doit être inférieure à la durée maximale");
    projects.set(p.id, p);
    return projectOut(p);
  }
  if ((m = pth.match(/^\/api\/projects\/([^/]+)(\/.*)?$/))) {
    const p = projects.get(m[1]);
    if (!p) throw new LocalError("Projet introuvable");
    const rest = m[2] ?? "";
    if (!rest && method === "GET") return projectOut(p, true);
    if (!rest && method === "DELETE") {
      for (const c of projectClips(p.id)) clips.delete(c.id);
      projects.delete(p.id);
      return undefined;
    }
    if (!rest && method === "PATCH") { Object.assign(p, b); return projectOut(p); }
    if (rest === "/jobs") return jobs.filter((j) => j.project_id === p.id).map((j) => ({ ...j }));
    if (rest === "/transcript") {
      if (p.transcript?.raw) return p.transcript.raw;
      if (!p.transcript) throw new LocalError("Pas encore de transcription");
      const s = splitSentences(p.transcript.words);
      return { language: p.transcript.language, provider: p.transcript.provider, approximate: p.transcript.approximate,
        sentences: s.map(({ idx, start, end, text }) => ({ idx, start, end, text })), words: p.transcript.words, silences: null };
    }
    if (rest === "/transcript-file" && body instanceof FormData) {
      const f = body.get("file") as File;
      const words = parseSubtitles(await f.text());
      if (p.probe && words[words.length - 1].e > p.probe.duration + 2) throw new LocalError("Les horodatages des sous-titres dépassent la durée de la vidéo.");
      p.transcript = { language: p.language, provider: "subtitles", approximate: true, words };
      return { words: words.length, approximate: true };
    }
    if (rest === "/analyze") {
      if (p.example) throw new LocalError("Le projet d'exemple a été produit par le serveur : importez votre propre vidéo pour lancer une analyse.");
      if (!p.file) throw new LocalError("La vidéo n'est plus en mémoire (page rechargée ?). Réimportez-la.");
      if (b.retranscribe) p.transcript = undefined;
      p.status = "queued"; p.error = null;
      return { ...enqueue("analyze", p.id) };
    }
    throw new LocalError(NEEDS_SERVER);
  }

  if (pth === "/api/clips" && method === "GET") {
    let list = [...clips.values()].map(summary);
    const st = q.get("status");
    if (q.get("project_id")) list = list.filter((c) => c.project_id === q.get("project_id"));
    if (st) list = list.filter((c) => st.split(",").includes(c.status));
    const n = (k: string) => (q.get(k) ? Number(q.get(k)) : null);
    const [minS, minD, maxD] = [n("min_score"), n("min_duration"), n("max_duration")];
    if (minS != null) list = list.filter((c) => c.score >= minS);
    if (minD != null) list = list.filter((c) => c.duration >= minD);
    if (maxD != null) list = list.filter((c) => c.duration <= maxD);
    const sort = q.get("sort") ?? "-created_at";
    const key = sort.replace("-", "") as keyof ClipSummary;
    return list.sort((x, y) => ((x[key] as number | string) > (y[key] as number | string) ? 1 : -1) * (sort.startsWith("-") ? -1 : 1));
  }
  if ((m = pth.match(/^\/api\/clips\/([^/]+)(\/.*)?$/))) {
    const c = clips.get(m[1]);
    if (!c) throw new LocalError("Clip introuvable");
    const p = projects.get(c.project_id)!;
    const rest = m[2] ?? "";
    if (!rest && method === "GET") return { ...c, source: p.source };
    if (!rest && method === "DELETE") { clips.delete(c.id); return undefined; }
    if (rest === "/render") {
      if (p.example) throw new LocalError("Le clip d'exemple a été rendu par le serveur ; le re-rendu fonctionne sur vos propres vidéos.");
      if (!p.file) throw new LocalError("La vidéo source n'est plus en mémoire (page rechargée ?). Réimportez-la.");
      c.status = "queued"; c.error = null;
      return { ...enqueue("render", p.id, c.id) };
    }
    if (rest === "/duplicate") {
      const id = uid();
      const dup: ClipDetail = JSON.parse(JSON.stringify({ ...c, export_url: null, thumbnail_url: null, srt_url: null }));
      Object.assign(dup, { id, title: `${c.title} (copie)`, status: "draft", created_at: now(), rendered_at: null, source: p.source });
      clips.set(id, dup);
      return dup;
    }
    if (!rest && method === "PATCH") {
      let render = false;
      if (Array.isArray(b.words) && c.subtitles) { c.subtitles = { ...c.subtitles, words: cleanWords(b.words as Word[]), edited: true }; render = true; }
      if (typeof b.start === "number" || typeof b.end === "number") {
        const start = (b.start as number) ?? c.start, end = (b.end as number) ?? c.end;
        const dur = p.source?.duration ?? end;
        if (!(start >= 0 && start < end && end <= dur + 0.01)) throw new LocalError("Bornes du clip invalides");
        if (end - start < 3 || end - start > 180) throw new LocalError("Un clip doit durer entre 3 et 180 secondes");
        c.start = start; c.end = end;
        const all = p.transcript?.words ?? [];
        if (all.length && c.subtitles) {
          const edits = new Map(c.subtitles.words.map((w) => [Math.round(w.s * 100), w.w]));
          c.subtitles.words = all.filter((w) => w.s >= start - 0.01 && w.e <= end + 0.01).map((w) => ({ ...w, w: edits.get(Math.round(w.s * 100)) ?? w.w }));
        }
        render = true;
      }
      for (const k of ["title", "description"] as const) if (typeof b[k] === "string") c[k] = b[k] as string;
      if (Array.isArray(b.hashtags)) c.hashtags = (b.hashtags as string[]).map((h) => "#" + h.replace(/^#/, ""));
      if (typeof b.crop_auto === "boolean") { c.crop_auto = b.crop_auto; render = true; }
      if (typeof b.crop_x === "number") { c.crop_x = b.crop_x; if (b.crop_auto === undefined) c.crop_auto = false; render = true; }
      if (typeof b.thumbnail_time === "number") { c.thumbnail_time = b.thumbnail_time; render = true; }
      if (b.subtitle_style && c.subtitles) { c.subtitles.style = b.subtitle_style as SubtitleStyle; render = true; }
      if (b.export_settings && c.export_settings) { Object.assign(c.export_settings, b.export_settings); render = true; }
      if (render) {
        c.segments = keepSegments(c.subtitles?.words ?? [], c.start, c.end, c.export_settings?.remove_silences ?? true);
        c.duration = Math.round(c.segments.reduce((a, [s, e]) => a + e - s, 0) * 100) / 100;
        if (c.status === "ready" || c.status === "failed") c.status = "draft";
      }
      c.updated_at = now();
      return { ...c, source: p.source };
    }
    throw new LocalError(NEEDS_SERVER);
  }

  if ((m = pth.match(/^\/api\/jobs\/([^/]+)(\/.*)?$/))) {
    const j = jobs.find((x) => x.id === m![1]);
    if (!j) throw new LocalError("Tâche introuvable");
    if (m[2] === "/cancel" && (j.status === "queued" || j.status === "running")) {
      j.status = "cancelled";
      log(j, "Annulée (l'étape en cours se termine avant l'arrêt)", "warning");
    }
    if (m[2] === "/retry") return { ...enqueue(j.kind, j.project_id, j.clip_id) };
    return { ...j };
  }
  throw new LocalError(NEEDS_SERVER);
}
