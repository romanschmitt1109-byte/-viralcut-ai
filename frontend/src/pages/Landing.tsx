import { ArrowRight, AudioLines, Captions, Crop, Gauge, ScanSearch, Scissors, ShieldCheck, Sparkles } from "lucide-react";
import { Link } from "react-router-dom";
import { Logo } from "../components/Layout";
import { useAuth } from "../lib/auth";

const STEPS = [
  { icon: ScanSearch, title: "Transcription", text: "Chaque mot est horodaté avec Whisper pour un découpage au mot près." },
  { icon: Sparkles, title: "Sélection", text: "L'IA repère accroches, histoires, révélations et conseils qui tiennent seuls." },
  { icon: Crop, title: "Cadrage 9:16", text: "Le visage du locuteur reste dans le cadre, sans tremblement." },
  { icon: Captions, title: "Sous-titres", text: "Mot par mot, mots-clés en couleur, style entièrement réglable." },
];

const FEATURES = [
  { icon: Scissors, title: "Silences et hésitations retirés", text: "Les pauses longues et les « euh » sont coupés pour garder le rythme." },
  { icon: AudioLines, title: "Audio normalisé", text: "Volume calé à −14 LUFS, la référence des plateformes courtes." },
  { icon: Gauge, title: "Score explicable", text: "Accroche, clarté, rythme, intérêt, conclusion : chaque note est détaillée. C'est une estimation, pas une promesse de vues." },
  { icon: ShieldCheck, title: "Vos vidéos, vos droits", text: "Traitement uniquement des fichiers que vous êtes autorisé à utiliser. Aucun contournement de plateforme." },
];

