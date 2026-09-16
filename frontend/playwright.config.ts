import { defineConfig, devices } from "@playwright/test"

/**
 * E2E do InnoElektron. Nesta fase (F0) só existe o shell "hello" — os specs
 * de verdade (fluxo de carga, checkout PIX/cartão) entram quando o Vega e a
 * Lyra tiverem as telas reais.
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
        command: "npm run dev",
        url: `http://localhost:${PORT}`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
})
