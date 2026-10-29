import { Clapperboard, LayoutDashboard, LogOut, Settings, Upload } from "lucide-react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { DEMO } from "../lib/demo";
import { cx } from "./ui";

const NAV = [
  { to: "/app", label: "Tableau de bord", icon: LayoutDashboard, end: true },
  { to: "/app/import", label: "Importer", icon: Upload },
  { to: "/app/clips", label: "Clips", icon: Clapperboard },
  { to: "/app/settings", label: "Paramètres", icon: Settings },
];

export function Logo({ compact }: { compact?: boolean }) {
  return (
    <span className="flex items-center gap-2 font-semibold tracking-tight">
      <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-violet-500 to-blue-500 shadow-lg shadow-violet-900/40">
        <svg viewBox="0 0 24 24" className="h-4 w-4 fill-white"><path d="M8 5v14l11-7z" /></svg>
      </span>
      {!compact && <span>ViralCut <span className="text-gradient">AI</span></span>}
    </span>
  );
}

export default function Layout() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  return (
    <div className="min-h-screen bg-ink-900 lg:flex">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-ink-700 bg-ink-950/60 p-4 lg:flex">
        <div className="mb-8 px-2 pt-1"><Logo /></div>
        <nav className="flex flex-1 flex-col gap-1">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end}
              className={({ isActive }) => cx("flex items-center gap-3 rounded-xl px-3 py-2 text-sm transition-colors",
                isActive ? "bg-violet-500/15 text-violet-200" : "text-mist-400 hover:bg-ink-700/60 hover:text-mist-100")}>
              <Icon className="h-4 w-4" /> {label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-ink-700 pt-4">
          <p className="truncate px-2 text-sm">{user?.display_name || user?.email}</p>
          <p className="px-2 text-xs uppercase tracking-wide text-mist-400">Offre {user?.plan}</p>
          <button onClick={() => { logout(); nav("/"); }} className="mt-3 flex w-full items-center gap-2 rounded-xl px-2 py-2 text-sm text-mist-400 hover:bg-ink-700/60 hover:text-mist-100">
            <LogOut className="h-4 w-4" /> Déconnexion
          </button>
        </div>
      </aside>

      <header className="sticky top-0 z-20 flex items-center justify-between border-b border-ink-700 bg-ink-900/90 px-4 py-3 backdrop-blur lg:hidden">
        <Logo />
        <button onClick={() => { logout(); nav("/"); }} aria-label="Déconnexion" className="rounded-lg p-2 text-mist-400 hover:text-mist-100"><LogOut className="h-4 w-4" /></button>
      </header>

      <main className="min-w-0 flex-1 px-4 pb-24 pt-6 sm:px-6 lg:px-10 lg:pb-10 lg:pt-8">
        {DEMO && (
          <div className="mx-auto mb-6 max-w-7xl rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
            <strong>Mode navigateur.</strong> Vos vidéos sont traitées sur cet appareil (FFmpeg et Whisper en WebAssembly), sans serveur : c'est plus lent qu'un serveur.
            Projets et Shorts sont enregistrés sur cet appareil ; un traitement interrompu par un rechargement de la page doit être relancé. Vidéos de moins de 10 min conseillées.
          </div>
        )}
        <div className="mx-auto max-w-7xl"><Outlet /></div>
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-4 border-t border-ink-700 bg-ink-950/95 backdrop-blur lg:hidden">
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end}
            className={({ isActive }) => cx("flex flex-col items-center gap-1 py-2.5 text-[11px]", isActive ? "text-violet-300" : "text-mist-400")}>
            <Icon className="h-5 w-5" /> {label.split(" ")[0]}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
