import { expect, test, type Page } from "@playwright/test"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { SENHA } from "./constantes"
import { medirContrastePixel } from "./contraste-pixel"
import { aguardarEstavel, prepararPagina } from "./estabilizar"

/**
 * VERIFICAÇÕES INDEPENDENTES da tela /admin/gateway-pagamento (redesenho da Lyra, commit 7dfc401) — o que o `test:visual` (uma foto por largura) NÃO prova:
 *  1) contraste de TEXTO por PIXEL em VÁRIOS ESTADOS (cada persona de gateway do mock, diálogos abertos, erros de salvar, resultado do teste de conexão, segredo aberto/gerado, barra com alteração);
 *  2) geometria que a foto não mostra: a barra de salvar só gruda com alteração (e, solta, não tapa a tela), o interruptor tem alvo de toque >= 44 px, nenhum controle abaixo de 44 px a 375,
 *     nenhuma rolagem horizontal, um único h1 e a ordem das seções.
 * Rodar: `npx playwright test --config playwright.visual.config.ts verificacoes-gateway`. Grava `e2e-visual/.resultados/gateway/*.json` (menor razão por estado).
 * Cada persona é uma conta do mock (`src/mocks/paymentGatewayData.ts`): o estado do mock vive na PÁGINA, então cada teste abre a sua.
 */

const PASTA = "e2e-visual/.resultados/gateway"
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
  await page.goto("/admin/gateway-pagamento", { waitUntil: "load" })
  await aguardarEstavel(page)
}
/** Mede, grava e exige 0 reprovados. Diálogos animam a entrada: espera ~700 ms antes (medido na F-D). */
async function medir(page: Page, projeto: string, persona: string, estado: string, opts: { dialogo?: boolean; ignorar?: RegExp } = {}) {
  if (opts.dialogo) await page.waitForTimeout(700)
  const r = await medirContrastePixel(page)
  gravar(`${projeto}__${persona}__${estado}`, r)
  expect(r.textos, `nenhum texto medido (${persona}/${estado})`).toBeGreaterThan(3)
  // `ignorar`: texto cujo "reprovo" é efeito de OUTRO defeito, já coberto por teste próprio (aqui: o host do passo do teste de conexão que vaza do cartão a 375 px, ver o teste da seção 2).
  r.reprovados = r.reprovados.filter((m) => !(opts.ignorar && opts.ignorar.test(m.texto)))
  expect(r.reprovados, `texto abaixo do limiar AA por pixel (${persona}/${estado}) a ${projeto}px: ${JSON.stringify(r.reprovados.slice(0, 3))}`).toEqual([])
}
const tela = (page: Page) => page.locator("main")
const rotuloProducao = (page: Page) => page.getByTestId("section-environment").locator("label").filter({ hasText: "Produção" })

/** Escolhe produção pelo diálogo de confirmação (digita a palavra) e deixa a alteração no rascunho. */
async function escolherProducao(page: Page) {
  await rotuloProducao(page).click()
  const d = page.getByRole("dialog", { name: "Passar para produção?" })
  await expect(d).toBeVisible()
  return d
}
async function abrirDialogoSalvar(page: Page) {
  await page.getByRole("button", { name: "Salvar alterações" }).click()
  const d = page.getByRole("dialog", { name: "Confirmar alterações no gateway" })
  await expect(d).toBeVisible()
  return d
}

