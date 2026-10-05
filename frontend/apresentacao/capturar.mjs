/**
 * Captura das telas REAIS (app em modo mock/MSW, dados de demonstração) para os dois PDFs.
 *
 *  - Admin: 1440x900 @2x (janela de navegador).  - Motorista: 390x844 @2x (celular).
 *  - Cada captura é a viewport ("na dobra"), como o usuário vê — nada é montado à mão.
 *  - Ações (diálogos, rolagem, fluxo de recarga) usam os mesmos controles de um usuário; o estado do mock vive na PÁGINA, então o
 *    fluxo da recarga é UMA página só (ver e2e-visual/estados.visual.ts).
 *  - Dados: nenhum mock é alterado. A única "edição" é REMOVER do DOM os dois controles do login que só existem em modo mock
 *    ("Continuar com o Google (mock)" / "Simular conta de operação (mock)") — em produção eles não existem.
 *
 * Saída: apresentacao/capturas/<id>.jpg + manifesto.json (largura/altura em px reais).
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { expect } from "@playwright/test"
import { AGORA, VIEW_ADMIN, VIEW_CELULAR, abrirNavegador, aguardarEstavel, fotografar, login, novoContexto, prepararPagina, subirServidor } from "./lib/navegador.mjs"

const AQUI = path.dirname(fileURLToPath(import.meta.url))
export const PASTA_CAPTURAS = path.join(AQUI, "capturas")
const MANIFESTO = path.join(PASTA_CAPTURAS, "manifesto.json")

const SALTO_AO_VIVO_MS = 30 * 60_000 // 30 min de recarga => 3,50 kWh (7 kW constantes no mock): números de demonstração mais realistas
const SALTO_FIM_MS = 10_000

function lerManifesto() {
  return existsSync(MANIFESTO) ? JSON.parse(readFileSync(MANIFESTO, "utf8")) : {}
}

/** Remove os controles de login que só existem no mock (ver cabeçalho). */
async function removerControlesMock(page) {
  await page.evaluate(() => {
    for (const el of Array.from(document.querySelectorAll("button"))) {
      if (/\(mock\)/.test(el.textContent || "")) {
        const caixa = el.closest(".space-y-4")
        ;(caixa ?? el).remove()
        break
      }
    }
  })
}

async function rolarParaTopo(page, texto) {
  await page.getByText(texto, { exact: true }).first().evaluate((el) => el.scrollIntoView({ block: "start" }))
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
}

/** Cada item: id, rota (ou null quando a página já está no estado certo), acao opcional (page) => Promise, pronto opcional. */
const ADMIN = [
  { id: "adm-dashboard", path: "/admin/dashboard", espera: { text: "Ao vivo" } },
  { id: "adm-dashboard-ao-vivo", path: null, acao: (p) => rolarParaTopo(p, "Movimento de hoje") },
  { id: "adm-sites", path: "/admin/sites" },
  { id: "adm-charge-points", path: "/admin/charge-points" },
  { id: "adm-connectors", path: "/admin/connectors" },
  { id: "adm-tariffs", path: "/admin/tariffs" },
  {
    id: "adm-tariffs-vinculos",
    path: null,
    acao: async (p) => {
      await p.getByRole("button", { name: "Onde Padrão DC vale" }).click()
      await expect(p.getByRole("dialog")).toBeVisible()
    },
  },
  { id: "adm-sessoes", path: "/admin/sessoes" },
  {
    id: "adm-sessoes-detalhe",
    path: null,
    acao: async (p) => {
      // Uma sessão ENCERRADA e paga (retrato mais limpo); a de "encerramento em confirmação" aparece na lista.
      await p.locator("tbody tr").filter({ hasText: "Encerrada" }).first().click()
      await expect(p.getByRole("dialog")).toBeVisible()
    },
  },
  { id: "adm-financeiro", path: "/admin/financeiro" },
  { id: "adm-faturamento", path: "/admin/faturamento" },
  { id: "adm-movimento-diario", path: "/admin/movimento-diario" },
  { id: "adm-pagamentos", path: "/admin/pagamentos" },
  { id: "adm-carteiras", path: "/admin/carteiras" },
  {
    id: "adm-carteiras-extrato",
    path: null,
    acao: async (p) => {
      await p.getByRole("button", { name: /Ver extrato de Juliana Alves/ }).click()
      await expect(p.getByRole("dialog")).toBeVisible()
    },
  },
  {
    id: "adm-auditoria",
    path: "/admin/auditoria",
    // A coluna "Onde" mostra o método+rota técnica da requisição (ex.: "POST /api/admin/..."): nas capturas da apresentação essa linha é
    // ocultada (visibility) para não expor caminhos internos de API; o restante da célula (operador) permanece.
    acao: (p) => p.evaluate(() => document.querySelectorAll("td .font-mono").forEach((el) => (el.style.visibility = "hidden"))),
  },
  { id: "adm-auth-tokens", path: "/admin/auth-tokens" },
  // Gateway: o slide é MARCADO como pendente de recaptura (outra frente está redesenhando a tela). A captura sai em gateway-atual.jpg
  // só para o gerador já suportar a rota; o PDF só a usa com --gateway-pronto.
  { id: "adm-gateway-pagamento", path: "/admin/gateway-pagamento", opcional: true },
]

