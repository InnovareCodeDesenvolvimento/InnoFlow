/**
 * Infra de captura da apresentação: sobe o app em modo mock (MSW) numa porta PRÓPRIA, faz login por persona e
 * estabiliza a página antes de fotografar.
 *
 * A estabilização é um PORTE de `e2e-visual/estabilizar.ts` (relógio fixo, host externo bloqueado, tiles do mapa sem rede,
 * animação zerada, Inter garantida, imagens lazy decodificadas, "documento assentado"). Não dá para importar o .ts direto:
 * ele usa import sem extensão (`./geometria`), que o Node não resolve. Constantes de persona/senha vêm do harness de verdade
 * (`e2e-visual/constantes.ts`) — esse arquivo não tem import e carrega nativamente.
 */
import { spawn } from "node:child_process"
import { deflateSync, crc32 } from "node:zlib"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "@playwright/test"
import { LOCALE, PERSONAS, SENHA, TIMEZONE } from "../../e2e-visual/constantes.ts"

const AQUI = path.dirname(fileURLToPath(import.meta.url))
export const RAIZ_FRONT = path.resolve(AQUI, "..", "..")

/** Porta própria (a suíte E2E usa 5173/5174, o harness visual 5199). */
export const PORTA = Number(process.env.APRESENTACAO_PORTA || 5291)
export const BASE = `http://localhost:${PORTA}`

/** "Agora" das capturas: 05/10/2026 14:30 (America/Sao_Paulo; depois dos horários dos recibos pré-semeados do mock, que usam "hoje 14:07") — data da apresentação. O mock calcula tudo relativo a Date.now(). */
export const AGORA = new Date("2026-10-05T17:30:00.000Z")

export { PERSONAS, SENHA, LOCALE, TIMEZONE }

// ---------------------------------------------------------------- servidor
export async function subirServidor() {
  // O app só liga o MSW em dev com VITE_USE_MOCKS=true. Sem reaproveitar servidor: outro processo na porta serviria CSS/mocks velhos.
  const proc = spawn(process.execPath, [path.join(RAIZ_FRONT, "node_modules/vite/bin/vite.js"), "--port", String(PORTA), "--strictPort"], {
    cwd: RAIZ_FRONT,
    env: { ...process.env, VITE_USE_MOCKS: "true" },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let log = ""
  proc.stdout.on("data", (d) => (log += d))
  proc.stderr.on("data", (d) => (log += d))
  const limite = Date.now() + 120_000
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`O Vite saiu antes de subir (porta ${PORTA} ocupada?):\n${log}`)
    try {
      const r = await fetch(BASE + "/")
      if (r.ok) break
    } catch {
      /* ainda subindo */
    }
    if (Date.now() > limite) {
      proc.kill()
      throw new Error("Timeout esperando o Vite:\n" + log)
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return {
    async parar() {
      if (proc.exitCode === null) {
        // No Windows `kill()` mata só o node; o Vite não tem filhos persistentes aqui.
        proc.kill()
        await new Promise((r) => setTimeout(r, 300))
      }
    },
  }
}

export async function abrirNavegador() {
  return chromium.launch()
}

// ---------------------------------------------------------------- contexto/página
export const VIEW_ADMIN = { width: 1440, height: 900 }
export const VIEW_CELULAR = { width: 390, height: 844 }

export async function novoContexto(browser, { celular = false } = {}) {
  return browser.newContext({
    baseURL: BASE,
    locale: LOCALE,
    timezoneId: TIMEZONE,
    reducedMotion: "reduce",
    colorScheme: "light",
    viewport: celular ? VIEW_CELULAR : VIEW_ADMIN,
    deviceScaleFactor: 2,
    hasTouch: celular,
    isMobile: celular,
    serviceWorkers: "allow", // o MSW É um service worker
    // Onboarding desligado neste aparelho: todo login de mock é uma 1ª visita e o tour do mascote abriria por cima de cada captura (e o card "Primeiros passos" apareceria no Dashboard).
    // Mesmo interruptor do harness (`ONBOARDING_OFF_KEY` em src/components/onboarding/onboardingStorage.ts).
    storageState: { cookies: [], origins: [{ origin: new URL(BASE).origin, localStorage: [{ name: "innoflow:onboarding:off", value: "1" }] }] },
  })
}

function chunk(tipo, dados) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(dados.length)
  const corpo = Buffer.concat([Buffer.from(tipo, "ascii"), dados])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(corpo))
  return Buffer.concat([len, corpo, crc])
}
/** Tile cinza sólido do mapa (sem rede): marcadores/layout reais, fundo estável. O OSM real não é determinístico nem necessário aqui. */
function tileSolido(cor = [0xe5, 0xe7, 0xeb]) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(256, 0)
  ihdr.writeUInt32BE(256, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const linha = Buffer.alloc(1 + 256 * 3)
  for (let i = 0; i < 256 * 3; i++) linha[1 + i] = cor[i % 3]
  const bruto = Buffer.concat(Array.from({ length: 256 }, () => linha))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(bruto)),
    chunk("IEND", Buffer.alloc(0)),
  ])
}
const TILE = tileSolido()

