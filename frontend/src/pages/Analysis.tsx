import { ArrowRight, Check, ChevronDown, Circle, Loader2, RefreshCw, ScrollText, XCircle } from "lucide-react";
import LoadError from "../components/LoadError";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Badge, Button, Card, cx, ErrorBox, Notice, PageHeader, ProgressBar, Spinner } from "../components/ui";
import { api, mediaUrl } from "../lib/api";
import { fmtBytes, fmtTime, PROJECT_STATUS, STEP_LABELS, usePoll } from "../lib/format";
import type { Job, Project } from "../lib/types";

const ANALYZE_STEPS = ["extract_audio", "transcribe", "silences", "analyze", "validate", "done"];
type Transcript = { language: string; provider: string; approximate: boolean; sentences: { idx: number; start: number; end: number; text: string }[] };

export default function Analysis() {
  const { id } = useParams();
  const [project, setProject] = useState<Project | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [showTranscript, setShowTranscript] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [p, j] = await Promise.all([api<Project>(`/api/projects/${id}`), api<Job[]>(`/api/projects/${id}/jobs`)]);
      setProject(p);
      setJobs(j);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);
  useEffect(() => { load(); }, [load]);
  const active = jobs.some((j) => j.status === "queued" || j.status === "running");
  usePoll(load, active, 1200);

  useEffect(() => {
    if (showTranscript && !transcript && project?.has_transcript) {
      api<Transcript>(`/api/projects/${id}/transcript`).then(setTranscript).catch((e) => setError(e.message));
    }
  }, [showTranscript, transcript, project?.has_transcript, id]);

  if (!project) return error ? <LoadError message={error} /> : <Spinner />;

  const analyze = jobs.find((j) => j.kind === "analyze");
  const renders = jobs.filter((j) => j.kind === "render" && j.created_at >= (analyze?.created_at ?? ""));
  const latestRender = new Map<string, Job>();
  for (const j of renders) if (j.clip_id && !latestRender.has(j.clip_id)) latestRender.set(j.clip_id, j);
  const renderList = [...latestRender.values()];
  const rendersDone = renderList.filter((j) => j.status === "succeeded").length;
  const st = PROJECT_STATUS[project.status] ?? PROJECT_STATUS.draft;
  const stepIdx = analyze ? ANALYZE_STEPS.indexOf(analyze.step) : -1;

  const rerun = async (retranscribe: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/projects/${id}/analyze`, { method: "POST", json: { retranscribe } });
      setTranscript(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const cancel = async (j: Job) => { await api(`/api/jobs/${j.id}/cancel`, { method: "POST" }); load(); };

  return (
    <div className="animate-fade-up">
      <PageHeader
        title={project.title}
        subtitle={<span className="inline-flex items-center gap-2"><Badge cls={st.cls}>{st.label}</Badge>{project.source?.duration ? `Vidéo de ${fmtTime(project.source.duration)}` : ""}</span>}
        actions={project.n_clips > 0 && (
          <Link to={`/app/projects/${id}/clips`} className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-violet-600 to-indigo-600 px-4 py-2.5 text-sm font-medium text-white">
            Voir les {project.n_clips} clips <ArrowRight className="h-4 w-4" />
          </Link>
        )}
      />
      {error && <div className="mb-4"><ErrorBox>{error}</ErrorBox></div>}

      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <div className="space-y-5">
          <Card className="p-5">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="font-semibold">Analyse</h2>
              {analyze && <span className="text-sm tabular-nums text-mist-400">{Math.round(analyze.progress)} %</span>}
            </div>
            {!analyze ? (
              <div className="space-y-3">
                <p className="text-sm text-mist-400">{project.source?.has_file ? "La vidéo est prête. Lancez l'analyse pour générer les clips." : "Aucun fichier vidéo importé pour ce projet."}</p>
                {project.source?.has_file && <Button onClick={() => rerun(false)} loading={busy}>Lancer l'analyse</Button>}
              </div>
            ) : (
              <>
                <ProgressBar value={analyze.progress} live={analyze.status === "running"} />
                <ol className="mt-5 space-y-3">
                  {ANALYZE_STEPS.slice(0, -1).map((s, i) => {
                    const done = analyze.status === "succeeded" || stepIdx > i || (s === "extract_audio" && stepIdx >= 1);
                    const current = analyze.status === "running" && stepIdx === i;
                    const failed = analyze.status === "failed" && stepIdx === i;
                    return (
                      <li key={s} className="flex items-center gap-3 text-sm">
                        {failed ? <XCircle className="h-5 w-5 text-rose-400" /> : done ? <span className="grid h-5 w-5 place-items-center rounded-full bg-emerald-500/20 text-emerald-300"><Check className="h-3.5 w-3.5" /></span>
                          : current ? <Loader2 className="h-5 w-5 animate-spin text-violet-300" /> : <Circle className="h-5 w-5 text-ink-500" />}
                        <span className={cx(done ? "text-mist-100" : current ? "text-violet-200" : "text-mist-400")}>{STEP_LABELS[s]}</span>
                      </li>
                    );
                  })}
                </ol>
                {analyze.status === "queued" && <p className="mt-4 text-sm text-mist-400">En attente d'un worker disponible… {analyze.attempts > 0 && `(tentative ${analyze.attempts + 1})`}</p>}
                {analyze.status === "failed" && (
                  <div className="mt-4 space-y-3">
                    <ErrorBox>{analyze.error}</ErrorBox>
                    <div className="flex flex-wrap gap-2">
                      <Button onClick={() => rerun(false)} loading={busy} icon={<RefreshCw className="h-4 w-4" />}>Relancer</Button>
                      {project.has_transcript && <Button variant="secondary" onClick={() => rerun(true)} loading={busy}>Relancer avec nouvelle transcription</Button>}
                    </div>
                  </div>
                )}
                {analyze.status === "running" && <button onClick={() => cancel(analyze)} className="mt-4 text-xs text-mist-400 hover:text-rose-300">Annuler</button>}
                {analyze.status === "succeeded" && !active && (
                  <div className="mt-5 flex flex-wrap gap-2 border-t border-ink-700 pt-4">
                    <Button variant="secondary" size="sm" onClick={() => rerun(false)} loading={busy} icon={<RefreshCw className="h-3.5 w-3.5" />}>Régénérer les clips</Button>
                    <span className="self-center text-xs text-mist-400">Remplace les clips automatiques (les clips manuels sont conservés).</span>
                  </div>
                )}
                <button onClick={() => setShowLogs((v) => !v)} className="mt-4 inline-flex items-center gap-1 text-xs text-mist-400 hover:text-mist-100" aria-expanded={showLogs}>
                  <ChevronDown className={cx("h-3.5 w-3.5 transition-transform", showLogs && "rotate-180")} /> Journal de traitement
                </button>
                {showLogs && (
                  <pre className="mt-2 max-h-64 overflow-auto rounded-xl bg-ink-950 p-3 text-xs leading-relaxed text-mist-300">
                    {analyze.logs.filter((l) => l.level !== "debug").map((l) => `${l.t.slice(11, 19)}  ${l.level === "info" ? "" : l.level.toUpperCase() + " "}${l.msg}`).join("\n") || "—"}
                  </pre>
                )}
              </>
            )}
          </Card>

          {renderList.length > 0 && (
            <Card className="p-5">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="font-semibold">Rendu des Shorts</h2>
                <span className="text-sm text-mist-400">{rendersDone} / {renderList.length}</span>
              </div>
              <ul className="space-y-3">
                {renderList.map((j) => {
                  const clip = project.clips?.find((c) => c.id === j.clip_id);
                  return (
                    <li key={j.id} className="text-sm">
                      <div className="mb-1 flex items-center justify-between gap-3">
                        <Link to={`/app/clips/${j.clip_id}`} className="truncate hover:text-violet-200">{clip?.title ?? "Clip"}</Link>
                        <span className={cx("shrink-0 text-xs", j.status === "failed" ? "text-rose-300" : "text-mist-400")}>
                          {j.status === "succeeded" ? "Prêt" : j.status === "failed" ? "Échec" : j.status === "queued" ? "En file" : `${STEP_LABELS[j.step] ?? j.step} · ${Math.round(j.progress)} %`}
                        </span>
                      </div>
                      <ProgressBar value={j.status === "succeeded" ? 100 : j.progress} live={j.status === "running"} />
                      {j.status === "failed" && <p className="mt-1 text-xs text-rose-300">{j.error}</p>}
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}

          {project.has_transcript && (
            <Card className="p-5">
              <button onClick={() => setShowTranscript((v) => !v)} className="flex w-full items-center justify-between" aria-expanded={showTranscript}>
                <h2 className="flex items-center gap-2 font-semibold"><ScrollText className="h-4 w-4 text-mist-400" /> Transcription</h2>
                <ChevronDown className={cx("h-4 w-4 transition-transform", showTranscript && "rotate-180")} />
              </button>
              {showTranscript && (transcript ? (
                <div className="mt-4">
                  <p className="mb-3 text-xs text-mist-400">Langue : {transcript.language} · source : {transcript.provider}{transcript.approximate ? " · calage mot à mot approximatif" : ""}</p>
                  <div className="max-h-96 space-y-1.5 overflow-auto pr-2 text-sm">
                    {transcript.sentences.map((s) => (
                      <p key={s.idx}><span className="mr-2 font-mono text-xs text-mist-400">{fmtTime(s.start)}</span>{s.text}</p>
                    ))}
                  </div>
                </div>
              ) : <Spinner />)}
            </Card>
          )}
        </div>

        <Card className="h-fit overflow-hidden">
          {project.source?.thumbnail_url && <img src={mediaUrl(project.source.thumbnail_url)} alt="" className="aspect-video w-full object-cover" />}
          <dl className="space-y-2 p-4 text-sm">
            <Row k="Fichier" v={project.source?.original_filename ?? "—"} />
            <Row k="Taille" v={fmtBytes(project.source?.size_bytes)} />
            <Row k="Résolution" v={project.source?.width ? `${project.source.width}×${project.source.height}` : "—"} />
            <Row k="Durée" v={fmtTime(project.source?.duration)} />
            <Row k="Clips demandés" v={`${project.clip_count} · ${project.min_duration}–${project.max_duration} s`} />
            <Row k="Silences" v={project.remove_silences ? "retirés" : "conservés"} />
            {project.source?.youtube_url && <Row k="Référence" v={<a href={project.source.youtube_url} target="_blank" rel="noreferrer" className="text-violet-300">YouTube ↗</a>} />}
          </dl>
          {project.transcript_provider === "subtitles" && <div className="px-4 pb-4"><Notice>Transcription importée : le surlignage mot à mot est approximatif.</Notice></div>}
        </Card>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return <div className="flex justify-between gap-4"><dt className="text-mist-400">{k}</dt><dd className="truncate text-right">{v}</dd></div>;
}
