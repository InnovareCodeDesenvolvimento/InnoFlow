import AxeBuilder from "@axe-core/playwright"
import { expect, test, type Page } from "@playwright/test"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { SENHA, T0 } from "./constantes"
import { medirContrastePixel } from "./contraste-pixel"
import { aguardarEstavel, prepararPagina } from "./estabilizar"

/**
 * Régua do diálogo "Iniciar recarga" (L1.5, Admin → Pontos de recarga), medida no NAVEGADOR nas 3 larguras do harness (375 / 768 / 1440) - não deduzida do CSS
 * (skill `medir-antes-de-afirmar`). Para cada ESTADO do diálogo: geometria (cabe na janela, sem rolagem lateral, alvos de toque), axe (TODAS as regras, 0 violações) e contraste
 * de texto por pixel (0 reprovados, com o diálogo rolado ao topo E ao fim, porque ele rola por dentro a 375). Grava `e2e-visual/.resultados/recarga-remota/<largura>__<estado>.json` e `.png`
 * (para revisar a olho; NÃO é baseline: o `test:visual` só compara o que a Íris classificar e gravar).
 * Rodar: `npx playwright test --config playwright.visual.config.ts criterios-recarga-remota --update-snapshots=none`.
 *
 * Estados (conta ADMIN do mock; relógio fixo, saltos explícitos para o mock sair de PENDING): form vazio · form preenchido (busca com dívida, motorista escolhido, motivo longo) ·
 * confirmação com dívida + erro por code · aguardando · recusado · aceito.
 */

const PASTA = "e2e-visual/.resultados/recarga-remota"
const CP = "CP-VILA-NORTE-01"
const MOTIVO = "Motorista sem bateria no celular, recarga iniciada pelo suporte por telefone a pedido do cliente que está no local"

function gravar(nome: string, dados: unknown) {
  mkdirSync(PASTA, { recursive: true })
  writeFileSync(path.join(PASTA, `${nome}.json`), JSON.stringify(dados, null, 1))
}

async function entrar(page: Page) {
  await prepararPagina(page)
  await page.goto("/login", { waitUntil: "load" })
  await page.getByLabel("E-mail").fill("admin@innoelektron.com")
  await page.getByLabel("Senha").fill(SENHA)
  await page.getByRole("button", { name: "Entrar" }).click()
  await expect(page).toHaveURL(/\/admin\/dashboard/)
  await page.goto("/admin/charge-points", { waitUntil: "load" })
  await aguardarEstavel(page)
}

const dialogo = (page: Page) => page.getByRole("dialog", { name: "Iniciar recarga" })

async function abrir(page: Page) {
  await page.getByRole("button", { name: `Comandos de ${CP}` }).click()
  await page.getByRole("menuitem", { name: /Iniciar recarga/ }).click()
  await expect(dialogo(page)).toBeVisible()
  await page.waitForTimeout(500) // entrada animada do Dialog (reduced-motion: ~0), margem
}

