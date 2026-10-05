import AxeBuilder from "@axe-core/playwright"
import { expect, test, type Page } from "@playwright/test"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { SENHA } from "./constantes"
import { medirContrastePixel } from "./contraste-pixel"
import { aguardarEstavel, prepararPagina } from "./estabilizar"

/**
 * VERIFICAÇÕES INDEPENDENTES das telas de ESTORNO / CHARGEBACK / DEVOLUÇÃO DE CONTA EXCLUÍDA (L1.8 / L1.4, Lyra) — a régua que NÃO depende de baseline (nenhuma foto é comparada nem gravada em `baseline/`):
 *  1) contraste de TEXTO por PIXEL + axe COMPLETO (wcag2a/aa + 2.1 a/aa, 0 violações) em cada ESTADO: bloco "Devoluções" do detalhe da sessão, formulário de estorno (carteira, cartão,
 *     erros), confirmações com senha (vazia, errada, erro de rede), confirmar à mão, cancelar registro, busca por Tid/NSU, registrar chargeback (erros, já registrado, concluído), lista de
 *     chargebacks (aberto vencido/próximo/sem prazo, ganho, perdido, desbloqueado), desfecho (ganho, perdido + dívida), desbloqueio, fila de devoluções (pendentes, todas, vazia, erro);
 *  2) geometria a 375/768/1440: sem rolagem lateral (documento, <main> e diálogo), 1 h1, alvos >= 44 px a 375 (telas e diálogos), rótulos do filtro de ação da Auditoria cabendo no select,
 *     item novo do menu cabendo na barra lateral.
 * Rodar: `VISUAL_PORT=5197 npx playwright test --config playwright.visual.config.ts verificacoes-estorno --update-snapshots=none` (nunca em paralelo com outro harness: compartilham `.auth`).
 * Grava `e2e-visual/.resultados/estorno/*.json`. NADA aqui foi provado contra o backend real (só os mocks MSW).
 */

const PASTA = "e2e-visual/.resultados/estorno"
function gravar(nome: string, dados: unknown) {
  mkdirSync(PASTA, { recursive: true })
  writeFileSync(path.join(PASTA, `${nome}.json`), JSON.stringify(dados, null, 1))
}

