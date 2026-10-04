import { deflateSync, crc32 } from "node:zlib"
import { test, type Page } from "@playwright/test"
import { writeFileSync } from "node:fs"
import path from "node:path"
import { gravarGeometria } from "./geometria"
import { T0 } from "./constantes"

function chunk(tipo: string, dados: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(dados.length)
  const corpo = Buffer.concat([Buffer.from(tipo, "ascii"), dados])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(corpo))
  return Buffer.concat([len, corpo, crc])
}

/** PNG 256x256 cinza sólido (#e5e7eb), gerado aqui (sem dependência): substitui qualquer tile do OpenStreetMap — mapa com layout/marcadores reais e fundo estável. */
function tileSolido(): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(256, 0)
  ihdr.writeUInt32BE(256, 4)
  ihdr[8] = 8 // 8 bits por canal
  ihdr[9] = 2 // RGB
  const cor = [0xe5, 0xe7, 0xeb]
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

/** Zera tudo o que se move ou pisca. Complementa `animations: "disabled"` do screenshot (que só cobre animações CSS/WAAPI finitas+infinitas). */
const CSS_CONGELA = `
*, *::before, *::after {
  animation: none !important;
  transition: none !important;
  caret-color: transparent !important;
  scroll-behavior: auto !important;
}
`

/**
 * Prepara a página ANTES do `goto`: relógio fixo, tiles do mapa sem rede e nenhum pedido a hosts externos (fontes/CDN/OSM).
 *
 * Relógio: `setFixedTime` fixa `Date.now()`/`new Date()` mas deixa os timers correrem — o mock calcula "agora", "últimos 30 dias" e a
 * energia da sessão ao vivo a partir de `Date.now()`, e polling/SSE precisam continuar rodando (ver `estados.visual.ts`).
 */
export async function prepararPagina(page: Page, agora: Date = T0) {
  await page.clock.setFixedTime(agora)
  await page.route(/^https?:\/\/[a-z]\.tile\.openstreetmap\.org\//, (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: TILE }),
  )
  await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (route) => {
    // Qualquer host externo que não seja o tile acima (GIS do Google, scripts da Cielo…) vira falha rápida e determinística.
    if (/tile\.openstreetmap\.org/.test(route.request().url())) return route.fallback()
    return route.abort()
  })
}