const OPERADOR = [
  { id: "op-dashboard", path: "/admin/dashboard", espera: { text: "Ao vivo" } },
  { id: "op-acesso-restrito", path: "/admin/auditoria" },
]

async function irPara(page, item) {
  if (item.path) {
    await page.goto(item.path, { waitUntil: "load" })
    await aguardarEstavel(page, item.espera)
  }
  if (item.acao) {
    await item.acao(page)
    await aguardarEstavel(page, { spinnerEhConteudo: false }).catch(() => undefined)
  }
}

async function fotoItem(page, item, manifesto, view, nome = item.id) {
  await fotografar(page, path.join(PASTA_CAPTURAS, `${nome}.jpg`))
  manifesto[nome] = { w: view.width * 2, h: view.height * 2 }
  console.log("  ok", nome)
}

async function fecharDialogo(page) {
  await page.keyboard.press("Escape")
  await page.getByRole("dialog").waitFor({ state: "hidden" }).catch(() => undefined)
}

async function capturarAdmin(browser, manifesto, quais) {
  for (const [persona, lista] of [["admin", ADMIN], ["operator", OPERADOR]]) {
    // Itens sem `path` dependem da página do item anterior: ao refazer só alguns, puxa a "âncora" (com path) junto, sem fotografá-la.
    const escolhidos = new Set()
    lista.forEach((it, i) => {
      if (quais && !quais.includes(it.id)) return
      escolhidos.add(i)
      for (let j = i; j >= 0 && lista[j].path === null; j--) escolhidos.add(j - 1)
    })
    const itens = lista.map((it, i) => ({ ...it, _foto: !quais || quais.includes(it.id) })).filter((_, i) => escolhidos.has(i))
    if (!itens.length) continue
    const ctx = await novoContexto(browser)
    const page = await ctx.newPage()
    await prepararPagina(page)
    await login(page, persona)
    for (const item of itens) {
      try {
        await irPara(page, item)
        if (item._foto) await fotoItem(page, item, manifesto, VIEW_ADMIN)
        if (await page.getByRole("dialog").isVisible().catch(() => false)) await fecharDialogo(page)
      } catch (e) {
        if (item.opcional) console.warn(`  AVISO: ${item.id} não capturado (${String(e.message).split("\n")[0]})`)
        else throw e
      }
    }
    await ctx.close()
  }
}

