import { expect, test, type Page } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"

/**
 * L1.3 - "Esqueci minha senha" (`/esqueci-senha`) e "Redefinir senha" (`/redefinir-senha#t=<token>`), contra os MOCKS MSW (`mocks/handlers.ts`). NADA aqui foi provado contra o backend
 * real nem contra um e-mail real: o mock segue `ForgotPasswordRequest`/`ResetPasswordRequest` (`types/api.ts`) e as rotas lidas em `backend/src/api/routes/passwordReset.routes.ts`.
 *
 * Gatilhos do mock: forgot -> e-mail `ip-bloqueado@` (429 + Retry-After 300), `erro-servidor@` (500), `sem-rede@` (rede). reset -> o COMEÇO do token de 43 caracteres
 * (`invalido`, `limite`, `indisponivel`, `quebrado`, `semrede`; `motorista` troca de verdade a senha de `motorista@`); `localStorage["mock:reset-weak"]="1"` -> 400 VALIDATION_ERROR.
 * O estado do mock vive na PÁGINA: `page.goto` zera a senha trocada - por isso o "reset -> login com a senha nova" é UMA página só (navegação interna).
 */

const TOKEN_KEY = "innoelektron_token"
const SENHA_ANTIGA = "senha1234"
const SENHA_NOVA = "uma-senha-nova-123"
const SENT = "Se este e-mail tiver uma conta, enviamos um link para redefinir a senha. Ele vale por 30 minutos."
const NETWORK = "Sem conexão com o servidor. Confira sua internet e tente de novo."
const UNSTABLE = "O serviço está instável agora. Tente novamente em instantes."
const LINK_INVALIDO = "Este link é inválido ou expirou. Peça um novo."
const RATE_5MIN = "Muitas tentativas. Tente de novo em 5 minutos."

/** Token de 43 caracteres base64url com o prefixo que escolhe o cenário do mock. */
const tok = (prefix: string) => prefix.padEnd(43, "A")
const resetUrl = (prefix: string) => `/redefinir-senha#t=${tok(prefix)}`

/** Axe com todas as regras habilitadas por padrão (WCAG A/AA + boas práticas), igual ao resto da suíte: violações = 0. */
const axeViolations = async (page: Page) => (await new AxeBuilder({ page }).analyze()).violations

const horizontalOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

async function askForLink(page: Page, email: string) {
  await page.goto("/esqueci-senha")
  await page.getByLabel("E-mail").fill(email)
  await page.getByRole("button", { name: "Enviar link" }).click()
}

async function askForLinkAgain(page: Page, email: string) {
  await page.getByLabel("E-mail").fill(email)
  await page.getByRole("button", { name: "Enviar link" }).click()
}

async function fillReset(page: Page, password = SENHA_NOVA, confirm = password) {
  await page.getByLabel(/^Nova senha/).fill(password)
  await page.getByLabel("Repita a nova senha").fill(confirm)
}

const submitReset = (page: Page) => page.getByRole("button", { name: "Redefinir senha" })

test.describe("Login - link 'Esqueci minha senha'", () => {
  for (const width of [375, 1440]) {
    test(`${width}px: o link existe, é alvo de 44 px (a 375) e leva a /esqueci-senha`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 375 ? 812 : 900 })
      await page.goto("/login")
      const link = page.getByRole("link", { name: "Esqueci minha senha" })
      await expect(link).toBeVisible()
      const box = await link.boundingBox()
      expect(box!.height).toBeGreaterThanOrEqual(44) // o alvo é de 44 px em qualquer largura (o link é `min-h-11` sempre)
      expect(await horizontalOverflow(page)).toBe(0)
      await link.click()
      await expect(page).toHaveURL(/\/esqueci-senha$/)
      await expect(page.getByRole("heading", { level: 1, name: "Esqueceu a senha?" })).toBeVisible()
    })
  }

  test("o link vem DEPOIS do campo de senha e ANTES do botão Entrar na ordem de Tab", async ({ page }) => {
    await page.goto("/login")
    await page.getByLabel("Senha").focus()
    await page.keyboard.press("Tab")
    await expect(page.getByRole("link", { name: "Esqueci minha senha" })).toBeFocused()
    await page.keyboard.press("Tab")
    await expect(page.getByRole("button", { name: "Entrar" })).toBeFocused()
  })
})

