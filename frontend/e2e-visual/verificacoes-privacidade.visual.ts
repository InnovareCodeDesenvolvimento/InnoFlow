import AxeBuilder from "@axe-core/playwright"
import { expect, test, type Page } from "@playwright/test"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { SENHA } from "./constantes"
import { medirContrastePixel } from "./contraste-pixel"
import { aguardarEstavel, prepararPagina } from "./estabilizar"

/**
 * VERIFICAÇÕES INDEPENDENTES de Privacidade e dados (L1.4), Notificações (L1.6) e Termos (L1.9), medidas no navegador - não deduzidas do CSS:
 *  1) contraste de TEXTO por PIXEL + axe `color-contrast` em cada estado (páginas legais, cadastro com aceite, pedido de aceite do Google, seções do perfil, os 3 passos da exclusão,
 *     avisos de erro, pedido de novo aceite no app), a 375/768/1440 (os 3 projetos do harness);
 *  2) geometria: sem rolagem horizontal e alvos de toque (>= 44 px no celular) dos controles novos.
 * NÃO é pixel-diff (isso é do `rotas.visual.ts`/`estados.visual.ts`, que dependem da baseline da Íris). Rodar: `npx playwright test --config playwright.visual.config.ts verificacoes-privacidade --update-snapshots=none`.
 * Grava `e2e-visual/.resultados/privacidade/<largura>__<estado>.json`.
 */

const PASTA = "e2e-visual/.resultados/privacidade"
function gravar(nome: string, dados: unknown) {
  mkdirSync(PASTA, { recursive: true })
  writeFileSync(path.join(PASTA, `${nome}.json`), JSON.stringify(dados, null, 1))
}

async function entrar(page: Page, email: string) {
  await page.goto("/login?redirect=%2Fapp")
  await page.getByLabel("E-mail").fill(email)
  await page.getByLabel("Senha").fill(SENHA)
  await page.getByRole("button", { name: "Entrar" }).click()
  await page.waitForURL((u) => u.pathname === "/app", { timeout: 30_000 })
}
async function irAoPerfil(page: Page, email = "exclusao@innoelektron.com") {
  await entrar(page, email)
  await page.getByRole("link", { name: /^Meu perfil/ }).click()
  await expect(page.getByRole("heading", { level: 2, name: "Privacidade e dados" })).toBeVisible()
}
const knob = (page: Page, k: string, v: string) => page.evaluate(([a, b]) => localStorage.setItem(a, b), [k, v] as const)
const abrirExclusao = (page: Page) => page.locator("section").filter({ has: page.getByRole("heading", { name: "Privacidade e dados" }) }).getByRole("button", { name: "Excluir minha conta" }).click()
const dlg = (page: Page) => page.getByRole("dialog")

interface Estado {
  id: string
  /** Elemento que identifica o estado pronto (em vez do h1, que não existe com diálogo aberto). */
  pronto: (page: Page) => Promise<void>
  abrir: (page: Page) => Promise<void>
}

