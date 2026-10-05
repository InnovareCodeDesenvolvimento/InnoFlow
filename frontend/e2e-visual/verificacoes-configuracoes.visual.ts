import AxeBuilder from "@axe-core/playwright"
import { expect, test, type Page } from "@playwright/test"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { SENHA } from "./constantes"
import { medirContrastePixel } from "./contraste-pixel"
import { aguardarEstavel, prepararPagina } from "./estabilizar"

/**
 * VERIFICAÇÕES INDEPENDENTES de /admin/configuracoes (abas Geral, E-mail, WhatsApp e Alertas; antes a tela única /admin/comunicacao, N-7) — a régua que NÃO depende de baseline
 * (nenhuma foto é comparada nem gravada em `baseline/`):
 *  1) contraste de TEXTO por PIXEL em vários ESTADOS (cada persona do mock em cada aba, diálogos, segredo aberto, erros de salvar, resultados do teste de conexão por estágio,
 *     e-mail de teste, verificação de domínio, confirmação de mudança de versão, campos inválidos);
 *  2) axe COMPLETO (wcag2a/aa + 2.1 a/aa) no <main> e nos diálogos, 0 violações;
 *  3) geometria a 375/768/1440 em cada aba: mesma coluna/largura das telas de referência (Tarifas), sem rolagem lateral, 1 h1 + h2 nas seções, alvos >= 44 px a 375, rodapé do
 *     cartão estático, barra de abas sem rolagem lateral, altura dos cartões (para calibrar os esqueletos de carga) e perfil OPERATOR = "Acesso restrito".
 * Rodar: `npx playwright test --config playwright.visual.config.ts verificacoes-configuracoes --update-snapshots=none` (nunca em paralelo com outro harness: compartilham `.auth`).
 * Grava `e2e-visual/.resultados/configuracoes/*.json` e capturas `*.png` (para olhar; não são baseline).
 */

const PASTA = "e2e-visual/.resultados/configuracoes"
function gravar(nome: string, dados: unknown) {
  mkdirSync(PASTA, { recursive: true })
  writeFileSync(path.join(PASTA, `${nome}.json`), JSON.stringify(dados, null, 1))
}

type Aba = "geral" | "email" | "whatsapp" | "alertas"
const ROTULO: Record<Aba, string> = { geral: "Geral", email: "E-mail", whatsapp: "WhatsApp", alertas: "Alertas" }