async function geometria(page: Page) {
  return page.evaluate(() => {
    const d = document.querySelector<HTMLElement>('[role="dialog"]')!
    const r = d.getBoundingClientRect()
    const visivel = (el: Element) => {
      const b = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      return b.width > 0 && b.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"
    }
    // Alvos: campos, botões, links e a LINHA inteira de cada opção (o <input> radio é sr-only; o alvo real é o <label>). O "X" do Radix tem hit-area estendida por ::before (-inset-2).
    const alvos = [...d.querySelectorAll("input:not([type=radio]), textarea, button:not([aria-label='Fechar']), a, label:has(input[type=radio])")]
      .filter(visivel)
      .map((e) => {
        const b = e.getBoundingClientRect()
        return { nome: (e.getAttribute("aria-label") ?? e.textContent ?? e.tagName).trim().replace(/\s+/g, " ").slice(0, 44), h: Math.round(b.height * 10) / 10, w: Math.round(b.width * 10) / 10 }
      })
    const fechar = d.querySelector("button[aria-label='Fechar']")!.getBoundingClientRect()
    const rodape = [...d.querySelectorAll("button, a")].filter((e) => visivel(e) && /Revisar|Iniciar recarga|Voltar|Cancelar|Concluir|Fechar janela|Tentar|Ver sessões/.test(e.textContent ?? "")).map((e) => e.getBoundingClientRect())
    return {
      janela: { w: window.innerWidth, h: window.innerHeight },
      dialogo: { x: r.x, y: r.y, w: r.width, h: r.height, direita: r.right, base: r.bottom },
      rolaPorDentro: d.scrollHeight > d.clientHeight + 1,
      sobraLateralDialogo: d.scrollWidth - d.clientWidth,
      sobraLateralPagina: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      alvos,
      fechar: { w: Math.round(fechar.width), h: Math.round(fechar.height) },
      estourados: [...d.querySelectorAll("*")].filter((e) => visivel(e) && e.getBoundingClientRect().right > r.right + 1).slice(0, 5).map((e) => `${e.tagName.toLowerCase()} ${Math.round(e.getBoundingClientRect().right - r.right)}px além`),
      rodapeDentro: rodape.every((b) => b.left >= r.left - 1 && b.right <= r.right + 1),
      h3: [...d.querySelectorAll("h3")].map((h) => (h.textContent ?? "").trim()),
      ativo: (document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName ?? "") + "",
      ativoRole: document.activeElement?.getAttribute("role") ?? "",
    }
  })
}

