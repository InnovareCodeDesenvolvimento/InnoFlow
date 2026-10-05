import AxeBuilder from "@axe-core/playwright"
import { expect, test, type Page } from "@playwright/test"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { SENHA } from "./constantes"
import { medirContrastePixel } from "./contraste-pixel"
import { aguardarEstavel, prepararPagina } from "./estabilizar"

/**
 * VERIFICAÇÕES INDEPENDENTES da tela /admin/comunicacao (N-7, Lyra) — a régua que NÃO depende de baseline (nenhuma foto é comparada nem gravada em `baseline/`):
 *  1) contraste de TEXTO por PIXEL em vários ESTADOS (cada persona do mock, diálogo de salvar, segredo aberto, erros de salvar, resultados de teste, campos inválidos);
 *  2) axe COMPLETO (wcag2a/aa + 2.1 a/aa) no <main> e no diálogo, 0 violações;
 *  3) geometria a 375/768/1440: mesma coluna/largura das telas de referência (Tarifas), sem rolagem lateral, 1 h1 + h2 nas seções, alvos >= 44 px a 375, barra de salvar só gruda com
 *     alteração, altura dos cartões (para calibrar o esqueleto de carga) e perfil OPERATOR = "Acesso restrito".
 * Rodar: `npx playwright test --config playwright.visual.config.ts verificacoes-comunicacao --update-snapshots=none` (nunca em paralelo com outro harness: compartilham `.auth`).
 * Grava `e2e-visual/.resultados/comunicacao/*.json` e capturas `*.png` (para olhar; não são baseline).
 */

const PASTA = "e2e-visual/.resultados/comunicacao"
function gravar(nome: string, dados: unknown) {
  mkdirSync(PASTA, { recursive: true })
  writeFileSync(path.join(PASTA, `${nome}.json`), JSON.stringify(dados, null, 1))
}

