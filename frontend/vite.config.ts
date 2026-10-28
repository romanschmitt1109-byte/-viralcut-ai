import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  // chemins relatifs pour la démo statique (GitHub Pages, sous-dossier du dépôt)
  base: process.env.VITE_DEMO === "1" ? "./" : "/",
  plugins: [
    react(),
    tailwindcss(),
    {
      // Démo GitHub Pages : active l'isolation cross-origin (SharedArrayBuffer → FFmpeg multi-cœurs)
      name: "coi-serviceworker",
      transformIndexHtml: (html) =>
        process.env.VITE_DEMO === "1" ? html.replace("<head>", '<head>\n    <script src="./coi-serviceworker.js"></script>') : html,
    },
  ],
  server: {
    port: 5173,
    proxy: { "/api": { target: process.env.VITE_API_PROXY ?? "http://localhost:8000", changeOrigin: true } },
  },
});
