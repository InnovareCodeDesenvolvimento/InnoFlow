import AxeBuilder from "@axe-core/playwright"
import { expect, test, type Page } from "@playwright/test"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { medirContrastePixel } from "./contraste-pixel"
import { aguardarEstavel, prepararPagina } from "./estabilizar"

/**
 * VERIFICAÇÕES INDEPENDENTES da recuperação de senha (L1.3: `/esqueci-senha`, `/redefinir-senha#t=`, link "Esqueci minha senha" no Login), medidas no navegador - não deduzidas do CSS:
 *  1) contraste de TEXTO por PIXEL (sobre o degradê/moldura de marca) + axe `color-contrast`, em todos os estados da tela, a 375/768/1440 (os 3 projetos do harness);
 *  2) geometria: sem rolagem horizontal, alvos de toque (>= 44 px) e a posição do link novo do Login (entre o campo de senha e o botão Entrar).
 * NÃO é pixel-diff (isso é do `rotas.visual.ts`/`estados.visual.ts`, que dependem da baseline da Íris). Rodar: `npx playwright test --config playwright.visual.config.ts verificacoes-recuperar-senha`.
 * Grava `e2e-visual/.resultados/recuperar-senha/<largura>__<estado>.json`.
 */

const PASTA = "e2e-visual/.resultados/recuperar-senha"
function gravar(nome: string, dados: unknown) {
  mkdirSync(PASTA, { recursive: true })
  writeFileSync(path.join(PASTA, `${nome}.json`), JSON.stringify(dados, null, 1))
}

const tok = (prefix: string) => prefix.padEnd(43, "A")
const SENHA_NOVA = "uma-senha-nova-123"

async function preencherReset(page: Page, senha = SENHA_NOVA, confirma = senha) {
  await page.getByLabel(/^Nova senha/).fill(senha)
  await page.getByLabel(/^Repita a nova senha/).fill(confirma)
}

const ESTADOS: Array<{ id: string; abrir: (page: Page) => Promise<void> }> = [
  { id: "login-com-link", abrir: async (p) => void (await p.goto("/login")) },
  {
    id: "login-aviso-senha-alterada",
    abrir: async (p) => {
      await p.goto(`/redefinir-senha#t=${tok("qualquer")}`)
      await preencherReset(p)
      await p.getByRole("button", { name: "Redefinir senha" }).click()
      await expect(p.getByText("Senha alterada. Entre com a nova senha.")).toBeVisible()
    },
  },
  { id: "esqueci-formulario", abrir: async (p) => void (await p.goto("/esqueci-senha")) },
  {
    id: "esqueci-erro-campo",
    abrir: async (p) => {
      await p.goto("/esqueci-senha")
      await p.getByLabel(/^E-mail/).fill("sem-arroba")
      await p.getByRole("button", { name: "Enviar link" }).click()
      await expect(p.getByText("E-mail inválido.")).toBeVisible()
    },
  },
  {
    id: "esqueci-erro-429",
    abrir: async (p) => {
      await p.goto("/esqueci-senha")
      await p.getByLabel(/^E-mail/).fill("ip-bloqueado@example.com")
      await p.getByRole("button", { name: "Enviar link" }).click()
      await expect(p.getByRole("alert")).toBeVisible()
    },
  },
  {
    id: "esqueci-enviado",
    abrir: async (p) => {
      await p.goto("/esqueci-senha")
      await p.getByLabel(/^E-mail/).fill("motorista@innoelektron.com")
      await p.getByRole("button", { name: "Enviar link" }).click()
      await expect(p.getByRole("heading", { level: 1, name: "Confira seu e-mail" })).toBeVisible()
    },
  },
  { id: "redefinir-sem-token", abrir: async (p) => void (await p.goto("/redefinir-senha")) },
  { id: "redefinir-formulario", abrir: async (p) => void (await p.goto(`/redefinir-senha#t=${tok("motorista")}`)) },
  {
    id: "redefinir-erros-de-campo",
    abrir: async (p) => {
      await p.goto(`/redefinir-senha#t=${tok("motorista")}`)
      await preencherReset(p, "curta", "outra")
      await p.getByRole("button", { name: "Redefinir senha" }).click()
      await expect(p.getByText("A nova senha precisa de pelo menos 10 caracteres.")).toBeVisible()
    },
  },
  {
    id: "redefinir-senha-longa-demais",
    abrir: async (p) => {
      await p.goto(`/redefinir-senha#t=${tok("motorista")}`)
      await p.getByLabel(/^Nova senha/).fill("ã".repeat(37))
      await expect(p.getByText("(não atendido)")).toBeVisible()
    },
  },
  {
    id: "redefinir-mostrar-senhas",
    abrir: async (p) => {
      await p.goto(`/redefinir-senha#t=${tok("motorista")}`)
      await preencherReset(p)
      await p.getByLabel("Mostrar senhas").check()
    },
  },
  ...(["limite", "indisponivel", "semrede"] as const).map((prefixo) => ({
    id: `redefinir-aviso-${prefixo}`,
    abrir: async (p: Page) => {
      await p.goto(`/redefinir-senha#t=${tok(prefixo)}`)
      await preencherReset(p)
      await p.getByRole("button", { name: "Redefinir senha" }).click()
      await expect(p.getByRole("alert")).toBeVisible()
    },
  })),
  {
    id: "redefinir-link-invalido-apos-envio",
    abrir: async (p) => {
      await p.goto(`/redefinir-senha#t=${tok("invalido")}`)
      await preencherReset(p)
      await p.getByRole("button", { name: "Redefinir senha" }).click()
      await expect(p.getByRole("heading", { level: 1, name: "Link inválido" })).toBeVisible()
    },
  },
]