const CSS_CONGELA = `
*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; scroll-behavior: auto !important; }
`

/** Antes do `goto`: relógio fixo, tiles sem rede e nenhum pedido a host externo (GIS do Google, Cielo, fontes). */
export async function prepararPagina(page, { agora = AGORA, tilesReais = false } = {}) {
  // `agora: null` = relógio real. O Leaflet anima o fade dos tiles por Date.now(): com relógio fixo a opacidade fica em 0 e o mapa sai CINZA.
  if (agora) await page.clock.setFixedTime(agora)
  if (!tilesReais) await page.route(/^https?:\/\/[a-z]\.tile\.openstreetmap\.org\//, (route) => route.fulfill({ status: 200, contentType: "image/png", body: TILE }))
  await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (route) => {
    if (/tile\.openstreetmap\.org/.test(route.request().url())) return route.fallback()
    return route.abort()
  })
}

export async function login(page, persona) {
  const { email } = PERSONAS[persona]
  await page.goto("/login", { waitUntil: "load" })
  await page.getByLabel("E-mail").fill(email)
  await page.getByLabel("Senha").fill(SENHA)
  await page.getByRole("button", { name: "Entrar" }).click()
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 })
}

// ---------------------------------------------------------------- estabilização
export async function aguardarEstavel(page, opts = {}) {
  if (opts.heading) await page.getByRole("heading", { name: opts.heading }).first().waitFor({ state: "visible" })
  if (opts.text) await page.getByText(opts.text).first().waitFor({ state: "visible" })
  await page.waitForFunction(() => (document.getElementById("root")?.childElementCount ?? 0) > 0 && document.body.innerText.trim().length > 20, undefined, { timeout: 30_000 })
  await page.waitForFunction(
    (spinnerOk) => !document.querySelector(spinnerOk ? ".skeleton, [aria-busy='true']" : ".skeleton, .animate-spin, [aria-busy='true']"),
    !!opts.spinnerEhConteudo,
    { timeout: 30_000 },
  )
  await page.addStyleTag({ content: CSS_CONGELA })
  await carregarImagensPreguicosas(page)
  await garantirInter(page)
  await aguardarSemMudanca(page)
  await garantirInter(page)
}

async function garantirInter(page) {
  const ok = await page.evaluate(async () => {
    await Promise.all(["400", "500", "600", "700", "800", "900"].map((w) => document.fonts.load(`${w} 16px Inter`, "AaÇãé0123 R$")))
    await document.fonts.ready
    return document.fonts.check("16px Inter", "AaÇãé0123 R$")
  })
  if (!ok) throw new Error("A fonte Inter não carregou: a captura sairia com a fonte de reserva.")
}

async function aguardarSemMudanca(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const assinatura = () => [document.documentElement.scrollHeight, document.images.length, document.getElementsByTagName("*").length].join("|")
        let ultima = ""
        let iguais = 0
        let tentativas = 0
        const timer = setInterval(() => {
          const atual = assinatura()
          iguais = atual === ultima ? iguais + 1 : 0
          ultima = atual
          tentativas++
          if (iguais >= 10 || tentativas > 200) {
            clearInterval(timer)
            resolve()
          }
        }, 100)
      }),
  )
  await carregarImagensPreguicosas(page)
}

async function carregarImagensPreguicosas(page) {
  await page.evaluate(async () => {
    const passo = Math.max(200, Math.floor(window.innerHeight * 0.8))
    for (let y = 0; y < document.documentElement.scrollHeight; y += passo) {
      window.scrollTo(0, y)
      await new Promise((r) => requestAnimationFrame(() => r(null)))
    }
    window.scrollTo(0, 0)
    await Promise.all(Array.from(document.images).map((img) => (img.complete || img.getClientRects().length === 0 ? Promise.resolve() : new Promise((r) => (img.addEventListener("load", r, { once: true }), img.addEventListener("error", r, { once: true }))))))
    await Promise.all(
      Array.from(document.images)
        .filter((img) => img.getClientRects().length > 0)
        .map((img) => img.decode().catch(() => undefined)),
    )
  })
}

/** Foto da viewport atual (o que o usuário vê "na dobra") em JPEG q90 a 2x (o Chromium embute JPEG no PDF sem recomprimir). Duas capturas, guarda a segunda (ver nota em estabilizar.ts). */
export async function fotografar(page, destino) {
  await page.screenshot({ type: "jpeg", quality: 20, animations: "disabled", caret: "hide" })
  await page.screenshot({ path: destino, type: "jpeg", quality: 90, animations: "disabled", caret: "hide", scale: "device" })
}