test.describe("/esqueci-senha", () => {
  test("e-mail malformado: erro no campo, com foco, e fica na tela", async ({ page }) => {
    await page.goto("/esqueci-senha")
    await page.getByLabel("E-mail").fill("sem-arroba")
    await page.getByRole("button", { name: "Enviar link" }).click()
    const field = page.getByLabel("E-mail")
    await expect(page.getByText("E-mail inválido.")).toBeVisible()
    await expect(field).toBeFocused()
    await expect(field).toHaveAttribute("aria-invalid", "true")
    await expect(page.getByRole("heading", { level: 1, name: "Esqueceu a senha?" })).toBeVisible()
  })

  test("sucesso NEUTRO: a mesma frase para motorista, ADMIN e e-mail que não existe (nunca confirma nem nega a conta)", async ({ page }) => {
    const frases: string[] = []
    for (const email of ["motorista@innoelektron.com", "admin@innoelektron.com", "ninguem-aqui@example.com"]) {
      await askForLink(page, email)
      const heading = page.getByRole("heading", { level: 1, name: "Confira seu e-mail" })
      await expect(heading).toBeVisible()
      await expect(heading).toBeFocused() // foco no título: o leitor de tela lê o resultado
      frases.push((await page.getByText(SENT).innerText()).trim())
      const corpo = await page.locator("body").innerText()
      expect(corpo).not.toMatch(/n[ãa]o existe|n[ãa]o encontramos|n[ãa]o h[áa] conta|n[ãa]o cadastrad|administrador/i)
    }
    expect(new Set(frases).size).toBe(1)
    expect(frases[0]).toBe(SENT)
  })

  test("reenvio: botão travado com contagem regressiva, libera depois de 60 s, reenvia e rearma", async ({ page }) => {
    await page.clock.install()
    await askForLink(page, "motorista@innoelektron.com")
    await expect(page.getByRole("heading", { level: 1, name: "Confira seu e-mail" })).toBeVisible()

    const resend = page.getByRole("button", { name: /^Reenviar/ })
    await expect(resend).toBeDisabled()
    await expect(resend).toHaveText(/Reenviar em (5\d|60) s/)

    await page.clock.fastForward(30_000)
    await expect(resend).toHaveText(/Reenviar em (2\d|3[01]) s/)
    await expect(resend).toBeDisabled()

    await page.clock.fastForward(40_000)
    await expect(resend).toBeEnabled()
    await expect(resend).toHaveText("Reenviar e-mail")
    await expect(page.getByRole("status").filter({ hasText: "Você já pode reenviar o e-mail." })).toHaveCount(1)

    await resend.click()
    await expect(page.getByText("Pedido enviado de novo.")).toBeVisible()
    await expect(resend).toBeDisabled() // contagem rearmada
    await expect(resend).toHaveText(/Reenviar em (5\d|60) s/)
  })

  test("'Usar outro e-mail' volta ao formulário vazio", async ({ page }) => {
    await askForLink(page, "motorista@innoelektron.com")
    await page.getByRole("button", { name: "Usar outro e-mail" }).click()
    await expect(page.getByLabel("E-mail")).toHaveValue("")
    await expect(page.getByRole("heading", { level: 1, name: "Esqueceu a senha?" })).toBeVisible()
  })

  test("429: aviso com o tempo (Retry-After legível no mesmo domínio), foco no aviso e e-mail mantido", async ({ page }) => {
    await askForLink(page, "ip-bloqueado@example.com")
    const alert = page.getByRole("alert")
    await expect(alert).toHaveText(RATE_5MIN)
    await expect(alert).toBeFocused()
    await expect(page.getByLabel("E-mail")).toHaveValue("ip-bloqueado@example.com")
    await expect(page.getByRole("heading", { level: 1, name: "Esqueceu a senha?" })).toBeVisible()
  })

  test("5xx e falha de rede: as mensagens de authErrors, sem sair da tela", async ({ page }) => {
    await askForLink(page, "erro-servidor@example.com")
    await expect(page.getByRole("alert")).toHaveText(UNSTABLE)
    await askForLinkAgain(page, "sem-rede@example.com")
    await expect(page.getByRole("alert")).toHaveText(NETWORK)
  })

  test("teclado: Enter envia; 'Voltar ao login' é alcançável e leva ao /login", async ({ page }) => {
    await page.goto("/esqueci-senha")
    await page.getByLabel("E-mail").fill("motorista@innoelektron.com")
    await page.keyboard.press("Enter")
    await expect(page.getByRole("heading", { level: 1, name: "Confira seu e-mail" })).toBeVisible()
    await page.getByRole("link", { name: "Voltar ao login" }).focus()
    await page.keyboard.press("Enter")
    await expect(page).toHaveURL(/\/login$/)
  })
})

