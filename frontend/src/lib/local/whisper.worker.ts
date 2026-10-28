/// <reference lib="webworker" />
/**
 * Transcription Whisper dans le navigateur (transformers.js / ONNX Runtime Web).
 * Le modèle est téléchargé depuis Hugging Face au premier usage puis mis en cache
 * par le navigateur. L'audio est traité par fenêtres de 30 s pour une progression réelle.
 */
import { env, pipeline } from "@huggingface/transformers";

env.allowLocalModels = false;

type Word = { w: string; s: number; e: number };
type Msg = { audio: Float32Array; language: string; windows: [number, number][]; model: string };

const SR = 16000;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let asr: any = null;
let loaded = "";
let wordLevel = true;

const post = (m: unknown) => (self as unknown as Worker).postMessage(m);

async function load(model: string) {
  if (asr && loaded === model) return;
  const progress_callback = (p: { status: string; progress?: number; file?: string }) => {
    if (p.status === "progress" && p.progress != null) post({ type: "download", value: p.progress / 100, file: p.file });
  };
  try {
    asr = await pipeline("automatic-speech-recognition", `onnx-community/whisper-${model}_timestamped`, { dtype: "q8", device: "wasm", progress_callback });
    wordLevel = true;
  } catch {
    // modèle sans têtes d'alignement : horodatage par segment, mots interpolés
    asr = await pipeline("automatic-speech-recognition", `onnx-community/whisper-${model}`, { dtype: "q8", device: "wasm", progress_callback });
    wordLevel = false;
  }
  loaded = model;
}

self.onmessage = async (e: MessageEvent<Msg>) => {
  const { audio, language, windows, model } = e.data;
  try {
    await load(model);
    post({ type: "ready", wordLevel });
    const words: Word[] = [];
    const total = audio.length / SR;
    for (const [ws, we] of windows) {
      const chunk = audio.subarray(Math.floor(ws * SR), Math.floor(Math.min(total, we) * SR));
      if (chunk.length < SR * 0.3) continue;
      // fenêtres de 30 s avec recouvrement gérés par la bibliothèque (pas de mots coupés)
      const out = await asr(chunk, {
        return_timestamps: wordLevel ? "word" : true, task: "transcribe", language,
        chunk_length_s: 30, stride_length_s: 5,
      });
      for (const c of (out.chunks ?? []) as { text: string; timestamp: [number, number | null] }[]) {
        const [s, e2] = c.timestamp;
        if (s == null) continue;
        const end = e2 ?? s + 0.5;
        if (wordLevel) {
          const t = c.text.trim();
          if (t) words.push({ w: t, s: ws + s, e: ws + end });
        } else {
          const toks = c.text.trim().split(/\s+/).filter(Boolean);
          const tot = toks.reduce((a, t) => a + t.length + 1, 0);
          let t = s;
          for (const tok of toks) {
            const d = ((end - s) * (tok.length + 1)) / tot;
            words.push({ w: tok, s: ws + t, e: ws + t + d * 0.92 });
            t += d;
          }
        }
      }
      post({ type: "progress", value: Math.min(1, we / total) });
    }
    words.sort((a, b) => a.s - b.s);
    post({ type: "done", words, approximate: !wordLevel });
  } catch (err) {
    post({ type: "error", message: (err as Error).message ?? String(err) });
  }
};
