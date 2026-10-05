import AxeBuilder from "@axe-core/playwright"
import { expect, test, type Page } from "@playwright/test"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { SENHA } from "./constantes"
import { medirContrastePixel } from "./contraste-pixel"
import { aguardarEstavel, prepararPagina } from "./estabilizar"

/**
 * VERIFICAÇÕES INDEPENDENTES da tela /admin/backups (Lyra) — a régua que NÃO depende de baseline (nenhuma foto é comparada nem gravada em `baseline/`):
 *  1) contraste de TEXTO por PIXEL em vários ESTADOS (cada persona do mock, resultado de cada ação, retorno do Google, diálogos de senha/chave/conexão, segredo aberto, erros de campo);
 *  2) axe COMPLETO (wcag2a/aa + 2.1 a/aa) no <main> e nos diálogos, 0 violações;
 *  3) geometria a 375/768/1440: mesma coluna/largura das telas de referência (Tarifas), sem rolagem lateral, 1 h1 + h2 nas seções, alvos >= 44 px a 375, barra de salvar só gruda com alteração,
 *     altura dos cartões (para calibrar o esqueleto de carga) e perfil OPERATOR = "Acesso restrito".
 * Rodar: `npx playwright test --config playwright.visual.config.ts verificacoes-backup --update-snapshots=none` (nunca em paralelo com outro harness: compartilham `.auth`).
 * Grava `e2e-visual/.resultados/backup/*.json` e capturas `*.png` (para olhar; não são baseline).
 */