test.describe("/redefinir-senha - token no fragmento", () => {
  test("sem token: 'Link inválido' com botão para /esqueci-senha e nenhum formulário", async ({ page }) => {
    await page.goto("/redefinir-senha")
    const heading = page.getByRole("heading", { level: 1, name: "Link inválido" })
    await expect(heading).toBeVisible()
    await expect(heading).toBeFocused()
    await expect(page.getByText(LINK_INVALIDO)).toBeVisible()
    await expect(page.getByLabel(/^Nova senha/)).toHaveCount(0)
    await page.getByRole("link", { name: "Pedir novo link" }).click()
    await expect(page).toHaveURL(/\/esqueci-senha$/)
  })

  test("colar OUTRO link estando na tela (só o fragmento muda, sem recarregar): o token novo vale e o fragmento sai", async ({ page }) => {
    await page.goto("/redefinir-senha")
    await expect(page.getByRole("heading", { level: 1, name: "Link inválido" })).toBeVisible()
    await page.evaluate((t) => void (location.hash = `t=${t}`), tok("motorista"))
    await expect(page.getByRole("heading", { level: 1, name: "Crie uma nova senha" })).toBeVisible()
    await expect.poll(() => page.evaluate(() => location.hash)).toBe("")
  })

  test("o token na QUERYSTRING não vale (só o fragmento): 'Link inválido'", async ({ page }) => {
    await page.goto(`/redefinir-senha?t=${tok("motorista")}`)
    await expect(page.getByRole("heading", { level: 1, name: "Link inválido" })).toBeVisible()
  })

  test("token fora do formato (curto): 'Link inválido' e o fragmento sai da URL do mesmo jeito", async ({ page }) => {
    await page.goto("/redefinir-senha#t=curto")
    await expect(page.getByRole("heading", { level: 1, name: "Link inválido" })).toBeVisible()
    expect(new URL(page.url()).hash).toBe("")
  })

  test("o fragmento SAI da URL logo depois de lido; o token não fica em storage, atributo nem link, e há `no-referrer`", async ({ page }) => {
    await page.goto(resetUrl("motorista"))
    await expect(page.getByRole("heading", { level: 1, name: "Crie uma nova senha" })).toBeVisible()
    expect(new URL(page.url()).hash).toBe("")
    expect(page.url()).not.toContain(tok("motorista"))
    expect(await page.evaluate(() => location.hash)).toBe("")
    const donde = await page.evaluate((t) => ({
      local: JSON.stringify({ ...localStorage }).includes(t),
      session: JSON.stringify({ ...sessionStorage }).includes(t),
      html: document.documentElement.outerHTML.includes(t),
      referrer: document.querySelector('meta[name="referrer"]')?.getAttribute("content") ?? null,
      linksExternos: [...document.querySelectorAll("a[href]")].filter((a) => /^https?:/.test(a.getAttribute("href") ?? "")).length,
    }), tok("motorista"))
    expect(donde).toEqual({ local: false, session: false, html: false, referrer: "no-referrer", linksExternos: 0 })

    // Recarregar depois da leitura cai em 'link inválido' (o fragmento já foi apagado do histórico): consequência desejada.
    await page.reload()
    await expect(page.getByRole("heading", { level: 1, name: "Link inválido" })).toBeVisible()
    // A meta `no-referrer` é só desta tela: some ao sair dela.
    await page.getByRole("link", { name: "Voltar ao login" }).click()
    await expect(page).toHaveURL(/\/login$/)
    await expect(page.locator('meta[name="referrer"]')).toHaveCount(0)
  })
})