export default function Landing() {
  const { user } = useAuth();
  const cta = user ? "/app" : "/login?mode=register";
  return (
    <div className="min-h-screen overflow-x-hidden bg-ink-950">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[640px] bg-[radial-gradient(60%_50%_at_50%_0%,rgba(139,92,246,0.28),transparent_70%)]" />
      <header className="relative mx-auto flex max-w-6xl items-center justify-between px-5 py-5">
        <Logo />
        <div className="flex items-center gap-2">
          {user ? (
            <Link to="/app" className="rounded-xl bg-ink-700 px-4 py-2 text-sm ring-1 ring-ink-500 hover:bg-ink-600">Ouvrir l'app</Link>
          ) : (
            <>
              <Link to="/login" className="rounded-xl px-4 py-2 text-sm text-mist-300 hover:text-white">Connexion</Link>
              <Link to="/login?mode=register" className="rounded-xl bg-white px-4 py-2 text-sm font-medium text-ink-950 hover:bg-mist-100">Commencer</Link>
            </>
          )}
        </div>
      </header>

      <section className="relative mx-auto max-w-6xl px-5 pb-20 pt-14 sm:pt-24">
        <div className="grid items-center gap-14 lg:grid-cols-[1.15fr_0.85fr]">
          <div className="animate-fade-up">
            <p className="mb-5 inline-flex items-center gap-2 rounded-full border border-violet-500/30 bg-violet-500/10 px-3 py-1 text-xs text-violet-200">
              <Sparkles className="h-3.5 w-3.5" /> Vidéo longue → Shorts prêts à publier
            </p>
            <h1 className="text-4xl font-semibold leading-[1.08] tracking-tight sm:text-6xl">
              Vos meilleurs moments,<br /><span className="text-gradient">découpés pour retenir.</span>
            </h1>
            <p className="mt-6 max-w-xl text-lg text-mist-300">
              ViralCut AI transcrit votre vidéo, sélectionne les passages qui tiennent seuls, les recadre en 9:16 avec sous-titres dynamiques et vous livre des MP4 1080×1920 prêts pour YouTube Shorts et TikTok.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link to={cta} className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-violet-600 to-indigo-600 px-5 py-3 font-medium text-white shadow-lg shadow-violet-900/40 hover:from-violet-500 hover:to-indigo-500">
                Créer mes premiers Shorts <ArrowRight className="h-4 w-4" />
              </Link>
              <a href="#fonctionnement" className="rounded-xl px-5 py-3 text-mist-300 ring-1 ring-ink-600 hover:bg-ink-800">Comment ça marche</a>
            </div>
            <p className="mt-4 text-sm text-mist-400">Offre gratuite : 60 minutes de vidéo par mois.</p>
          </div>

          <div className="relative mx-auto w-full max-w-[300px]" aria-hidden>
            <div className="absolute -inset-10 rounded-full bg-gradient-to-br from-violet-600/25 to-blue-600/20 blur-3xl" />
            <div className="relative aspect-[9/16] overflow-hidden rounded-[2rem] border border-ink-500/60 bg-gradient-to-b from-ink-700 to-ink-850 shadow-2xl glow">
              <div className="bg-grid absolute inset-0" />
              <div className="absolute left-1/2 top-[30%] h-28 w-28 -translate-x-1/2 rounded-full bg-gradient-to-br from-mist-300/30 to-mist-400/10" />
              <div className="absolute left-1/2 top-[48%] h-40 w-48 -translate-x-1/2 rounded-t-[5rem] bg-gradient-to-b from-mist-300/20 to-transparent" />
              <div className="absolute inset-x-4 top-[68%] text-center text-[22px] font-extrabold uppercase leading-tight tracking-tight [text-shadow:0_2px_0_#000,0_0_12px_rgba(0,0,0,0.8)]">
                <span className="text-white">Personne ne </span><span className="text-violet-300">mesure</span><span className="text-amber-300"> vraiment</span>
              </div>
              <div className="absolute inset-x-4 bottom-4 flex items-center justify-between rounded-xl bg-black/40 px-3 py-2 text-[11px] text-mist-300 backdrop-blur">
                <span>0:12 / 0:38</span><span className="rounded-md bg-violet-500/30 px-1.5 py-0.5 text-violet-100">Score 82</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="fonctionnement" className="relative mx-auto max-w-6xl px-5 py-16">
        <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">De la vidéo longue au Short, en quatre étapes</h2>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map(({ icon: I, title, text }, i) => (
            <div key={title} className="rounded-2xl border border-ink-600/60 bg-ink-850 p-5">
              <div className="mb-4 flex items-center justify-between">
                <span className="grid h-10 w-10 place-items-center rounded-xl bg-violet-500/15 text-violet-300"><I className="h-5 w-5" /></span>
                <span className="text-sm tabular-nums text-mist-400">0{i + 1}</span>
              </div>
              <h3 className="font-medium">{title}</h3>
              <p className="mt-1 text-sm text-mist-400">{text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="relative mx-auto max-w-6xl px-5 py-16">
        <div className="grid gap-4 sm:grid-cols-2">
          {FEATURES.map(({ icon: I, title, text }) => (
            <div key={title} className="flex gap-4 rounded-2xl border border-ink-600/60 bg-ink-900 p-5">
              <I className="mt-0.5 h-5 w-5 shrink-0 text-blue-300" />
              <div><h3 className="font-medium">{title}</h3><p className="mt-1 text-sm text-mist-400">{text}</p></div>
            </div>
          ))}
        </div>
      </section>

      <section className="relative mx-auto max-w-6xl px-5 py-16">
        <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">Offres</h2>
        <p className="mt-2 text-sm text-mist-400">Le paiement en ligne n'est pas encore activé : toutes les inscriptions démarrent sur l'offre gratuite.</p>
        <div className="mt-8 grid gap-4 md:grid-cols-3">
          {[
            { n: "Gratuit", m: "60 min / mois", f: ["Vidéos jusqu'à 30 min", "5 clips par vidéo", "Export MP4 1080×1920"] },
            { n: "Pro", m: "600 min / mois", f: ["Vidéos jusqu'à 2 h", "20 clips par vidéo", "Fichiers jusqu'à 4 Go"], hl: true },
            { n: "Studio", m: "3 000 min / mois", f: ["Vidéos jusqu'à 4 h", "50 clips par vidéo", "Traitement par lots"] },
          ].map((p) => (
            <div key={p.n} className={`rounded-2xl border p-6 ${p.hl ? "border-violet-500/50 bg-violet-500/5" : "border-ink-600/60 bg-ink-850"}`}>
              <h3 className="font-semibold">{p.n}</h3>
              <p className="mt-1 text-2xl font-semibold">{p.m}</p>
              <ul className="mt-4 space-y-2 text-sm text-mist-300">{p.f.map((x) => <li key={x}>— {x}</li>)}</ul>
            </div>
          ))}
        </div>
      </section>

      <footer className="border-t border-ink-700 px-5 py-8 text-center text-sm text-mist-400">
        ViralCut AI — les scores sont des estimations éditoriales et ne garantissent aucun nombre de vues.
      </footer>
    </div>
  );
}