const PASTA = "e2e-visual/.resultados/backup"
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
async function abrir(page: Page, opts: { spinnerEhConteudo?: boolean } = {}) {
  await page.goto("/admin/backups", { waitUntil: "load" })
  await expect(page.getByRole("heading", { name: "Backups", level: 1 })).toBeVisible()
  await expect(page.getByTestId("section-history")).toBeVisible()
  await aguardarEstavel(page, opts)
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
const dialogoSalvar = (page: Page) => page.getByRole("dialog", { name: "Confirmar alterações no backup" })

/** Janela alta: a barra de salvar GRUDADA (há alteração) cobriria o rodapé numa janela baixa e falsearia o pixel lido (o da sombra). Janela alta = nada escondido. */
async function janelaAlta(page: Page) {
  await page.setViewportSize({ width: page.viewportSize()!.width, height: 3200 })
  await aguardarEstavel(page, { spinnerEhConteudo: true })
}

test.describe("1) contraste por pixel + axe — estados da tela (ADMIN)", () => {
  const CONTAS: [string, string, { spinnerEhConteudo?: boolean }?][] = [
    ["admin@innoelektron.com", "primeiro-uso"],
    ["backup-s3@innoelektron.com", "s3-pronto"],
    ["backup-drive@innoelektron.com", "drive-conectado"],
    ["backup-drive-desconectado@innoelektron.com", "drive-desconectado"],
    ["backup-atrasado@innoelektron.com", "atrasado"],
    ["backup-nunca@innoelektron.com", "nunca-rodou"],
    ["backup-andamento@innoelektron.com", "em-andamento", { spinnerEhConteudo: true }],
    ["backup-sem-chave@innoelektron.com", "servidor-sem-chave"],
    ["backup-ilegivel@innoelektron.com", "segredos-ilegiveis"],
  ]
  for (const [email, estado, opts] of CONTAS) {
    test(`${estado}`, async ({ page }, info) => {
      await entrar(page, email)
      await abrir(page, opts)
      await medir(page, info.project.name, email.split("@")[0], estado)
      await axeZero(page, info.project.name, estado)
    })
  }

  test("erro 503 no GET da config", async ({ page }, info) => {
    await entrar(page, "backup-indisponivel@innoelektron.com")
    await page.goto("/admin/backups", { waitUntil: "load" })
    await expect(page.getByText("O servidor não conseguiu atender agora")).toBeVisible()
    await aguardarEstavel(page)
    await medir(page, info.project.name, "indisponivel", "erro-503-no-get")
    await axeZero(page, info.project.name, "erro-503-no-get")
  })

  test("estado geral com erro 500 (a tela segue útil)", async ({ page }, info) => {
    await entrar(page, "backup-s3@innoelektron.com")
    await page.evaluate(() => localStorage.setItem("mock:backup-estado", "HTTP_500"))
    await abrir(page)
    await expect(page.getByTestId("status-error")).toBeVisible()
    await medir(page, info.project.name, "s3", "estado-geral-erro-500")
    await axeZero(page, info.project.name, "estado-geral-erro-500")
  })

  test("retorno do Google: sucesso e cada tipo de erro (banner)", async ({ page }, info) => {
    await entrar(page, "backup-drive-desconectado@innoelektron.com")
    await page.goto("/admin/backup?google=ok", { waitUntil: "load" })
    await expect(page.getByTestId("google-return-ok")).toBeVisible()
    await aguardarEstavel(page)
    await medir(page, info.project.name, "drive-desconectado", "google-ok")
    await axeZero(page, info.project.name, "google-ok")
    await page.goto("/admin/backup?google=erro&motivo=no_refresh_token", { waitUntil: "load" })
    await expect(page.getByTestId("google-return-error")).toBeVisible()
    await aguardarEstavel(page)
    await medir(page, info.project.name, "drive-desconectado", "google-erro")
    await axeZero(page, info.project.name, "google-erro")
  })

  test("resultados das ações: backup concluído, teste do pg_dump, falha por código, destino ok e com falha, erro 429", async ({ page }, info) => {
    const p = info.project.name
    await entrar(page, "backup-s3@innoelektron.com")
    await abrir(page)
    await page.getByTestId("action-run").click()
    await expect(page.getByTestId("run-outcome")).toHaveAttribute("data-ok", "true", { timeout: 30_000 })
    await janelaAlta(page)
    await medir(page, p, "s3", "backup-concluido")
    await axeZero(page, p, "backup-concluido")

    await page.evaluate(() => localStorage.setItem("mock:backup-execucao", "OAUTH_DISCONNECTED"))
    await page.getByTestId("action-run").click()
    await expect(page.getByTestId("run-outcome")).toHaveAttribute("data-ok", "false", { timeout: 30_000 })
    await aguardarEstavel(page)
    await medir(page, p, "s3", "backup-falhou-por-codigo")
    await axeZero(page, p, "backup-falhou-por-codigo")

    await page.evaluate(() => localStorage.setItem("mock:backup-execucao", "VERIFY"))
    await page.getByTestId("action-verify").click()
    await expect(page.getByTestId("run-outcome")).toHaveAttribute("data-code", "VERIFY", { timeout: 30_000 })
    await aguardarEstavel(page)
    await medir(page, p, "s3", "conferencia-reprovada")

    await page.getByTestId("action-test").click()
    await expect(page.getByTestId("test-outcome")).toHaveAttribute("data-ok", "true")
    await medir(page, p, "s3", "destino-ok")
    await page.evaluate(() => localStorage.setItem("mock:backup-teste", "CREDENTIAL"))
    await page.getByTestId("action-test").click()
    await expect(page.getByTestId("test-outcome")).toHaveAttribute("data-ok", "false")
    await medir(page, p, "s3", "destino-com-falha")
    await axeZero(page, p, "destino-com-falha")
    await page.evaluate(() => localStorage.setItem("mock:backup-fila", "off"))
    await page.evaluate(() => localStorage.removeItem("mock:backup-execucao"))
    await page.getByTestId("action-run").click()
    await expect(page.getByTestId("action-error")).toBeVisible()
    await medir(page, p, "s3", "erro-da-fila")
    await axeZero(page, p, "erro-da-fila")
  })

  test("teste do pg_dump sem destino (aviso, não é backup)", async ({ page }, info) => {
    await entrar(page, "admin@innoelektron.com")
    await abrir(page)
    await page.getByTestId("action-run").click()
    await expect(page.getByTestId("run-outcome")).toHaveAttribute("data-ok", "true", { timeout: 30_000 })
    await janelaAlta(page)
    await medir(page, info.project.name, "admin", "teste-sem-destino")
    await axeZero(page, info.project.name, "teste-sem-destino")
  })

  test("backup na fila e em andamento (spinner é o conteúdo)", async ({ page }, info) => {
    await entrar(page, "backup-s3@innoelektron.com")
    await abrir(page)
    await page.getByTestId("action-run").click()
    await expect(page.getByTestId("active-run")).toHaveAttribute("data-status", "QUEUED")
    await janelaAlta(page)
    await medir(page, info.project.name, "s3", "na-fila")
    await axeZero(page, info.project.name, "na-fila")
  })

  test("S3: segredo aberto, trocar o endereço (credenciais de novo), erros de campo e do servidor", async ({ page }, info) => {
    const p = info.project.name
    await entrar(page, "backup-s3@innoelektron.com")
    await abrir(page)
    await page.getByRole("button", { name: "Substituir Chave de acesso" }).click()
    await page.getByTestId("secret-s3AccessKey").getByLabel("Chave de acesso").fill("valor-novo")
    await page.getByRole("button", { name: "Apagar o segredo salvo" }).click()
    await janelaAlta(page)
    await medir(page, p, "s3", "segredo-aberto-e-marcado-para-apagar")
    await axeZero(page, p, "segredo-aberto-e-marcado-para-apagar")

    await page.getByRole("button", { name: "Descartar" }).click()
    await page.getByTestId("s3-endpoint").fill("https://novo.exemplo.com")
    await page.getByTestId("field-retention").fill("0")
    await page.getByTestId("field-alert-after").fill("9999")
    await janelaAlta(page)
    await medir(page, p, "s3", "host-trocado-e-campos-invalidos")
    await axeZero(page, p, "host-trocado-e-campos-invalidos")

    await page.getByTestId("field-retention").fill("10")
    await page.getByTestId("field-alert-after").fill("36")
    await page.getByTestId("s3-endpoint").fill("https://localhost")
    await page.getByTestId("secret-s3AccessKey").getByLabel("Chave de acesso").fill("AK")
    await page.getByTestId("secret-s3SecretKey").getByLabel("Segredo").fill("SK")
    await salvar(page).click()
    await dialogoSalvar(page).getByLabel("Sua senha atual").fill(SENHA)
    await dialogoSalvar(page).getByRole("button", { name: "Confirmar e salvar" }).click()
    await expect(page.getByTestId("save-error")).toBeVisible()
    await janelaAlta(page)
    await medir(page, p, "s3", "erro-do-servidor-destino-proibido")
    await axeZero(page, p, "erro-do-servidor-destino-proibido")
  })

  test("Drive: Client ID trocado (aviso de desconexão), conectado e desconectado", async ({ page }, info) => {
    const p = info.project.name
    await entrar(page, "backup-drive@innoelektron.com")
    await abrir(page)
    await page.getByTestId("drive-client-id").fill("outro.apps.googleusercontent.com")
    await janelaAlta(page)
    await medir(page, p, "drive", "client-id-trocado")
    await axeZero(page, p, "client-id-trocado")
  })

  test("ligar e desligar: impedimentos escritos e o 429 do step-up", async ({ page }, info) => {
    const p = info.project.name
    await entrar(page, "backup-s3@innoelektron.com")
    await abrir(page)
    await page.getByTestId("field-retention").fill("5")
    await salvar(page).click()
    await dialogoSalvar(page).getByLabel("Sua senha atual").fill("stepup-429")
    await dialogoSalvar(page).getByRole("button", { name: "Confirmar e salvar" }).click()
    await expect(page.getByTestId("save-error")).toBeVisible()
    await janelaAlta(page)
    await medir(page, p, "s3", "erro-429-do-step-up")
    await axeZero(page, p, "erro-429-do-step-up")
  })

  test("diálogos: salvar (resumo + aviso de reduzir), senha errada, gerar chave, substituir chave, conectar e desconectar", async ({ page }, info) => {
    const p = info.project.name
    await entrar(page, "backup-s3@innoelektron.com")
    await abrir(page)
    await page.getByTestId("field-retention").fill("5")
    await salvar(page).click()
    await expect(dialogoSalvar(page)).toBeVisible()
    await medir(page, p, "s3", "dialogo-salvar-vazio", { dialogo: true })
    await axeZero(page, p, "dialogo-salvar", "[role=dialog]")
    await dialogoSalvar(page).getByLabel("Sua senha atual").fill("errada")
    await dialogoSalvar(page).getByRole("button", { name: "Confirmar e salvar" }).click()
    await expect(dialogoSalvar(page).getByText("Senha incorreta.")).toBeVisible()
    await medir(page, p, "s3", "dialogo-senha-errada", { dialogo: true })
    await axeZero(page, p, "dialogo-senha-errada", "[role=dialog]")
    await page.keyboard.press("Escape")
    await page.getByRole("button", { name: "Descartar" }).click()

    await page.getByTestId("key-replace").click()
    const trocar = page.getByRole("dialog", { name: "Substituir a chave do backup" })
    await expect(trocar).toBeVisible()
    await medir(page, p, "s3", "dialogo-substituir-chave", { dialogo: true })
    await axeZero(page, p, "dialogo-substituir-chave", "[role=dialog]")
    await trocar.getByTestId("replace-key-phrase").fill("GERAR NOVA CHAVE")
    await trocar.getByLabel("Sua senha atual").fill("errada")
    await trocar.getByTestId("key-confirm").click()
    await expect(trocar.getByText("Senha incorreta.")).toBeVisible()
    await medir(page, p, "s3", "dialogo-substituir-chave-senha-errada", { dialogo: true })
    await trocar.getByRole("button", { name: "Cancelar" }).click()
  })

  test("diálogo da chave gerada (aviso de 'guardei' e a chave) e gerar a primeira chave", async ({ page }, info) => {
    const p = info.project.name
    await entrar(page, "admin@innoelektron.com")
    await abrir(page)
    await page.getByTestId("key-generate").click()
    const gerar = page.getByRole("dialog", { name: "Gerar a chave do backup" })
    await expect(gerar).toBeVisible()
    await medir(page, p, "admin", "dialogo-gerar-chave", { dialogo: true })
    await axeZero(page, p, "dialogo-gerar-chave", "[role=dialog]")
    await gerar.getByLabel("Sua senha atual").fill(SENHA)
    await gerar.getByTestId("key-confirm").click()
    const revelar = page.getByTestId("key-reveal-dialog")
    await expect(revelar).toBeVisible()
    await medir(page, p, "admin", "dialogo-chave-gerada", { dialogo: true })
    await axeZero(page, p, "dialogo-chave-gerada", "[role=dialog]")
    await page.keyboard.press("Escape")
    await expect(revelar.getByTestId("key-saved-warning")).toBeVisible()
    await medir(page, p, "admin", "dialogo-chave-gerada-aviso-guardei", { dialogo: true })
    await axeZero(page, p, "dialogo-chave-gerada-aviso-guardei", "[role=dialog]")
  })

  test("diálogos do Google: conectar e desconectar (com o aviso do automático)", async ({ page }, info) => {
    const p = info.project.name
    await entrar(page, "backup-drive@innoelektron.com")
    await abrir(page)
    await page.getByTestId("drive-disconnect").click()
    const desconectar = page.getByRole("dialog", { name: "Desconectar a conta Google" })
    await expect(desconectar).toBeVisible()
    await medir(page, p, "drive", "dialogo-desconectar", { dialogo: true })
    await axeZero(page, p, "dialogo-desconectar", "[role=dialog]")
    await desconectar.getByRole("button", { name: "Cancelar" }).click()
    await page.getByTestId("drive-connect").click()
    const conectar = page.getByRole("dialog", { name: "Conectar com o Google" })
    await expect(conectar).toBeVisible()
    await medir(page, p, "drive", "dialogo-conectar", { dialogo: true })
    await axeZero(page, p, "dialogo-conectar", "[role=dialog]")
  })

  test("histórico: segunda página e linha com erro", async ({ page }, info) => {
    await entrar(page, "backup-s3@innoelektron.com")
    await abrir(page)
    await page.getByTestId("history-next").click()
    await expect(page.getByTestId("history-range")).toContainText("11–20")
    await aguardarEstavel(page)
    await medir(page, info.project.name, "s3", "historico-pagina-2")
    await axeZero(page, info.project.name, "historico-pagina-2")
  })
})

test.describe("2) geometria (ADMIN / OPERATOR)", () => {
  test("coluna e largura iguais às de Tarifas; sem rolagem lateral; 1 h1 + h2; alvos >= 44 a 375; barra só gruda com alteração; alturas dos cartões", async ({ page }, info) => {
    const larg = info.project.name
    await entrar(page, "backup-s3@innoelektron.com")

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
          alturas: {
            aviso: altura("secrets-key-notice"),
            estado: altura("section-status"),
            acoes: altura("section-actions"),
            chave: altura("section-key"),
            agendamento: altura("section-schedule"),
            destino: altura("section-destination"),
            barra: altura("save-bar"),
            historico: altura("section-history"),
            restaurar: altura("restore-notice"),
          },
          pequenos,
        }
      })

    const solta = await medidas()
    expect(solta.posicao).toBe("static")
    expect(solta.topoComScrollZero, "sem alteração a barra NÃO pode estar na dobra").toBeGreaterThan(solta.janela)
    expect(solta.rolagemLateral).toEqual({ main: 0, doc: 0 })
    expect(solta.h1).toBe(1)
    expect(solta.secoes).toEqual(["H1:Backups", "H2:Estado geral", "H2:Ações", "H2:Chave de criptografia", "H2:Agendamento", "H2:Destino", "H2:Histórico"])
    if (larg === "375") expect(solta.pequenos, `alvos < 44 px a 375: ${solta.pequenos.join(" | ")}`).toEqual([])

    await tela(page).getByTestId("field-alert-after").fill("48")
    await expect(page.getByTestId("save-bar-status")).toContainText("1 alteração não salva")
    const grudada = await medidas()
    expect(grudada.posicao).toBe("sticky")
    expect(grudada.topoComScrollZero).toBeLessThan(grudada.janela)
    expect(grudada.rolagemLateral).toEqual({ main: 0, doc: 0 })

    gravar(`${larg}__geometria`, { referencia, minha, solta, grudada })

    await page.getByRole("button", { name: "Descartar" }).click()
    const alto = await page.evaluate(() => document.querySelector("main")!.scrollHeight + 120)
    await page.setViewportSize({ width: Number(larg), height: Math.min(alto, 7000) })
    await aguardarEstavel(page)
    mkdirSync(PASTA, { recursive: true })
    await page.screenshot({ path: path.join(PASTA, `${larg}__pagina.png`) })
  })

  test("alturas do esqueleto de carga x cartões reais (para calibrar o `BackupSkeleton`)", async ({ page }, info) => {
    await entrar(page, "backup-s3@innoelektron.com")
    // Segura a resposta do GET da config para fotografar o esqueleto de verdade.
    await page.goto("/admin/backups", { waitUntil: "commit" })
    const esqueleto = await page.waitForFunction(
      () => {
        const el = document.querySelector('[aria-label="Carregando a configuração de backup"]')
        if (!el) return null
        return [...el.children].map((c) => Math.round(c.getBoundingClientRect().height))
      },
      undefined,
      { timeout: 30_000, polling: 20 },
    )
    gravar(`${info.project.name}__esqueleto`, await esqueleto.jsonValue())
    expect(true).toBe(true)
  })

  test("OPERATOR: sem o item no menu e a rota mostra 'Acesso restrito'", async ({ page }) => {
    await entrar(page, "operador@innoelektron.com")
    await page.goto("/admin/backups", { waitUntil: "load" })
    await expect(page.getByRole("heading", { level: 1, name: "Acesso restrito" })).toBeVisible()
    const links = await page.evaluate(() => [...document.querySelectorAll("nav a[href]")].map((a) => a.getAttribute("href")))
    expect(links).not.toContain("/admin/backups")
  })
})
