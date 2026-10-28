import { Copy, Download, Pencil, Play, Trash2, X } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { mediaUrl } from "../lib/api";
import { CLIP_STATUS, fmtTime, METHOD_LABEL } from "../lib/format";
import type { ClipSummary } from "../lib/types";
import { Badge, ScoreRing } from "./ui";

type Props = {
  clip: ClipSummary;
  showProject?: boolean;
  onDuplicate?: (c: ClipSummary) => void;
  onDelete?: (c: ClipSummary) => void;
};

export default function ClipCard({ clip, showProject, onDuplicate, onDelete }: Props) {
  const [playing, setPlaying] = useState(false);
  const st = CLIP_STATUS[clip.status] ?? CLIP_STATUS.draft;
  const video = mediaUrl(clip.export_url);
  return (
    <div className="group flex flex-col overflow-hidden rounded-2xl border border-ink-600/60 bg-ink-850 transition-colors hover:border-violet-500/40">
      <div className="relative aspect-[9/16] bg-ink-800">
        {playing && video ? (
          <>
            <video src={video} controls autoPlay playsInline className="h-full w-full bg-black object-contain" />
            <button onClick={() => setPlaying(false)} aria-label="Fermer le lecteur" className="absolute right-2 top-2 rounded-full bg-black/60 p-1.5 text-white"><X className="h-4 w-4" /></button>
          </>
        ) : (
          <>
            {clip.thumbnail_url ? (
              <img src={mediaUrl(clip.thumbnail_url)} alt="" loading="lazy" className="h-full w-full object-cover" />
            ) : (
              <div className="bg-grid h-full w-full" />
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-black/20" />
            {video && (
              <button onClick={() => setPlaying(true)} aria-label={`Lire ${clip.title}`}
                className="absolute inset-0 m-auto grid h-14 w-14 place-items-center rounded-full bg-white/15 text-white opacity-90 backdrop-blur transition hover:scale-105 hover:bg-white/25">
                <Play className="ml-0.5 h-6 w-6 fill-white" />
              </button>
            )}
            <div className="absolute left-2 top-2"><Badge cls={st.cls}>{st.label}</Badge></div>
            <span className="absolute bottom-2 right-2 rounded-md bg-black/60 px-1.5 py-0.5 text-xs tabular-nums text-white">{fmtTime(clip.duration)}</span>
          </>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-3 p-3">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="line-clamp-2 text-sm font-medium leading-snug">{clip.title}</p>
            <p className="mt-1 truncate text-xs text-mist-400">
              {showProject && clip.project_title ? `${clip.project_title} · ` : ""}{METHOD_LABEL[clip.selection_method] ?? clip.selection_method} · {fmtTime(clip.start)}
            </p>
          </div>
          <ScoreRing score={clip.score} size={40} />
        </div>
        {clip.status === "failed" && clip.error && <p className="line-clamp-2 text-xs text-rose-300">{clip.error}</p>}
        <div className="mt-auto flex items-center gap-1">
          <Link to={`/app/clips/${clip.id}`} className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-ink-700 px-2 py-1.5 text-xs hover:bg-ink-600">
            <Pencil className="h-3.5 w-3.5" /> Modifier
          </Link>
          {video && (
            <a href={`${video}${video.includes("?") ? "&" : "?"}download=1`} download aria-label="Télécharger le MP4" title="Télécharger le MP4"
              className="rounded-lg p-2 text-mist-400 hover:bg-ink-700 hover:text-mist-100"><Download className="h-3.5 w-3.5" /></a>
          )}
          {onDuplicate && (
            <button onClick={() => onDuplicate(clip)} aria-label="Dupliquer" title="Dupliquer" className="rounded-lg p-2 text-mist-400 hover:bg-ink-700 hover:text-mist-100"><Copy className="h-3.5 w-3.5" /></button>
          )}
          {onDelete && (
            <button onClick={() => onDelete(clip)} aria-label="Supprimer" title="Supprimer" className="rounded-lg p-2 text-mist-400 hover:bg-rose-500/15 hover:text-rose-300"><Trash2 className="h-3.5 w-3.5" /></button>
          )}
        </div>
      </div>
    </div>
  );
}