async function entrar(page: Page, email: string) {
  await prepararPagina(page)
  await page.goto("/login", { waitUntil: "load" })
  await page.getByLabel("E-mail").fill(email)
  await page.getByLabel("Senha").fill(SENHA)
  await page.getByRole("button", { name: "Entrar" }).click()
  await expect(page).toHaveURL(/\/admin\/dashboard/)
}
async function abrir(page: Page, aba: Aba) {
  await page.goto(`/admin/configuracoes/${aba}`, { waitUntil: "load" })
  await expect(page.getByRole("heading", { name: `Configurações · ${ROTULO[aba]}`, level: 1 })).toBeVisible()
  await aguardarEstavel(page)
}
/** Troca de aba por clique na SPA (o estado do mock sobrevive). */
async function irPara(page: Page, aba: Aba) {
  await page.getByRole("navigation", { name: "Assuntos das configurações" }).getByRole("link", { name: ROTULO[aba], exact: true }).click()
  await expect(page.getByRole("heading", { name: `Configurações · ${ROTULO[aba]}`, level: 1 })).toBeVisible()
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
const salvar = (page: Page) => page.getByTestId("save-button")
const dialogo = (page: Page) => page.getByRole("dialog", { name: "Confirmar alterações na comunicação" })
const testeConexao = (page: Page) => page.getByRole("button", { name: "Testar conexão" })

async function abrirDialogoSalvar(page: Page) {
  await salvar(page).click()
  await expect(dialogo(page)).toBeVisible()
  return dialogo(page)
}
/** Mede contraste + axe no estado atual. */
async function checar(page: Page, projeto: string, persona: string, estado: string) {
  await medir(page, projeto, persona, estado)
  await axeZero(page, projeto, estado)
}

test.describe("1) contraste por pixel + axe — estados das abas (ADMIN)", () => {
  const CONTAS: [string, string][] = [
    ["admin@innoelektron.com", "env-email-do-ambiente"],
    ["comunicacao-pronta@innoelektron.com", "pronta-database"],
    ["comunicacao-vazia@innoelektron.com", "vazia-nada-configurado"],
    ["comunicacao-sem-chave@innoelektron.com", "sem-chave-de-cifragem"],
    ["comunicacao-ilegivel@innoelektron.com", "segredos-ilegiveis"],
    ["comunicacao-rede-privada@innoelektron.com", "rede-privada-liberada"],
  ]
  for (const [email, estado] of CONTAS) {
    for (const aba of ["geral", "email", "whatsapp", "alertas"] as const) {
      test(`${estado} / ${aba}`, async ({ page }, info) => {
        await entrar(page, email)
        await abrir(page, aba)
        await checar(page, info.project.name, email.split("@")[0], `${estado}-${aba}`)
      })
    }
  }

  test("erro-503-no-get (indisponivel@): Geral e as abas de comunicação", async ({ page }, info) => {
    await entrar(page, "comunicacao-indisponivel@innoelektron.com")
    await page.goto("/admin/configuracoes/email", { waitUntil: "load" })
    await expect(page.getByText("O servidor não conseguiu ler a configuração")).toBeVisible()
    await aguardarEstavel(page)
    await checar(page, info.project.name, "indisponivel", "erro-503-email")
    await irPara(page, "geral")
    await expect(page.getByText("O servidor não conseguiu ler os dados da empresa")).toBeVisible()
    await checar(page, info.project.name, "indisponivel", "erro-503-geral")
  })

  test("pronta / e-mail: host trocado pede a senha, segredo aberto, campos inválidos, diálogo de salvar (vazio, com senha, senha errada)", async ({ page }, info) => {
    const p = info.project.name
    await entrar(page, "comunicacao-pronta@innoelektron.com")
    await abrir(page, "email")
    await tela(page).getByTestId("email-host").fill("smtp.novo.exemplo.com")
    await checar(page, p, "pronta", "host-trocado-pede-senha-de-novo")
    await page.getByRole("button", { name: "Substituir Senha SMTP" }).click()
    await tela(page).getByLabel("Senha SMTP", { exact: true }).fill("SEGREDO-123")
    await checar(page, p, "pronta", "segredo-aberto-preenchendo")
    await tela(page).getByTestId("email-port").fill("70000")
    await tela(page).getByTestId("email-from").fill("isto nao e um remetente")
    await checar(page, p, "pronta", "campos-invalidos-erro-no-rodape")
    await tela(page).getByTestId("email-port").fill("587")
    await tela(page).getByTestId("email-from").fill("InnoFlow <alertas@innoflow.example>")
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

  test("pronta / e-mail: marcar a senha para apagar; WhatsApp: apikey para apagar", async ({ page }, info) => {
    await entrar(page, "comunicacao-pronta@innoelektron.com")
    await abrir(page, "email")
    await page.getByRole("button", { name: "Apagar a senha SMTP salva" }).click()
    await expect(page.getByTestId("secret-smtpPassword-chip")).toBeVisible()
    await checar(page, info.project.name, "pronta", "senha-marcada-para-apagar")
    await abrir(page, "whatsapp") // navegação nova: o rascunho da aba E-mail (senha marcada) pediria confirmação para trocar de aba
    await page.getByRole("button", { name: "Apagar a apikey salva" }).click()
    await expect(page.getByTestId("secret-evolutionApiKey-chip")).toBeVisible()
    await checar(page, info.project.name, "pronta", "apikey-marcada-para-apagar")
  })

  test("pronta: aviso de alteração não salva ao trocar de aba", async ({ page }, info) => {
    await entrar(page, "comunicacao-pronta@innoelektron.com")
    await abrir(page, "email")
    await tela(page).getByTestId("email-port").fill("2525")
    await page.getByRole("navigation", { name: "Assuntos das configurações" }).getByRole("link", { name: "WhatsApp", exact: true }).click()
    await expect(page.getByRole("dialog", { name: "Você tem alterações não salvas" })).toBeVisible()
    await medir(page, info.project.name, "pronta", "dialogo-alteracao-nao-salva", { dialogo: true })
    await axeZero(page, info.project.name, "dialogo-alteracao-nao-salva", "[role=dialog]")
  })

  test("vazia / WhatsApp: 409 CHANNEL_INCOMPLETE e destino proibido (SSRF) como alerta da tela", async ({ page }, info) => {
    const p = info.project.name
    await entrar(page, "comunicacao-vazia@innoelektron.com")
    await abrir(page, "whatsapp")
    await tela(page).getByTestId("whatsapp-baseUrl").fill("https://evolution.exemplo.com.br")
    await page.getByRole("switch", { name: "Ligar o WhatsApp" }).click()
    await salvar(page).click()
    await dialogo(page).getByLabel("Sua senha atual").fill(SENHA)
    await dialogo(page).getByRole("button", { name: "Confirmar e salvar" }).click()
    await expect(page.getByTestId("save-error")).toBeVisible()
    await checar(page, p, "vazia", "erro-409-canal-incompleto")
    await tela(page).getByTestId("whatsapp-baseUrl").fill("https://localhost")
    await salvar(page).click()
    await dialogo(page).getByLabel("Sua senha atual").fill(SENHA)
    await dialogo(page).getByRole("button", { name: "Confirmar e salvar" }).click()
    await expect(page.getByTestId("save-error")).toHaveAttribute("data-code", "DESTINATION_NOT_ALLOWED")
    await checar(page, p, "vazia", "erro-destino-proibido")
  })

  const ESTAGIOS: [string, string][] = [
    ["smtp.exemplo.com.br", "conexao-ok"],
    ["falha-conexao.exemplo.com", "conexao-falha-connect"],
    ["falha-tls.exemplo.com", "conexao-falha-tls"],
    ["falha-auth.exemplo.com", "conexao-falha-auth"],
  ]
  for (const [host, estado] of ESTAGIOS) {
    test(`pronta / e-mail: Testar conexão — ${estado}`, async ({ page }, info) => {
      await entrar(page, "comunicacao-pronta@innoelektron.com")
      await abrir(page, "email")
      if (estado !== "conexao-ok") {
        await tela(page).getByTestId("email-host").fill(host)
        await page.getByRole("button", { name: "Substituir Senha SMTP" }).click()
        await tela(page).getByLabel("Senha SMTP", { exact: true }).fill("SEGREDO-123")
      }
      await testeConexao(page).click()
      await expect(page.getByTestId("smtp-connection-result")).toBeVisible()
      await checar(page, info.project.name, "pronta", estado)
    })
  }

  const TESTES: [string | null, "email" | "whatsapp", string][] = [
    [null, "email", "teste-email-ok"],
    ["SMTP_AUTH_FAILED", "email", "teste-email-falha"],
    [null, "whatsapp", "teste-whatsapp-ok"],
    ["WHATSAPP_AUTH_FAILED", "whatsapp", "teste-whatsapp-falha"],
    ["HTTP_503", "whatsapp", "teste-erro-503"],
  ]
  for (const [override, canal, estado] of TESTES) {
    test(`pronta / ${canal}: ${estado}`, async ({ page }, info) => {
      await entrar(page, "comunicacao-pronta@innoelektron.com")
      if (override) await page.evaluate((o) => localStorage.setItem("mock:comunicacao-teste", o), override)
      await abrir(page, canal)
      await page.getByRole("button", { name: canal === "email" ? "Enviar e-mail de teste" : "Enviar WhatsApp de teste", exact: true }).click()
      await expect(page.getByTestId(`${canal}-test-result`).or(page.getByTestId(`${canal}-test-request-error`))).toBeVisible()
      await checar(page, info.project.name, "pronta", estado)
    })
  }

  test("pronta / e-mail: ajuda do e-mail de teste aberta e aviso de alteração não salva", async ({ page }, info) => {
    await entrar(page, "comunicacao-pronta@innoelektron.com")
    await abrir(page, "email")
    await tela(page).getByTestId("email-host").fill("smtp.teste.exemplo.com")
    await page.getByRole("button", { name: "O que é o e-mail de teste?" }).click()
    await expect(page.getByTestId("email-test-unsaved-note")).toBeVisible()
    await expect(page.getByTestId("email-test-help")).toBeVisible()
    await checar(page, info.project.name, "pronta", "email-teste-ajuda-e-aviso")
  })

  const DOMINIOS: [string, string][] = [
    ["", "dominio-sem-seletor"],
    ["default", "dominio-dkim-ok"],
    ["ausente", "dominio-dkim-ausente"],
    ["erro", "dominio-dkim-sem-resposta"],
  ]
  for (const [seletor, estado] of DOMINIOS) {
    test(`pronta / e-mail: verificação do domínio — ${estado}`, async ({ page }, info) => {
      await entrar(page, "comunicacao-pronta@innoelektron.com")
      await abrir(page, "email")
      if (seletor) await page.getByTestId("domain-selector").fill(seletor)
      await page.getByTestId("domain-check-button").click()
      await expect(page.getByTestId("domain-check-result")).toBeVisible()
      await page.getByTestId("domain-dmarc").getByRole("button", { name: "Como configurar" }).click()
      await checar(page, info.project.name, "pronta", estado)
    })
  }

  test("vazia / e-mail: verificação sem remetente e com seletor inválido", async ({ page }, info) => {
    await entrar(page, "comunicacao-vazia@innoelektron.com")
    await abrir(page, "email")
    await page.getByTestId("domain-check-button").click()
    await expect(page.getByTestId("domain-check-result")).toContainText("Cadastre primeiro")
    await checar(page, info.project.name, "vazia", "dominio-sem-remetente")
    await page.getByTestId("domain-selector").fill("a b!")
    await page.getByTestId("domain-check-button").click()
    await expect(page.getByText("Seletor inválido")).toBeVisible()
    await checar(page, info.project.name, "vazia", "dominio-seletor-invalido")
  })

  test("pronta / alertas: campos inválidos", async ({ page }, info) => {
    await entrar(page, "comunicacao-pronta@innoelektron.com")
    await abrir(page, "alertas")
    await tela(page).getByTestId("email-recipients").fill("isto-nao-e-email")
    await tela(page).getByTestId("alerts-dedupeMinutes").fill("2000")
    await checar(page, info.project.name, "pronta", "alertas-campos-invalidos")
  })

  test("pronta / geral: CNPJ inválido, outros campos inválidos, confirmação de mudança de versão e erro 429", async ({ page }, info) => {
    const p = info.project.name
    await entrar(page, "comunicacao-pronta@innoelektron.com")
    await abrir(page, "geral")
    await tela(page).getByTestId("company-cnpj").fill("11.222.333/0001-82")
    await tela(page).getByTestId("company-supportEmail").fill("sem-arroba")
    await tela(page).getByTestId("company-website").fill("localhost")
    await checar(page, p, "pronta", "geral-campos-invalidos")
    await page.getByRole("button", { name: "Descartar" }).click()
    await tela(page).getByTestId("company-termsVersion").fill("2026-11-01")
    await checar(page, p, "pronta", "geral-aviso-de-versao-ativo")
    await salvar(page).click()
    const d = page.getByRole("dialog", { name: "Mudar a versão dos documentos?" })
    await expect(d).toBeVisible()
    await medir(page, p, "pronta", "geral-confirmar-versao", { dialogo: true })
    await axeZero(page, p, "geral-confirmar-versao", "[role=dialog]")
    await d.getByLabel("Entendo que todos os motoristas terão de aceitar os documentos de novo.").check()
    await medir(page, p, "pronta", "geral-confirmar-versao-marcado", { dialogo: true })
    await d.getByRole("button", { name: "Voltar" }).click()
    await page.getByRole("button", { name: "Descartar" }).click()
    await tela(page).getByTestId("company-legalName").fill("Limite Ltda")
    await salvar(page).click()
    await expect(page.getByTestId("company-save-error")).toBeVisible()
    await checar(page, p, "pronta", "geral-erro-429")
  })
})

/** Largura mínima (px) do título (h2) de um cartão. A 375 px o cartão tem 303 px; o selo vai para a linha de baixo e o título fica com a linha toda. */
const H2_LARGURA_MIN = 160

test.describe("2b) título do cartão com largura útil — cada conta do mock × cada aba (selos e avisos variam por estado)", () => {
  const CONTAS: [string, string][] = [
    ["admin@innoelektron.com", "env"],
    ["comunicacao-pronta@innoelektron.com", "pronta"],
    ["comunicacao-vazia@innoelektron.com", "vazia"],
    ["comunicacao-sem-chave@innoelektron.com", "sem-chave"],
    ["comunicacao-ilegivel@innoelektron.com", "ilegivel"],
  ]
  for (const [email, estado] of CONTAS) {
    for (const aba of ["geral", "email", "whatsapp", "alertas"] as const) {
      test(`${estado} / ${aba}: todo h2 de cartão >= ${H2_LARGURA_MIN} px`, async ({ page }, info) => {
        await entrar(page, email)
        await abrir(page, aba)
        const h2s = await page.evaluate(() => [...document.querySelectorAll("main h2")].map((h) => ({ t: (h.textContent ?? "").trim(), w: Math.round(h.getBoundingClientRect().width * 10) / 10 })))
        expect(h2s.length).toBeGreaterThan(0)
        for (const h of h2s) expect(h.w, `h2 "${h.t}" mede ${h.w} px (${estado}/${aba}) a ${info.project.name}`).toBeGreaterThanOrEqual(H2_LARGURA_MIN)
      })
    }
  }
})

test.describe("2) geometria (ADMIN / OPERATOR)", () => {
  for (const aba of ["geral", "email", "whatsapp", "alertas"] as const) {
    test(`${aba}: coluna e largura iguais às de Tarifas; sem rolagem lateral; 1 h1 + h2; alvos >= 44 a 375; rodapé estático; alturas dos cartões`, async ({ page }, info) => {
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

      await abrir(page, aba)
      // espera os dados (o esqueleto de carga some quando o cartão existe)
      await expect(page.locator("main h2").first()).toBeVisible()
      await aguardarEstavel(page)
      const minha = await raiz()
      expect(minha, "mesma coluna e largura que Tarifas").toEqual(referencia)

      const medidas = () =>
        page.evaluate(() => {
          const main = document.querySelector("main")!
          const barra = document.querySelector<HTMLElement>('[data-testid="save-bar"]')!
          const abas = document.querySelector<HTMLElement>('[data-testid="config-tabs"] ul')!
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
            // o checkbox nativo tem 20 px mas o rótulo inteiro (44 px) é o alvo
            if (el instanceof HTMLInputElement && el.type === "checkbox") h = el.closest("label")?.getBoundingClientRect().height ?? h
            if (h < 43.5) pequenos.push(`${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 30)}" h=${Math.round(h)}`)
          }
          const cartoes: Record<string, number> = {}
          for (const el of main.querySelectorAll<HTMLElement>('[data-testid^="section-"]')) cartoes[el.dataset.testid!] = Math.round(el.getBoundingClientRect().height)
          return {
            posicao: getComputedStyle(barra).position,
            rolagemLateral: { main: main.scrollWidth - main.clientWidth, doc: document.documentElement.scrollWidth - document.documentElement.clientWidth, abas: abas.scrollWidth - abas.clientWidth },
            h1: main.querySelectorAll("h1").length,
            h2Largura: Object.fromEntries([...main.querySelectorAll("h2")].map((h) => [h.textContent!.trim(), Math.round(h.getBoundingClientRect().width * 10) / 10])),
            secoes: [...main.querySelectorAll("h1, h2")].map((h) => `${h.tagName}:${h.textContent!.trim()}`),
            cartoes,
            pequenos,
          }
        })

      const m = await medidas()
      expect(m.posicao).toBe("static")
      expect(m.rolagemLateral).toEqual({ main: 0, doc: 0, abas: 0 })
      expect(m.h1).toBe(1)
      // REGRESSÃO (05/10, Íris-B): a 375 px os selos do cabeçalho do cartão não quebravam linha e espremiam o h2 para 0-109 px. Largura útil mínima do título de TODO cartão, em toda aba.
      for (const [titulo, largura] of Object.entries(m.h2Largura)) expect(largura, `h2 "${titulo}" mede ${largura} px a ${larg}`).toBeGreaterThanOrEqual(H2_LARGURA_MIN)
      expect(m.secoes[0]).toBe(`H1:Configurações · ${ROTULO[aba]}`)
      expect(m.secoes.length).toBeGreaterThan(1)
      if (larg === "375") expect(m.pequenos, `alvos < 44 px a 375: ${m.pequenos.join(" | ")}`).toEqual([])
      gravar(`${larg}__geometria__${aba}`, { referencia, minha, m })

      // captura inteira (para olhar; NÃO é baseline): a janela cresce até caber o miolo
      const alto = await page.evaluate(() => document.querySelector("main")!.scrollHeight + 120)
      await page.setViewportSize({ width: Number(larg), height: Math.min(alto, 6000) })
      await aguardarEstavel(page)
      mkdirSync(PASTA, { recursive: true })
      await page.screenshot({ path: path.join(PASTA, `${larg}__${aba}__pagina.png`) })
    })
  }

  test("OPERATOR: sem o item no menu e as rotas (nova e antiga) mostram 'Acesso restrito'", async ({ page }) => {
    await entrar(page, "operador@innoelektron.com")
    for (const rota of ["/admin/configuracoes/email", "/admin/comunicacao"]) {
      await page.goto(rota, { waitUntil: "load" })
      await expect(page.getByRole("heading", { level: 1, name: "Acesso restrito" })).toBeVisible()
    }
    const links = await page.evaluate(() => [...document.querySelectorAll("nav a[href]")].map((a) => a.getAttribute("href")))
    expect(links).not.toContain("/admin/configuracoes")
    expect(links).not.toContain("/admin/comunicacao")
  })
})
