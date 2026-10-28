import { Pause, Play, Volume2, VolumeX } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { fmtTime } from "../lib/format";
import { captionAt, captionStyle, groupWords, norm } from "../lib/subtitles";
import type { SubtitleStyle, Word } from "../lib/types";

type Props = {
  src: string;
  srcW: number;
  srcH: number;
  segments: [number, number][]; // temps source conservés
  words: Word[]; // temps source
  style: SubtitleStyle;
  showSubtitles: boolean;
  cropX: number | null; // null = automatique
  cropShots: [number, number][] | null; // [t_clip, cx]
  onTime?: (sourceTime: number) => void;
};

export type PreviewHandle = { seekSource: (t: number) => void; currentSource: () => number };

/** Aperçu vertical en temps réel : recadrage, coupes et sous-titres simulés dans le
 * navigateur à partir de la vidéo source (aucun rendu nécessaire). */
const VerticalPreview = forwardRef<PreviewHandle, Props>(function VerticalPreview(
  { src, srcW, srcH, segments, words, style, showSubtitles, cropX, cropShots, onTime }, ref,
) {
  const box = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [size, setSize] = useState({ w: 270, h: 480 });
  const [t, setT] = useState(segments[0]?.[0] ?? 0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [ready, setReady] = useState(false);
  const lastRef = useRef(-1);

  const total = useMemo(() => segments.reduce((a, [s, e]) => a + e - s, 0), [segments]);
  const toClip = (st: number) => {
    let off = 0;
    for (const [s, e] of segments) {
      if (st < s) return off;
      if (st < e) return off + st - s;
      off += e - s;
    }
    return total;
  };
  const toSource = (ct: number) => {
    let off = 0;
    for (const [s, e] of segments) {
      if (ct < off + e - s) return s + ct - off;
      off += e - s;
    }
    return segments[segments.length - 1]?.[1] ?? 0;
  };

  useImperativeHandle(ref, () => ({
    seekSource: (st: number) => { if (video.current) video.current.currentTime = st; setT(st); },
    currentSource: () => video.current?.currentTime ?? t,
  }));

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // remet la tête de lecture au début quand les segments changent
  useEffect(() => {
    if (video.current && segments[0]) {
      const cur = video.current.currentTime;
      if (cur < segments[0][0] || cur > segments[segments.length - 1][1]) video.current.currentTime = segments[0][0];
    }
  }, [segments]);

  // boucle de lecture : saute les portions retirées, reboucle en fin de clip
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const v = video.current;
      if (v && segments.length) {
        const cur = v.currentTime;
        const seg = segments.find(([s, e]) => cur >= s - 0.02 && cur < e);
        if (!seg) {
          const next = segments.find(([s]) => s > cur);
          if (next) v.currentTime = next[0];
          else { v.currentTime = segments[0][0]; }
        }
        if (Math.abs(v.currentTime - lastRef.current) > 0.04) {
          lastRef.current = v.currentTime;
          setT(v.currentTime);
          onTime?.(v.currentTime);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [segments, onTime]);

  const toggle = () => {
    const v = video.current;
    if (!v) return;
    if (v.paused) v.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    else { v.pause(); setPlaying(false); }
  };

  const clipT = toClip(t);
  // centre horizontal du recadrage
  let cx = cropX ?? 0.5;
  if (cropX == null && cropShots?.length) {
    for (const [st, c] of cropShots) if (clipT >= st) cx = c;
  }
  const landscape = srcW / srcH > 9 / 16 + 0.01;
  const scaledW = (srcW * size.h) / srcH;
  const left = Math.max(0, Math.min(scaledW - size.w, cx * scaledW - size.w / 2));

  const groups = useMemo(() => groupWords(words, style.mode === "word" ? 1 : style.group_size), [words, style.mode, style.group_size]);
  const cap = showSubtitles ? captionAt(groups, t) : null;
  const kw = new Set(style.keywords.map(norm));
  const multi = style.mode === "group" && style.group_size > 1;

  return (
    <div className="space-y-3">
      <div ref={box} className="relative mx-auto aspect-[9/16] w-full max-w-[300px] overflow-hidden rounded-2xl bg-black ring-1 ring-ink-600 glow">
        <video
          ref={video} src={src} muted={muted} playsInline preload="auto"
          onLoadedMetadata={() => { if (video.current && segments[0]) video.current.currentTime = segments[0][0]; setReady(true); }}
          onPause={() => setPlaying(false)} onPlay={() => setPlaying(true)}
          className="absolute top-0 h-full max-w-none"
          style={landscape ? { width: scaledW, left: -left } : { width: "100%", left: 0, objectFit: "contain" }}
        />
        {cap && (
          <div className="pointer-events-none absolute inset-x-[6%] -translate-y-1/2 text-center" style={captionStyle(style, size.h)}>
            {cap.words.map((w, i) => {
              const isActive = multi && style.highlight_active && i === cap.active;
              const color = isActive ? style.highlight_color : kw.has(norm(w.w)) ? style.keyword_color : undefined;
              return <span key={`${w.s}-${i}`} style={{ color }}>{w.w}{i < cap.words.length - 1 ? " " : ""}</span>;
            })}
          </div>
        )}
        {!ready && <div className="absolute inset-0 grid place-items-center text-sm text-mist-400">Chargement de la vidéo…</div>}
        <button onClick={toggle} className="absolute inset-0" aria-label={playing ? "Pause" : "Lecture"} />
      </div>

      <div className="mx-auto flex max-w-[300px] items-center gap-2">
        <button onClick={toggle} className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white text-ink-950" aria-label={playing ? "Pause" : "Lecture"}>
          {playing ? <Pause className="h-4 w-4 fill-current" /> : <Play className="ml-0.5 h-4 w-4 fill-current" />}
        </button>
        <input
          type="range" min={0} max={total || 1} step={0.05} value={clipT} aria-label="Position dans le clip"
          onChange={(e) => { const st = toSource(+e.target.value); if (video.current) video.current.currentTime = st; setT(st); }}
          className="flex-1"
        />
        <span className="w-20 shrink-0 text-right text-xs tabular-nums text-mist-400">{fmtTime(clipT)} / {fmtTime(total)}</span>
        <button onClick={() => setMuted((m) => !m)} className="text-mist-400 hover:text-mist-100" aria-label={muted ? "Activer le son" : "Couper le son"}>
          {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
});

export default VerticalPreview;
