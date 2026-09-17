import { defineConfig } from "vitest/config"
import react from "@vitejs/plugin-react"
import path from "path"
import { buildDefine } from "./buildInfo.ts"

// Config exclusiva de TESTES (Vitest a prioriza sobre vite.config.ts) —
// mesma separação do ParquedasFeiras, para o build de produção nunca
// depender de devDeps de teste.
export default defineConfig({
  plugins: [react()],
  // Mesmo buildDefine do vite.config.ts — sem isto, qualquer teste que
  // importe algo de lib/appInfo.ts falha com "__APP_VERSION__ is not
  // defined" (define é resolvido em build-time, vite-env.d.ts só tipa).
  define: buildDefine,
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
