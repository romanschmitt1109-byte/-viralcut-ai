import { FileVideo, Link2, Loader2, Subtitles, UploadCloud, X, MonitorPlay } from "lucide-react";
import { useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Card, cx, ErrorBox, Field, Input, Notice, PageHeader, ProgressBar, Select, Toggle } from "../components/ui";
import { api, uploadVideo } from "../lib/api";
import { DEMO } from "../lib/demo";
import { fmtBytes, fmtTime } from "../lib/format";
import type { Project, Usage } from "../lib/types";

const EXT = [".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi"];
const PRESETS = [
  { label: "15–30 s", min: 15, max: 30 },
  { label: "15–60 s", min: 15, max: 60 },
  { label: "30–90 s", min: 30, max: 90 },
];

type YtMeta = { title: string | null; author: string | null; thumbnail_url: string | null; duration: number | null };

export default function Import() {
  const nav = useNavigate();
  const [tab, setTab] = useState<"file" | "youtube">("file");
  const [file, setFile] = useState<File | null>(null);
  const [srt, setSrt] = useState<File | null>(null);
  const [drag, setDrag] = useState(false);
  const [ytUrl, setYtUrl] = useState("");
  const [yt, setYt] = useState<YtMeta | null>(null);
  const [ytLoading, setYtLoading] = useState(false);
  const [title, setTitle] = useState("");
  const [language, setLanguage] = useState(DEMO ? "fr" : "auto");
  const [count, setCount] = useState(5);
  const [minD, setMinD] = useState(15);
  const [maxD, setMaxD] = useState(60);
  const [silences, setSilences] = useState(true);
  const [rights, setRights] = useState(false);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [phase, setPhase] = useState<"idle" | "uploading" | "starting">("idle");
  const [progress, setProgress] = useState<{ loaded: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<(() => void) | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { api<Usage>("/api/usage").then(setUsage).catch(() => {}); }, []);
  const plan = usage?.plan;

  const pick = (f: File | undefined | null) => {
    setError(null);
    if (!f) return;
    const ext = f.name.slice(f.name.lastIndexOf(".")).toLowerCase();
    if (!EXT.includes(ext)) return setError(`Format non pris en charge (${ext}). Formats acceptés : ${EXT.join(", ")}`);
    if (plan && f.size > plan.max_upload_mb * 1024 * 1024) return setError(`Fichier trop volumineux (${fmtBytes(f.size)}) : limite ${plan.max_upload_mb} Mo pour votre offre.`);
    setFile(f);
    if (!title) setTitle(f.name.replace(/\.[^.]+$/, ""));
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    pick(e.dataTransfer.files?.[0]);
  };

  const lookupYt = async () => {
    setError(null);
    setYtLoading(true);
    try {
      const m = await api<YtMeta>("/api/youtube/metadata", { method: "POST", json: { url: ytUrl } });
      setYt(m);
      if (m.title && !title) setTitle(m.title);
    } catch (e) {
      setYt(null);
      setError((e as Error).message);
    } finally {
      setYtLoading(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return setError("Sélectionnez le fichier vidéo à traiter.");
    if (!rights) return setError("Confirmez que vous détenez les droits de traitement de cette vidéo.");
    setError(null);
    setPhase("uploading");
    let project: Project | null = null;
    try {
      project = await api<Project>("/api/projects", {
        method: "POST",
        json: { title: title || "Nouveau projet", language, clip_count: count, min_duration: minD, max_duration: maxD,
                remove_silences: silences, youtube_url: tab === "youtube" && yt ? ytUrl : null },
      });
      const up = uploadVideo(project.id, file, (loaded, total) => setProgress({ loaded, total }));
      abortRef.current = up.abort;
      await up.promise;
      setPhase("starting");
      if (srt) {
        const fd = new FormData();
        fd.append("file", srt);
        await api(`/api/projects/${project.id}/transcript-file`, { method: "POST", body: fd });
      }
      await api(`/api/projects/${project.id}/analyze`, { method: "POST", json: {} });
      nav(`/app/projects/${project.id}`);
    } catch (err) {
      setError((err as Error).message);
      setPhase("idle");
      setProgress(null);
      if (project) api(`/api/projects/${project.id}`, { method: "DELETE" }).catch(() => {});
    } finally {
      abortRef.current = null;
    }
  };

  const busy = phase !== "idle";
  const pct = progress ? (progress.loaded / progress.total) * 100 : 0;

  return (
    <div className="mx-auto max-w-3xl animate-fade-up">
      <PageHeader title="Importer une vidéo" subtitle="Fichier MP4, MOV, MKV ou WebM. L'IA en extraira les meilleurs passages." />
      <form onSubmit={submit} className="space-y-5">
        <Card className="p-5">
          <div className="mb-5 inline-flex rounded-xl bg-ink-800 p-1" role="tablist">
            {([["file", "Fichier", FileVideo], ["youtube", "Lien YouTube", MonitorPlay]] as const).map(([k, l, I]) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
                className={cx("inline-flex items-center gap-2 rounded-lg px-4 py-1.5 text-sm", tab === k ? "bg-ink-600 text-white" : "text-mist-400 hover:text-mist-100")}>
                <I className="h-4 w-4" /> {l}
              </button>
            ))}
          </div>

          {tab === "youtube" && (
            <div className="mb-5 space-y-3">
              <div className="flex gap-2">
                <Input placeholder="https://www.youtube.com/watch?v=…" value={ytUrl} onChange={(e) => setYtUrl(e.target.value)} disabled={busy} />
                <Button type="button" variant="secondary" onClick={lookupYt} loading={ytLoading} disabled={!ytUrl || busy} icon={<Link2 className="h-4 w-4" />}>Vérifier</Button>
              </div>
              {yt && (
                <div className="flex gap-3 rounded-xl bg-ink-800 p-3">
                  {yt.thumbnail_url && <img src={yt.thumbnail_url} alt="" className="h-16 w-28 rounded-lg object-cover" />}
                  <div className="min-w-0 text-sm">
                    <p className="line-clamp-2 font-medium">{yt.title}</p>
                    <p className="text-mist-400">{yt.author}{yt.duration ? ` · ${fmtTime(yt.duration)}` : ""}</p>
                  </div>
                </div>
              )}
              <Notice>
                ViralCut AI ne télécharge pas les vidéos depuis YouTube et ne contourne aucune protection. Importez ci-dessous le fichier original de la vidéo
                (par exemple téléchargé depuis votre YouTube Studio s'il s'agit de votre chaîne). Le lien est conservé comme référence.
              </Notice>
            </div>
          )}

          <div
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop}
            onClick={() => !busy && inputRef.current?.click()}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && inputRef.current?.click()}
            role="button" tabIndex={0} aria-label="Choisir un fichier vidéo"
            className={cx("flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-colors",
              drag ? "border-violet-400 bg-violet-500/10" : "border-ink-500 hover:border-violet-500/60 hover:bg-ink-800/50")}>
            <input ref={inputRef} type="file" accept={EXT.join(",") + ",video/*"} hidden onChange={(e) => pick(e.target.files?.[0])} />
            {file ? (
              <>
                <FileVideo className="h-8 w-8 text-violet-300" />
                <div><p className="font-medium">{file.name}</p><p className="text-sm text-mist-400">{fmtBytes(file.size)}</p></div>
                {!busy && <button type="button" onClick={(e) => { e.stopPropagation(); setFile(null); }} className="inline-flex items-center gap-1 text-xs text-mist-400 hover:text-mist-100"><X className="h-3 w-3" /> Changer de fichier</button>}
              </>
            ) : (
              <>
                <UploadCloud className="h-8 w-8 text-violet-300" />
                <div>
                  <p className="font-medium">Glissez votre vidéo ici ou cliquez pour parcourir</p>
                  <p className="text-sm text-mist-400">{plan ? `Jusqu'à ${plan.max_upload_mb >= 1024 ? `${plan.max_upload_mb / 1024} Go` : `${plan.max_upload_mb} Mo`} et ${plan.max_video_minutes} min` : " "}</p>
                </div>
              </>
            )}
          </div>
        </Card>

        <Card className="grid gap-4 p-5 sm:grid-cols-2">
          <Field label="Titre du projet"><Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} placeholder="Nom du projet" /></Field>
          <Field label="Langue de la vidéo">
            <Select value={language} onChange={(e) => setLanguage(e.target.value)}>
              {!DEMO && <option value="auto">Détection automatique</option>}<option value="fr">Français</option><option value="en">Anglais</option>
              <option value="es">Espagnol</option><option value="de">Allemand</option><option value="it">Italien</option><option value="pt">Portugais</option>
            </Select>
          </Field>
          <Field label={`Nombre de clips : ${count}`} hint={plan ? `Maximum ${plan.max_clips_per_video} avec votre offre` : undefined}>
            <input type="range" min={1} max={plan?.max_clips_per_video ?? 5} value={count} onChange={(e) => setCount(+e.target.value)} className="w-full" />
          </Field>
          <Field label="Durée des clips">
            <div className="flex flex-wrap gap-2">
              {PRESETS.map((p) => (
                <button key={p.label} type="button" onClick={() => { setMinD(p.min); setMaxD(p.max); }}
                  className={cx("rounded-lg px-3 py-1.5 text-sm ring-1", minD === p.min && maxD === p.max ? "bg-violet-500/20 text-violet-100 ring-violet-500/50" : "text-mist-300 ring-ink-500 hover:bg-ink-700")}>{p.label}</button>
              ))}
              <span className="flex items-center gap-1 text-sm text-mist-400">
                <Input type="number" min={5} max={170} value={minD} onChange={(e) => setMinD(+e.target.value)} className="w-16 px-2 py-1" aria-label="Durée minimale" />–
                <Input type="number" min={10} max={180} value={maxD} onChange={(e) => setMaxD(+e.target.value)} className="w-16 px-2 py-1" aria-label="Durée maximale" /> s
              </span>
            </div>
          </Field>
          <div className="sm:col-span-2">
            <Toggle checked={silences} onChange={setSilences} label="Retirer les silences et hésitations" hint="Coupe les pauses de plus de 0,6 s et les « euh » isolés pour dynamiser le rythme." />
          </div>
          <div className="sm:col-span-2">
            <Field label="Transcription existante (facultatif)" hint="Un fichier SRT ou VTT remplace la transcription automatique. Le calage mot à mot sera alors approximatif.">
              <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-ink-600 bg-ink-800 px-3 py-2 text-sm text-mist-300 hover:border-ink-500">
                <Subtitles className="h-4 w-4 text-mist-400" />
                <span className="flex-1 truncate">{srt ? srt.name : "Choisir un fichier .srt ou .vtt"}</span>
                {srt && <button type="button" onClick={(e) => { e.preventDefault(); setSrt(null); }} aria-label="Retirer"><X className="h-4 w-4" /></button>}
                <input type="file" accept=".srt,.vtt" hidden onChange={(e) => setSrt(e.target.files?.[0] ?? null)} />
              </label>
            </Field>
          </div>
        </Card>

        <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-ink-600/60 bg-ink-850 p-4 text-sm">
          <input type="checkbox" checked={rights} onChange={(e) => setRights(e.target.checked)} className="mt-0.5 h-4 w-4 accent-violet-500" />
          <span>Je confirme être l'auteur de cette vidéo ou disposer des autorisations nécessaires pour la découper, la modifier et la republier.</span>
        </label>

        {error && <ErrorBox>{error}</ErrorBox>}

        {busy && (
          <Card className="p-4">
            <div className="mb-2 flex justify-between text-sm">
              <span className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                {phase === "uploading" ? "Import du fichier" : "Lancement de l'analyse"}
              </span>
              {progress && <span className="tabular-nums text-mist-400">{fmtBytes(progress.loaded)} / {fmtBytes(progress.total)} · {Math.round(pct)} %</span>}
            </div>
            <ProgressBar value={phase === "starting" ? 100 : pct} live />
            {phase === "uploading" && <button type="button" onClick={() => abortRef.current?.()} className="mt-3 text-xs text-mist-400 hover:text-rose-300">Annuler l'import</button>}
          </Card>
        )}

        <div className="flex justify-end">
          <Button type="submit" loading={busy} disabled={!file || !rights}>Importer et analyser</Button>
        </div>
      </form>
    </div>
  );
}