test.describe("1) contraste de texto por pixel — estados da tela do gateway (ADMIN)", () => {
  // Contas de gateway do mock que só mudam o ESTADO inicial da tela (nada a fazer depois de abrir).
  const CONTAS: [string, string][] = [
    ["admin@innoelektron.com", "env-nada-configurado"],
    ["gateway-pronto@innoelektron.com", "pronto-sandbox"],
    ["gateway-producao@innoelektron.com", "producao"],
    ["gateway-sem-chave@innoelektron.com", "sem-chave-sem-webhook"],
    ["gateway-ilegivel@innoelektron.com", "erro-503-no-get"],
    ["gateway-ilegivel-segredos@innoelektron.com", "segredos-ilegiveis"],
    ["gateway-sandbox-publico@innoelektron.com", "sandbox-restrito"],
  ]
  for (const [email, estado] of CONTAS) {
    test(`${estado}`, async ({ page }, info) => {
      await entrar(page, email)
      await abrir(page)
      await medir(page, info.project.name, email.split("@")[0], estado)
    })
  }

  test("admin: diálogo de produção (vazio e com a palavra), produção pendente (barra grudada), diálogo de salvar (vazio e com senha), erro de par", async ({ page }, info) => {
    const p = info.project.name
    await entrar(page, "admin@innoelektron.com")
    await abrir(page)
    const dp = await escolherProducao(page)
    await medir(page, p, "admin", "dialogo-producao-vazio", { dialogo: true })
    await dp.getByLabel(/Para confirmar, digite/).fill("PRODUÇÃO")
    await medir(page, p, "admin", "dialogo-producao-confirmavel", { dialogo: true })
    await dp.getByRole("button", { name: "Selecionar produção" }).click()
    await expect(dp).toBeHidden()
    await expect(page.getByTestId("environment-production-banner")).toBeVisible()
    await medir(page, p, "admin", "producao-pendente-barra-com-alteracao")
    const ds = await abrirDialogoSalvar(page)
    await medir(page, p, "admin", "dialogo-salvar-producao-vazio", { dialogo: true })
    await ds.getByLabel("Sua senha atual").fill("qualquer")
    await medir(page, p, "admin", "dialogo-salvar-producao-com-senha", { dialogo: true })
    await ds.getByRole("button", { name: "Cancelar" }).click()
    await expect(ds).toBeHidden()
    // Par incompleto (MerchantId sem MerchantKey): erro nos campos e na barra.
    await tela(page).getByLabel("MerchantId", { exact: true }).fill("mid-novo-123")
    await expect(page.getByTestId("save-bar-errors")).toBeVisible()
    await medir(page, p, "admin", "par-incompleto-erro-na-barra")
  })

  test("admin: segredo aberto, preenchendo e segredo do webhook gerado", async ({ page }, info) => {
    const p = info.project.name
    await entrar(page, "admin@innoelektron.com")
    await abrir(page)
    await page.getByRole("button", { name: /^(Informar|Substituir) MerchantKey$/ }).click()
    await tela(page).getByLabel("MerchantKey", { exact: true }).fill("chave-de-teste-123")
    await medir(page, p, "admin", "segredo-aberto-preenchendo")
    await page.getByRole("button", { name: "Gerar segredo aleatório" }).click()
    await expect(page.getByTestId("webhook-secret-generated-note")).toBeVisible()
    await medir(page, p, "admin", "segredo-do-webhook-gerado")
  })

  // Resultado do teste de conexão: cada cenário do mock (OK, credencial rejeitada, não configurado, ilegível, 503 e alteração pendente).
  const TESTES: [string, string | null, string][] = [
    ["gateway-pronto@innoelektron.com", null, "teste-ok"],
    ["gateway-falhas@innoelektron.com", null, "teste-credencial-rejeitada"],
    ["admin@innoelektron.com", null, "teste-nao-configurado"],
    ["gateway-ilegivel-segredos@innoelektron.com", null, "teste-ilegivel"],
    ["gateway-pronto@innoelektron.com", "HTTP_503", "teste-erro-503"],
  ]
  for (const [email, override, estado] of TESTES) {
    test(`${estado} (${email.split("@")[0]})`, async ({ page }, info) => {
      await entrar(page, email)
      if (override) await page.evaluate((o) => localStorage.setItem("mock:gateway-test", o), override)
      await abrir(page)
      await page.getByRole("button", { name: "Testar conexão" }).click()
      await expect(page.getByTestId("test-result").or(page.getByTestId("test-request-error"))).toBeVisible()
      await medir(page, info.project.name, email.split("@")[0], estado, { ignorar: /^api/ })
    })
  }

  test("pronto: aviso 'o teste usa o que está salvo' (alteração pendente) e erro de senha errada no diálogo", async ({ page }, info) => {
    const p = info.project.name
    await entrar(page, "gateway-pronto@innoelektron.com")
    await abrir(page)
    await tela(page).getByLabel("MerchantId", { exact: true }).fill("mid-novo-123")
    await expect(page.getByTestId("test-unsaved-note")).toBeVisible()
    await medir(page, p, "gateway-pronto", "alteracao-pendente-aviso-do-teste")
    const d = await abrirDialogoSalvar(page)
    await d.getByLabel("Sua senha atual").fill("senha-errada")
    await d.getByRole("button", { name: "Confirmar e salvar" }).click()
    await expect(d.getByText(/senha/i).and(d.locator("[role=alert], [id*=error], p"))).toBeVisible()
    await medir(page, p, "gateway-pronto", "dialogo-senha-errada", { dialogo: true })
  })

  test("falhas: erro de servidor (503) ao salvar aparece como alerta da tela", async ({ page }, info) => {
    const p = info.project.name
    await entrar(page, "gateway-falhas@innoelektron.com")
    await abrir(page)
    await tela(page).getByLabel("MerchantId", { exact: true }).fill("ERRO-503")
    const d = await abrirDialogoSalvar(page)
    await d.getByLabel("Sua senha atual").fill(SENHA)
    await d.getByRole("button", { name: "Confirmar e salvar" }).click()
    await expect(page.getByTestId("save-error")).toBeVisible()
    await medir(page, p, "gateway-falhas", "erro-503-ao-salvar")
  })

  test("em-andamento: 409 GATEWAY_HAS_INFLIGHT_PAYMENTS ao trocar de ambiente", async ({ page }, info) => {
    const p = info.project.name
    await entrar(page, "gateway-em-andamento@innoelektron.com")
    await abrir(page)
    const dp = await escolherProducao(page)
    await dp.getByLabel(/Para confirmar, digite/).fill("PRODUÇÃO")
    await dp.getByRole("button", { name: "Selecionar produção" }).click()
    const d = await abrirDialogoSalvar(page)
    await d.getByLabel("Sua senha atual").fill(SENHA)
    await d.getByRole("button", { name: "Confirmar e salvar" }).click()
    await expect(page.getByTestId("save-error")).toBeVisible()
    await medir(page, p, "gateway-em-andamento", "erro-409-pagamentos-em-andamento")
  })
})

