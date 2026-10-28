import { CheckCircle2, CircleAlert, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Badge, Button, Card, ErrorBox, Field, Input, PageHeader, ProgressBar, Spinner } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { SystemStatus, Usage } from "../lib/types";

export default function Settings() {
  const { user, refresh, logout } = useAuth();
  const nav = useNavigate();
  const [name, setName] = useState(user?.display_name ?? "");
  const [usage, setUsage] = useState<Usage | null>(null);
  const [sys, setSys] = useState<SystemStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([api<Usage>("/api/usage"), api<SystemStatus>("/api/system/status")])
      .then(([u, s]) => { setUsage(u); setSys(s); })
      .catch((e) => setError(e.message));
  }, []);

  const saveProfile = async () => {
    setBusy(true);
    try {
      await api("/api/auth/me", { method: "PATCH", json: { display_name: name } });
      await refresh();
      setOk(true);
      setTimeout(() => setOk(false), 2000);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const resetStyle = async () => {
    try {
      await api("/api/auth/me", { method: "PATCH", json: { default_subtitle_style: sys?.default_subtitle_style } });
      await refresh();
      setOk(true);
      setTimeout(() => setOk(false), 2000);
    } catch (e) { setError((e as Error).message); }
  };
  const deleteAccount = async () => {
    if (!confirm("Supprimer définitivement votre compte, vos vidéos et tous vos clips ? Cette action est irréversible.")) return;
    try { await api("/api/auth/me", { method: "DELETE" }); logout(); nav("/"); } catch (e) { setError((e as Error).message); }
  };

  if (!usage || !sys) return error ? <ErrorBox>{error}</ErrorBox> : <Spinner />;
  const llmLabel = { anthropic: "Claude (Anthropic)", openai: "OpenAI", heuristic: "Heuristique (sans IA générative)" }[sys.llm_provider] ?? sys.llm_provider;

  return (
    <div className="mx-auto max-w-3xl animate-fade-up space-y-5">
      <PageHeader title="Paramètres" subtitle="Compte, consommation et configuration du traitement." />
      {error && <ErrorBox>{error}</ErrorBox>}

      <Card className="space-y-4 p-5">
        <h2 className="font-semibold">Profil</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nom affiché"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></Field>
          <Field label="E-mail"><Input value={user?.email ?? ""} disabled /></Field>
        </div>
        <div className="flex items-center gap-3">
          <Button onClick={saveProfile} loading={busy}>Enregistrer</Button>
          {ok && <span className="text-sm text-emerald-300">Enregistré</span>}
        </div>
      </Card>

      <Card className="space-y-4 p-5">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Offre et consommation</h2>
          <Badge cls="bg-violet-500/15 text-violet-200 ring-violet-500/30">{usage.plan.name}</Badge>
        </div>
        <div>
          <div className="mb-1 flex justify-between text-sm"><span>Minutes vidéo ce mois-ci</span><span className="tabular-nums text-mist-400">{usage.video_minutes_used.toFixed(1)} / {usage.plan.monthly_video_minutes}</span></div>
          <ProgressBar value={(usage.video_minutes_used / usage.plan.monthly_video_minutes) * 100} />
        </div>
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <Stat k="Fichier max." v={`${usage.plan.max_upload_mb} Mo`} />
          <Stat k="Vidéo max." v={`${usage.plan.max_video_minutes} min`} />
          <Stat k="Clips / vidéo" v={usage.plan.max_clips_per_video} />
          <Stat k="Coût API estimé" v={`${usage.estimated_cost_eur.toFixed(2)} €`} />
        </dl>
        <p className="text-xs text-mist-400">Tokens IA ce mois-ci : {usage.llm_tokens_in.toLocaleString("fr-FR")} en entrée, {usage.llm_tokens_out.toLocaleString("fr-FR")} en sortie.</p>
        <p className="rounded-xl bg-ink-800 px-4 py-3 text-sm text-mist-300">
          Le paiement en ligne n'est pas activé sur cette instance. Le changement d'offre se fait par l'administrateur.
        </p>
      </Card>

      <Card className="space-y-3 p-5">
        <h2 className="font-semibold">Style de sous-titres par défaut</h2>
        <p className="text-sm text-mist-400">Définissez-le depuis l'éditeur d'un clip (« Utiliser ce style par défaut »). Il s'applique aux prochains clips générés.</p>
        <Button variant="secondary" size="sm" onClick={resetStyle}>Rétablir le style d'origine</Button>
      </Card>

      <Card className="space-y-3 p-5">
        <h2 className="font-semibold">Traitement</h2>
        <ul className="space-y-2 text-sm">
          <Status ok={sys.ffmpeg} label="FFmpeg" detail={sys.ffmpeg ? "disponible" : "introuvable sur le serveur"} />
          <Status ok={sys.transcription_configured} label="Transcription" detail={`${sys.transcription_provider === "openai" ? "API OpenAI" : "Whisper local"} · ${sys.whisper_model}`} />
          <Status ok={sys.llm_provider !== "heuristic"} warn={sys.llm_provider === "heuristic"} label="Sélection des passages" detail={`${llmLabel}${sys.llm_model ? ` · ${sys.llm_model}` : ""}`} />
          <Status ok label="Stockage" detail={sys.storage === "s3" ? "S3" : "disque local"} />
        </ul>
        {sys.llm_provider === "heuristic" && (
          <p className="text-xs text-mist-400">Aucune clé d'API IA n'est configurée : les passages sont choisis par des règles explicables et les titres sont extraits du texte. Ajoutez ANTHROPIC_API_KEY ou OPENAI_API_KEY côté serveur pour la sélection par IA.</p>
        )}
      </Card>

      <Card className="flex flex-wrap items-center justify-between gap-3 border-rose-500/30 p-5">
        <div><h2 className="font-semibold">Supprimer le compte</h2><p className="text-sm text-mist-400">Efface vos vidéos, clips, transcriptions et données de consommation.</p></div>
        <Button variant="danger" onClick={deleteAccount} icon={<Trash2 className="h-4 w-4" />}>Supprimer</Button>
      </Card>
    </div>
  );
}

function Stat({ k, v }: { k: string; v: React.ReactNode }) {
  return <div className="rounded-xl bg-ink-800 p-3"><dt className="text-xs text-mist-400">{k}</dt><dd className="mt-0.5 font-medium tabular-nums">{v}</dd></div>;
}

function Status({ ok, warn, label, detail }: { ok: boolean; warn?: boolean; label: string; detail: string }) {
  return (
    <li className="flex items-center gap-3">
      {ok ? <CheckCircle2 className="h-4 w-4 text-emerald-400" /> : <CircleAlert className={warn ? "h-4 w-4 text-amber-400" : "h-4 w-4 text-rose-400"} />}
      <span className="w-44 shrink-0">{label}</span><span className="text-mist-400">{detail}</span>
    </li>
  );
}
