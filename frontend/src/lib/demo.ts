/**
 * Mode démonstration (build statique pour GitHub Pages, `VITE_DEMO=1`).
 *
 * Aucune donnée n'est inventée : `public/demo/demo.json` et les vidéos sont
 * produits par le vrai pipeline (scripts/build_demo.py). Sans serveur, seules
 * la consultation et l'édition locale fonctionnent ; l'import, l'analyse et le
 * rendu renvoient une erreur explicite.
 */
import type { ClipDetail, ClipSummary } from "./types";

export const DEMO = import.meta.env.VITE_DEMO === "1";

type DemoData = {
  user: Record<string, unknown>;
  usage: unknown;
  system: unknown;
  project: { id: string; clips: ClipSummary[] } & Record<string, unknown>;
  clips: ClipDetail[];
  jobs: unknown[];
  transcript: unknown;
};

let data: Promise<DemoData> | null = null;
const load = (): Promise<DemoData> => (data ??= fetch("demo/demo.json").then((r) => r.json() as Promise<DemoData>));

export class DemoUnavailable extends Error {
  status = 501;
}

const NEEDS_SERVER = "Indisponible dans la démonstration : cette action nécessite le serveur (import, analyse, rendu).";

function summary(c: ClipDetail): ClipSummary {
  const { id, project_id, project_title, start, end, duration, source_duration, title, score, status, selection_method,
    error, created_at, updated_at, rendered_at, export_url, thumbnail_url, srt_url } = c;
  return { id, project_id, project_title, start, end, duration, source_duration, title, score, status, selection_method,
    error, created_at, updated_at, rendered_at, export_url, thumbnail_url, srt_url };
}

export async function demoApi(path: string, method: string, body: unknown): Promise<unknown> {
  const d = await load();
  const url = new URL(path, "http://demo");
  const p = url.pathname;
  const q = url.searchParams;
  const clipM = p.match(/^\/api\/clips\/([^/]+)$/);

  if (p === "/api/auth/me" && method === "PATCH") return Object.assign(d.user, body);
  if (p === "/api/auth/me") return d.user;
  if (p === "/api/auth/login" || p === "/api/auth/register") return { token: "demo", user: d.user };
  if (p === "/api/usage") return d.usage;
  if (p === "/api/system/status") return d.system;
  if (method === "GET") {
    if (p === "/api/projects") return [{ ...d.project, clips: undefined }];
    if (p === `/api/projects/${d.project.id}`) return { ...d.project, clips: d.clips.map(summary) };
    if (p === `/api/projects/${d.project.id}/jobs`) return d.jobs;
    if (p === `/api/projects/${d.project.id}/transcript`) return d.transcript;
    if (p === "/api/clips") {
      let list = d.clips.map(summary);
      const st = q.get("status");
      if (st) list = list.filter((c) => st.split(",").includes(c.status));
      const n = (k: string) => (q.get(k) ? Number(q.get(k)) : null);
      const [minS, minD, maxD] = [n("min_score"), n("min_duration"), n("max_duration")];
      if (minS != null) list = list.filter((c) => c.score >= minS);
      if (minD != null) list = list.filter((c) => c.duration >= minD);
      if (maxD != null) list = list.filter((c) => c.duration <= maxD);
      const sort = q.get("sort") ?? "-created_at";
      const key = sort.replace("-", "") as keyof ClipSummary;
      list.sort((a, b) => ((a[key] as number | string) > (b[key] as number | string) ? 1 : -1) * (sort.startsWith("-") ? -1 : 1));
      return list;
    }
    if (clipM) {
      const c = d.clips.find((x) => x.id === clipM[1]);
      if (c) return c;
    }
  }
  if (clipM && method === "PATCH") {
    // édition locale (non enregistrée sur un serveur) pour essayer l'éditeur
    const c = d.clips.find((x) => x.id === clipM[1]);
    if (!c) throw new DemoUnavailable("Clip introuvable");
    const b = body as Record<string, unknown>;
    if (typeof b.start === "number") c.start = b.start;
    if (typeof b.end === "number") c.end = b.end;
    if (typeof b.title === "string") c.title = b.title;
    if (typeof b.description === "string") c.description = b.description;
    if (Array.isArray(b.hashtags)) c.hashtags = (b.hashtags as string[]).map((h) => "#" + h.replace(/^#/, ""));
    if (typeof b.crop_auto === "boolean") c.crop_auto = b.crop_auto;
    if (typeof b.crop_x === "number") c.crop_x = b.crop_x;
    if (typeof b.thumbnail_time === "number") c.thumbnail_time = b.thumbnail_time;
    if (b.subtitle_style && c.subtitles) c.subtitles.style = b.subtitle_style as never;
    if (Array.isArray(b.words) && c.subtitles) c.subtitles = { ...c.subtitles, words: b.words as never, edited: true };
    if (b.export_settings && c.export_settings) Object.assign(c.export_settings, b.export_settings);
    if (b.start !== undefined || b.end !== undefined) c.segments = [[c.start, c.end]];
    c.status = "draft";
    return c;
  }
  throw new DemoUnavailable(NEEDS_SERVER);
}