test.describe("/redefinir-senha - fluxo feliz", () => {
  test("esqueci -> redefinir -> /login com aviso, SEM auto-login; a senha antiga deixa de valer e a nova entra", async ({ page }) => {
    // 1) Pedido do link (o e-mail em si é do servidor; aqui só o 202 neutro).
    await askForLink(page, "motorista@innoelektron.com")
    await expect(page.getByText(SENT)).toBeVisible()

    // 2) Abre o link do e-mail (uma carga nova: é o que o clique no e-mail faz) e redefine.
    await page.goto(resetUrl("motorista"))
    await fillReset(page)
    await submitReset(page).click()

    // 3) Foi para /login, com o aviso (foco nele), sem sessão e sem token em lugar nenhum.
    await expect(page).toHaveURL(/\/login$/)
    const notice = page.getByRole("status").filter({ hasText: "Senha alterada. Entre com a nova senha." })
    await expect(notice).toBeVisible()
    await expect(notice).toBeFocused()
    expect(await page.evaluate((k) => localStorage.getItem(k), TOKEN_KEY)).toBeNull()
    expect(await page.evaluate((t) => JSON.stringify({ ...localStorage, ...sessionStorage }).includes(t), tok("motorista"))).toBe(false)
    // O estado da rota foi apagado na chegada (senão um F5 reexibiria o aviso).
    expect(await page.evaluate(() => history.state?.usr ?? null)).toBeNull()

    // 4) A senha antiga não entra; a nova entra.
    await page.getByLabel("E-mail").fill("motorista@innoelektron.com")
    await page.getByLabel("Senha").fill(SENHA_ANTIGA)
    await page.getByRole("button", { name: "Entrar" }).click()
    await expect(page.getByRole("alert")).toContainText("E-mail ou senha inválidos")
    await page.getByLabel("Senha").fill(SENHA_NOVA)
    await page.getByRole("button", { name: "Entrar" }).click()
    await expect(page).toHaveURL(/\/app/)
  })

  test("o aviso 'Senha alterada' NÃO persiste: recarregar o /login não o mostra de novo", async ({ page }) => {
    await page.goto(resetUrl("qualquer"))
    await fillReset(page)
    await submitReset(page).click()
    await expect(page).toHaveURL(/\/login$/)
    await expect(page.getByText("Senha alterada. Entre com a nova senha.")).toBeVisible()
    await page.reload()
    await expect(page.getByRole("heading", { level: 1, name: "Bem-vindo de volta" })).toBeVisible()
    await expect(page.getByText("Senha alterada. Entre com a nova senha.")).toHaveCount(0)
  })

  test("o login aberto direto (sem passar pelo reset) nunca mostra o aviso", async ({ page }) => {
    await page.goto("/login")
    await expect(page.getByText("Senha alterada")).toHaveCount(0)
  })
})