async function medirEstado(page: Page, projeto: string, estado: string) {
  const g = await geometria(page)
  const axe = await new AxeBuilder({ page }).analyze()
  // Contraste por pixel: diálogo no topo e rolado até o fim (a 375 o formulário rola por dentro).
  await page.evaluate(() => (document.querySelector('[role="dialog"]') as HTMLElement).scrollTo(0, 0))
  const topo = await medirContrastePixel(page)
  await page.evaluate(() => (document.querySelector('[role="dialog"]') as HTMLElement).scrollTo(0, 99999))
  const fim = await medirContrastePixel(page)
  await page.evaluate(() => (document.querySelector('[role="dialog"]') as HTMLElement).scrollTo(0, 0))
  await page.screenshot({ path: path.join(PASTA, `${projeto}__${estado}.png`), animations: "disabled", caret: "hide" })
  gravar(`${projeto}__${estado}`, { estado, ...g, axe: axe.violations.map((v) => ({ id: v.id, impacto: v.impact, nos: v.nodes.map((n) => n.target.join(" ")).slice(0, 4) })), contraste: { topo: { textos: topo.textos, menor: topo.menor }, fim: { textos: fim.textos, menor: fim.menor } } })

  // ---- Geometria ----
  expect(g.dialogo.x, `[${estado}] diálogo vaza pela esquerda`).toBeGreaterThanOrEqual(0)
  expect(g.dialogo.direita, `[${estado}] diálogo vaza pela direita`).toBeLessThanOrEqual(g.janela.w + 0.5)
  expect(g.dialogo.base, `[${estado}] diálogo vaza por baixo`).toBeLessThanOrEqual(g.janela.h + 0.5)
  expect(g.sobraLateralDialogo, `[${estado}] rolagem lateral dentro do diálogo`).toBeLessThanOrEqual(0)
  expect(g.sobraLateralPagina, `[${estado}] rolagem lateral na página`).toBe(0)
  expect(g.estourados, `[${estado}] elementos além da borda do diálogo`).toEqual([])
  expect(g.rodapeDentro, `[${estado}] botões do rodapé fora do diálogo`).toBe(true)
  if (projeto === "375") expect(g.alvos.filter((a) => a.h < 44), `[${estado}] alvos < 44 px a 375`).toEqual([])
  // ---- axe (todas as regras) e contraste de texto por pixel ----
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`), `[${estado}] violações axe`).toEqual([])
  expect(topo.reprovados, `[${estado}] contraste (topo): ${JSON.stringify(topo.reprovados.slice(0, 3))}`).toEqual([])
  expect(fim.reprovados, `[${estado}] contraste (fim): ${JSON.stringify(fim.reprovados.slice(0, 3))}`).toEqual([])
  expect(topo.textos, `[${estado}] nenhum texto medido`).toBeGreaterThan(3)
  return g
}

test.describe("Iniciar recarga — régua de geometria, axe e contraste", () => {
  test("estados do diálogo", async ({ page }, info) => {
    const projeto = info.project.name
    test.setTimeout(120_000)
    await entrar(page)
    await abrir(page)
    const d = dialogo(page)

    // 1) formulário vazio
    await medirEstado(page, projeto, "1-form-vazio")

    // 2) formulário preenchido: busca (lista com dívida), motorista escolhido, motivo longo
    await d.getByRole("searchbox", { name: "Buscar motorista" }).fill("a")
    await expect(d.getByRole("radio", { name: /Juliana Alves/ })).toBeVisible()
    await d.getByText("Juliana Alves", { exact: true }).first().click()
    await d.getByLabel(/Motivo/).fill(MOTIVO)
    await medirEstado(page, projeto, "2-form-preenchido")

    // 3) confirmação com dívida + erro por code (DRIVER_HAS_OPEN_DEBT)
    await d.getByRole("button", { name: /Revisar recarga/ }).click()
    await expect(page.getByTestId("remote-start-summary")).toBeVisible()
    await d.getByRole("button", { name: "Iniciar recarga" }).click()
    await expect(page.getByTestId("remote-start-error")).toBeVisible()
    const g3 = await medirEstado(page, projeto, "3-confirmacao-com-erro")
    expect(g3.h3).toEqual(["Confirme a recarga"])
    expect(g3.ativoRole, "falhou o envio: o foco vai para o aviso de erro (não cai no corpo do diálogo)").toBe("alert")

    // 4) aguardando (relógio parado: o mock continua PENDING). Troca para Carla (sem dívida).
    await d.getByRole("button", { name: /Voltar/ }).click()
    await d.getByRole("searchbox", { name: "Buscar motorista" }).fill("carla")
    await d.getByText("Carla Motorista", { exact: true }).first().click()
    await d.getByRole("button", { name: /Revisar recarga/ }).click()
    await d.getByRole("button", { name: "Iniciar recarga" }).click()
    await expect(page.getByTestId("remote-start-status")).toHaveAttribute("data-phase", "POLLING")
    const g4 = await medirEstado(page, projeto, "4-aguardando")
    expect(g4.h3, "o foco/título do passo de acompanhamento").toEqual(["Acompanhando a recarga"])
    expect(g4.ativo, "o foco foi para o título do passo (não ficou no corpo)").toBe("H3")

    // 5) aceito (salto do relógio: o mock passa dos 3 s e o próximo ciclo traz ACCEPTED)
    await page.clock.setFixedTime(new Date(T0.getTime() + 5_000))
    await expect(page.getByTestId("remote-start-status")).toHaveAttribute("data-phase", "ACCEPTED", { timeout: 15_000 })
    await medirEstado(page, projeto, "5-aceito")
  })

  test("estado recusado (cenário do mock)", async ({ page }, info) => {
    const projeto = info.project.name
    test.setTimeout(120_000)
    await entrar(page)
    await page.evaluate(() => localStorage.setItem("mock:remote-start", "rejected"))
    await abrir(page)
    const d = dialogo(page)
    await d.getByRole("searchbox", { name: "Buscar motorista" }).fill("carla")
    await d.getByText("Carla Motorista", { exact: true }).first().click()
    await d.getByLabel(/Motivo/).fill(MOTIVO)
    await d.getByRole("button", { name: /Revisar recarga/ }).click()
    await d.getByRole("button", { name: "Iniciar recarga" }).click()
    await page.clock.setFixedTime(new Date(T0.getTime() + 5_000))
    await expect(page.getByTestId("remote-start-status")).toHaveAttribute("data-phase", "REJECTED", { timeout: 15_000 })
    await medirEstado(page, projeto, "6-recusado")
  })
})
