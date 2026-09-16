import { defineConfig } from "vitest/config"
import react from "@vitejs/plugin-react"
import path from "path"

// Config exclusiva de TESTES (Vitest a prioriza sobre vite.config.ts) —
// mesma separação do ParquedasFeiras, para o build de produção nunca
// depender de devDeps de teste.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.d.ts", "src/main.tsx", "src/test/**"],
    },
  },
})
