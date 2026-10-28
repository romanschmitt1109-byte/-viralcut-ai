/**
 * FFmpeg compilé en WebAssembly (ffmpeg.wasm), exécuté dans un Worker.
 * Le fichier source est monté en lecture (WORKERFS) : il n'est pas copié en mémoire.
 * Les opérations sont sérialisées (une seule instance FFmpeg).
 */
import { FFmpeg } from "@ffmpeg/ffmpeg";

let instance: Promise<FFmpeg> | null = null;
let chain: Promise<unknown> = Promise.resolve();
let logSink: ((line: string) => void) | null = null;
let mounted: File | null = null;

const asset = (p: string) => new URL(p, document.baseURI).href;
export const FONT_NAME = "Inter";
export const MULTI_THREAD = typeof crossOriginIsolated !== "undefined" && crossOriginIsolated && typeof SharedArrayBuffer !== "undefined";
const THREADS = String(Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 2) - 1)));

async function get(): Promise<FFmpeg> {
  instance ??= (async () => {
    const ff = new FFmpeg();
    ff.on("log", ({ message }) => { if (import.meta.env.VITE_FFDEBUG) console.log("[ff]", message); logSink?.(message); });
    // Multi-cœurs si la page est « cross-origin isolated » (service worker coi-serviceworker),
    // sinon version mono-cœur. Le multi-cœurs accélère fortement l'encodage.
    if (MULTI_THREAD) {
      await ff.load({ coreURL: asset("ffmpeg-mt/ffmpeg-core.js"), wasmURL: asset("ffmpeg-mt/ffmpeg-core.wasm"), workerURL: asset("ffmpeg-mt/ffmpeg-core.worker.js") });
    } else {
      await ff.load({ coreURL: asset("ffmpeg/ffmpeg-core.js"), wasmURL: asset("ffmpeg/ffmpeg-core.wasm") });
    }
    await ff.createDir("/fonts");
    for (const f of ["Inter-Regular.otf", "Inter-Bold.otf", "Inter-ExtraBold.otf"]) {
      const buf = new Uint8Array(await (await fetch(asset(`ffmpeg/fonts/${f}`))).arrayBuffer());
      await ff.writeFile(`/fonts/${f}`, buf);
    }
    await ff.createDir("/in");
    return ff;
  })().catch((e) => {
    instance = null;
    throw new Error(`Impossible de charger FFmpeg dans le navigateur : ${(e as Error).message ?? e}`);
  });
  return instance;
}

/** Exécute une tâche FFmpeg en exclusivité. */
function exclusive<T>(fn: (ff: FFmpeg) => Promise<T>): Promise<T> {
  const run = chain.then(async () => fn(await get()));
  chain = run.catch(() => undefined);
  return run;
}

async function mount(ff: FFmpeg, file: File): Promise<string> {
  if (mounted !== file) {
    if (mounted) await ff.unmount("/in").catch(() => undefined);
    await ff.mount("WORKERFS" as never, { files: [file] }, "/in");
    mounted = file;
  }
  return `/in/${file.name}`;
}

async function run(ff: FFmpeg, args: string[], duration?: number, onProgress?: (f: number) => void): Promise<string[]> {
  const logs: string[] = [];
  logSink = (l) => {
    logs.push(l);
    const m = l.match(/time=(\d+):(\d+):([\d.]+)/);
    if (m && duration && onProgress) onProgress(Math.min(1, (+m[1] * 3600 + +m[2] * 60 + +m[3]) / duration));
  };
  try {
    const code = await ff.exec(["-hide_banner", "-y", ...args]);
    if (code !== 0) {
      console.error("[ffmpeg]", args.join(" "), "\n" + logs.join("\n"));
      const key = logs.filter((l) => /error|invalid|no such|not found|unable|failed/i.test(l)).slice(0, 3);
      throw new Error("FFmpeg a échoué : " + (key.length ? key : logs.slice(-3)).join(" | "));
    }
  } finally {
    logSink = null;
  }
  return logs;
}

export type Probe = { duration: number; width: number; height: number; fps: number; hasAudio: boolean };

