import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import path from "path"

// Alvo do proxy de desenvolvimento: a API local (entrypoints/api.ts).
const API_DEV_TARGET = process.env.VITE_DEV_API_TARGET || "http://localhost:3000"

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // import.meta.dirname (não __dirname) — exigido pelo configLoader
      // "native" do Vite 8.
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  server: {
    // Sem proxy, uma chamada relativa a /api cairia no fallback de SPA do
    // dev server (200 + index.html) em vez de falhar de verdade quando a
    // API está fora do ar — mesmo raciocínio do ParquedasFeiras.
    proxy: {
      "/api": { target: API_DEV_TARGET, changeOrigin: true },
    },
  },
})
