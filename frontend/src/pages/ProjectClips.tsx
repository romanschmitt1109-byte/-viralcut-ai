import { ArrowLeft, Check, Copy, Download, FolderDown, Pencil, Play, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import ScoreBreakdown from "../components/ScoreBreakdown";
import { Badge, Button, Card, ErrorBox, PageHeader, ProgressBar, ScoreRing, Spinner } from "../components/ui";
import { api, downloadAuthed, downloadUrl, mediaUrl } from "../lib/api";
import { CLIP_STATUS, fmtTime, METHOD_LABEL, usePoll } from "../lib/format";
import type { ClipDetail, Job, Project } from "../lib/types";

export default function ProjectClips() {
  const { id } = useParams();
  const [project, setProject] = useState<Project | null>(null);
  const [clips, setClips] = useState<ClipDetail[] | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [zipping, setZipping] = useState(false);

  const load = useCallback(async () => {
    try {
      const p = await api<Project>(`/api/projects/${id}`);
      setProject(p);
      const [details, j] = await Promise.all([
        Promise.all((p.clips ?? []).map((c) => api<ClipDetail>(`/api/clips/${c.id}`))),
        api<Job[]>(`/api/projects/${id}/jobs`),
      ]);
      setClips(details);
      setJobs(j);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);
  useEffect(() => { load(); }, [load]);
  usePoll(load, !!clips?.some((c) => c.status === "queued" || c.status === "rendering"), 2000);

  const zip = async () => {
    setZipping(true);
    try { await downloadAuthed(`/api/projects/${id}/export.zip`, `${project?.title ?? "shorts"}.zip`); }
    catch (e) { setError((e as Error).message); }
    finally { setZipping(false); }
  };
  const render = async (c: ClipDetail) => {
    try { await api(`/api/clips/${c.id}/render`, { method: "POST" }); load(); } catch (e) { setError((e as Error).message); }
  };

  if (!project || !clips) return error ? <ErrorBox>{error}</ErrorBox> : <Spinner />;
  const ready = clips.filter((c) => c.status === "ready").length;

  return (
    <div className="animate-fade-up">
      <Link to={`/app/projects/${id}`} className="mb-3 inline-flex items-center gap-1 text-sm text-mist-400 hover:text-mist-100"><ArrowLeft className="h-4 w-4" /> {project.title}</Link>
      <PageHeader
        title="Clips générés"
        subtitle={`${clips.length} clips · ${ready} prêts · classés par score estimatif`}
        actions={<Button variant="secondary" onClick={zip} loading={zipping} disabled={!ready} icon={<FolderDown className="h-4 w-4" />}>Tout exporter (.zip)</Button>}
      />
      {error && <div className="mb-4"><ErrorBox>{error}</ErrorBox></div>}
      <div className="space-y-4">
        {clips.map((c, i) => {
          const job = jobs.find((j) => j.clip_id === c.id && (j.status === "running" || j.status === "queued"));
          return <ClipRow key={c.id} clip={c} rank={i + 1} job={job} onRender={() => render(c)} />;
        })}
      </div>
    </div>
  );
}

function ClipRow({ clip, rank, job, onRender }: { clip: ClipDetail; rank: number; job?: Job; onRender: () => void }) {
  const [play, setPlay] = useState(false);
  const st = CLIP_STATUS[clip.status] ?? CLIP_STATUS.draft;
  const video = mediaUrl(clip.export_url);
  return (
    <Card className="grid gap-5 p-4 md:grid-cols-[180px_1fr_260px]">
      <div className="relative mx-auto aspect-[9/16] w-full max-w-[180px] overflow-hidden rounded-xl bg-ink-800">
        {play && video ? <video src={video} controls autoPlay playsInline className="h-full w-full bg-black object-contain" /> : (
          <>
            {clip.thumbnail_url ? <img src={mediaUrl(clip.thumbnail_url)} alt="" className="h-full w-full object-cover" /> : <div className="bg-grid h-full w-full" />}
            {video && <button onClick={() => setPlay(true)} aria-label="Lire" className="absolute inset-0 m-auto grid h-12 w-12 place-items-center rounded-full bg-white/20 backdrop-blur hover:bg-white/30"><Play className="ml-0.5 h-5 w-5 fill-white text-white" /></button>}
            <span className="absolute left-2 top-2 rounded-md bg-black/60 px-1.5 text-xs">#{rank}</span>
          </>
        )}
      </div>

      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-mist-400">
          <Badge cls={st.cls}>{st.label}</Badge>
          <span>{fmtTime(clip.duration)} · source {fmtTime(clip.start)}–{fmtTime(clip.end)}</span>
          <span>· {METHOD_LABEL[clip.selection_method] ?? clip.selection_method}</span>
        </div>
        <h3 className="text-lg font-semibold leading-snug">{clip.title}</h3>
        {job && <div><ProgressBar value={job.progress} live={job.status === "running"} /></div>}
        {clip.status === "failed" && <ErrorBox>{clip.error}</ErrorBox>}
        <Section label="Titres proposés">{clip.title_options.map((t) => <CopyLine key={t} text={t} />)}</Section>
        {clip.hooks.length > 0 && <Section label="Phrases d'accroche">{clip.hooks.map((t) => <CopyLine key={t} text={t} />)}</Section>}
        {clip.description && <Section label="Description"><CopyLine text={`${clip.description}\n\n${clip.hashtags.join(" ")}`} display={clip.description} /></Section>}
        {clip.hashtags.length > 0 && <div className="flex flex-wrap gap-1.5">{clip.hashtags.map((h) => <span key={h} className="rounded-md bg-blue-500/10 px-2 py-0.5 text-xs text-blue-200">{h}</span>)}</div>}
        <p className="text-sm text-mist-400"><span className="text-mist-300">Pourquoi ce passage :</span> {clip.reason}</p>
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <ScoreRing score={clip.score} size={52} />
          <p className="text-xs text-mist-400">Score estimatif de potentiel de rétention. Ce n'est pas une prédiction de vues.</p>
        </div>
        <ScoreBreakdown breakdown={clip.score_breakdown} />
        <div className="flex flex-wrap gap-2 pt-1">
          <Link to={`/app/clips/${clip.id}`} className="inline-flex items-center gap-1.5 rounded-lg bg-ink-700 px-3 py-1.5 text-sm hover:bg-ink-600"><Pencil className="h-3.5 w-3.5" /> Éditer</Link>
          {video && <a href={downloadUrl(clip.export_url)} download={`${clip.title.slice(0, 40)}.mp4`} className="inline-flex items-center gap-1.5 rounded-lg bg-ink-700 px-3 py-1.5 text-sm hover:bg-ink-600"><Download className="h-3.5 w-3.5" /> MP4</a>}
          {clip.srt_url && <a href={downloadUrl(clip.srt_url)} download={`${clip.title.slice(0, 40)}.srt`} className="inline-flex items-center gap-1.5 rounded-lg bg-ink-700 px-3 py-1.5 text-sm hover:bg-ink-600"><Download className="h-3.5 w-3.5" /> SRT</a>}
          {(clip.status === "draft" || clip.status === "failed") && <Button size="sm" onClick={onRender} icon={<RefreshCw className="h-3.5 w-3.5" />}>Rendre</Button>}
        </div>
      </div>
    </Card>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><p className="mb-1 text-xs font-medium uppercase tracking-wide text-mist-400">{label}</p><div className="space-y-1">{children}</div></div>;
}

function CopyLine({ text, display }: { text: string; display?: string }) {
  const [ok, setOk] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setOk(true); setTimeout(() => setOk(false), 1200); } catch { /* presse-papiers indisponible */ }
  };
  return (
    <button onClick={copy} className="group flex w-full items-start gap-2 rounded-lg px-2 py-1 text-left text-sm hover:bg-ink-700/60" title="Copier">
      <span className="flex-1">{display ?? text}</span>
      {ok ? <Check className="mt-0.5 h-3.5 w-3.5 text-emerald-300" /> : <Copy className="mt-0.5 h-3.5 w-3.5 text-mist-400 opacity-0 group-hover:opacity-100" />}
    </button>
  );
}