export function probe(file: File): Promise<Probe> {
  return exclusive(async (ff) => {
    const path = await mount(ff, file);
    const logs: string[] = [];
    logSink = (l) => logs.push(l);
    await ff.exec(["-hide_banner", "-i", path]).catch(() => undefined); // sort en erreur (pas de sortie), c'est voulu
    logSink = null;
    const text = logs.join("\n");
    const d = text.match(/Duration: (\d+):(\d+):([\d.]+)/);
    const v = text.match(/Stream #.*Video:.*?(\d{2,5})x(\d{2,5})/);
    if (!d || !v) throw new Error("Fichier illisible : ce n'est pas une vidéo valide ou son format n'est pas pris en charge.");
    const rot = /rotation of -?90|rotate\s*:\s*-?90|rotation of -?270/.test(text);
    const fps = Number(text.match(/(\d+(?:\.\d+)?) fps/)?.[1] ?? 30);
    const [w, h] = [Number(v[1]), Number(v[2])];
    return {
      duration: +d[1] * 3600 + +d[2] * 60 + +d[3],
      width: rot ? h : w, height: rot ? w : h, fps,
      hasAudio: /Stream #.*Audio:/.test(text),
    };
  });
}

export function thumbnail(file: File, t: number): Promise<Blob> {
  return exclusive(async (ff) => {
    const path = await mount(ff, file);
    await run(ff, ["-ss", t.toFixed(2), "-i", path, "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "4", "/thumb.jpg"]);
    const data = (await ff.readFile("/thumb.jpg")) as Uint8Array;
    await ff.deleteFile("/thumb.jpg");
    return new Blob([data.slice()], { type: "image/jpeg" });
  });
}

/** Audio mono 16 kHz en flottants, pour Whisper. */
export function extractAudio(file: File, duration: number, onProgress: (f: number) => void): Promise<Float32Array> {
  return exclusive(async (ff) => {
    const path = await mount(ff, file);
    await run(ff, ["-i", path, "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "/audio.pcm"], duration, onProgress);
    const data = (await ff.readFile("/audio.pcm")) as Uint8Array;
    await ff.deleteFile("/audio.pcm");
    return new Float32Array(data.slice(0, data.byteLength - (data.byteLength % 4)).buffer);
  });
}

export type RenderSpec = {
  file: File; srcW: number; srcH: number;
  segments: [number, number][]; cropX: number; ass: string | null;
  normalize: boolean; lufs: number; thumbAt: number; // temps SOURCE
};

/** Même graphe de filtres que backend/app/pipeline/render.py. */
export function renderShort(spec: RenderSpec, onProgress: (f: number) => void): Promise<{ mp4: Blob; thumb: Blob; duration: number }> {
  return exclusive(async (ff) => {
    const path = await mount(ff, spec.file);
    const W = 1080, H = 1920, n = spec.segments.length;
    const seek0 = Math.max(0, spec.segments[0][0]);
    const span = spec.segments[n - 1][1] - seek0 + 0.5;
    const total = spec.segments.reduce((a, [s, e]) => a + e - s, 0);
    const f: string[] = [
      `[0:v]split=${n}${spec.segments.map((_, k) => `[vs${k}]`).join("")}`,
      `[0:a]asplit=${n}${spec.segments.map((_, k) => `[as${k}]`).join("")}`,
    ];
    spec.segments.forEach(([s, e], k) => {
      f.push(`[vs${k}]trim=start=${(s - seek0).toFixed(3)}:end=${(e - seek0).toFixed(3)},setpts=PTS-STARTPTS[v${k}]`);
      f.push(`[as${k}]atrim=start=${(s - seek0).toFixed(3)}:end=${(e - seek0).toFixed(3)},asetpts=PTS-STARTPTS[a${k}]`);
    });
    f.push(`${spec.segments.map((_, k) => `[v${k}][a${k}]`).join("")}concat=n=${n}:v=1:a=1[vc][ac]`);
    let cropVf = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2`;
    if (spec.srcW / spec.srcH > W / H + 0.01) {
      const cw = Math.round((spec.srcH * W) / H / 2) * 2;
      const x = Math.round(Math.max(0, Math.min(spec.srcW - cw, spec.cropX * spec.srcW - cw / 2)));
      cropVf = `crop=${cw}:${spec.srcH}:${x}:0`;
      f.push(`[vc]crop=${cw}:${spec.srcH}:${x}:0,scale=${W}:${H},setsar=1[vf]`);
    } else {
      f.push("[vc]split[bg][fg]");
      f.push(`[bg]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=20:2,eq=brightness=-0.08[bgb]`);
      f.push(`[fg]scale=${W}:${H}:force_original_aspect_ratio=decrease[fgs]`);
      f.push("[bgb][fgs]overlay=(W-w)/2:(H-h)/2,setsar=1[vf]");
    }
    if (spec.ass) {
      await ff.writeFile("/subs.ass", new TextEncoder().encode(spec.ass));
      f.push("[vf]ass=filename=/subs.ass:fontsdir=/fonts[vout]");
    } else f.push("[vf]null[vout]");
    f.push(spec.normalize ? `[ac]loudnorm=I=${spec.lufs}:TP=-1.5:LRA=11,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[aout]` : "[ac]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[aout]");
    await run(ff, [
      "-ss", seek0.toFixed(3), "-t", span.toFixed(3), "-i", path,
      "-filter_complex", f.join(";"), "-map", "[vout]", "-map", "[aout]",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "24", "-pix_fmt", "yuv420p",
      ...(MULTI_THREAD ? ["-threads", THREADS] : []),
      "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "/out.mp4",
    ], total, onProgress);
    // Vignette prise dans la source (même recadrage) : relire /out.mp4 bloque ffmpeg.wasm.
    await run(ff, ["-ss", spec.thumbAt.toFixed(2), "-i", path, "-frames:v", "1", "-vf", `${cropVf},scale=540:960`, "-q:v", "4", "/thumb.jpg"]);
    const mp4 = (await ff.readFile("/out.mp4")) as Uint8Array;
    const th = (await ff.readFile("/thumb.jpg")) as Uint8Array;
    for (const p of ["/out.mp4", "/thumb.jpg", "/subs.ass"]) await ff.deleteFile(p).catch(() => undefined);
    return { mp4: new Blob([mp4.slice()], { type: "video/mp4" }), thumb: new Blob([th.slice()], { type: "image/jpeg" }), duration: total };
  });
}
