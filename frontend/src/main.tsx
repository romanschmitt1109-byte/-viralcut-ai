import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import "./index.css";
import Layout from "./components/Layout";
import ClipLibrary from "./components/ClipLibrary";
import { PageHeader, Spinner } from "./components/ui";
import { AuthProvider, useAuth } from "./lib/auth";
import Analysis from "./pages/Analysis";
import Dashboard from "./pages/Dashboard";
import Editor from "./pages/Editor";
import Import from "./pages/Import";
import Landing from "./pages/Landing";
import Login from "./pages/Login";
import ProjectClips from "./pages/ProjectClips";
import Settings from "./pages/Settings";

function Protected({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <div className="min-h-screen bg-ink-900"><Spinner /></div>;
  if (!user) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  return <>{children}</>;
}

function AllClips() {
  return (
    <div className="animate-fade-up">
      <PageHeader title="Clips" subtitle="Tous vos Shorts, tous projets confondus." />
      <ClipLibrary />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/login" element={<Login />} />
          <Route path="/app" element={<Protected><Layout /></Protected>}>
            <Route index element={<Dashboard />} />
            <Route path="import" element={<Import />} />
            <Route path="projects/:id" element={<Analysis />} />
            <Route path="projects/:id/clips" element={<ProjectClips />} />
            <Route path="clips" element={<AllClips />} />
            <Route path="clips/:id" element={<Editor />} />
            <Route path="settings" element={<Settings />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  </StrictMode>,
);
