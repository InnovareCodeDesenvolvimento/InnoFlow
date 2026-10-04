import { defineConfig } from "@playwright/test"
import { VIEWPORTS, TIMEZONE, LOCALE } from "./e2e-visual/constantes"

/**
 * Harness de REGRESSÃO VISUAL + contraste (axe) + linha de base — FORA da suíte E2E de 185 (`playwright.config.ts`,
 * `testDir: ./e2e`). Rodar: `npm run test:visual` (compara) · `npm run test:visual:update` (regrava a baseline —
 * só a Lyra/Atlas aprovam, ver `e2e-visual/README.md`) · `npm run test:contraste` (axe).
 *
 * Contra os mocks MSW (`dev:mock`), numa porta PRÓPRIA (5199): a suíte E2E usa 5173 com `reuseExistingServer`, e
 * reaproveitar por engano um `npm run dev` sem mock (de quem estiver trabalhando) capturaria telas de erro de API.
 *
 * Determinismo (o que é imposto, e onde):
 *  - 1 projeto por viewport (375 / 768 / 1440), `reducedMotion: "reduce"` (landing e canvas param no quadro estático);
 *  - fuso e locale fixos; relógio fixo por teste (`estabilizar.ts`) — o mock calcula tudo relativo a `Date.now()`;
 *  - `animations: "disabled"` + CSS que zera animação/transição/caret; fontes aguardadas (`document.fonts.ready`);
 *  - tiles do mapa interceptados e trocados por um PNG sólido (rede externa = instabilidade);
 *  - JPEG nos baselines (`toMatchSnapshot` aceita .jpg) para o repositório não inchar com PNG de página inteira.
 */
const PORT = Number(process.env.VISUAL_PORT || 5199)
const baseURL = process.env.VISUAL_BASE_URL || `http://localhost:${PORT}`

export default defineConfig({
  testDir: "./e2e-visual",
  testMatch: /.*\.visual\.ts$/,
  // O estado do mock vive na PÁGINA (MSW no navegador), então testes não se enxergam; paralelismo é seguro. Mas o dev server do Vite
  // compila sob demanda: poucos workers evitam capturar uma tela enquanto a CPU está disputada (instabilidade de timing, não de pixel).
  fullyParallel: true,
  workers: Number(process.env.VISUAL_WORKERS || 3),
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 90_000,
  reporter: [["list"], ["html", { open: "never", outputFolder: "e2e-visual/.relatorio" }]],
  outputDir: "e2e-visual/.resultados",
  // Baseline versionada. `{platform}` fica no caminho de propósito: a rasterização de texto difere entre Windows/Linux/macOS, então
  // uma baseline gravada no Windows NUNCA vale como verdade no Linux (ver README, "Plataforma").
  snapshotPathTemplate: "e2e-visual/baseline/{platform}/{projectName}/{arg}{ext}",
  expect: {
    toMatchSnapshot: {
      // Calibrado em `e2e-visual/BASELINE.md`: ruído medido (456 capturas repetidas sem mudança) = 0 px na configuração padrão e <= 114 px
      // com tolerância ZERO; sensibilidade medida em `sensibilidade.visual.ts` (o que este limiar pega e o que NÃO pega).
      maxDiffPixelRatio: Number(process.env.VISUAL_MAX_DIFF_RATIO ?? 0.0003),
      threshold: Number(process.env.VISUAL_THRESHOLD ?? 0.03),
    },
  },
  globalSetup: "./e2e-visual/global-setup.ts",
  use: {
    baseURL,
    locale: LOCALE,
    timezoneId: TIMEZONE,
    reducedMotion: "reduce",
    colorScheme: "light",
    deviceScaleFactor: 1,
    hasTouch: false,
    // Sem trace/vídeo: cada captura é só pixel + a imagem de diff que o Playwright já anexa em falha.
    trace: "off",
  },
  projects: VIEWPORTS.map((v) => ({
    name: String(v.width),
    use: { viewport: { width: v.width, height: v.height } },
  })),
  webServer: process.env.VISUAL_BASE_URL
    ? undefined
    : {
        command: `npm run dev:mock -- --port ${PORT} --strictPort`,
        url: `http://localhost:${PORT}`,
        // NUNCA reaproveitar servidor por padrão. O Vite dev NÃO recompila `tailwind.config.js`/tokens editados depois que subiu (skill medir-antes-de-afirmar): um servidor velho
        // na porta serve o CSS ANTIGO e a comparação "falha" (ou "passa") por motivo nenhum — foi a 1ª rodada instável da F-A (45 falhas sem 768). Com porta ocupada o Playwright
        // ERRA em voz alta em vez de fotografar o servidor errado. `VISUAL_REUSE_SERVER=1` reativa o reaproveitamento de propósito.
        reuseExistingServer: process.env.VISUAL_REUSE_SERVER === "1",
        timeout: 120_000,
      },
})
