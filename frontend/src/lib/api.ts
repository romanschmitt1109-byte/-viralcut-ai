const BASE = import.meta.env.VITE_API_URL ?? "";
const TOKEN_KEY = "viralcut.token";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* stockage indisponible : session non persistée */
  }
}

/** URL absolue pour les médias renvoyés par l'API (chemins relatifs signés ou URL S3). */
export function mediaUrl(u: string | null | undefined): string | undefined {
  if (!u) return undefined;
  return u.startsWith("http") ? u : `${BASE}${u}`;
}

function detail(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "detail" in body) {
    const d = (body as { detail: unknown }).detail;
    if (typeof d === "string") return d;
    if (Array.isArray(d) && d[0]?.msg) return d.map((x) => String(x.msg).replace(/^Value error, /, "")).join(" · ");
  }
  return fallback;
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.json);
  }
  const res = await fetch(`${BASE}${path}`, { ...init, headers, body });
  if (res.status === 401 && token) {
    setToken(null);
    window.dispatchEvent(new Event("viralcut:logout"));
  }
  if (!res.ok) {
    let b: unknown = null;
    try {
      b = await res.json();
    } catch {
      /* corps non JSON */
    }
    throw new ApiError(res.status, detail(b, `Erreur ${res.status}`));
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

/** Import en flux avec progression réelle (XHR expose l'avancement de l'envoi). */
export function uploadVideo(
  projectId: string,
  file: File,
  onProgress: (loaded: number, total: number) => void,
): { promise: Promise<unknown>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const params = new URLSearchParams({ filename: file.name, rights_confirmed: "true" });
  const promise = new Promise((resolve, reject) => {
    xhr.open("PUT", `${BASE}/api/projects/${projectId}/upload?${params}`);
    const token = getToken();
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded, e.total);
    xhr.onload = () => {
      let b: unknown = null;
      try {
        b = JSON.parse(xhr.responseText);
      } catch {
        /* */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(b);
      else reject(new ApiError(xhr.status, detail(b, `Échec de l'import (${xhr.status})`)));
    };
    xhr.onerror = () => reject(new ApiError(0, "Connexion interrompue pendant l'import"));
    xhr.onabort = () => reject(new ApiError(0, "Import annulé"));
    xhr.send(file);
  });
  return { promise, abort: () => xhr.abort() };
}

export async function downloadAuthed(path: string, filename: string) {
  const token = getToken();
  const res = await fetch(`${BASE}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) {
    let b: unknown = null;
    try {
      b = await res.json();
    } catch {
      /* */
    }
    throw new ApiError(res.status, detail(b, "Téléchargement impossible"));
  }
  const blob = await res.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