test.describe("recuperação de senha - contraste por pixel, axe e geometria", () => {
  for (const estado of ESTADOS) {
    test(estado.id, async ({ page }, info) => {
      const largura = info.project.name
      await prepararPagina(page)
      await estado.abrir(page)
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible()
      await aguardarEstavel(page)

      // 1) contraste de texto por PIXEL + axe color-contrast.
      const pixel = await medirContrastePixel(page)
      const axe = await new AxeBuilder({ page }).withRules(["color-contrast"]).analyze()
      const axeRuins = axe.violations.flatMap((v) => v.nodes.map((n) => n.target.join(" ")))

      // 2) geometria.
      const geo = await page.evaluate(() => {
        const visivel = (el: Element) => {
          const r = el.getBoundingClientRect()
          return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"
        }
        const alvo = (el: Element | null) => {
          if (!el || !visivel(el)) return null
          const r = el.getBoundingClientRect()
          return { x: Math.round(r.x), y: Math.round(r.y + window.scrollY), w: Math.round(r.width), h: Math.round(r.height) }
        }
        const porTexto = (sel: string, texto: RegExp) => [...document.querySelectorAll(sel)].find((el) => texto.test(el.textContent ?? "")) ?? null
        return {
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          link: alvo(porTexto("a", /Esqueci minha senha/)),
          senha: alvo(document.querySelector('input[type="password"]')),
          entrar: alvo(porTexto("button", /^Entrar$/)),
          voltar: alvo(porTexto("a", /Voltar ao login/)),
          pedirNovo: alvo(porTexto("a", /Pedir novo link/)),
          primario: alvo(porTexto("button", /^(Enviar link|Redefinir senha)$/)),
          reenviar: alvo(porTexto("button", /^Reenviar/)),
        }
      })
      gravar(`${largura}__${estado.id}`, { pixel: { textos: pixel.textos, menor: pixel.menor, reprovados: pixel.reprovados }, axeColorContrast: axeRuins, geo })

      expect(pixel.textos, "nenhum texto medido").toBeGreaterThan(3)
      expect(pixel.reprovados, `texto abaixo de AA por pixel: ${JSON.stringify(pixel.reprovados.slice(0, 3))}`).toEqual([])
      expect(axeRuins, "axe color-contrast").toEqual([])
      expect(geo.overflow, "rolagem horizontal").toBe(0)
      // Alvo de toque de 44 px vale no celular (375). A partir de `sm` (640) o design system usa 40 px nos botões e 42 px nos campos (mouse): a medida fica no JSON, sem exigência.
      // O campo de senha só entra aqui como referência de posição (não é alvo de toque da régua).
      for (const nome of ["link", "entrar", "voltar", "pedirNovo", "primario", "reenviar"] as const) {
        const caixa = geo[nome]
        if (caixa === null) continue
        if (largura === "375" || nome === "link" || nome === "voltar") expect(caixa.h, `${nome}: alvo de toque >= 44 px`).toBeGreaterThanOrEqual(43.5)
      }
      if (estado.id === "login-com-link") {
        // O link novo fica ENTRE o campo de senha e o botão Entrar (ordem visual = ordem de Tab).
        expect(geo.link!.y).toBeGreaterThan(geo.senha!.y + geo.senha!.h - 1)
        expect(geo.link!.y + geo.link!.h).toBeLessThanOrEqual(geo.entrar!.y + 1)
      }
    })
  }
})
