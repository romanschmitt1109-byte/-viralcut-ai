import type { ClipDetail } from "../lib/types";

const LABELS: Record<string, string> = { hook: "Accroche", clarity: "Clarté", pace: "Rythme", interest: "Intérêt", payoff: "Conclusion" };

export default function ScoreBreakdown({ breakdown }: { breakdown: ClipDetail["score_breakdown"] }) {
  const sub = breakdown.subscores ?? {};
  const w = breakdown.weights ?? {};
  const pm = breakdown.pace_measures;
  return (
    <div className="space-y-1.5">
      {Object.keys(LABELS).map((k) => (
        <div key={k} className="grid grid-cols-[80px_1fr_28px] items-center gap-2 text-xs">
          <span className="text-mist-300">{LABELS[k]}</span>
          <div className="h-1.5 rounded-full bg-ink-700">
            <div className="h-full rounded-full bg-gradient-to-r from-violet-500 to-blue-500" style={{ width: `${((sub[k] ?? 0) / 10) * 100}%` }} />
          </div>
          <span className="text-right tabular-nums text-mist-400" title={w[k] ? `poids ${Math.round(w[k] * 100)} %` : undefined}>{(sub[k] ?? 0).toFixed(1)}</span>
        </div>
      ))}
      {pm && (
        <p className="pt-1 text-[11px] text-mist-400">
          Rythme mesuré : {pm.words_per_second} mots/s · {Math.round((pm.silence_ratio ?? 0) * 100)} % de silence{pm.fillers ? ` · ${pm.fillers} hésitation(s)` : ""}
        </p>
      )}
    </div>
  );
}
