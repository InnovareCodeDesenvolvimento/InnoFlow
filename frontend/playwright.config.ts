import { defineConfig, devices } from "@playwright/test"

/**
 * E2E do InnoElektron, contra os mocks MSW (`src/mocks/`) — não há
 * Postgres/Redis disponível neste ambiente de CI (limitação conhecida, ver
 * `.claude/agent-memory/iris/project_innoelektron_e2e_gap.md`). Por isso o
 * `webServer` sobe com `dev:mock` (`VITE_USE_MOCKS=true`), não `dev` puro —
 * sem isso o app tentaria falar com uma API real inexistente e todo spec que
 * bate em `/api/...` quebraria. Cobre hoje: smoke, fluxo completo do PWA do
 * motorista e CRUD+relatório do admin (`e2e/*.spec.ts`, qualquer arquivo
 * novo na pasta já é pego automaticamente por `testDir`).
 *
 * Pré-requisito local: `npx playwright install --with-deps chromium`.
 */
const PORT = 5173
const baseURL = process.env.E2E_BASE_URL || `http://localhost:${PORT}`

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "npm run dev:mock",
        url: `http://localhost:${PORT}`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
})