async function entrar(page: Page, email: string) {
  await prepararPagina(page)
  await page.goto("/login", { waitUntil: "load" })
  await page.getByLabel("E-mail").fill(email)
  await page.getByLabel("Senha").fill(SENHA)
  await page.getByRole("button", { name: "Entrar" }).click()
  await expect(page).toHaveURL(/\/admin\/dashboard/)
}
async function abrir(page: Page) {
  await page.goto("/admin/comunicacao", { waitUntil: "load" })
  await expect(page.getByRole("heading", { name: "Comunicação", level: 1 })).toBeVisible()
  await aguardarEstavel(page)
}
async function medir(page: Page, projeto: string, persona: string, estado: string, opts: { dialogo?: boolean } = {}) {
  if (opts.dialogo) await page.waitForTimeout(700)
  const r = await medirContrastePixel(page)
  gravar(`${projeto}__${persona}__${estado}`, r)
  expect(r.textos, `nenhum texto medido (${persona}/${estado})`).toBeGreaterThan(3)
  expect(r.reprovados, `texto abaixo do limiar AA por pixel (${persona}/${estado}) a ${projeto}px: ${JSON.stringify(r.reprovados.slice(0, 3))}`).toEqual([])
}
async function axeZero(page: Page, projeto: string, estado: string, incluir = "main") {
  const r = await new AxeBuilder({ page }).include(incluir).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze()
  gravar(`${projeto}__axe__${estado}`, r.violations.map((v) => ({ id: v.id, impacto: v.impact, nos: v.nodes.map((n) => n.target.join(" ")) })))
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`), `axe em ${estado} a ${projeto}px`).toEqual([])
}
const tela = (page: Page) => page.locator("main")
const salvar = (page: Page) => page.getByRole("button", { name: "Salvar alterações" })
const dialogo = (page: Page) => page.getByRole("dialog", { name: "Confirmar alterações na comunicação" })

async function abrirDialogoSalvar(page: Page) {
  await salvar(page).click()
  await expect(dialogo(page)).toBeVisible()
  return dialogo(page)
}

test.describe("1) contraste por pixel + axe — estados da tela (ADMIN)", () => {
  const CONTAS: [string, string][] = [
    ["admin@innoelektron.com", "env-email-do-ambiente"],
    ["comunicacao-pronta@innoelektron.com", "pronta-database"],
    ["comunicacao-vazia@innoelektron.com", "vazia-nada-configurado"],
    ["comunicacao-sem-chave@innoelektron.com", "sem-chave-de-cifragem"],
    ["comunicacao-ilegivel@innoelektron.com", "segredos-ilegiveis"],
    ["comunicacao-indisponivel@innoelektron.com", "erro-503-no-get"],
    ["comunicacao-rede-privada@innoelektron.com", "rede-privada-liberada"],
  ]
  for (const [email, estado] of CONTAS) {
    test(`${estado}`, async ({ page }, info) => {
      await entrar(page, email)
      if (estado === "erro-503-no-get") {
        await page.goto("/admin/comunicacao", { waitUntil: "load" })
        await expect(page.getByText("O servidor não conseguiu ler a configuração")).toBeVisible()
        await aguardarEstavel(page)
      } else await abrir(page)
      await medir(page, info.project.name, email.split("@")[0], estado)
      await axeZero(page, info.project.name, estado)
    })
  }

  test("pronta: alteração pendente (barra grudada), campo inválido, segredo aberto, diálogo de salvar (vazio, com senha, senha errada)", async ({ page }, info) => {
    const p = info.project.name
    await entrar(page, "comunicacao-pronta@innoelektron.com")
    await abrir(page)
    await tela(page).getByTestId("email-host").fill("smtp.novo.exemplo.com")
    await medir(page, p, "pronta", "host-trocado-pede-senha-de-novo")
    await axeZero(page, p, "host-trocado-pede-senha-de-novo")
    await page.getByRole("button", { name: "Substituir Senha SMTP" }).click()
    await tela(page).getByLabel("Senha SMTP", { exact: true }).fill("SEGREDO-123")
    await medir(page, p, "pronta", "segredo-aberto-preenchendo")
    await axeZero(page, p, "segredo-aberto-preenchendo")
    await tela(page).getByTestId("email-port").fill("70000")
    await tela(page).getByTestId("email-recipients").fill("isto-nao-e-email")
    await medir(page, p, "pronta", "campos-invalidos-erro-na-barra")
    await axeZero(page, p, "campos-invalidos-erro-na-barra")
    await tela(page).getByTestId("email-port").fill("587")
    await tela(page).getByTestId("email-recipients").fill("dono@innoflow.example")
    const d = await abrirDialogoSalvar(page)
    await medir(page, p, "pronta", "dialogo-salvar-vazio", { dialogo: true })
    await axeZero(page, p, "dialogo-salvar", "[role=dialog]")
    await d.getByLabel("Sua senha atual").fill("senha-errada")
    await medir(page, p, "pronta", "dialogo-salvar-com-senha", { dialogo: true })
    await d.getByRole("button", { name: "Confirmar e salvar" }).click()
    await expect(d.getByText("Senha incorreta.")).toBeVisible()
    await medir(page, p, "pronta", "dialogo-senha-errada", { dialogo: true })
    await axeZero(page, p, "dialogo-senha-errada", "[role=dialog]")
  })

  test("pronta: marcar a senha para apagar e a apikey para apagar", async ({ page }, info) => {
    await entrar(page, "comunicacao-pronta@innoelektron.com")
    await abrir(page)
    await page.getByRole("button", { name: "Apagar a senha SMTP salva" }).click()
    await page.getByRole("button", { name: "Apagar a apikey salva" }).click()
    await expect(page.getByTestId("secret-smtpPassword-chip")).toBeVisible()
    // A medição fotografa a janela desde o topo e, com a barra de salvar GRUDADA (há alteração) numa janela baixa (375 x 812), o chip da apikey fica ATRÁS da barra: o pixel lido é o da barra
    // (sombra), não o do chip, e falseia o resultado. Janela alta = nada escondido pela barra; o que se mede é o chip de verdade.
    await page.setViewportSize({ width: page.viewportSize()!.width, height: 2600 })
    await aguardarEstavel(page)
    await medir(page, info.project.name, "pronta", "segredos-marcados-para-apagar")
    await axeZero(page, info.project.name, "segredos-marcados-para-apagar")
  })

  test("vazia: 409 CHANNEL_INCOMPLETE e destino proibido (SSRF) como alerta da tela", async ({ page }, info) => {
    const p = info.project.name
    await entrar(page, "comunicacao-vazia@innoelektron.com")
    await abrir(page)
    await tela(page).getByTestId("whatsapp-baseUrl").fill("https://evolution.exemplo.com.br")
    await page.getByRole("switch", { name: "Ligar o WhatsApp" }).click()
    await salvar(page).click()
    const d = dialogo(page)
    await d.getByLabel("Sua senha atual").fill(SENHA)
    await d.getByRole("button", { name: "Confirmar e salvar" }).click()
    await expect(page.getByTestId("save-error")).toBeVisible()
    await medir(page, p, "vazia", "erro-409-canal-incompleto")
    await axeZero(page, p, "erro-409-canal-incompleto")
    await tela(page).getByTestId("whatsapp-baseUrl").fill("https://localhost")
    await salvar(page).click()
    await dialogo(page).getByLabel("Sua senha atual").fill(SENHA)
    await dialogo(page).getByRole("button", { name: "Confirmar e salvar" }).click()
    await expect(page.getByTestId("save-error")).toHaveAttribute("data-code", "DESTINATION_NOT_ALLOWED")
    await medir(page, p, "vazia", "erro-destino-proibido")
    await axeZero(page, p, "erro-destino-proibido")
  })

  const TESTES: [string | null, "email" | "whatsapp", string][] = [
    [null, "email", "teste-email-ok"],
    ["SMTP_AUTH_FAILED", "email", "teste-email-falha"],
    [null, "whatsapp", "teste-whatsapp-ok"],
    ["WHATSAPP_AUTH_FAILED", "whatsapp", "teste-whatsapp-falha"],
    ["HTTP_503", "whatsapp", "teste-erro-503"],
  ]
  for (const [override, canal, estado] of TESTES) {
    test(`${estado}`, async ({ page }, info) => {
      await entrar(page, "comunicacao-pronta@innoelektron.com")
      if (override) await page.evaluate((o) => localStorage.setItem("mock:comunicacao-teste", o), override)
      await abrir(page)
      await page.getByRole("button", { name: canal === "email" ? "Enviar e-mail de teste" : "Enviar WhatsApp de teste" }).click()
      await expect(page.getByTestId(`${canal}-test-result`).or(page.getByTestId(`${canal}-test-request-error`))).toBeVisible()
      await medir(page, info.project.name, "pronta", estado)
      await axeZero(page, info.project.name, estado)
    })
  }

  test("pronta: teste com valores não salvos (aviso) e erro de 'digite a senha de novo' no teste", async ({ page }, info) => {
    await entrar(page, "comunicacao-pronta@innoelektron.com")
    await abrir(page)
    await tela(page).getByTestId("email-host").fill("smtp.teste.exemplo.com")
    await page.getByRole("button", { name: "Enviar e-mail de teste" }).click()
    await expect(page.getByTestId("email-test-unsaved-note")).toBeVisible()
    await medir(page, info.project.name, "pronta", "teste-com-valores-nao-salvos")
    await axeZero(page, info.project.name, "teste-com-valores-nao-salvos")
  })
})

test.describe("2) geometria (ADMIN / OPERATOR)", () => {
  test("coluna e largura iguais às de Tarifas; sem rolagem lateral; 1 h1 + h2; alvos >= 44 a 375; barra só gruda com alteração; alturas dos cartões", async ({ page }, info) => {
    const larg = info.project.name
    await entrar(page, "comunicacao-pronta@innoelektron.com")

    const raiz = () =>
      page.evaluate(() => {
        const main = document.querySelector("main")!
        const root = main.firstElementChild as HTMLElement
        const r = root.getBoundingClientRect()
        return { x: Math.round(r.x), width: Math.round(r.width) }
      })

    await page.goto("/admin/tariffs", { waitUntil: "load" })
    await expect(page.getByRole("heading", { name: "Tarifas", level: 1 })).toBeVisible()
    await aguardarEstavel(page)
    const referencia = await raiz()

    await abrir(page)
    const minha = await raiz()
    expect(minha, "mesma coluna e largura que Tarifas").toEqual(referencia)

    const medidas = () =>
      page.evaluate(() => {
        const main = document.querySelector("main")!
        const bar = document.querySelector<HTMLElement>('[data-testid="save-bar"]')!
        main.scrollTo(0, 0)
        const rb0 = bar.getBoundingClientRect()
        const altura = (id: string) => Math.round(document.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect().height)
        const pequenos: string[] = []
        for (const el of main.querySelectorAll<HTMLElement>("button, a[href], input:not(.sr-only), select, textarea, [role=switch]")) {
          const r = el.getBoundingClientRect()
          if (r.width === 0 || r.height === 0) continue
          let h = r.height
          if (el.getAttribute("role") === "switch") {
            el.scrollIntoView({ block: "center" })
            const rr = el.getBoundingClientRect()
            const cx = rr.left + rr.width / 2
            h = document.elementFromPoint(cx, rr.top - 10) === el && document.elementFromPoint(cx, rr.bottom + 10) === el ? 44 : rr.height
          }
          if (h < 43.5) pequenos.push(`${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 30)}" h=${Math.round(h)}`)
        }
        return {
          posicao: getComputedStyle(bar).position,
          topoComScrollZero: Math.round(rb0.top),
          janela: window.innerHeight,
          rolagemLateral: { main: main.scrollWidth - main.clientWidth, doc: document.documentElement.scrollWidth - document.documentElement.clientWidth },
          h1: main.querySelectorAll("h1").length,
          secoes: [...main.querySelectorAll("h1, h2")].map((h) => `${h.tagName}:${h.textContent!.trim()}`),
          alturas: { email: altura("section-email"), whatsapp: altura("section-whatsapp"), alertas: altura("section-alerts"), barra: altura("save-bar") },
          pequenos,
        }
      })

    const solta = await medidas()
    expect(solta.posicao).toBe("static")
    expect(solta.topoComScrollZero, "sem alteração a barra NÃO pode estar na dobra").toBeGreaterThan(solta.janela)
    expect(solta.rolagemLateral).toEqual({ main: 0, doc: 0 })
    expect(solta.h1).toBe(1)
    expect(solta.secoes).toEqual(["H1:Comunicação", "H2:E-mail (SMTP)", "H2:WhatsApp (Evolution API)", "H2:Alertas"])
    if (larg === "375") expect(solta.pequenos, `alvos < 44 px a 375: ${solta.pequenos.join(" | ")}`).toEqual([])

    await tela(page).getByTestId("email-fromName").fill("Outro nome")
    await expect(page.getByTestId("save-bar-status")).toContainText("1 alteração não salva")
    const grudada = await medidas()
    expect(grudada.posicao).toBe("sticky")
    expect(grudada.topoComScrollZero).toBeLessThan(grudada.janela)

    gravar(`${larg}__geometria`, { referencia, minha, solta, grudada })

    // captura inteira (para olhar; NÃO é baseline): a janela cresce até caber o miolo
    await page.getByRole("button", { name: "Descartar" }).click()
    const alto = await page.evaluate(() => document.querySelector("main")!.scrollHeight + 120)
    await page.setViewportSize({ width: Number(larg), height: Math.min(alto, 6000) })
    await aguardarEstavel(page)
    mkdirSync(PASTA, { recursive: true })
    await page.screenshot({ path: path.join(PASTA, `${larg}__pagina.png`) })
  })

  test("OPERATOR: sem o item no menu e a rota mostra 'Acesso restrito'", async ({ page }) => {
    await entrar(page, "operador@innoelektron.com")
    await page.goto("/admin/comunicacao", { waitUntil: "load" })
    await expect(page.getByRole("heading", { level: 1, name: "Acesso restrito" })).toBeVisible()
    const links = await page.evaluate(() => [...document.querySelectorAll("nav a[href]")].map((a) => a.getAttribute("href")))
    expect(links).not.toContain("/admin/comunicacao")
  })
})
