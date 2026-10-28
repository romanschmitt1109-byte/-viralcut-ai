import { ArrowRight, Film, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import ClipLibrary from "../components/ClipLibrary";
import { Badge, Button, Card, Empty, ErrorBox, PageHeader, ProgressBar, Spinner } from "../components/ui";
import { api, mediaUrl } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtDate, fmtTime, PROJECT_STATUS, STEP_LABELS, usePoll } from "../lib/format";
import type { Project, Usage } from "../lib/types";

export default function Dashboard() {
  const { user } = useAuth();
  const nav = useNavigate();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, u] = await Promise.all([api<Project[]>("/api/projects"), api<Usage>("/api/usage")]);
      setProjects(p);
      setUsage(u);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  usePoll(load, !!projects?.some((p) => p.active_jobs.length > 0), 2000);

  const remove = async (p: Project) => {
    if (!confirm(`Supprimer le projet « ${p.title} », sa vidéo et tous ses clips ?`)) return;
    try { await api(`/api/projects/${p.id}`, { method: "DELETE" }); load(); } catch (e) { setError((e as Error).message); }
  };

  const totalClips = projects?.reduce((a, p) => a + p.n_clips, 0) ?? 0;
  const ready = projects?.reduce((a, p) => a + p.n_ready, 0) ?? 0;

  return (
    <div className="animate-fade-up">
      <PageHeader
        title={`Bonjour${user?.display_name ? ` ${user.display_name}` : ""}`}
        subtitle="Vos projets vidéo et les Shorts générés."
        actions={<Button icon={<Plus className="h-4 w-4" />} onClick={() => nav("/app/import")}>Nouveau projet</Button>}
      />
      {error && <div className="mb-4"><ErrorBox>{error}</ErrorBox></div>}

      <div className="mb-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Projets" value={projects?.length ?? "–"} />
        <Stat label="Clips générés" value={totalClips} />
        <Stat label="Prêts à publier" value={ready} />
        <Card className="p-4">
          <p className="text-xs text-mist-400">Minutes ce mois-ci</p>
          <p className="mt-1 text-xl font-semibold tabular-nums">{usage ? `${Math.round(usage.video_minutes_used)} / ${usage.plan.monthly_video_minutes}` : "–"}</p>
          {usage && <div className="mt-2"><ProgressBar value={(usage.video_minutes_used / usage.plan.monthly_video_minutes) * 100} /></div>}
        </Card>
      </div>

      <h2 className="mb-3 text-lg font-semibold">Projets</h2>
      {projects === null ? <Spinner /> : projects.length === 0 ? (
        <Empty icon={<Film className="h-5 w-5" />} title="Aucun projet">
          <p>Importez une vidéo dont vous détenez les droits pour commencer.</p>
          <Link to="/app/import" className="mt-3 inline-block text-violet-300 hover:text-violet-200">Importer une vidéo →</Link>
        </Empty>
      ) : (
        <div className="mb-10 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {projects.map((p) => {
            const st = PROJECT_STATUS[p.status] ?? PROJECT_STATUS.draft;
            const job = p.active_jobs.find((j) => j.kind === "analyze") ?? p.active_jobs[0];
            const renders = p.active_jobs.filter((j) => j.kind === "render").length;
            return (
              <Card key={p.id} className="flex gap-4 p-3 transition-colors hover:border-violet-500/40">
                <Link to={`/app/projects/${p.id}`} className="relative h-20 w-32 shrink-0 overflow-hidden rounded-xl bg-ink-700">
                  {p.source?.thumbnail_url && <img src={mediaUrl(p.source.thumbnail_url)} alt="" className="h-full w-full object-cover" />}
                  {p.source?.duration && <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 text-[11px] tabular-nums">{fmtTime(p.source.duration)}</span>}
                </Link>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <Link to={`/app/projects/${p.id}`} className="line-clamp-1 font-medium hover:text-violet-200">{p.title}</Link>
                    <button onClick={() => remove(p)} aria-label="Supprimer le projet" className="rounded p-1 text-mist-400 hover:text-rose-300"><Trash2 className="h-3.5 w-3.5" /></button>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-mist-400">
                    <Badge cls={st.cls}>{st.label}</Badge>
                    <span>{fmtDate(p.created_at)}</span>
                    {p.n_clips > 0 && <span>{p.n_ready}/{p.n_clips} clips prêts</span>}
                  </div>
                  {job && (
                    <div className="mt-2">
                      <div className="mb-1 flex justify-between text-[11px] text-mist-400">
                        <span>{job.kind === "render" ? `Rendu de ${renders} clip(s)` : STEP_LABELS[job.step] ?? job.step}</span>
                        <span className="tabular-nums">{Math.round(job.progress)} %</span>
                      </div>
                      <ProgressBar value={job.progress} live={job.status === "running"} />
                    </div>
                  )}
                  {!job && p.status === "ready" && (
                    <Link to={`/app/projects/${p.id}/clips`} className="mt-2 inline-flex items-center gap-1 text-xs text-violet-300 hover:text-violet-200">Voir les clips <ArrowRight className="h-3 w-3" /></Link>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <h2 className="mb-3 text-lg font-semibold">Tous les Shorts</h2>
      <ClipLibrary compact />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <Card className="p-4">
      <p className="text-xs text-mist-400">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
    </Card>
  );
}
