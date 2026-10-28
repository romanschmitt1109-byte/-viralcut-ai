import { Clapperboard, SlidersHorizontal } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { usePoll } from "../lib/format";
import type { ClipSummary } from "../lib/types";
import ClipCard from "./ClipCard";
import { Empty, ErrorBox, Input, Select, Spinner } from "./ui";

type Filters = { status: string; minScore: string; minDur: string; maxDur: string; from: string; to: string; sort: string };
const INITIAL: Filters = { status: "", minScore: "", minDur: "", maxDur: "", from: "", to: "", sort: "-created_at" };

export default function ClipLibrary({ projectId, limit, compact }: { projectId?: string; limit?: number; compact?: boolean }) {
  const [clips, setClips] = useState<ClipSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState<Filters>(INITIAL);
  const [open, setOpen] = useState(!compact);

  const query = useMemo(() => {
    const q = new URLSearchParams({ sort: f.sort });
    if (projectId) q.set("project_id", projectId);
    if (f.status) q.set("status", f.status);
    if (f.minScore) q.set("min_score", f.minScore);
    if (f.minDur) q.set("min_duration", f.minDur);
    if (f.maxDur) q.set("max_duration", f.maxDur);
    if (f.from) q.set("date_from", new Date(f.from).toISOString());
    if (f.to) q.set("date_to", new Date(`${f.to}T23:59:59`).toISOString());
    return q.toString();
  }, [f, projectId]);

  const load = useCallback(async () => {
    try {
      setClips(await api<ClipSummary[]>(`/api/clips?${query}`));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [query]);

  useEffect(() => { load(); }, [load]);
  usePoll(load, !!clips?.some((c) => c.status === "queued" || c.status === "rendering"), 2500);

  const duplicate = async (c: ClipSummary) => {
    try { await api(`/api/clips/${c.id}/duplicate`, { method: "POST" }); load(); } catch (e) { setError((e as Error).message); }
  };
  const remove = async (c: ClipSummary) => {
    if (!confirm(`Supprimer « ${c.title} » ? Le fichier exporté sera effacé.`)) return;
    try { await api(`/api/clips/${c.id}`, { method: "DELETE" }); load(); } catch (e) { setError((e as Error).message); }
  };

  const set = (k: keyof Filters) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));
  const shown = limit ? clips?.slice(0, limit) : clips;
  const filtered = JSON.stringify(f) !== JSON.stringify(INITIAL);

  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="text-sm text-mist-400">{clips ? `${clips.length} clip${clips.length > 1 ? "s" : ""}` : ""}</p>
        <button onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm text-mist-300 ring-1 ring-ink-600 hover:bg-ink-800" aria-expanded={open}>
          <SlidersHorizontal className="h-4 w-4" /> Filtres{filtered ? " •" : ""}
        </button>
      </div>
      {open && (
        <div className="mb-5 grid grid-cols-2 gap-3 rounded-2xl border border-ink-600/60 bg-ink-850 p-4 sm:grid-cols-4 lg:grid-cols-7">
          <label className="text-xs text-mist-400">Statut
            <Select value={f.status} onChange={set("status")} className="mt-1">
              <option value="">Tous</option><option value="ready">Prêts</option><option value="draft">À rendre</option>
              <option value="queued,rendering">En cours</option><option value="failed">Échecs</option>
            </Select>
          </label>
          <label className="text-xs text-mist-400">Score min.<Input type="number" min={0} max={100} value={f.minScore} onChange={set("minScore")} className="mt-1" placeholder="0" /></label>
          <label className="text-xs text-mist-400">Durée min. (s)<Input type="number" min={0} value={f.minDur} onChange={set("minDur")} className="mt-1" /></label>
          <label className="text-xs text-mist-400">Durée max. (s)<Input type="number" min={0} value={f.maxDur} onChange={set("maxDur")} className="mt-1" /></label>
          <label className="text-xs text-mist-400">Du<Input type="date" value={f.from} onChange={set("from")} className="mt-1" /></label>
          <label className="text-xs text-mist-400">Au<Input type="date" value={f.to} onChange={set("to")} className="mt-1" /></label>
          <label className="text-xs text-mist-400">Tri
            <Select value={f.sort} onChange={set("sort")} className="mt-1">
              <option value="-created_at">Plus récents</option><option value="-score">Meilleur score</option>
              <option value="duration">Plus courts</option><option value="-duration">Plus longs</option>
            </Select>
          </label>
        </div>
      )}
      {error && <div className="mb-4"><ErrorBox>{error}</ErrorBox></div>}
      {clips === null ? <Spinner /> : !shown?.length ? (
        <Empty icon={<Clapperboard className="h-5 w-5" />} title={filtered ? "Aucun clip ne correspond aux filtres" : "Aucun clip pour l'instant"}>
          {filtered ? "Élargissez les critères." : "Importez une vidéo pour générer vos premiers Shorts."}
        </Empty>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {shown.map((c) => <ClipCard key={c.id} clip={c} showProject={!projectId} onDuplicate={duplicate} onDelete={remove} />)}
        </div>
      )}
    </div>
  );
}