/** Espera a tela "parar": sem esqueleto/spinner, fontes carregadas, imagens (inclusive lazy) decodificadas e 2 quadros sem mudança de layout. */
export async function aguardarEstavel(page: Page, opts: { heading?: string; text?: string; spinnerEhConteudo?: boolean } = {}) {
  if (opts.heading) await page.getByRole("heading", { name: opts.heading }).first().waitFor({ state: "visible" })
  if (opts.text) await page.getByText(opts.text).first().waitFor({ state: "visible" })

  // O app só monta depois do `await worker.start()` do MSW (main.tsx): até lá `#root` está vazio e "sem esqueleto" seria verdade trivial
  // — foi exatamente assim que a 1ª versão deste harness gravou baseline em BRANCO. Exige conteúdo de verdade antes de qualquer outra coisa.
  await page.waitForFunction(() => (document.getElementById("root")?.childElementCount ?? 0) > 0 && document.body.innerText.trim().length > 20, undefined, {
    timeout: 30_000,
  })
  // `spinnerEhConteudo`: telas cujo ESTADO é "carregando" (ex.: "Conectando ao carregador…") — o spinner é o que se quer fotografar.
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

/**
 * A Inter é `font-display: swap` e variável: o navegador só BAIXA o arquivo quando algum texto a usa, e `document.fonts.ready` pode resolver
 * ANTES disso. Aqui a fonte é PEDIDA e a captura falha se não carregar (sem isso a foto poderia sair na fonte de reserva).
 */
async function garantirInter(page: Page) {
  const ok = await page.evaluate(async () => {
    await Promise.all(["400", "500", "600", "700", "800", "900"].map((w) => document.fonts.load(`${w} 16px Inter`, "AaÇãé0123 R$")))
    await document.fonts.ready
    return document.fonts.check("16px Inter", "AaÇãé0123 R$")
  })
  if (!ok) throw new Error("A fonte Inter não carregou: a captura sairia com a fonte de reserva (baseline instável).")
}

/**
 * Espera o documento "assentar": altura, nº de <img> e nº de nós iguais por ~1 s seguido (10 amostras de 100 ms). Só "3 quadros iguais"
 * NÃO bastava — a landing hidrata seções abaixo da dobra num chunk lazy e o mapa monta o Leaflet depois do primeiro paint.
 */
async function aguardarSemMudanca(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
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

/** Rola a página inteira (dispara `loading="lazy"`), espera cada <img> terminar e volta ao topo. */
async function carregarImagensPreguicosas(page: Page) {
  await page.evaluate(async () => {
    const passo = Math.max(200, Math.floor(window.innerHeight * 0.8))
    for (let y = 0; y < document.documentElement.scrollHeight; y += passo) {
      window.scrollTo(0, y)
      await new Promise((r) => requestAnimationFrame(() => r(null)))
    }
    window.scrollTo(0, 0)
    await Promise.all(
      // Só espera imagem que está EM LAYOUT: `<img loading="lazy">` dentro de `display:none` (ex.: painel `lg:hidden` / `hidden lg:flex`) nunca
      // carrega — por desenho do navegador — e a espera pendurava a rota até o timeout (achado da F-B, nas telas de login/cadastro).
      Array.from(document.images).map((img) =>
        img.complete || img.getClientRects().length === 0 ? Promise.resolve() : new Promise((r) => (img.addEventListener("load", r, { once: true }), img.addEventListener("error", r, { once: true }))),
      ),
    )
    await Promise.all(
      Array.from(document.images)
        .filter((img) => img.getClientRects().length > 0) // decode() de imagem preguiçosa fora de layout também nunca resolve
        .map((img) => img.decode().catch(() => undefined)),
    )
  })
}

/** Opções de screenshot da baseline. JPEG q70: ~5x menor que PNG em página inteira; o diff do Playwright decodifica os dois lados. */
export const OPCOES_FOTO = { type: "jpeg", quality: 70, fullPage: true, animations: "disabled", caret: "hide", scale: "css" } as const

/** Altura máxima que o harness aceita para uma captura (acima disso a rota provavelmente tem lista infinita/bug e a foto viraria um monstro). */
const ALTURA_MAXIMA = 14_000

/**
 * Tira a foto da rota INTEIRA. `fullPage` do Playwright só enxerga a rolagem do documento; os shells do app (Admin, PWA) são `h-screen` com
 * um `<main>` que rola por dentro — sem tratamento, a baseline guardaria só a 1ª tela (achado deste harness: 812 px de um painel com 2.000).
 * Em vez de mexer no CSS (o que mudaria o que está sendo testado), CRESCE a viewport até o rolador principal caber inteiro; sidebar e
 * bottom nav continuam com a geometria real (altura = 100vh da viewport ampliada).
 *
 * `crescerAteODocumento`: telas do PWA têm bottom nav `fixed`; sem crescer, o `fullPage` a desenha no meio da imagem, por cima do conteúdo
 * (a posição "na dobra" da viewport original). NÃO use onde a altura depende de `vh` (landing, login): a viewport gigante esticaria o hero.
 */
export async function fotografar(page: Page, opts: { crescerAteODocumento?: boolean; nome?: string } = {}): Promise<Buffer> {
  const original = page.viewportSize()!
  const extra = await page.evaluate((doc) => {
    let melhor = doc ? Math.max(0, document.documentElement.scrollHeight - window.innerHeight) : 0
    let clientMelhor = 0
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
      const oy = getComputedStyle(el).overflowY
      if ((oy !== "auto" && oy !== "scroll") || el.clientHeight < 300) continue
      const falta = el.scrollHeight - el.clientHeight
      if (falta > 1 && el.clientHeight >= clientMelhor) {
        clientMelhor = el.clientHeight
        melhor = falta
      }
    }
    return melhor
  }, !!opts.crescerAteODocumento)
  if (extra > 0) {
    await page.setViewportSize({ width: original.width, height: Math.min(original.height + extra, ALTURA_MAXIMA) })
    await aguardarLayout(page)
  }
  try {
    // Captura DESCARTADA antes da real. Descoberta da calibração (3 flakes em 114, sempre texto, só no viewport de 768): a PRIMEIRA captura
    // fullPage de uma página saía em ~60% das vezes com outra quebra de linha/altura (texto na métrica da fonte de reserva), e a SEGUNDA, no
    // mesmo instante, era sempre igual à baseline. DOM e `document.fonts` eram idênticos antes das duas (as faces "Inter Fallback" só ficam
    // `loaded` DEPOIS da 1ª captura). Causa raiz não identificada no Chromium; o contorno é fotografar duas vezes e guardar a segunda.
    await page.screenshot({ ...OPCOES_FOTO, quality: 20 })
    // Sonda de geometria (F-A): só com VISUAL_GEO_DIR. Grava o DOM+retângulos+estilos e a imagem da MESMA captura (ver geometria.ts / scripts/comparar-geometria.mjs).
    if (process.env.VISUAL_GEO_DIR && opts.nome) {
      const vp = test.info().project.name
      await gravarGeometria(page, opts.nome, vp)
      const foto = await page.screenshot(OPCOES_FOTO)
      writeFileSync(path.join(process.env.VISUAL_GEO_DIR, `${vp}__${opts.nome}.jpg`), foto)
      return foto
    }
    return await page.screenshot(OPCOES_FOTO)
  } finally {
    if (extra > 0) await page.setViewportSize(original)
  }
}

async function aguardarLayout(page: Page) {
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
  await page.evaluate(() => document.fonts.ready)
}
