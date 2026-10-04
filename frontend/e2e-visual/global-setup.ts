import { chromium, type FullConfig, type Page } from "@playwright/test"
import { mkdirSync } from "node:fs"
import path from "node:path"
import { LOCALE, PASTA_AUTH, PERSONAS, SENHA, TIMEZONE } from "./constantes"
import { ROTAS } from "./rotas"

/**
 * 1) Faz login UMA vez por persona (pela UI, como o motorista/admin fazem) e guarda o `storageState` — o estado do mock
 *    (carteira, sessão) vive na página, então reaproveitar só o token não contamina um teste com outro.
 * 2) AQUECE o dev server: a 1ª visita a cada rota faz o Vite pré-empacotar dependências e, às vezes, recarregar a página no meio
 *    ("optimized dependencies changed"). Sem o aquecimento, a primeira captura de cada rota saía com a tela errada.
 */
export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0].use.baseURL as string
  mkdirSync(PASTA_AUTH, { recursive: true })
  const browser = await chromium.launch()

  for (const [persona, { email, arquivo }] of Object.entries(PERSONAS)) {
    const context = await browser.newContext({ baseURL, locale: LOCALE, timezoneId: TIMEZONE, viewport: { width: 1440, height: 900 } })
    const page = await context.newPage()
    await page.goto("/login")
    await page.getByLabel("E-mail").fill(email)
    await page.getByLabel("Senha").fill(SENHA)
    await page.getByRole("button", { name: "Entrar" }).click()
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 })
    await context.storageState({ path: path.join(PASTA_AUTH, `${arquivo}.json`) })

    // Aquecimento das rotas desta persona.
    for (const rota of ROTAS.filter((r) => r.persona === (persona as keyof typeof PERSONAS))) await aquecer(page, rota.path)
    await context.close()
  }

  const anon = await browser.newContext({ baseURL, locale: LOCALE, timezoneId: TIMEZONE })
  const pageAnon = await anon.newPage()
  for (const rota of ROTAS.filter((r) => r.persona === "anon")) await aquecer(pageAnon, rota.path)
  await anon.close()
  await browser.close()
}

/** Aquecimento tolerante: uma navegação que falha (dev server ainda compilando/recarregando) é tentada de novo uma vez e NUNCA derruba a suíte. */
async function aquecer(page: Page, caminho: string) {
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    try {
      await page.goto(caminho, { waitUntil: "load", timeout: 60_000 })
      await page.waitForFunction(() => !document.querySelector(".skeleton, .animate-spin"), undefined, { timeout: 30_000 }).catch(() => undefined)
      return
    } catch {
      /* tenta de novo */
    }
  }
}