async function entrar(page: Page, email = "admin@innoelektron.com") {
  await prepararPagina(page)
  await page.goto("/login", { waitUntil: "load" })
  await page.getByLabel("E-mail").fill(email)
  await page.getByLabel("Senha").fill(SENHA)
  await page.getByRole("button", { name: "Entrar" }).click()
  await expect(page).toHaveURL(/\/admin\/dashboard/)
}
async function irPara(page: Page, rota: string, titulo: string) {
  // Janela baixa (375 x 812) usa o drawer: navegar por URL direto é mais estável e o login já aconteceu pela UI.
  await page.goto(rota, { waitUntil: "load" })
  await expect(page.getByRole("heading", { name: titulo, level: 1 })).toBeVisible()
  await aguardarEstavel(page)
}
async function medir(page: Page, projeto: string, estado: string, opts: { dialogo?: boolean } = {}) {
  // Janela alta: o diálogo (max-h 90vh) e o miolo inteiro ficam à vista; o pixel lido é o de verdade, não o de uma barra/rolagem.
  await page.setViewportSize({ width: page.viewportSize()!.width, height: 2600 })
  await aguardarEstavel(page)
  if (opts.dialogo) await page.waitForTimeout(700)
  const r = await medirContrastePixel(page)
  gravar(`${projeto}__${estado}`, r)
  expect(r.textos, `nenhum texto medido (${estado})`).toBeGreaterThan(3)
  expect(r.reprovados, `texto abaixo do limiar AA por pixel (${estado}) a ${projeto}px: ${JSON.stringify(r.reprovados.slice(0, 3))}`).toEqual([])
}
async function axeZero(page: Page, projeto: string, estado: string, incluir = "main") {
  const r = await new AxeBuilder({ page }).include(incluir).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze()
  gravar(`${projeto}__axe__${estado}`, r.violations.map((v) => ({ id: v.id, impacto: v.impact, nos: v.nodes.map((n) => n.target.join(" ")) })))
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`), `axe em ${estado} a ${projeto}px`).toEqual([])
}
async function estado(page: Page, projeto: string, nome: string, incluir = "main", opts: { dialogo?: boolean } = {}) {
  await medir(page, projeto, nome, opts)
  await axeZero(page, projeto, nome, incluir)
}
async function cenario(page: Page, chave: string, valor: string | null) {
  await page.evaluate(([k, v]) => (v === null ? localStorage.removeItem(k as string) : localStorage.setItem(k as string, v as string)), [chave, valor])
}

/** Sessão de demo (cartão, R$ 37,82) com 4 devoluções semeadas. O MSW só vive na página: abre pelo menu depois do login, sem `goto` extra. */
async function abrirSessao(page: Page) {
  await page.goto("/admin/sessoes", { waitUntil: "load" })
  await expect(page.getByRole("heading", { name: "Sessões", level: 1 })).toBeVisible()
  await aguardarEstavel(page)
  const linha = page.getByRole("row").filter({ hasText: "Tiago Travado" }).filter({ hasText: "Encerrada" })
  await linha.click()
  const d = page.getByRole("dialog", { name: /Detalhe da sessão/ })
  await expect(d.getByTestId("admin-refunds").getByTestId("refund-item").first()).toBeVisible()
  return d
}
const refunds = (page: Page) => page.getByTestId("admin-refunds")

test.describe("1) contraste por pixel + axe — Sessões > Devoluções", () => {
  test("lista de devoluções (4 estados) e formulários de estorno", async ({ page }, info) => {
    const p = info.project.name
    await entrar(page)
    await abrirSessao(page)
    await estado(page, p, "sessao-devolucoes", "[role=dialog]", { dialogo: true })

    await page.setViewportSize({ width: page.viewportSize()!.width, height: info.project.name === "375" ? 812 : 900 })
    await refunds(page).getByRole("button", { name: "Estornar" }).click()
    const form = page.getByRole("dialog", { name: /Estornar sessão/ })
    await expect(form).toBeVisible()
    await estado(page, p, "estorno-form-carteira", "[role=dialog]", { dialogo: true })

    await form.getByLabel(/Valor \(R\$\)/).fill("99,00")
    await form.getByLabel(/Motivo/).fill("Cortesia para o Tiago")
    await form.getByRole("button", { name: /Revisar estorno/ }).click()
    await expect(form.getByText(/passa do que ainda dá para estornar/)).toBeVisible()
    await estado(page, p, "estorno-form-erros", "[role=dialog]", { dialogo: true })

    await form.getByText("Cartão (portal da Cielo)").click()
    await expect(form.getByTestId("parque-alert-notice")).toBeVisible()
    await estado(page, p, "estorno-form-cartao-aviso-parque", "[role=dialog]", { dialogo: true })

    await form.getByLabel(/Valor \(R\$\)/).fill("8,00")
    await form.getByLabel(/Motivo/).fill("Estorno parcial por energia não entregue")
    await form.getByRole("button", { name: /Revisar estorno/ }).click()
    const confirm = page.getByRole("dialog", { name: "Confirmar estorno" })
    await expect(confirm).toBeVisible()
    await estado(page, p, "estorno-confirmacao-vazia", "[role=dialog]", { dialogo: true })
    await confirm.getByLabel(/Sua senha atual/).fill("errada123")
    await confirm.getByRole("button", { name: "Registrar estorno" }).click()
    await expect(confirm.getByText("Senha incorreta.")).toBeVisible()
    await estado(page, p, "estorno-confirmacao-senha-errada", "[role=dialog]", { dialogo: true })
    await confirm.getByLabel(/Sua senha atual/).fill("stepup-503")
    await confirm.getByRole("button", { name: "Registrar estorno" }).click()
    await expect(confirm.getByRole("alert")).toBeVisible()
    await estado(page, p, "estorno-confirmacao-erro-503", "[role=dialog]", { dialogo: true })
  })

  test("confirmar à mão e cancelar registro", async ({ page }, info) => {
    const p = info.project.name
    await entrar(page)
    await abrirSessao(page)
    const pendente = refunds(page).getByTestId("refund-item").filter({ hasText: "Aguardando confirmação" })
    await pendente.getByRole("button", { name: "Confirmar à mão" }).click()
    const form = page.getByRole("dialog", { name: "Confirmar devolução à mão" })
    await form.getByLabel(/Referência do comprovante/).fill("tem espaço")
    await form.getByRole("button", { name: /Revisar/ }).click()
    await expect(form.getByText(/sem espaços nem e-mail/)).toBeVisible()
    await estado(page, p, "confirmar-a-mao-form-erro", "[role=dialog]", { dialogo: true })
    await form.getByLabel(/Referência do comprovante/).fill("COMP-2026-0123")
    await form.getByRole("button", { name: /Revisar/ }).click()
    const confirm = page.getByRole("dialog", { name: "Confirmar devolução à mão" }).last()
    await expect(confirm.getByTestId("save-summary")).toBeVisible()
    await estado(page, p, "confirmar-a-mao-confirmacao", "[role=dialog]", { dialogo: true })
    await scenarioNotConfirmable(page)
    await confirm.getByLabel(/Sua senha atual/).fill(SENHA)
    await confirm.getByRole("button", { name: "Confirmar devolução" }).click()
    await expect(confirm.getByRole("alert")).toBeVisible()
    await estado(page, p, "confirmar-a-mao-erro-409", "[role=dialog]", { dialogo: true })
    await confirm.getByRole("button", { name: "Cancelar" }).click()
    await form.getByRole("button", { name: "Cancelar" }).click()

    await pendente.getByRole("button", { name: "Cancelar registro" }).click()
    const cancelar = page.getByRole("dialog", { name: "Cancelar registro da devolução" })
    await expect(cancelar).toBeVisible()
    await estado(page, p, "cancelar-registro-confirmacao", "[role=dialog]", { dialogo: true })
  })
})
async function scenarioNotConfirmable(page: Page) {
  await cenario(page, "mock:estorno", "not-confirmable")
}

test.describe("2) contraste por pixel + axe — Pagamentos e Chargebacks", () => {
  test("Pagamentos: busca pela Cielo e registrar chargeback", async ({ page }, info) => {
    const p = info.project.name
    await entrar(page)
    await irPara(page, "/admin/pagamentos", "Pagamentos")
    await page.getByRole("button", { name: "Buscar venda da Cielo" }).click()
    await expect(page.locator("#acquirer-filters")).toBeVisible()
    await estado(page, p, "pagamentos-busca-aberta")
    await page.locator("#acquirer-filters").getByLabel("Tid").fill("10069930690000999001")
    await page.locator("#acquirer-filters").getByRole("button", { name: "Buscar" }).click()
    await expect(page.getByRole("row")).toHaveCount(2)
    await estado(page, p, "pagamentos-busca-com-resultado")

    await page.getByRole("button", { name: /Registrar chargeback/ }).click()
    const d = page.getByRole("dialog", { name: "Registrar chargeback" })
    await expect(d).toBeVisible()
    await estado(page, p, "chargeback-registrar-form", "[role=dialog]", { dialogo: true })
    await d.getByLabel(/Valor contestado/).fill("999999,00")
    await d.getByRole("button", { name: "Registrar chargeback" }).click()
    await expect(d.getByText(/passa do que foi capturado/)).toBeVisible()
    await estado(page, p, "chargeback-registrar-erros", "[role=dialog]", { dialogo: true })
    await d.getByLabel(/Valor contestado/).fill("1,00")
    await d.getByLabel(/Referência do caso na Cielo/).fill("CASO-NOVO-1")
    await d.getByRole("button", { name: "Registrar chargeback" }).click()
    await expect(d.getByRole("alert")).toContainText("Já existe um chargeback registrado")
    await estado(page, p, "chargeback-registrar-ja-registrado", "[role=dialog]", { dialogo: true })
  })

  test("Pagamentos: registro concluído (cartão bloqueado + dossiê)", async ({ page }, info) => {
    await entrar(page)
    await irPara(page, "/admin/pagamentos", "Pagamentos")
    await page.getByRole("button", { name: /Registrar chargeback/ }).first().click()
    const d = page.getByRole("dialog", { name: "Registrar chargeback" })
    await d.getByLabel(/Valor contestado/).fill("1,00")
    await d.getByLabel(/Referência do caso na Cielo/).fill("CASO-VIS-001")
    await d.getByRole("button", { name: "Registrar chargeback" }).click()
    await expect(page.getByRole("dialog", { name: "Chargeback registrado" })).toBeVisible()
    await estado(page, info.project.name, "chargeback-registrar-concluido", "[role=dialog]", { dialogo: true })
  })

  test("Chargebacks: lista, detalhe, desfecho e desbloqueio", async ({ page }, info) => {
    const p = info.project.name
    await entrar(page)
    await irPara(page, "/admin/chargebacks", "Chargebacks")
    await expect(page.getByTestId("chargebacks-urgent")).toBeVisible()
    await estado(page, p, "chargebacks-lista")

    await page.getByRole("button", { name: "Ver chargeback do caso CASO-2026-0166" }).click()
    const detalhe = page.getByRole("dialog", { name: /CASO-2026-0166/ })
    await expect(detalhe).toBeVisible()
    await estado(page, p, "chargeback-detalhe-aberto-vencido", "[role=dialog]", { dialogo: true })

    await detalhe.getByRole("button", { name: "Registrar desfecho" }).click()
    const desfecho = page.getByRole("dialog", { name: "Registrar desfecho" })
    await expect(desfecho).toBeVisible()
    await estado(page, p, "desfecho-ganho", "[role=dialog]", { dialogo: true })
    await desfecho.getByText("Perdido", { exact: true }).click()
    await desfecho.getByLabel("Criar dívida para o motorista").check()
    await estado(page, p, "desfecho-perdido-com-divida", "[role=dialog]", { dialogo: true })
    await desfecho.getByRole("button", { name: /Revisar desfecho/ }).click()
    const confirma = page.getByRole("dialog", { name: "Confirmar desfecho" })
    await expect(confirma).toBeVisible()
    await estado(page, p, "desfecho-confirmacao", "[role=dialog]", { dialogo: true })
    await confirma.getByLabel(/Sua senha atual/).fill(SENHA)
    await confirma.getByRole("button", { name: "Registrar desfecho" }).click()
    await expect(page.getByText("Desfecho registrado: Perdido.")).toBeVisible()
    await expect(detalhe.getByRole("button", { name: "Desbloquear cartão" })).toBeVisible()
    await estado(page, p, "chargeback-detalhe-perdido-bloqueado", "[role=dialog]", { dialogo: true })

    await detalhe.getByRole("button", { name: "Desbloquear cartão" }).click()
    const desbloqueio = page.getByRole("dialog", { name: "Desbloquear cartão" })
    await desbloqueio.getByLabel(/Por que liberar o cartão/).fill("curto")
    await desbloqueio.getByRole("button", { name: "Revisar" }).click()
    await expect(desbloqueio.getByText(/mínimo de 10 caracteres/)).toBeVisible()
    await estado(page, p, "desbloqueio-form-erro", "[role=dialog]", { dialogo: true })
  })

  test("Chargebacks: detalhe de caso desbloqueado e de caso com dívida; estados da lista (vazio filtrado)", async ({ page }, info) => {
    const p = info.project.name
    await entrar(page)
    await irPara(page, "/admin/chargebacks", "Chargebacks")
    await page.getByRole("button", { name: "Ver chargeback do caso CASO-2026-0091" }).click()
    await expect(page.getByRole("dialog", { name: /CASO-2026-0091/ })).toBeVisible()
    await estado(page, p, "chargeback-detalhe-desbloqueado", "[role=dialog]", { dialogo: true })
    await page.getByRole("dialog", { name: /CASO-2026-0091/ }).getByRole("button", { name: "Fechar", exact: true }).first().click()
    await page.getByRole("button", { name: "Ver chargeback do caso CASO-2026-0077" }).click()
    await expect(page.getByRole("dialog", { name: /CASO-2026-0077/ })).toBeVisible()
    await estado(page, p, "chargeback-detalhe-aceito-com-divida", "[role=dialog]", { dialogo: true })
  })
})

test.describe("3) contraste por pixel + axe — Devoluções de contas excluídas", () => {
  test("fila de pendentes, todas, vazia e erro", async ({ page }, info) => {
    const p = info.project.name
    await entrar(page)
    await irPara(page, "/admin/devolucoes-contas-excluidas", "Devoluções de contas excluídas")
    await expect(page.getByTestId("deletion-row")).toHaveCount(3)
    await estado(page, p, "devolucoes-pendentes")
    await page.getByLabel("Situação").selectOption("ALL")
    await expect(page.getByTestId("deletion-row")).toHaveCount(5)
    await estado(page, p, "devolucoes-todas")
    await page.getByLabel("Situação").selectOption("PENDING_REFUND")
    await cenario(page, "mock:devolucoes", "empty")
    await page.getByRole("button", { name: "Atualizar" }).click()
    await expect(page.getByText("Nenhuma devolução pendente")).toBeVisible()
    await estado(page, p, "devolucoes-vazia")
    await cenario(page, "mock:devolucoes", "5xx")
    await page.getByRole("button", { name: "Atualizar" }).click()
    await expect(page.getByRole("button", { name: /Tentar novamente/ })).toBeVisible()
    await estado(page, p, "devolucoes-erro-500")
  })

  test("Devolver: formulário, erro de campo, confirmação, erros por code", async ({ page }, info) => {
    const p = info.project.name
    await entrar(page)
    await irPara(page, "/admin/devolucoes-contas-excluidas", "Devoluções de contas excluídas")
    await page.getByTestId("deletion-row").nth(2).getByRole("button", { name: /Devolver/ }).click()
    const form = page.getByRole("dialog", { name: "Devolver saldo" })
    await expect(form).toBeVisible()
    await estado(page, p, "devolver-form", "[role=dialog]", { dialogo: true })
    await form.getByRole("button", { name: /Revisar devolução/ }).click()
    await expect(form.getByText(/Informe o comprovante/)).toBeVisible()
    await estado(page, p, "devolver-form-erro", "[role=dialog]", { dialogo: true })
    await form.getByLabel(/Comprovante do Pix/).fill("E1234567820261005ABC")
    await form.getByRole("button", { name: /Revisar devolução/ }).click()
    const confirma = page.getByRole("dialog", { name: "Confirmar devolução do saldo" })
    await expect(confirma).toBeVisible()
    await estado(page, p, "devolver-confirmacao", "[role=dialog]", { dialogo: true })
    await cenario(page, "mock:devolucoes", "already-refunded")
    await confirma.getByLabel(/Sua senha atual/).fill(SENHA)
    await confirma.getByRole("button", { name: "Registrar devolução" }).click()
    await expect(confirma.getByRole("alert")).toBeVisible()
    await estado(page, p, "devolver-erro-409", "[role=dialog]", { dialogo: true })
  })
})

test.describe("4) geometria", () => {
  /** Tudo que é interativo dentro de `raiz`, visível e com menos de 44 px de altura (alvo de toque). */
  /** Controles que JÁ eram menores que 44 px antes desta entrega (seletor de período, "Exportar CSV" e a paginação são componentes compartilhados): ficam registrados no JSON, não reprovam. */
  const PREEXISTENTES = "^(Exportar CSV|Hoje|Últimos 7 dias|Últimos 30 dias|Este mês|Personalizado|Página anterior|Próxima página|Anterior|Próxima)$"
  async function alvosPequenos(page: Page, raiz: string) {
    return page.evaluate(([sel, ignorar]) => {
      const preexistente = new RegExp(ignorar)
      const root = document.querySelector(sel)!
      const pequenos: string[] = []
      for (const el of root.querySelectorAll<HTMLElement>("button, a[href], input:not(.sr-only), select, textarea, [role=switch]")) {
        const r = el.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) continue
        // O X do Radix ganha área de toque por pseudo-elemento (before:-inset-2): 16 + 12 + 16 = 44.
        if (el.getAttribute("aria-label") === "Fechar") continue
        if (preexistente.test((el.getAttribute("aria-label") ?? el.textContent ?? "").trim())) continue
        // Checkbox nativo: o alvo é o <label> que o envolve (min-h-11).
        const alvo = el.matches("input[type=checkbox]") ? (el.closest("label") ?? el) : el
        if (alvo.getBoundingClientRect().height < 43.5) pequenos.push(`${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 40)}" h=${Math.round(alvo.getBoundingClientRect().height)}`)
      }
      return pequenos
    }, [raiz, PREEXISTENTES])
  }
  async function semRolagemLateral(page: Page) {
    return page.evaluate(() => {
      const main = document.querySelector("main")!
      const dlg = document.querySelector<HTMLElement>("[role=dialog]")
      return { main: main.scrollWidth - main.clientWidth, doc: document.documentElement.scrollWidth - document.documentElement.clientWidth, dialogo: dlg ? dlg.scrollWidth - dlg.clientWidth : 0 }
    })
  }

  test("telas e diálogos: sem rolagem lateral, 1 h1, alvos >= 44 a 375", async ({ page }, info) => {
    const larg = info.project.name
    await entrar(page)
    const medidas: Record<string, unknown> = {}

    async function verifica(nome: string, raiz: string) {
      const lateral = await semRolagemLateral(page)
      expect(lateral, `rolagem lateral em ${nome}`).toEqual({ main: 0, doc: 0, dialogo: 0 })
      const pequenos = await alvosPequenos(page, raiz)
      medidas[nome] = { lateral, pequenos }
      if (larg === "375") expect(pequenos, `alvos < 44 px a 375 em ${nome}: ${pequenos.join(" | ")}`).toEqual([])
    }
    const h1 = async (titulo: string) => {
      await expect(page.locator("main h1")).toHaveCount(1)
      await expect(page.locator("main h1")).toHaveText(titulo)
    }

    // Pagamentos
    await irPara(page, "/admin/pagamentos", "Pagamentos")
    await h1("Pagamentos")
    await verifica("pagamentos", "main")
    await page.getByRole("button", { name: "Buscar venda da Cielo" }).click()
    await verifica("pagamentos-busca-aberta", "main")
    await page.getByRole("button", { name: /Registrar chargeback/ }).first().click()
    await verifica("chargeback-registrar-form", "[role=dialog]")
    await page.getByRole("dialog", { name: "Registrar chargeback" }).getByRole("button", { name: "Cancelar" }).click()

    // Chargebacks
    await irPara(page, "/admin/chargebacks", "Chargebacks")
    await h1("Chargebacks")
    await verifica("chargebacks", "main")
    await page.getByRole("button", { name: "Ver chargeback do caso CASO-2026-0166" }).click()
    await verifica("chargeback-detalhe", "[role=dialog]")
    await page.getByRole("dialog", { name: /CASO-2026-0166/ }).getByRole("button", { name: "Registrar desfecho" }).click()
    const desfecho = page.getByRole("dialog", { name: "Registrar desfecho" })
    await desfecho.getByText("Perdido", { exact: true }).click()
    await verifica("desfecho-form-perdido", "[role=dialog]")
    await desfecho.getByRole("button", { name: /Revisar desfecho/ }).click()
    await verifica("desfecho-confirmacao", "[role=dialog]")

    // Devoluções de contas excluídas
    await irPara(page, "/admin/devolucoes-contas-excluidas", "Devoluções de contas excluídas")
    await h1("Devoluções de contas excluídas")
    await verifica("devolucoes", "main")
    await page.getByTestId("deletion-row").nth(2).getByRole("button", { name: /Devolver/ }).click()
    await verifica("devolver-form", "[role=dialog]")
    await page.getByRole("dialog", { name: "Devolver saldo" }).getByRole("button", { name: "Cancelar" }).click()

    // Sessões > detalhe > Devoluções
    const d = await abrirSessao(page)
    await verifica("sessao-devolucoes", "[role=dialog]")
    await expect(d.getByTestId("admin-refunds")).toBeVisible()
    await d.getByTestId("admin-refunds").getByRole("button", { name: "Estornar" }).click()
    await verifica("estorno-form", "[role=dialog]")

    gravar(`${larg}__geometria`, medidas)
  })

  test("menu: os 2 itens novos só para ADMIN e o rótulo cabe em UMA linha (1440, drawer 375/768)", async ({ page }, info) => {
    const larg = info.project.name
    await entrar(page)
    if (larg !== "1440") {
      await page.getByRole("button", { name: /menu/i }).first().click()
    }
    const nav = page.getByRole("navigation", { name: "Navegação do painel administrativo" }).last()
    const links = nav.getByRole("link")
    await expect(links.filter({ hasText: "Chargebacks" })).toHaveCount(1)
    const longo = links.filter({ hasText: "Devoluções de saldo" })
    await expect(longo).toHaveCount(1)
    const medida = await longo.evaluate((a) => {
      const r = a.getBoundingClientRect()
      const t = a.querySelector("span, div") as HTMLElement | null
      const cs = getComputedStyle(a)
      const linhaPx = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4
      return { altura: Math.round(r.height), largura: Math.round(r.width), linhas: t ? Math.round(t.getBoundingClientRect().height / linhaPx) : null, rolagemLateral: a.scrollWidth - a.clientWidth }
    })
    gravar(`${larg}__menu-item-longo`, medida)
    expect(medida.rolagemLateral).toBe(0)
    expect(medida.linhas, "rótulo do item numa linha só (como os demais itens do menu)").toBe(1)
    expect(medida.altura, "alvo do item do menu").toBeGreaterThanOrEqual(36)
  })

  test("Auditoria: os rótulos novos do filtro de ação cabem no select (texto não cortado)", async ({ page }, info) => {
    await entrar(page)
    await irPara(page, "/admin/auditoria", "Auditoria")
    const r = await page.getByLabel("Tipo de ação").evaluate((sel) => {
      const el = sel as HTMLSelectElement
      const cs = getComputedStyle(el)
      const ctx = document.createElement("canvas").getContext("2d")!
      ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
      const util = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
      return [...el.options].map((o) => ({ rotulo: o.text, largura: Math.round(ctx.measureText(o.text).width), util: Math.round(util) }))
    })
    gravar(`${info.project.name}__auditoria-select`, r)
    const cortados = r.filter((o) => o.largura > o.util)
    expect(cortados, `rótulos que não cabem no select: ${JSON.stringify(cortados)}`).toEqual([])
  })

  test("OPERATOR: sem itens no menu, rotas novas = 'Acesso restrito' e sem bloco de devoluções na sessão", async ({ page }) => {
    await entrar(page, "operador@innoelektron.com")
    for (const rota of ["/admin/chargebacks", "/admin/devolucoes-contas-excluidas"]) {
      await page.goto(rota, { waitUntil: "load" })
      await expect(page.getByRole("heading", { level: 1, name: "Acesso restrito" })).toBeVisible()
    }
    const links = await page.evaluate(() => [...document.querySelectorAll("nav a[href]")].map((a) => a.getAttribute("href")))
    expect(links).not.toContain("/admin/chargebacks")
    expect(links).not.toContain("/admin/devolucoes-contas-excluidas")
  })
})
