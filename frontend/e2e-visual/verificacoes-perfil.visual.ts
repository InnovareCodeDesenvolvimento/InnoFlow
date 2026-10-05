import { expect, test, type Page } from "@playwright/test"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { SENHA } from "./constantes"
import { medirContrastePixel } from "./contraste-pixel"
import { aguardarEstavel, prepararPagina } from "./estabilizar"

/**
 * VERIFICAÇÕES INDEPENDENTES do "Meu perfil" (`/app/perfil`, L1.2, commit 7c923d1) e da pílula avatar+nome do cabeçalho de TODAS as rotas /app/*:
 *  1) contraste de TEXTO por PIXEL em vários estados da tela (motorista comum, conta com CPF salvo + "Alterar CPF", erros de validação de dados e de senha, 403 de senha atual errada,
 *     falha de rede/5xx/429 ao salvar, "Dados salvos.", "Mostrar senhas", falha ao carregar o perfil, conta só-Google "Definir senha") e a pílula do cabeçalho em /app;
 *  2) o que a foto não mostra: o cabeçalho tem a MESMA altura (56 px) com e sem a pílula, o alvo da pílula tem >= 44 px, e nenhuma rota /app/* ganha rolagem horizontal.
 * Rodar: `npx playwright test --config playwright.visual.config.ts verificacoes-perfil`. Grava `e2e-visual/.resultados/perfil-contraste/*.json`.
 */

const PASTA = "e2e-visual/.resultados/perfil-contraste"
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
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30_000 })
}
async function abrirPerfil(page: Page) {
  await page.getByRole("link", { name: /^Meu perfil/ }).click()
  await expect(page).toHaveURL(/\/app\/perfil$/)
  await expect(page.getByLabel("Nome")).toBeVisible()
  await aguardarEstavel(page)
}
async function medir(page: Page, projeto: string, estado: string) {
  const r = await medirContrastePixel(page)
  gravar(`${projeto}__${estado}`, r)
  expect(r.textos, `nenhum texto medido (${estado})`).toBeGreaterThan(3)
  expect(r.reprovados, `texto abaixo do limiar AA por pixel (${estado}) a ${projeto}px: ${JSON.stringify(r.reprovados.slice(0, 3))}`).toEqual([])
}
const salvar = (p: Page) => p.getByRole("button", { name: "Salvar alterações" })
const alterarSenha = (p: Page) => p.getByRole("button", { name: "Alterar senha" })
const setKnob = (p: Page, k: string, v: string | null) => p.evaluate(([key, val]) => (val === null ? localStorage.removeItem(key) : localStorage.setItem(key, val)), [k, v] as const)

test.describe("1) contraste por pixel — Meu perfil", () => {
  test("motorista comum: tela normal, erros de dados, falhas ao salvar, Dados salvos, erros de senha, 403, Mostrar senhas", async ({ page }, info) => {
    const p = info.project.name
    await entrar(page, "motorista@innoelektron.com")
    await abrirPerfil(page)
    await medir(page, p, "motorista-normal")

    await page.getByLabel("Nome").fill("")
    await page.getByLabel("Telefone").fill("12ab")
    await page.getByLabel("CPF", { exact: true }).fill("111.111.111-11")
    await salvar(page).click()
    await expect(page.getByText("CPF inválido.")).toBeVisible()
    await medir(page, p, "dados-erros-de-validacao")

    await page.getByLabel("Nome").fill("Nome Novo")
    await page.getByLabel("Telefone").fill("(11) 91234-5678")
    await page.getByLabel("CPF", { exact: true }).fill("")
    for (const [knob, estado] of [["network", "falha-rede"], ["500", "falha-5xx"], ["429", "falha-429"]] as const) {
      await setKnob(page, "mock:profile-patch", knob)
      await salvar(page).click()
      await expect(page.getByRole("alert").first()).toBeVisible()
      await medir(page, p, `salvar-${estado}`)
    }
    await setKnob(page, "mock:profile-patch", null)
    await salvar(page).click()
    await expect(page.getByText("Dados salvos.")).toBeVisible()
    await medir(page, p, "dados-salvos")

    await alterarSenha(page).click()
    await expect(page.getByText("Informe a senha atual.")).toBeVisible()
    await medir(page, p, "senha-erros-de-validacao")

    await page.getByLabel(/^Senha atual/).fill("senha-errada-123")
    await page.getByLabel(/^Nova senha/).fill("senha-nova-1234")
    await page.getByLabel(/^Repita a nova senha/).fill("senha-nova-1234")
    await alterarSenha(page).click()
    await expect(page.getByText("Senha atual incorreta.")).toBeVisible()
    await medir(page, p, "senha-atual-errada-403")

    await page.getByLabel("Mostrar senhas").check()
    await medir(page, p, "mostrar-senhas")
  })

  test("conta com telefone e CPF salvos: CPF mascarado e 'Alterar CPF' aberto", async ({ page }, info) => {
    await entrar(page, "perfil@innoelektron.com")
    await abrirPerfil(page)
    await expect(page.getByTestId("cpf-masked")).toBeVisible()
    await medir(page, info.project.name, "perfil-cpf-mascarado")
    await page.getByRole("button", { name: "Alterar CPF" }).click()
    await medir(page, info.project.name, "perfil-alterar-cpf-aberto")
  })

  for (const [knob, estado] of [["network", "rede"], ["500", "5xx"]] as const) {
    test(`falha ao carregar o perfil (${estado}): estado de erro com 'Tentar novamente'`, async ({ page }, info) => {
      await entrar(page, "motorista@innoelektron.com")
      await setKnob(page, "mock:profile-get", knob)
      await page.getByRole("link", { name: /^Meu perfil/ }).click()
      await expect(page.getByRole("alert")).toBeVisible()
      await aguardarEstavel(page)
      await medir(page, info.project.name, `erro-ao-carregar-${estado}`)
    })
  }

  test("conta só-Google: 'Definir senha' (sem senha atual)", async ({ page }, info) => {
    await prepararPagina(page)
    await page.addInitScript(() => localStorage.setItem("mock:google-as", "user_driver_so_google"))
    await page.goto("/login", { waitUntil: "load" })
    await page.getByRole("button", { name: /Continuar com o Google \(mock\)/ }).click()
    await expect(page).toHaveURL(/\/app$/)
    await abrirPerfil(page)
    await expect(page.getByRole("heading", { level: 2, name: "Definir senha" })).toBeVisible()
    await medir(page, info.project.name, "so-google-definir-senha")
  })

  test("pílula avatar+nome do cabeçalho em /app (repouso)", async ({ page }, info) => {
    await entrar(page, "motorista@innoelektron.com")
    await aguardarEstavel(page)
    await medir(page, info.project.name, "cabecalho-pilula-em-app")
  })
})

