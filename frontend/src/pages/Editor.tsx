import { ArrowLeft, Captions, Crop, Download, Image, Loader2, Save, Scissors, Send, Sparkles, Type, Wand2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import ScoreBreakdown from "../components/ScoreBreakdown";
import VerticalPreview, { type PreviewHandle } from "../components/VerticalPreview";
import { Badge, Button, Card, cx, ErrorBox, Field, Input, Notice, ProgressBar, ScoreRing, Select, Spinner, Textarea, Toggle } from "../components/ui";
import { api, mediaUrl } from "../lib/api";
import { CLIP_STATUS, fmtTime, METHOD_LABEL, STEP_LABELS, usePoll } from "../lib/format";
import type { ClipDetail, ExportSettings, Job, SubtitleStyle, SystemStatus, Word } from "../lib/types";

type Draft = {
  start: number; end: number; title: string; description: string; hashtags: string;
  crop_auto: boolean; crop_x: number; thumbnail_time: number | null;
  style: SubtitleStyle; words: Word[]; export: ExportSettings;
};

const TABS = [
  { k: "trim", label: "Découpe", icon: Scissors },
  { k: "crop", label: "Cadrage", icon: Crop },
  { k: "style", label: "Sous-titres", icon: Captions },
  { k: "text", label: "Texte", icon: Type },
  { k: "publish", label: "Publication", icon: Sparkles },
  { k: "export", label: "Export", icon: Send },
] as const;
type TabKey = (typeof TABS)[number]["k"];

function toDraft(c: ClipDetail, defaults: SubtitleStyle | null): Draft {
  return {
    start: c.start, end: c.end, title: c.title, description: c.description, hashtags: c.hashtags.join(" "),
    crop_auto: c.crop_auto, crop_x: c.crop_x ?? 0.5, thumbnail_time: c.thumbnail_time,
    style: { ...(defaults ?? ({} as SubtitleStyle)), ...(c.subtitles?.style ?? {}) } as SubtitleStyle,
    words: c.subtitles?.words ?? [],
    export: c.export_settings ?? { width: 1080, height: 1920, burn_subtitles: true, normalize_audio: true, target_lufs: -14, remove_silences: true },
  };
}

export default function Editor() {
  const { id } = useParams();
  const [clip, setClip] = useState<ClipDetail | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [sys, setSys] = useState<SystemStatus | null>(null);
  const [tab, setTab] = useState<TabKey>("trim");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const preview = useRef<PreviewHandle>(null);
  const timeRef = useRef(0);

  const loadClip = useCallback(async (resetDraft: boolean) => {
    try {
      const c = await api<ClipDetail>(`/api/clips/${id}`);
      setClip(c);
      if (resetDraft) setDraft((d) => d ?? toDraft(c, null));
      if (c.status === "queued" || c.status === "rendering") {
        const jobs = await api<Job[]>(`/api/projects/${c.project_id}/jobs`);
        setJob(jobs.find((j) => j.clip_id === c.id && (j.status === "running" || j.status === "queued")) ?? null);
      } else setJob(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    setDraft(null);
    loadClip(true);
    api<SystemStatus>("/api/system/status").then(setSys).catch(() => {});
  }, [loadClip]);
  usePoll(() => loadClip(false), clip?.status === "queued" || clip?.status === "rendering", 1500);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const setStyle = <K extends keyof SubtitleStyle>(k: K, v: SubtitleStyle[K]) => setDraft((d) => (d ? { ...d, style: { ...d.style, [k]: v } } : d));
  const setExport = <K extends keyof ExportSettings>(k: K, v: ExportSettings[K]) => setDraft((d) => (d ? { ...d, export: { ...d.export, [k]: v } } : d));

  const boundsChanged = !!clip && !!draft && (Math.abs(draft.start - clip.start) > 0.001 || Math.abs(draft.end - clip.end) > 0.001);
  const segments = useMemo<[number, number][]>(() => {
    if (!clip || !draft) return [];
    if (!boundsChanged && clip.segments.length) return clip.segments;
    return [[draft.start, draft.end]];
  }, [clip, draft?.start, draft?.end, boundsChanged]); // eslint-disable-line react-hooks/exhaustive-deps
  const previewWords = useMemo(() => draft?.words.filter((w) => w.s >= (draft?.start ?? 0) - 0.01 && w.e <= (draft?.end ?? 0) + 0.01) ?? [], [draft?.words, draft?.start, draft?.end]);
  const onTime = useCallback((t: number) => { timeRef.current = t; }, []);

  const dirty = useMemo(() => {
    if (!clip || !draft) return false;
    return JSON.stringify(toDraft(clip, null)) !== JSON.stringify({ ...draft, style: { ...draft.style } });
  }, [clip, draft]);

  const save = async (): Promise<boolean> => {
    if (!clip || !draft) return false;
    setSaving(true);
    setError(null);
    try {
      const orig = toDraft(clip, null);
      const body: Record<string, unknown> = {};
      if (boundsChanged) { body.start = draft.start; body.end = draft.end; }
      if (draft.title !== orig.title) body.title = draft.title;
      if (draft.description !== orig.description) body.description = draft.description;
      if (draft.hashtags !== orig.hashtags) body.hashtags = draft.hashtags.split(/[\s,]+/).filter(Boolean);
      if (draft.crop_auto !== orig.crop_auto || draft.crop_x !== orig.crop_x) {
        body.crop_auto = draft.crop_auto;
        if (!draft.crop_auto) body.crop_x = draft.crop_x;
      }
      if (draft.thumbnail_time !== orig.thumbnail_time && draft.thumbnail_time != null) body.thumbnail_time = draft.thumbnail_time;
      if (JSON.stringify(draft.style) !== JSON.stringify(orig.style)) body.subtitle_style = draft.style;
      if (JSON.stringify(draft.words) !== JSON.stringify(orig.words)) body.words = draft.words;
      if (JSON.stringify(draft.export) !== JSON.stringify(orig.export)) {
        const { burn_subtitles, normalize_audio, target_lufs, remove_silences } = draft.export;
        body.export_settings = { burn_subtitles, normalize_audio, target_lufs, remove_silences };
      }
      const c = await api<ClipDetail>(`/api/clips/${clip.id}`, { method: "PATCH", json: body });
      setClip(c);
      setDraft(toDraft(c, null));
      setSaved("Modifications enregistrées");
      setTimeout(() => setSaved(null), 2000);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const renderNow = async () => {
    if (dirty && !(await save())) return;
    try {
      const j = await api<Job>(`/api/clips/${id}/render`, { method: "POST" });
      setJob(j);
      await loadClip(false);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const saveDefaultStyle = async () => {
    if (!draft) return;
    try {
      const { keywords: _k, ...rest } = draft.style;
      void _k;
      await api("/api/auth/me", { method: "PATCH", json: { default_subtitle_style: rest } });
      setSaved("Style enregistré par défaut pour les prochains clips");
      setTimeout(() => setSaved(null), 2500);
    } catch (e) { setError((e as Error).message); }
  };

  if (!clip || !draft) return error ? <ErrorBox>{error}</ErrorBox> : <Spinner />;
  const src = clip.source;
  const st = CLIP_STATUS[clip.status] ?? CLIP_STATUS.draft;
  const rendering = clip.status === "queued" || clip.status === "rendering";
  const fonts = sys?.fonts?.length ? sys.fonts : [draft.style.font];
  const maxT = src?.duration ?? draft.end + 30;

  return (
    <div className="animate-fade-up">
      <Link to={`/app/projects/${clip.project_id}/clips`} className="mb-3 inline-flex items-center gap-1 text-sm text-mist-400 hover:text-mist-100"><ArrowLeft className="h-4 w-4" /> {clip.project_title}</Link>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold">{draft.title || "Sans titre"}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-mist-400">
            <Badge cls={st.cls}>{st.label}</Badge>
            <span>{fmtTime(segments.reduce((a, [s, e]) => a + e - s, 0))} · {METHOD_LABEL[clip.selection_method] ?? clip.selection_method}</span>
            {dirty && <span className="text-amber-300">• modifications non enregistrées</span>}
            {saved && <span className="text-emerald-300">{saved}</span>}
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={save} loading={saving} disabled={!dirty} icon={<Save className="h-4 w-4" />}>Enregistrer</Button>
          <Button onClick={renderNow} loading={rendering} icon={<Wand2 className="h-4 w-4" />}>{clip.export_url ? "Rendre à nouveau" : "Rendre le Short"}</Button>
        </div>
      </div>
      {error && <div className="mb-4"><ErrorBox>{error}</ErrorBox></div>}
      {rendering && (
        <Card className="mb-5 p-4">
          <div className="mb-2 flex justify-between text-sm">
            <span className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />{job ? STEP_LABELS[job.step] ?? job.step : "En file d'attente"}</span>
            <span className="tabular-nums text-mist-400">{Math.round(job?.progress ?? 0)} %</span>
          </div>
          <ProgressBar value={job?.progress ?? 0} live />
        </Card>
      )}
      {clip.status === "failed" && clip.error && <div className="mb-5"><ErrorBox>Le dernier rendu a échoué : {clip.error}</ErrorBox></div>}

      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <div className="lg:sticky lg:top-6 lg:self-start">
          {src?.video_url && src.width && src.height ? (
            <VerticalPreview
              ref={preview} src={mediaUrl(src.video_url)!} srcW={src.width} srcH={src.height}
              segments={segments} words={previewWords} style={draft.style} showSubtitles={draft.export.burn_subtitles}
              cropX={draft.crop_auto ? null : draft.crop_x} cropShots={clip.crop_shots} onTime={onTime}
            />
          ) : <Notice>Vidéo source indisponible.</Notice>}
          <p className="mx-auto mt-2 max-w-[300px] text-center text-xs text-mist-400">Aperçu en direct depuis la source. Le fichier final est produit par le rendu.</p>
        </div>

        <div className="min-w-0">
          <div className="mb-4 flex gap-1 overflow-x-auto rounded-xl bg-ink-850 p-1" role="tablist">
            {TABS.map(({ k, label, icon: I }) => (
              <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
                className={cx("inline-flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm", tab === k ? "bg-ink-600 text-white" : "text-mist-400 hover:text-mist-100")}>
                <I className="h-4 w-4" /> {label}
              </button>
            ))}
          </div>

          <Card className="p-5">
            {tab === "trim" && (
              <div className="space-y-5">
                <div className="grid gap-4 sm:grid-cols-2">
                  {(["start", "end"] as const).map((k) => (
                    <Field key={k} label={k === "start" ? "Début (source)" : "Fin (source)"} hint={fmtTime(draft[k], true)}>
                      <div className="flex gap-1.5">
                        <Button size="sm" variant="secondary" onClick={() => set(k, Math.max(0, +(draft[k] - 0.5).toFixed(2)))} aria-label="−0,5 s">−0,5</Button>
                        <Input type="number" step={0.1} min={0} max={maxT} value={+draft[k].toFixed(2)} onChange={(e) => set(k, +e.target.value)} />
                        <Button size="sm" variant="secondary" onClick={() => set(k, Math.min(maxT, +(draft[k] + 0.5).toFixed(2)))} aria-label="+0,5 s">+0,5</Button>
                      </div>
                      <button type="button" onClick={() => set(k, +timeRef.current.toFixed(2))} className="mt-1.5 text-xs text-violet-300 hover:text-violet-200">
                        Utiliser la position de lecture
                      </button>
                    </Field>
                  ))}
                </div>
                <Timeline start={draft.start} end={draft.end} segments={segments} />
                {boundsChanged && <Notice>Enregistrez pour resynchroniser les sous-titres et recalculer les coupes de silences.</Notice>}
                <Toggle checked={draft.export.remove_silences} onChange={(v) => setExport("remove_silences", v)} label="Retirer les silences et hésitations" hint="Pauses > 0,6 s et « euh » isolés." />
              </div>
            )}

            {tab === "crop" && (
              <div className="space-y-5">
                <Toggle checked={draft.crop_auto} onChange={(v) => set("crop_auto", v)} label="Recadrage automatique"
                  hint="Suit le visage du locuteur ; le cadre ne bouge que lors d'un déplacement net et durable." />
                {draft.crop_auto ? (
                  <p className="text-sm text-mist-400">{clip.crop_shots ? `${clip.crop_shots.length} plan(s) calculé(s) lors du dernier rendu.` : "Le cadrage sera calculé lors du rendu."}</p>
                ) : (
                  <Field label={`Position horizontale : ${Math.round(draft.crop_x * 100)} %`}>
                    <input type="range" min={0} max={1} step={0.005} value={draft.crop_x} onChange={(e) => set("crop_x", +e.target.value)} className="w-full" />
                  </Field>
                )}
                {src && src.width && src.height && src.width / src.height <= 9 / 16 + 0.01 && (
                  <Notice>La source est déjà verticale : elle est centrée sur un fond flouté, sans recadrage.</Notice>
                )}
              </div>
            )}

            {tab === "style" && (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Police">
                  <Select value={draft.style.font} onChange={(e) => setStyle("font", e.target.value)}>
                    {[...new Set([draft.style.font, ...fonts])].map((f) => <option key={f}>{f}</option>)}
                  </Select>
                </Field>
                <Field label={`Taille : ${draft.style.size}`}>
                  <input type="range" min={40} max={140} value={draft.style.size} onChange={(e) => setStyle("size", +e.target.value)} className="w-full" />
                </Field>
                <Field label="Affichage">
                  <Select value={draft.style.mode} onChange={(e) => setStyle("mode", e.target.value as SubtitleStyle["mode"])}>
                    <option value="group">Par groupe de mots</option><option value="word">Mot par mot</option>
                  </Select>
                </Field>
                {draft.style.mode === "group" && (
                  <Field label={`Mots par groupe : ${draft.style.group_size}`}>
                    <input type="range" min={2} max={6} value={draft.style.group_size} onChange={(e) => setStyle("group_size", +e.target.value)} className="w-full" />
                  </Field>
                )}
                <Field label={`Position verticale : ${Math.round(draft.style.position * 100)} %`}>
                  <input type="range" min={0.1} max={0.9} step={0.01} value={draft.style.position} onChange={(e) => setStyle("position", +e.target.value)} className="w-full" />
                </Field>
                <Field label={`Contour : ${draft.style.outline}`}>
                  <input type="range" min={0} max={14} step={0.5} value={draft.style.outline} onChange={(e) => setStyle("outline", +e.target.value)} className="w-full" />
                </Field>
                <div className="grid grid-cols-4 gap-3 sm:col-span-2">
                  {([["text_color", "Texte"], ["highlight_color", "Mot actif"], ["keyword_color", "Mots-clés"], ["outline_color", "Contour"]] as const).map(([k, l]) => (
                    <label key={k} className="text-xs text-mist-400">{l}
                      <input type="color" value={draft.style[k]} onChange={(e) => setStyle(k, e.target.value.toUpperCase())} className="mt-1 block h-9 w-full cursor-pointer rounded-lg border border-ink-600 bg-ink-800" />
                    </label>
                  ))}
                </div>
                <div className="sm:col-span-2">
                  <Field label="Mots-clés mis en évidence" hint="Séparés par des virgules. Ils apparaissent dans la couleur « Mots-clés ».">
                    <Input value={draft.style.keywords.join(", ")} onChange={(e) => setStyle("keywords", e.target.value.split(",").map((s) => s.trim()).filter(Boolean))} />
                  </Field>
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <Toggle checked={draft.style.uppercase} onChange={(v) => setStyle("uppercase", v)} label="Majuscules" />
                  <Toggle checked={draft.style.bold} onChange={(v) => setStyle("bold", v)} label="Gras" />
                  <Toggle checked={draft.style.highlight_active} onChange={(v) => setStyle("highlight_active", v)} label="Surligner le mot prononcé" />
                </div>
                <div className="sm:col-span-2"><Button size="sm" variant="ghost" onClick={saveDefaultStyle}>Utiliser ce style par défaut</Button></div>
              </div>
            )}

            {tab === "text" && (
              <div>
                <p className="mb-3 text-sm text-mist-400">Corrigez la transcription : cliquez sur un mot pour le modifier. Les horodatages sont conservés.</p>
                <WordEditor words={draft.words} start={draft.start} end={draft.end} onChange={(w) => set("words", w)} onSeek={(t) => preview.current?.seekSource(t)} />
              </div>
            )}

            {tab === "publish" && (
              <div className="space-y-5">
                <Field label="Titre">
                  <Input value={draft.title} maxLength={100} onChange={(e) => set("title", e.target.value)} />
                </Field>
                {clip.title_options.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {clip.title_options.map((t) => (
                      <button key={t} onClick={() => set("title", t)} className={cx("rounded-lg px-3 py-1.5 text-left text-sm ring-1", draft.title === t ? "bg-violet-500/15 ring-violet-500/50" : "ring-ink-500 hover:bg-ink-700")}>{t}</button>
                    ))}
                  </div>
                )}
                {clip.hooks.length > 0 && (
                  <div>
                    <p className="mb-1.5 text-sm font-medium text-mist-300">Phrases d'accroche</p>
                    <ul className="space-y-1 text-sm text-mist-300">{clip.hooks.map((h) => <li key={h} className="rounded-lg bg-ink-800 px-3 py-2">{h}</li>)}</ul>
                  </div>
                )}
                <Field label="Description"><Textarea value={draft.description} onChange={(e) => set("description", e.target.value)} rows={3} /></Field>
                <Field label="Hashtags" hint="Séparés par des espaces. Restez pertinent : 3 à 6 suffisent."><Input value={draft.hashtags} onChange={(e) => set("hashtags", e.target.value)} /></Field>
                <div className="flex flex-wrap items-center gap-3">
                  <Button size="sm" variant="secondary" icon={<Image className="h-4 w-4" />}
                    onClick={() => set("thumbnail_time", Math.min(draft.end, Math.max(draft.start, +timeRef.current.toFixed(2))))}>
                    Miniature = image actuelle
                  </Button>
                  <span className="text-xs text-mist-400">Moment choisi : {fmtTime(draft.thumbnail_time, true)}</span>
                  {clip.thumbnail_url && <img src={mediaUrl(clip.thumbnail_url)} alt="Miniature suggérée" className="h-20 rounded-lg" />}
                </div>
                <div className="rounded-xl bg-ink-800 p-4">
                  <div className="mb-3 flex items-center gap-3"><ScoreRing score={clip.score} /><p className="text-xs text-mist-400">{clip.score_disclaimer}</p></div>
                  <ScoreBreakdown breakdown={clip.score_breakdown} />
                  <p className="mt-3 text-sm text-mist-300">{clip.reason}</p>
                </div>
              </div>
            )}

            {tab === "export" && (
              <div className="space-y-5">
                <div className="space-y-1">
                  <Toggle checked={draft.export.burn_subtitles} onChange={(v) => setExport("burn_subtitles", v)} label="Incruster les sous-titres" hint="Sinon, un fichier SRT séparé est fourni (toujours disponible)." />
                  <Toggle checked={draft.export.normalize_audio} onChange={(v) => setExport("normalize_audio", v)} label="Normaliser le volume" hint={`Cible ${draft.export.target_lufs} LUFS (EBU R128)`} />
                  <Toggle checked={draft.export.remove_silences} onChange={(v) => setExport("remove_silences", v)} label="Retirer les silences" />
                </div>
                <p className="text-sm text-mist-400">Format : MP4 H.264 / AAC, {draft.export.width}×{draft.export.height}, 9:16.</p>
                {clip.export_url ? (
                  <div className="grid gap-4 sm:grid-cols-[200px_1fr]">
                    <video src={mediaUrl(clip.export_url)} controls playsInline className="aspect-[9/16] w-full rounded-xl bg-black" />
                    <div className="space-y-2">
                      <p className="text-sm">Dernier rendu : {clip.rendered_at ? new Date(clip.rendered_at).toLocaleString("fr-FR") : "—"}</p>
                      {clip.status === "draft" && <p className="text-sm text-amber-300">Le clip a été modifié depuis ce rendu.</p>}
                      <div className="flex flex-wrap gap-2">
                        <a href={`${mediaUrl(clip.export_url)}${clip.export_url.includes("?") ? "&" : "?"}download=1`} className="inline-flex items-center gap-2 rounded-xl bg-ink-700 px-4 py-2 text-sm hover:bg-ink-600"><Download className="h-4 w-4" /> MP4</a>
                        {clip.srt_url && <a href={`${mediaUrl(clip.srt_url)}${clip.srt_url.includes("?") ? "&" : "?"}download=1`} className="inline-flex items-center gap-2 rounded-xl bg-ink-700 px-4 py-2 text-sm hover:bg-ink-600"><Download className="h-4 w-4" /> SRT</a>}
                      </div>
                    </div>
                  </div>
                ) : <Notice>Aucun rendu pour l'instant. Cliquez sur « Rendre le Short ».</Notice>}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function Timeline({ start, end, segments }: { start: number; end: number; segments: [number, number][] }) {
  const span = Math.max(0.1, end - start);
  return (
    <div>
      <div className="relative h-8 overflow-hidden rounded-lg bg-ink-700" aria-label="Portions conservées">
        {segments.map(([s, e], i) => (
          <div key={i} className="absolute inset-y-0 bg-gradient-to-b from-violet-500/70 to-indigo-600/70"
            style={{ left: `${((s - start) / span) * 100}%`, width: `${((e - s) / span) * 100}%` }} />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-xs text-mist-400">
        <span>{fmtTime(start, true)}</span>
        <span>{segments.length > 1 ? `${segments.length - 1} coupe(s)` : "aucune coupe"}</span>
        <span>{fmtTime(end, true)}</span>
      </div>
    </div>
  );
}

function WordEditor({ words, start, end, onChange, onSeek }: { words: Word[]; start: number; end: number; onChange: (w: Word[]) => void; onSeek: (t: number) => void }) {
  const [editing, setEditing] = useState<number | null>(null);
  return (
    <div className="flex max-h-[420px] flex-wrap gap-x-1 gap-y-1.5 overflow-auto rounded-xl bg-ink-800 p-3 text-[15px] leading-relaxed">
      {words.map((w, i) => {
        const outside = w.s < start - 0.01 || w.e > end + 0.01;
        return editing === i ? (
          <input key={i} autoFocus defaultValue={w.w} size={Math.max(2, w.w.length)}
            onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== w.w) onChange(words.map((x, j) => (j === i ? { ...x, w: v } : x))); setEditing(null); }}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setEditing(null); }}
            className="rounded bg-ink-950 px-1 text-violet-200 outline-none ring-1 ring-violet-500" />
        ) : (
          <button key={i} onClick={() => { setEditing(i); onSeek(w.s); }} title={`${fmtTime(w.s, true)}`}
            className={cx("rounded px-0.5 hover:bg-violet-500/20", outside && "opacity-40")}>{w.w}</button>
        );
      })}
    </div>
  );
}