const ESTADOS: Estado[] = [
  { id: "termos", pronto: (p) => expect(p.getByRole("heading", { level: 1, name: "Termos de Uso" })).toBeVisible(), abrir: async (p) => void (await p.goto("/termos")) },
  { id: "privacidade", pronto: (p) => expect(p.getByRole("heading", { level: 1, name: "Política de Privacidade" })).toBeVisible(), abrir: async (p) => void (await p.goto("/privacidade")) },
  {
    id: "privacidade-empresa-preenchida",
    pronto: (p) => expect(p.getByTestId("legal-company")).toBeVisible(),
    abrir: async (p) => {
      await p.goto("/login")
      await knob(p, "mock:legal-company", "full")
      await p.goto("/privacidade")
    },
  },
  {
    id: "cadastro-com-aceite",
    pronto: (p) => expect(p.getByRole("checkbox", { name: /Li e aceito/ })).toBeVisible(),
    abrir: async (p) => void (await p.goto("/cadastro")),
  },
  {
    id: "cadastro-aceite-erro",
    pronto: (p) => expect(p.getByText("Aceite os Termos de Uso e a Política de Privacidade para criar a conta.").first()).toBeVisible(),
    abrir: async (p) => {
      await p.goto("/cadastro")
      await p.getByLabel(/^Nome/).fill("Pessoa")
      await p.getByLabel(/^E-mail/).fill("pessoa@exemplo.com")
      await p.getByLabel(/^Senha/).fill("senha-nova-123")
      await p.getByRole("button", { name: "Criar conta" }).click()
    },
  },
  {
    id: "login-pedido-de-aceite-google",
    pronto: (p) => expect(p.getByTestId("google-terms-prompt")).toBeVisible(),
    abrir: async (p) => {
      await p.goto("/login")
      await knob(p, "mock:google-new", "1")
      await p.getByRole("button", { name: "Continuar com o Google (mock)" }).click()
    },
  },
  { id: "perfil-secoes", pronto: (p) => expect(p.getByTestId("always-on-notices")).toBeVisible(), abrir: async (p) => void (await irAoPerfil(p)) },
  {
    id: "perfil-notificacoes-limiar-erro",
    pronto: (p) => expect(p.getByText("Informe um valor entre R$ 5,00 e R$ 500,00, por exemplo 20,00.")).toBeVisible(),
    abrir: async (p) => {
      await irAoPerfil(p)
      await p.getByLabel("Avisar quando o saldo ficar abaixo de (R$)").fill("1")
      await p.getByRole("button", { name: "Salvar preferências" }).click()
    },
  },
  {
    id: "perfil-exportar-limite",
    pronto: (p) => expect(p.getByTestId("export-error")).toBeVisible(),
    abrir: async (p) => {
      await irAoPerfil(p)
      await knob(p, "mock:export-fail", "429")
      await p.getByRole("button", { name: "Baixar meus dados" }).click()
    },
  },
  {
    id: "exclusao-passo1",
    pronto: (p) => expect(p.getByTestId("deletion-balance")).toBeVisible(),
    abrir: async (p) => {
      await irAoPerfil(p)
      await abrirExclusao(p)
    },
  },
  {
    id: "exclusao-passo1-divida",
    pronto: (p) => expect(p.getByTestId("deletion-debt")).toBeVisible(),
    abrir: async (p) => {
      await irAoPerfil(p, "devedor@innoelektron.com")
      await abrirExclusao(p)
    },
  },
  {
    id: "exclusao-passo2-pix",
    pronto: (p) => expect(p.getByTestId("deletion-pix-preview")).toBeVisible(),
    abrir: async (p) => {
      await irAoPerfil(p)
      await abrirExclusao(p)
      await dlg(p).getByRole("button", { name: "Continuar" }).click()
      await dlg(p).getByLabel(/^Chave Pix/).fill("529.982.247-25")
    },
  },
  {
    id: "exclusao-passo2-pix-erro",
    pronto: (p) => expect(p.getByText(/Chave Pix inválida/)).toBeVisible(),
    abrir: async (p) => {
      await irAoPerfil(p)
      await abrirExclusao(p)
      await dlg(p).getByRole("button", { name: "Continuar" }).click()
      await dlg(p).getByLabel(/^Chave Pix/).fill("abc")
      await dlg(p).getByRole("button", { name: "Continuar" }).click()
    },
  },
  {
    id: "exclusao-passo3-confirmar",
    pronto: (p) => expect(p.getByLabel(/^Digite EXCLUIR/)).toBeVisible(),
    abrir: async (p) => {
      await irAoPerfil(p)
      await abrirExclusao(p)
      await dlg(p).getByRole("button", { name: "Continuar" }).click()
      await dlg(p).getByLabel(/^Chave Pix/).fill("fulano@exemplo.com")
      await dlg(p).getByRole("button", { name: "Continuar" }).click()
    },
  },
  {
    id: "exclusao-passo3-erros-de-campo",
    pronto: (p) => expect(p.getByText("Digite EXCLUIR para confirmar.")).toBeVisible(),
    abrir: async (p) => {
      await irAoPerfil(p, "exclusao-zero@innoelektron.com")
      await abrirExclusao(p)
      await dlg(p).getByRole("button", { name: "Continuar" }).click()
      await dlg(p).getByRole("button", { name: "Excluir minha conta" }).click()
    },
  },
  {
    id: "exclusao-aviso-bloqueante",
    pronto: (p) => expect(p.getByTestId("deletion-notice")).toBeVisible(),
    abrir: async (p) => {
      await irAoPerfil(p, "exclusao-zero@innoelektron.com")
      await abrirExclusao(p)
      await dlg(p).getByRole("button", { name: "Continuar" }).click()
      await dlg(p).getByLabel(/^Sua senha atual/).fill(SENHA)
      await dlg(p).getByLabel(/^Digite EXCLUIR/).fill("EXCLUIR")
      await knob(p, "mock:deletion-fail", "OPEN_DEBT")
      await dlg(p).getByRole("button", { name: "Excluir minha conta" }).click()
    },
  },
  {
    id: "exclusao-passo3-google",
    pronto: (p) => expect(p.getByTestId("deletion-google")).toBeVisible(),
    abrir: async (p) => {
      await p.goto("/login?redirect=%2Fapp")
      await knob(p, "mock:google-as", "user_driver_exclusao_google")
      await p.getByRole("button", { name: "Continuar com o Google (mock)" }).click()
      await p.waitForURL((u) => u.pathname === "/app")
      await p.getByRole("link", { name: /^Meu perfil/ }).click()
      await abrirExclusao(p)
      await dlg(p).getByRole("button", { name: "Continuar" }).click()
      await dlg(p).getByLabel(/^Chave Pix/).fill("fulano@exemplo.com")
      await dlg(p).getByRole("button", { name: "Continuar" }).click()
      await dlg(p).getByRole("button", { name: "Continuar com o Google (mock)" }).click()
      await expect(dlg(p).getByText("Identidade confirmada com o Google.")).toBeVisible()
    },
  },
  {
    id: "app-novo-aceite",
    pronto: (p) => expect(p.getByRole("dialog", { name: "Atualizamos nossos Termos" })).toBeVisible(),
    abrir: async (p) => void (await entrar(p, "termos@innoelektron.com")),
  },
  {
    id: "login-conta-excluida",
    pronto: (p) => expect(p.getByText("Sua conta foi excluída.")).toBeVisible(),
    abrir: async (p) => {
      await irAoPerfil(p, "exclusao-zero@innoelektron.com")
      await abrirExclusao(p)
      await dlg(p).getByRole("button", { name: "Continuar" }).click()
      await dlg(p).getByLabel(/^Sua senha atual/).fill(SENHA)
      await dlg(p).getByLabel(/^Digite EXCLUIR/).fill("EXCLUIR")
      await dlg(p).getByRole("button", { name: "Excluir minha conta" }).click()
    },
  },
]