async function capturarMotorista(browser, manifesto, quais) {
  const quer = (id) => !quais || quais.includes(id)
  const foto = async (page, id, opts, view = VIEW_CELULAR) => {
    await aguardarEstavel(page, opts)
    await fotografar(page, path.join(PASTA_CAPTURAS, `${id}.jpg`))
    manifesto[id] = { w: view.width * 2, h: view.height * 2 }
    console.log("  ok", id)
  }

  // ---- visitante (sem login): landing, cadastro, login, eletropostos, página do QR
  {
    const ctx = await novoContexto(browser, { celular: true })
    const page = await ctx.newPage()
    await prepararPagina(page)
    const telas = [
      ["mot-landing", "/", {}],
      ["mot-cadastro", "/cadastro", { semMock: true }],
      ["mot-login", "/login", { semMock: true }],
      ["mot-eletropostos", "/eletropostos", { heading: "Eletropostos" }],
      ["mot-qr-conectores", "/c/CP-VILA-NORTE-01", {}],
      ["mot-qr-tarifa", "/c/CP-VILA-NORTE-01/1", {}],
    ]
    for (const [id, rota, o] of telas) {
      if (!quer(id)) continue
      await page.goto(rota, { waitUntil: "load" })
      await aguardarEstavel(page, o.heading ? { heading: o.heading } : {})
      if (o.semMock) await removerControlesMock(page)
      await foto(page, id)
    }
    await ctx.close()
  }

  if (quer("mot-landing-desktop")) {
    const ctx = await novoContexto(browser)
    const page = await ctx.newPage()
    await prepararPagina(page)
    await page.goto("/", { waitUntil: "load" })
    await aguardarEstavel(page)
    await foto(page, "mot-landing-desktop", {}, VIEW_ADMIN)
    await ctx.close()
  }

  // ---- motorista com saldo (Carla): início, mapa, carteira, Pix, cartões e o fluxo completo de recarga
  {
    const ctx = await novoContexto(browser, { celular: true })
    const page = await ctx.newPage()
    await prepararPagina(page, { tilesReais: true })
    await login(page, "driver")
    const rotas = [
      ["mot-inicio", "/app"],
      ["mot-mapa-lista", "/app/mapa"],
      ["mot-carteira", "/app/carteira"],
      ["mot-adicionar-saldo", "/app/carteira/adicionar"],
      ["mot-cartoes", "/app/carteira/cartoes"],
    ]
    for (const [id, rota] of rotas) {
      if (!quer(id)) continue
      await page.goto(rota, { waitUntil: "load" })
      await foto(page, id)
    }

    if (quer("mot-pix")) {
      await page.goto("/app/carteira/adicionar", { waitUntil: "load" })
      await aguardarEstavel(page)
      await page.getByRole("radiogroup", { name: "Valores sugeridos" }).getByText("R$ 50,00").click()
      await page.getByRole("button", { name: "Gerar código Pix" }).click()
      await expect(page.getByText("Pix copia e cola")).toBeVisible({ timeout: 20_000 })
      await foto(page, "mot-pix", { spinnerEhConteudo: true })
    }

    if (quer("mot-cartao-isolado")) {
      await page.goto("/app/carteira/cartoes", { waitUntil: "load" })
      await aguardarEstavel(page)
      const [popup] = await Promise.all([ctx.waitForEvent("page"), page.getByRole("button", { name: "Adicionar cartão" }).first().click()])
      await popup.waitForLoadState("load")
      await expect(popup.getByRole("heading", { name: "Cadastrar cartão" })).toBeVisible()
      await foto(popup, "mot-cartao-isolado")
      await popup.close()
    }
    await ctx.close()
  }

  if (quer("mot-mapa")) {
    // Contexto próprio com RELÓGIO REAL (ver prepararPagina): o fade dos tiles do Leaflet depende de Date.now().
    const ctx2 = await novoContexto(browser, { celular: true })
    const page = await ctx2.newPage()
    await prepararPagina(page, { agora: null, tilesReais: true })
    await login(page, "driver")
      // Posição FICTÍCIA (centro de São Paulo) só para ordenar por distância; nada sai do navegador de captura.
      await ctx2.grantPermissions(["geolocation"])
      await ctx2.setGeolocation({ latitude: -23.5505, longitude: -46.6333 })
      await page.goto("/app/mapa", { waitUntil: "load" })
      await aguardarEstavel(page)
      await page.getByRole("button", { name: "Usar minha localização" }).click({ timeout: 4000 }).catch(() => undefined) // com a permissão já concedida o app pode usar a posição sozinho
      await page.getByText(/km/).first().waitFor({ state: "visible", timeout: 20_000 }).catch(() => undefined)
      await page.getByRole("button", { name: "Mapa", exact: true }).click()
      await page.locator(".leaflet-container").waitFor({ state: "visible" })
      await page.locator(".leaflet-marker-icon").first().waitFor({ state: "visible", timeout: 20_000 }).catch(() => undefined)
      await aguardarEstavel(page)
      await page.waitForFunction(() => document.querySelectorAll("img.leaflet-tile-loaded").length >= 4, undefined, { timeout: 20_000 }).catch(() => console.warn("  AVISO: tiles do OpenStreetMap não carregaram (offline?) — mapa sairá sem fundo"))
      await page.waitForTimeout(2000)
      // Rola DEPOIS de estabilizar (aguardarEstavel volta ao topo) e fotografa direto.
      await page.locator(".leaflet-container").evaluate((el) => el.scrollIntoView({ block: "center" }))
      await page.waitForTimeout(600)
      await fotografar(page, path.join(PASTA_CAPTURAS, "mot-mapa.jpg"))
      manifesto["mot-mapa"] = { w: VIEW_CELULAR.width * 2, h: VIEW_CELULAR.height * 2 }
      console.log("  ok mot-mapa")

    await ctx2.close()
  }

  // ---- fluxo da recarga: UMA página só (o estado do mock vive nela)
  if (["mot-fluxo-iniciar", "mot-sessao-conectando", "mot-sessao-ao-vivo", "mot-sessao-parar", "mot-recibo", "mot-historico-apos", "mot-carteira-apos"].some(quer)) {
    const ctx = await novoContexto(browser, { celular: true })
    const page = await ctx.newPage()
    await prepararPagina(page)
    await login(page, "driver")
    await page.goto("/c/CP-VILA-NORTE-01/1", { waitUntil: "load" })
    await aguardarEstavel(page)
    await foto(page, "mot-fluxo-iniciar")
    await page.getByRole("button", { name: "Iniciar recarga" }).click()
    await expect(page).toHaveURL(/\/app\/sessao/)
    await expect(page.getByText("Conectando ao carregador…")).toBeVisible()
    await foto(page, "mot-sessao-conectando", { spinnerEhConteudo: true })
    await page.clock.setFixedTime(new Date(AGORA.getTime() + SALTO_AO_VIVO_MS))
    await expect(page.getByText("Parar recarga").first()).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(/3,5/).first()).toBeVisible({ timeout: 30_000 })
    await foto(page, "mot-sessao-ao-vivo")
    await page.getByRole("button", { name: "Parar recarga" }).first().click()
    await expect(page.getByRole("dialog").getByText("Parar a recarga agora?")).toBeVisible()
    await foto(page, "mot-sessao-parar")
    await page.getByRole("dialog").getByRole("button", { name: "Parar recarga" }).click()
    await page.clock.setFixedTime(new Date(AGORA.getTime() + SALTO_AO_VIVO_MS + SALTO_FIM_MS))
    await expect(page).toHaveURL(/\/app\/sessoes\/.+/, { timeout: 30_000 })
    await expect(page.getByText("Recarga concluída")).toBeVisible()
    await foto(page, "mot-recibo")
    // Navegação SPA (sem goto): o estado do mock mora na página e o goto o zeraria.
    await page.getByRole("link", { name: "Histórico" }).last().click()
    await expect(page).toHaveURL(/\/app\/sessoes$/)
    await foto(page, "mot-historico-apos")
    await page.getByRole("link", { name: "Carteira" }).last().click()
    await expect(page).toHaveURL(/\/app\/carteira$/)
    await foto(page, "mot-carteira-apos")
    await ctx.close()
  }

  // ---- motorista com recibos pré-semeados (Tiago): histórico e sessão não confirmada
  {
    const ctx = await novoContexto(browser, { celular: true })
    const page = await ctx.newPage()
    await prepararPagina(page)
    await login(page, "travado")
    const rotas = [
      ["mot-historico", "/app/sessoes"],
      ["mot-sessao-falha", "/app/sessao"],
      ["mot-recibo-fechada-pelo-servidor", "/app/sessoes/me_seed_server_closed"],
      ["mot-recibo-nao-confirmado-carteira", "/app/sessoes/me_seed_unconfirmed_wallet"],
      ["mot-recibo-nao-confirmado-cartao", "/app/sessoes/me_seed_unconfirmed_card"],
    ]
    for (const [id, rota] of rotas) {
      if (!quer(id)) continue
      await page.goto(rota, { waitUntil: "load" })
      await foto(page, id)
    }
    await ctx.close()
  }
}

export async function capturar({ quais } = {}) {
  mkdirSync(PASTA_CAPTURAS, { recursive: true })
  const manifesto = lerManifesto()
  const servidor = await subirServidor()
  const browser = await abrirNavegador()
  try {
    console.log("Admin e operador…")
    await capturarAdmin(browser, manifesto, quais)
    console.log("Motorista…")
    await capturarMotorista(browser, manifesto, quais)
  } finally {
    writeFileSync(MANIFESTO, JSON.stringify(manifesto, null, 1))
    await browser.close()
    await servidor.parar()
  }
}

if (process.argv[1]?.endsWith("capturar.mjs")) {
  const arg = process.argv.find((a) => a.startsWith("--quais="))
  await capturar({ quais: arg ? arg.slice(8).split(",") : undefined })
}
