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
    // O default do Vitest (5 s por teste) e justo para os testes de dialog/formulario com user-event: medido, o RemoteStartDialog leva
    // ~1,5-1,9 s por teste SOZINHO numa maquina de 24 nucleos e estourou os 5 s quando a suite inteira rodou em paralelo (2 falhas, passou
    // isolado). O runner do GitHub tem 2-4 vCPU: sem folga, o CI ficaria vermelho por lentidao, nao por bug. Mesmos valores do backend.
    testTimeout: 20_000,
    hookTimeout: 30_000,
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.d.ts", "src/main.tsx", "src/test/**"],
    },
  },
})