test.describe("2) geometria que a foto não mostra (ADMIN)", () => {
  // ACHADO da Íris (05/10/2026): o host do passo do teste de conexão ("apiquerysandbox.cieloecommerce.cielo.com.br · HTTP 400 · 120 ms") é um <p text-xs> SEM quebra de palavra:
  // a 375 px ele mede 269 px num espaço de 237 e atravessa a borda do cartão do passo (28 px antes do redesenho, 32 px depois do Alert). Pré-existente (não é regressão da 7dfc401),
  // mas o redesenho declarou "sem rolagem horizontal" e a tela ainda tem texto fora da caixa. Teste marcado `fail` a 375 até a correção (break-words/[overflow-wrap:anywhere] no <p> do host);
  // quando corrigir, o Playwright acusa "esperava falhar e passou" e a marca sai.
  for (const email of ["gateway-falhas@innoelektron.com", "gateway-pronto@innoelektron.com"]) {
    test(`resultado do teste de conexão: nenhum texto passa da borda do seu passo (${email.split("@")[0]})`, async ({ page }, info) => {
      test.fail(info.project.name === "375", "BUG conhecido: host do passo vaza do cartão a 375 px (ver comentário acima)")
      await entrar(page, email)
      await abrir(page)
      await page.getByRole("button", { name: "Testar conexão" }).click()
      await expect(page.getByTestId("test-result")).toBeVisible()
      const vazando = await page.evaluate(() =>
        [...document.querySelectorAll("[data-testid^=test-step-][data-status]")].flatMap((li) => {
          const lr = li.getBoundingClientRect()
          return [...li.querySelectorAll("p, span")].filter((e) => e.scrollWidth > e.clientWidth + 1 || e.getBoundingClientRect().right > lr.right + 0.5).map((e) => (e.textContent ?? "").trim().slice(0, 40))
        }),
      )
      expect(vazando, "texto que passa da borda do passo do teste de conexão").toEqual([])
    })
  }

  test("barra de salvar: solta sem alteração (não tapa a tela), grudada com alteração; interruptor com alvo >= 44; sem rolagem lateral; 1 h1; ordem das seções", async ({ page }, info) => {
    const larg = info.project.name
    await entrar(page, "gateway-pronto@innoelektron.com")
    await abrir(page)

    const medidas = async () =>
      page.evaluate(() => {
        const main = document.querySelector("main")!
        const bar = document.querySelector<HTMLElement>('[data-testid="save-bar"]')!
        const rb = bar.getBoundingClientRect()
        const mb = main.getBoundingClientRect()
        main.scrollTo(0, 0)
        const rb0 = bar.getBoundingClientRect()
        return {
          posicao: getComputedStyle(bar).position,
          // com o <main> no TOPO: a barra já está visível (grudada) ou fica abaixo da dobra (solta)?
          topoComScrollZero: Math.round(rb0.top),
          fundoComScrollZero: Math.round(rb0.bottom),
          janelaAltura: window.innerHeight,
          mainFundo: Math.round(mb.bottom),
          alturaBarra: Math.round(rb.height),
          paginaMaisAltaQueJanela: main.scrollHeight > main.clientHeight,
        }
      })

    const solta = await medidas()
    expect(solta.posicao).toBe("static")
    expect(solta.paginaMaisAltaQueJanela).toBe(true)
    expect(solta.topoComScrollZero, "sem alteração a barra NÃO pode estar na dobra (tapando conteúdo)").toBeGreaterThan(solta.janelaAltura)

    await tela(page).getByLabel("MerchantId", { exact: true }).fill("mid-novo-123")
    await expect(page.getByTestId("save-bar-status")).toContainText("1 alteração não salva")
    const grudada = await medidas()
    expect(grudada.posicao).toBe("sticky")
    expect(grudada.fundoComScrollZero, "com alteração a barra gruda no fim da área visível").toBeLessThanOrEqual(grudada.mainFundo + 1)
    expect(grudada.topoComScrollZero).toBeLessThan(grudada.janelaAltura)
    gravar(`${larg}__geometria-barra`, { solta, grudada })

    // Alvos de toque (interruptor medido pelo ponteiro: o ::before é o alvo), rolagem lateral, h1 e ordem das seções.
    const g = await page.evaluate(() => {
      const main = document.querySelector("main")!
      const out: string[] = []
      for (const el of main.querySelectorAll<HTMLElement>("button, a[href], input:not(.sr-only), [role=switch]")) {
        const r = el.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) continue
        let altura = r.height
        if (el.getAttribute("role") === "switch") {
          el.scrollIntoView({ block: "center" })
          const rr = el.getBoundingClientRect()
          const cx = rr.left + rr.width / 2
          altura = document.elementFromPoint(cx, rr.top - 10) === el && document.elementFromPoint(cx, rr.bottom + 10) === el ? 44 : rr.height
        }
        if (altura < 44) out.push(`${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 30)}" h=${Math.round(altura)}`)
      }
      return {
        pequenos: out,
        rolagemLateral: { main: main.scrollWidth - main.clientWidth, doc: document.documentElement.scrollWidth - document.documentElement.clientWidth },
        h1: main.querySelectorAll("h1").length,
        secoes: [...main.querySelectorAll("h1, h2")].map((h) => `${h.tagName}:${h.textContent!.trim()}`),
      }
    })
    expect(g.rolagemLateral).toEqual({ main: 0, doc: 0 })
    expect(g.h1).toBe(1)
    expect(g.secoes).toEqual(["H1:Gateway de pagamento", "H2:Pix", "H2:Cartão", "H2:Ambiente", "H2:Credenciais da Cielo", "H2:Testar conexão", "H2:Webhook"])
    if (larg === "375") expect(g.pequenos, `alvos < 44 px a 375: ${g.pequenos.join(" | ")}`).toEqual([])
    gravar(`${larg}__geometria-alvos`, g)
  })
})