test.describe("/redefinir-senha - erros", () => {
  test("validação do cliente: curta, longa em BYTES e confirmação diferente - tudo no campo, nada enviado", async ({ page }) => {
    await page.goto(resetUrl("motorista"))
    await fillReset(page, "curta")
    await submitReset(page).click()
    await expect(page.getByText("A nova senha precisa de pelo menos 10 caracteres.")).toBeVisible()
    await expect(page.getByLabel(/^Nova senha/)).toBeFocused()

    await fillReset(page, "ã".repeat(37)) // 37 caracteres, 74 bytes
    await submitReset(page).click()
    await expect(page.getByText(/no máximo 72 bytes/i, { exact: false }).first()).toBeVisible()
    await expect(page.getByLabel(/^Nova senha/)).toHaveAttribute("aria-invalid", "true")

    await fillReset(page, SENHA_NOVA, `${SENHA_NOVA}x`)
    await submitReset(page).click()
    await expect(page.getByText("As senhas não conferem.")).toBeVisible()
    await expect(page.getByLabel("Repita a nova senha")).toBeFocused()
    await expect(page).toHaveURL(/\/redefinir-senha$/)
  })

  test("VALIDATION_ERROR do servidor: erro no campo, formulário e senha MANTIDOS; corrigida a causa, o MESMO token ainda vale", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("mock:reset-weak", "1"))
    await page.goto(resetUrl("motorista"))
    await fillReset(page)
    await submitReset(page).click()
    const field = page.getByLabel(/^Nova senha/)
    await expect(page.getByText("A nova senha precisa ter de 10 caracteres a 72 bytes.")).toBeVisible()
    await expect(field).toBeFocused()
    await expect(field).toHaveValue(SENHA_NOVA)
    await expect(page.getByLabel("Repita a nova senha")).toHaveValue(SENHA_NOVA)
    await expect(page.getByRole("heading", { level: 1, name: "Crie uma nova senha" })).toBeVisible()

    await page.evaluate(() => localStorage.removeItem("mock:reset-weak"))
    await submitReset(page).click()
    await expect(page).toHaveURL(/\/login$/)
  })

  test("RESET_TOKEN_INVALID: o formulário some, foco no título, e a única saída é pedir outro link", async ({ page }) => {
    await page.goto(resetUrl("invalido"))
    await fillReset(page)
    await submitReset(page).click()
    const heading = page.getByRole("heading", { level: 1, name: "Link inválido" })
    await expect(heading).toBeVisible()
    await expect(heading).toBeFocused()
    await expect(page.getByText(LINK_INVALIDO)).toBeVisible()
    await expect(page.getByLabel(/^Nova senha/)).toHaveCount(0)
    await page.getByRole("link", { name: "Pedir novo link" }).click()
    await expect(page).toHaveURL(/\/esqueci-senha$/)
  })

  test("429: tempo legível (Retry-After), foco no aviso, formulário mantido e SEM sair da tela", async ({ page }) => {
    await page.goto(resetUrl("limite"))
    await fillReset(page)
    await submitReset(page).click()
    const alert = page.getByRole("alert")
    await expect(alert).toHaveText(RATE_5MIN)
    await expect(alert).toBeFocused()
    await expect(page.getByLabel(/^Nova senha/)).toHaveValue(SENHA_NOVA)
    await expect(page).toHaveURL(/\/redefinir-senha$/)
  })

  test("503, 500 e falha de rede: avisos do formulário; senha e token mantidos", async ({ page }) => {
    for (const [prefix, texto] of [
      ["indisponivel", UNSTABLE],
      ["quebrado", UNSTABLE],
      ["semrede", NETWORK],
    ] as const) {
      await page.goto("/login") // outro caminho: trocar só o fragmento seria navegação no MESMO documento (o estado da tela anterior ficaria)
      await page.goto(resetUrl(prefix))
      await fillReset(page)
      await submitReset(page).click()
      await expect(page.getByRole("alert")).toHaveText(texto)
      await expect(page.getByLabel(/^Nova senha/)).toHaveValue(SENHA_NOVA)
      await expect(page.getByRole("heading", { level: 1, name: "Crie uma nova senha" })).toBeVisible()
    }
  })

  test("'Mostrar senhas' alterna os DOIS campos e é alvo de 44 px; as dicas acompanham a digitação", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto(resetUrl("motorista"))
    const nova = page.getByLabel(/^Nova senha/)
    const repita = page.getByLabel("Repita a nova senha")
    await expect(nova).toHaveAttribute("type", "password")
    const toggle = page.getByLabel("Mostrar senhas")
    expect((await toggle.locator("xpath=..").boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await toggle.check()
    await expect(nova).toHaveAttribute("type", "text")
    await expect(repita).toHaveAttribute("type", "text")

    const regras = page.getByRole("list", { name: "Requisitos da nova senha" })
    await expect(regras).toContainText("Pelo menos 10 caracteres (pendente)")
    await nova.fill("1234567890")
    await expect(regras).toContainText("Pelo menos 10 caracteres (atendido)")
    await nova.fill("ã".repeat(37))
    await expect(regras).toContainText("(não atendido)")
  })
})

