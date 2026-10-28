import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { Logo } from "../components/Layout";
import { Button, Card, ErrorBox, Field, Input } from "../components/ui";
import { useAuth } from "../lib/auth";

export default function Login() {
  const [params, setParams] = useSearchParams();
  const register = params.get("mode") === "register";
  const auth = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (auth.user) return <Navigate to="/app" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (register) await auth.register(email, password, name);
      else await auth.login(email, password);
      nav("/app");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-screen place-items-center bg-ink-950 px-4">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(50%_40%_at_50%_0%,rgba(139,92,246,0.2),transparent_70%)]" />
      <div className="relative w-full max-w-sm animate-fade-up">
        <Link to="/" className="mb-8 flex justify-center"><Logo /></Link>
        <Card className="p-6">
          <h1 className="text-xl font-semibold">{register ? "Créer un compte" : "Connexion"}</h1>
          <p className="mt-1 text-sm text-mist-400">{register ? "Offre gratuite, sans carte bancaire." : "Content de vous revoir."}</p>
          <form onSubmit={submit} className="mt-6 space-y-4">
            {register && (
              <Field label="Nom (facultatif)"><Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></Field>
            )}
            <Field label="E-mail"><Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></Field>
            <Field label="Mot de passe" hint={register ? "8 caractères minimum" : undefined}>
              <Input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={register ? "new-password" : "current-password"} />
            </Field>
            {error && <ErrorBox>{error}</ErrorBox>}
            <Button type="submit" loading={busy} className="w-full">{register ? "Créer mon compte" : "Se connecter"}</Button>
          </form>
        </Card>
        <p className="mt-4 text-center text-sm text-mist-400">
          {register ? "Déjà un compte ?" : "Pas encore de compte ?"}{" "}
          <button className="text-violet-300 hover:text-violet-200" onClick={() => setParams(register ? {} : { mode: "register" })}>
            {register ? "Se connecter" : "S'inscrire"}
          </button>
        </p>
      </div>
    </div>
  );
}