test.describe("2) geometria do cabeçalho em TODAS as rotas /app/*", () => {
  const ROTAS_APP = ["/app", "/app/mapa", "/app/carteira", "/app/carteira/cartoes", "/app/carteira/adicionar", "/app/sessoes", "/app/perfil"]
  test("cabeçalho de 56 px, pílula com alvo >= 44 px dentro da janela, sem rolagem horizontal", async ({ page }, info) => {
    await entrar(page, "motorista@innoelektron.com")
    const achados: Record<string, unknown> = {}
    for (const rota of ROTAS_APP) {
      await page.goto(rota, { waitUntil: "load" })
      await aguardarEstavel(page)
      const m = await page.evaluate(() => {
        const h = document.querySelector("header")!
        const link = [...h.querySelectorAll("a")].find((a) => /^Meu perfil/.test(a.getAttribute("aria-label") ?? ""))
        const rl = link?.getBoundingClientRect()
        const sair = h.querySelector("button")?.getBoundingClientRect()
        return {
          alturaHeader: Math.round(h.getBoundingClientRect().height),
          pilula: rl ? { x: Math.round(rl.x), w: Math.round(rl.width), h: Math.round(rl.height), direita: Math.round(rl.right) } : null,
          sairX: sair ? Math.round(sair.x) : null,
          rolagemLateral: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          janela: window.innerWidth,
        }
      })
      achados[rota] = m
      expect(m.alturaHeader, `${rota}: altura do cabeçalho`).toBe(56)
      expect(m.pilula, `${rota}: pílula do perfil presente`).not.toBeNull()
      expect(m.pilula!.h, `${rota}: alvo da pílula`).toBeGreaterThanOrEqual(44)
      expect(m.pilula!.direita, `${rota}: a pílula não pode invadir o botão Sair`).toBeLessThanOrEqual(m.sairX!)
      expect(m.rolagemLateral, `${rota}: rolagem horizontal`).toBe(0)
    }
    gravar(`${info.project.name}__cabecalho-em-todas-as-rotas`, achados)
  })

  test("nome longo: a pílula trunca e não empurra o botão Sair para fora da janela (375)", async ({ page }, info) => {
    test.skip(info.project.name !== "375", "o caso extremo é o da menor largura")
    await entrar(page, "motorista@innoelektron.com")
    await expect(page.getByRole("link", { name: /^Meu perfil/ })).toBeVisible()
    await page.evaluate(() => {
      const s = document.querySelector("header a[href='/app/perfil'] span:last-child") as HTMLElement
      s.textContent = "Maximiliano-Bartolomeu"
    })
    const m = await page.evaluate(() => {
      const h = document.querySelector("header")!
      const sair = h.querySelector("button")!.getBoundingClientRect()
      const link = h.querySelector("a[href='/app/perfil']")!.getBoundingClientRect()
      return { sairDireita: Math.round(sair.right), janela: window.innerWidth, pilulaDireita: Math.round(link.right), sairX: Math.round(sair.x) }
    })
    expect(m.sairDireita).toBeLessThanOrEqual(m.janela)
    expect(m.pilulaDireita).toBeLessThanOrEqual(m.sairX)
  })
})