test.describe("recuperação de senha - geometria (375/768/1440), axe e teclado", () => {
  const ESTADOS: Array<{ nome: string; abrir: (page: Page) => Promise<void> }> = [
    { nome: "login (com o link)", abrir: async (p) => void (await p.goto("/login")) },
    { nome: "esqueci - formulário", abrir: async (p) => void (await p.goto("/esqueci-senha")) },
    { nome: "esqueci - erro 429", abrir: (p) => askForLink(p, "ip-bloqueado@example.com") },
    {
      nome: "esqueci - enviado",
      abrir: async (p) => {
        await askForLink(p, "motorista@innoelektron.com")
        await expect(p.getByRole("heading", { level: 1, name: "Confira seu e-mail" })).toBeVisible()
      },
    },
    { nome: "redefinir - sem token", abrir: async (p) => void (await p.goto("/redefinir-senha")) },
    { nome: "redefinir - formulário", abrir: async (p) => void (await p.goto(resetUrl("motorista"))) },
    {
      nome: "redefinir - erros de campo",
      abrir: async (p) => {
        await p.goto(resetUrl("motorista"))
        await fillReset(p, "curta", "outra")
        await submitReset(p).click()
        await expect(p.getByText("A nova senha precisa de pelo menos 10 caracteres.")).toBeVisible()
      },
    },
    {
      nome: "redefinir - aviso 429",
      abrir: async (p) => {
        await p.goto(resetUrl("limite"))
        await fillReset(p)
        await submitReset(p).click()
        await expect(p.getByRole("alert")).toBeVisible()
      },
    },
  ]

  for (const width of [375, 768, 1440]) {
    for (const estado of ESTADOS) {
      test(`${width}px - ${estado.nome}: sem rolagem horizontal, controles dentro da janela, alvos >= 44 px (375), axe sem violações`, async ({ page }) => {
        await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 })
        await estado.abrir(page)
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible() // o chunk lazy da rota já montou (senão o axe mede a tela de carregamento)
        await page.waitForTimeout(400) // a animação de entrada do cartão (`animate-enter`) assenta antes de medir
        expect(await horizontalOverflow(page)).toBe(0)

        const medidas = await page.evaluate(() => {
          const visivel = (el: Element) => {
            const r = el.getBoundingClientRect()
            return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"
          }
          // Só controles do formulário/links principais do miolo (não os do painel de marca nem o `sr-only`).
          const alvos = [...document.querySelectorAll<HTMLElement>("main a, form a, form button, form input:not([type=checkbox]), form label, [data-card] a, a[href], button")]
            .filter(visivel)
            .filter((el) => !el.closest("aside") && !el.closest(".sr-only") && !el.matches(".sr-only"))
          return alvos.map((el) => {
            const r = el.getBoundingClientRect()
            return { texto: (el.textContent ?? "").trim().slice(0, 40) || el.tagName, tag: el.tagName, x: r.x, right: r.right, h: r.height, w: r.width }
          })
        })
        const vw = width
        for (const m of medidas) {
          expect(m.x, `${m.texto} começa dentro da janela`).toBeGreaterThanOrEqual(-0.5)
          expect(m.right, `${m.texto} termina dentro da janela`).toBeLessThanOrEqual(vw + 0.5)
        }
        if (width === 375) {
          // Alvos de toque do que o motorista aperta nesta recuperação (o logo e o rodapé do shell já têm a régua deles).
          for (const m of medidas.filter((x) => /Esqueci minha senha|Voltar ao login|Pedir novo link|Enviar link|Redefinir senha|Reenviar|Usar outro e-mail|Entrar/.test(x.texto))) {
            expect(m.h, `${m.texto} tem altura >= 44 px a 375`).toBeGreaterThanOrEqual(43.5)
          }
        }

        const violacoes = (await axeViolations(page)).map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)
        expect(violacoes).toEqual([])
      })
    }
  }

  test("teclado no reset: Tab percorre Nova senha -> Repita -> Mostrar senhas -> Redefinir senha -> Voltar ao login, com foco visível", async ({ page }) => {
    await page.goto(resetUrl("motorista"))
    await page.getByLabel(/^Nova senha/).focus()
    const ordem: string[] = []
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press("Tab")
      ordem.push(await page.evaluate(() => {
        const el = document.activeElement as HTMLElement
        const cs = getComputedStyle(el)
        const visivel = cs.outlineStyle !== "none" || cs.boxShadow !== "none"
        return `${el.tagName}:${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 30) || el.id}:${visivel ? "foco" : "sem-foco"}`
      }))
    }
    expect(ordem[0]).toMatch(/^INPUT:/) // Repita a nova senha
    expect(ordem[1]).toMatch(/^INPUT:/) // checkbox
    expect(ordem[2]).toMatch(/^BUTTON:Redefinir senha:foco$/)
    expect(ordem[3]).toMatch(/^A:Voltar ao login:foco$/)
  })
})