test.describe("privacidade, notificações e termos - contraste por pixel, axe e geometria", () => {
  for (const estado of ESTADOS) {
    test(estado.id, async ({ page }, info) => {
      const largura = info.project.name
      await prepararPagina(page)
      await estado.abrir(page)
      await estado.pronto(page)
      await aguardarEstavel(page, { spinnerEhConteudo: true })

      const pixel = await medirContrastePixel(page)
      const axe = await new AxeBuilder({ page }).withRules(["color-contrast"]).analyze()
      const axeRuins = axe.violations.flatMap((v) => v.nodes.map((n) => n.target.join(" ")))

      const geo = await page.evaluate(() => {
        const visivel = (el: Element) => {
          const r = el.getBoundingClientRect()
          return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"
        }
        // Controles clicáveis novos: todo botão/link/checkbox visível dentro das áreas medidas.
        const raiz = document.querySelector('[role="dialog"]') ?? document.body
        const alvos = [...raiz.querySelectorAll<HTMLElement>("button, a[href], input[type=checkbox]")]
          .filter(visivel)
          .map((el) => {
            // O checkbox é pequeno (20 px) de propósito: o alvo de toque é o `label` que o envolve.
            const caixa = (el instanceof HTMLInputElement ? el.closest("label") ?? el : el).getBoundingClientRect()
            return { nome: (el.getAttribute("aria-label") || el.textContent || el.getAttribute("name") || el.tagName).trim().slice(0, 50), h: Math.round(caixa.height * 10) / 10 }
          })
        return { overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, alvos }
      })
      gravar(`${largura}__${estado.id}`, { pixel: { textos: pixel.textos, menor: pixel.menor, reprovados: pixel.reprovados }, axeColorContrast: axeRuins, geo })

      expect(pixel.textos, "nenhum texto medido").toBeGreaterThan(3)
      expect(pixel.reprovados, `texto abaixo de AA por pixel: ${JSON.stringify(pixel.reprovados.slice(0, 3))}`).toEqual([])
      expect(axeRuins, "axe color-contrast").toEqual([])
      expect(geo.overflow, "rolagem horizontal").toBe(0)
      if (largura === "375") {
        // Só os controles NOVOS desta entrega (lista fechada). Fora dela ficam controles de peças que já existiam e têm a própria régua: o "Fechar" do Radix (28 px visíveis, alvo ampliado
        // por ::before), o cabeçalho público, os links de texto corrido do Login/Cadastro e o trilho do interruptor (24 px visíveis, alvo ampliado por ::before).
        const NOVOS = /^(Baixar meus dados|Salvar preferências|Excluir minha conta|Continuar|Voltar|Cancelar|Aceitar e continuar|Agora não|Tentar de novo|Usar outra conta|Ir para a carteira|Ver a sessão|Li e aceito)/
        const pequenos = geo.alvos.filter((a) => NOVOS.test(a.nome) && a.h < 43.5)
        expect(pequenos, `alvos de toque < 44 px: ${JSON.stringify(pequenos.slice(0, 5))}`).toEqual([])
      }
    })
  }
})
