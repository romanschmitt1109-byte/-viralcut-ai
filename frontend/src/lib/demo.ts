/**
 * Mode navigateur (build statique GitHub Pages, `VITE_DEMO=1`).
 * Les appels d'API sont servis par lib/local/backend.ts, qui traite réellement
 * les vidéos dans le navigateur (FFmpeg + Whisper en WebAssembly).
 */
export const DEMO = import.meta.env.VITE_DEMO === "1";

export async function demoApi(path: string, method: string, json: unknown, body?: BodyInit | null): Promise<unknown> {
  const { localApi } = await import("./local/backend");
  return localApi(path, method, json, body);
}

export async function demoUpload(projectId: string, file: File, onProgress: (l: number, t: number) => void) {
  const { localUpload } = await import("./local/backend");
  return localUpload(projectId, file, onProgress);
}
