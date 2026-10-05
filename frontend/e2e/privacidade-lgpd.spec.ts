import { readFileSync } from "node:fs"
import { expect, test, type Page } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"

/**
 * Privacidade e dados (L1.4 exportar/excluir conta), notificações (L1.6) e termos (L1.9: aceite no cadastro/Google, re-aceite, /termos e /privacidade), contra os mocks MSW
 * (`mocks/legalData.ts` e `mocks/notificationData.ts`; personas e gatilhos descritos lá). NADA aqui foi provado contra o backend real nem contra o Google real.
 * O estado do mock vive na PÁGINA: cada teste faz UM login e o resto é navegação interna (`page.goto` zera o mock).
 */

const SENHA = "senha1234"
const TOKEN_KEY = "innoelektron_token"
const MOCK_GOOGLE = "Continuar com o Google (mock)"
const setKnob = (page: Page, key: string, value: string | null) => page.evaluate(([k, v]) => (v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v)), [key, value] as const)
const noHScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
const token = (page: Page) => page.evaluate((k) => localStorage.getItem(k), TOKEN_KEY)

async function login(page: Page, email: string) {
  await page.goto("/login?redirect=%2Fapp")
  await page.getByLabel("E-mail").fill(email)
  await page.getByLabel("Senha").fill(SENHA)
  await page.getByRole("button", { name: "Entrar" }).click()
  await expect(page).toHaveURL(/\/app$/)
}

async function openProfile(page: Page) {
  await page.getByRole("link", { name: /^Meu perfil/ }).click()
  await expect(page).toHaveURL(/\/app\/perfil$/)
  await expect(page.getByRole("heading", { level: 2, name: "Privacidade e dados" })).toBeVisible()
}

/** Entra pelo "Google (mock)" numa conta existente (`mock:google-as`). */
async function loginGoogleAs(page: Page, userId: string) {
  await page.goto("/login?redirect=%2Fapp")
  await setKnob(page, "mock:google-as", userId)
  await page.getByRole("button", { name: MOCK_GOOGLE }).click()
  await expect(page).toHaveURL(/\/app$/)
}

const dialog = (page: Page) => page.getByRole("dialog", { name: "Excluir minha conta" })
const step = (page: Page) => page.getByTestId("deletion-step")
const openDelete = (page: Page) => page.locator("section").filter({ has: page.getByRole("heading", { name: "Privacidade e dados" }) }).getByRole("button", { name: "Excluir minha conta" }).click()

for (const viewport of [
  { name: "mobile (375px)", width: 375, height: 812 },
  { name: "desktop (1440px)", width: 1440, height: 900 },
]) {
  test.describe(`Privacidade e dados - ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } })

    test("seções na ordem certa, alvos de 44 px no celular, sem rolagem lateral e axe sem violações", async ({ page }) => {
      await login(page, "exclusao@innoelektron.com")
      await openProfile(page)
      const headings = await page.getByRole("heading", { level: 2 }).allTextContents()
      expect(headings.indexOf("Alterar senha")).toBeLessThan(headings.indexOf("Notificações"))
      expect(headings.indexOf("Notificações")).toBeLessThan(headings.indexOf("Privacidade e dados"))
      await expect(page.getByText("Baixe uma cópia dos seus dados em JSON (até 3 vezes por dia).")).toBeVisible()
      expect(await noHScroll(page)).toBe(0)
      if (viewport.width === 375) {
        for (const name of ["Baixar meus dados", "Salvar preferências"]) {
          const box = await page.getByRole("button", { name }).boundingBox()
          expect(box!.height, name).toBeGreaterThanOrEqual(44)
        }
        const del = await page.locator("section").filter({ has: page.getByRole("heading", { name: "Privacidade e dados" }) }).getByRole("button", { name: "Excluir minha conta" }).boundingBox()
        expect(del!.height).toBeGreaterThanOrEqual(44)
        for (const sw of await page.getByRole("switch").all()) expect((await sw.boundingBox())!.height).toBeGreaterThanOrEqual(24) // trilho visual; o alvo clicável é ampliado por ::before
      }
      const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()
      expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([])
    })

    test("exclusão com saldo: 3 passos, chave Pix validada, senha errada fica no campo, sucesso vai ao login com aviso e a conta deixa de existir", async ({ page }) => {
      await login(page, "exclusao@innoelektron.com")
      await openProfile(page)
      await openDelete(page)

      // Passo 1: texto definido pelo time + saldo.
      await expect(step(page)).toHaveText("Passo 1 de 3: Entenda o que acontece")
      await expect(page.getByTestId("deletion-warning")).toContainText("Exclusão da conta é definitiva. Seus dados pessoais são apagados (nome, e-mail, telefone, CPF, cartões salvos).")
      await expect(page.getByTestId("deletion-warning")).toContainText("Saldo restante é devolvido por Pix, em até 30 dias, para a chave que você informar.")
      await expect(page.getByTestId("deletion-balance")).toContainText("R$ 50,00")
      expect(await noHScroll(page)).toBe(0)
      const axe1 = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()
      expect(axe1.violations.map((v) => v.id)).toEqual([])
      await dialog(page).getByRole("button", { name: "Continuar" }).click()

      // Passo 2: chave Pix. Vazia e inválida barram; válida mostra a chave de volta para conferência.
      await expect(step(page)).toHaveText("Passo 2 de 3: Chave Pix para devolver o saldo")
      await dialog(page).getByRole("button", { name: "Continuar" }).click()
      await expect(dialog(page).getByText("Informe a chave Pix para receber a devolução do saldo.")).toBeVisible()
      await dialog(page).getByLabel(/^Chave Pix/).fill("não é uma chave")
      await dialog(page).getByRole("button", { name: "Continuar" }).click()
      await expect(dialog(page).getByText(/Chave Pix inválida/)).toBeVisible()
      await dialog(page).getByLabel(/^Chave Pix/).fill("529.982.247-25")
      await expect(page.getByTestId("deletion-pix-preview")).toContainText("CPF 529.982.247-25")
      await dialog(page).getByRole("button", { name: "Continuar" }).click()

      // Passo 3: reautenticação + palavra. Faltando tudo, erros nos campos (nada enviado).
      await expect(step(page)).toHaveText("Passo 3 de 3: Confirme que é você")
      const posts: unknown[] = []
      page.on("request", (r) => r.method() === "POST" && r.url().includes("/api/me/account/deletion") && posts.push(r.postDataJSON()))
      const final = dialog(page).getByRole("button", { name: "Excluir minha conta" })
      await final.click()
      await expect(dialog(page).getByText("Informe a sua senha atual.")).toBeVisible()
      await expect(dialog(page).getByText("Digite EXCLUIR para confirmar.")).toBeVisible()
      expect(posts).toHaveLength(0)

      // Senha errada: erro no campo (403, NÃO desloga), a conta segue lá.
      await dialog(page).getByLabel(/^Sua senha atual/).fill("senha-errada-1")
      await dialog(page).getByLabel(/^Digite EXCLUIR/).fill("excluir")
      await final.click()
      await expect(dialog(page).getByText("Senha incorreta.")).toBeVisible()
      expect(await token(page)).not.toBeNull()
      await expect(page).toHaveURL(/\/app\/perfil$/)

      // Senha certa: 200 -> login com o aviso, SEM ?redirect, token apagado.
      await dialog(page).getByLabel(/^Sua senha atual/).fill(SENHA)
      await final.click()
      await expect(page).toHaveURL(/\/login$/)
      await expect(page.getByRole("status").filter({ hasText: "Sua conta foi excluída." })).toContainText("devolvido por Pix, em até 30 dias")
      expect(await token(page)).toBeNull()
      // O corpo enviado: confirmação literal, senha e a chave Pix canônica; nada de googleCredential.
      expect(posts.at(-1)).toEqual({ confirmation: "EXCLUIR", currentPassword: SENHA, refundPixKey: "52998224725" })

      // O aviso não volta no F5 e o login antigo falha (conta anonimizada).
      await page.getByLabel("E-mail").fill("exclusao@innoelektron.com")
      await page.getByLabel("Senha").fill(SENHA)
      await page.getByRole("button", { name: "Entrar" }).click()
      await expect(page.getByText("E-mail ou senha inválidos.")).toBeVisible()
    })

    test("exclusão sem saldo: 2 passos (sem chave Pix) e aviso próprio no login", async ({ page }) => {
      await login(page, "exclusao-zero@innoelektron.com")
      await openProfile(page)
      await openDelete(page)
      await expect(step(page)).toHaveText("Passo 1 de 2: Entenda o que acontece")
      await expect(page.getByTestId("deletion-balance")).toContainText("R$ 0,00")
      await expect(page.getByTestId("deletion-balance")).toContainText("Você não tem saldo a devolver.")
      await dialog(page).getByRole("button", { name: "Continuar" }).click()
      await expect(step(page)).toHaveText("Passo 2 de 2: Confirme que é você")
      await expect(dialog(page).getByLabel(/^Chave Pix/)).toHaveCount(0)
      const posts: unknown[] = []
      page.on("request", (r) => r.method() === "POST" && r.url().includes("/api/me/account/deletion") && posts.push(r.postDataJSON()))
      await dialog(page).getByLabel(/^Sua senha atual/).fill(SENHA)
      await dialog(page).getByLabel(/^Digite EXCLUIR/).fill("EXCLUIR")
      await dialog(page).getByRole("button", { name: "Excluir minha conta" }).click()
      await expect(page).toHaveURL(/\/login$/)
      await expect(page.getByRole("status").filter({ hasText: "Sua conta foi excluída." })).toContainText("Seus dados pessoais foram apagados.")
      expect(posts.at(-1)).toEqual({ confirmation: "EXCLUIR", currentPassword: SENHA }) // sem refundPixKey
    })

    test("dívida em aberto: o passo 1 explica, mostra o valor, leva à carteira e NÃO deixa continuar", async ({ page }) => {
      await login(page, "devedor@innoelektron.com")
      await openProfile(page)
      await openDelete(page)
      await expect(page.getByTestId("deletion-debt")).toContainText("R$ 38,50")
      await expect(dialog(page).getByRole("button", { name: "Continuar" })).toBeDisabled()
      await dialog(page).getByRole("link", { name: "Ir para a carteira" }).click()
      await expect(page).toHaveURL(/\/app\/carteira$/)
      await expect(dialog(page)).toHaveCount(0)
    })

    test("saldo que não carrega: erro com 'Tentar de novo' e sem como continuar às cegas", async ({ page }) => {
      await login(page, "exclusao@innoelektron.com")
      await openProfile(page)
      await setKnob(page, "mock:wallet-get", "network")
      await openDelete(page)
      await expect(page.getByTestId("deletion-wallet-error")).toBeVisible()
      await expect(dialog(page).getByRole("button", { name: "Continuar" })).toBeDisabled()
      await setKnob(page, "mock:wallet-get", null)
      await dialog(page).getByRole("button", { name: "Tentar de novo" }).click()
      await expect(page.getByTestId("deletion-balance")).toContainText("R$ 50,00")
      await expect(dialog(page).getByRole("button", { name: "Continuar" })).toBeEnabled()
    })

    test("o diálogo é acessível por teclado: foco entra, Esc fecha, foco volta ao botão que abriu", async ({ page }) => {
      await login(page, "exclusao@innoelektron.com")
      await openProfile(page)
      const trigger = page.locator("section").filter({ has: page.getByRole("heading", { name: "Privacidade e dados" }) }).getByRole("button", { name: "Excluir minha conta" })
      await trigger.focus()
      await page.keyboard.press("Enter")
      await expect(dialog(page)).toBeVisible()
      expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true)
      await page.keyboard.press("Escape")
      await expect(dialog(page)).toHaveCount(0)
      await expect(trigger).toBeFocused()
    })
  })
}

test.describe("Exclusão de conta - erros por code (a conta nunca é apagada em erro)", () => {
  test.use({ viewport: { width: 375, height: 812 } })

  const CASES: Array<{ knob: string; text: RegExp; link?: string; stays?: "confirm" | "info" }> = [
    { knob: "ACTIVE_SESSION", text: /recarga em andamento/, link: "Ver a sessão" },
    { knob: "PAYMENT_IN_PROGRESS", text: /recarga ou um pagamento \(Pix ou cartão\) em andamento/, link: "Ir para a carteira" },
    { knob: "OPEN_DEBT", text: /dívida em aberto/, link: "Ir para a carteira" },
    { knob: "RATE_LIMITED_ACCOUNT_DELETION", text: /Muitas tentativas de exclusão\. Tente de novo em 10 minutos\. Sua conta não foi excluída\./ },
    { knob: "PAYMENT_SECRETS_KEY_MISSING", text: /devolução do saldo agora.*Sua conta não foi excluída/ },
    { knob: "STEPUP_UNAVAILABLE", text: /confirmar a sua identidade agora.*Sua conta não foi excluída/ },
    { knob: "500", text: /instável.*Sua conta não foi excluída/ },
    { knob: "network", text: /Sem conexão.*Sua conta não foi excluída/ },
    { knob: "FORBIDDEN", text: /Fale com o suporte/ },
  ]
  for (const c of CASES) {
    test(`${c.knob}`, async ({ page }) => {
      await login(page, "exclusao-zero@innoelektron.com")
      await openProfile(page)
      await openDelete(page)
      await dialog(page).getByRole("button", { name: "Continuar" }).click()
      await dialog(page).getByLabel(/^Sua senha atual/).fill(SENHA)
      await dialog(page).getByLabel(/^Digite EXCLUIR/).fill("EXCLUIR")
      await setKnob(page, "mock:deletion-fail", c.knob)
      await dialog(page).getByRole("button", { name: "Excluir minha conta" }).click()
      const notice = page.getByTestId("deletion-notice")
      await expect(notice).toBeVisible()
      await expect(notice).toContainText(c.text)
      await expect(notice).toBeFocused() // o aviso leva o foco
      if (c.link) await expect(notice.getByRole("link", { name: c.link })).toBeVisible()
      // Nada foi apagado: segue logado, no perfil, com o diálogo aberto.
      expect(await token(page)).not.toBeNull()
      await expect(page).toHaveURL(/\/app\/perfil$/)
      await expect(dialog(page)).toBeVisible()
      // Erros de ESTADO (dívida, sessão, pagamento) são bloqueantes: o botão final fica desabilitado até reabrir.
      if (["ACTIVE_SESSION", "PAYMENT_IN_PROGRESS", "OPEN_DEBT", "FORBIDDEN"].includes(c.knob)) {
        await expect(step(page)).toContainText(c.knob === "FORBIDDEN" ? "Passo 2 de 2" : "Passo 1 de 2")
      }
    })
  }

  test("o servidor diz que falta a chave Pix (saldo apareceu no meio): volta ao passo da chave, com erro e foco, e o 2º envio passa", async ({ page }) => {
    await login(page, "exclusao@innoelektron.com")
    await openProfile(page)
    await openDelete(page)
    await dialog(page).getByRole("button", { name: "Continuar" }).click()
    await dialog(page).getByLabel(/^Chave Pix/).fill("fulano@exemplo.com")
    await dialog(page).getByRole("button", { name: "Continuar" }).click()
    await dialog(page).getByLabel(/^Sua senha atual/).fill(SENHA)
    await dialog(page).getByLabel(/^Digite EXCLUIR/).fill("EXCLUIR")
    await setKnob(page, "mock:deletion-fail", "once:REFUND_PIX_KEY_REQUIRED")
    await dialog(page).getByRole("button", { name: "Excluir minha conta" }).click()
    await expect(step(page)).toContainText("Passo 2 de 3")
    await expect(dialog(page).getByText("Informe a chave Pix para receber a devolução do saldo.")).toBeVisible()
    await expect(dialog(page).getByLabel(/^Chave Pix/)).toBeFocused()
    await dialog(page).getByRole("button", { name: "Continuar" }).click()
    await dialog(page).getByLabel(/^Sua senha atual/).fill(SENHA)
    await dialog(page).getByLabel(/^Digite EXCLUIR/).fill("EXCLUIR")
    await dialog(page).getByRole("button", { name: "Excluir minha conta" }).click()
    await expect(page).toHaveURL(/\/login$/)
  })

  test("conta só-Google: reautentica com o Google (botão do login), credencial recusada NÃO desloga, e depois exclui", async ({ page }) => {
    await loginGoogleAs(page, "user_driver_exclusao_google")
    await openProfile(page)
    await openDelete(page)
    await dialog(page).getByRole("button", { name: "Continuar" }).click()
    await dialog(page).getByLabel(/^Chave Pix/).fill("+55 11 91234-5678")
    await dialog(page).getByRole("button", { name: "Continuar" }).click()
    await expect(dialog(page).getByTestId("deletion-google")).toContainText("Sua conta entra pelo Google")
    await expect(dialog(page).getByLabel(/^Sua senha atual/)).toHaveCount(0)
    await dialog(page).getByLabel(/^Digite EXCLUIR/).fill("EXCLUIR")
    // Sem confirmar com o Google: erro no campo, nada enviado.
    await dialog(page).getByRole("button", { name: "Excluir minha conta" }).click()
    await expect(dialog(page).getByText("Confirme com o Google para continuar.")).toBeVisible()
    await dialog(page).getByRole("button", { name: MOCK_GOOGLE }).click()
    await expect(dialog(page).getByText("Identidade confirmada com o Google.")).toBeVisible()
    // 401 INVALID_GOOGLE_TOKEN: a credencial é descartada e a SESSÃO continua (o interceptor não pode deslogar).
    await setKnob(page, "mock:deletion-fail", "once:INVALID_GOOGLE_TOKEN")
    const posts: unknown[] = []
    page.on("request", (r) => r.method() === "POST" && r.url().includes("/api/me/account/deletion") && posts.push(r.postDataJSON()))
    await dialog(page).getByRole("button", { name: "Excluir minha conta" }).click()
    await expect(dialog(page).getByText("Não foi possível validar a sua conta Google. Confirme de novo.")).toBeVisible()
    expect(await token(page)).not.toBeNull()
    await expect(page).toHaveURL(/\/app\/perfil$/)
    await expect(dialog(page).getByRole("button", { name: MOCK_GOOGLE })).toBeVisible() // pede de novo
    await dialog(page).getByRole("button", { name: MOCK_GOOGLE }).click()
    await dialog(page).getByRole("button", { name: "Excluir minha conta" }).click()
    await expect(page).toHaveURL(/\/login$/)
    expect(posts.at(-1)).toEqual({ confirmation: "EXCLUIR", googleCredential: "mock-google-credential", refundPixKey: "+5511912345678" })
  })

  test("Google desligado no servidor: a conta só-Google não consegue se reautenticar e a tela diz isso (sem botão quebrado)", async ({ page }) => {
    await loginGoogleAs(page, "user_driver_exclusao_google")
    await openProfile(page)
    await setKnob(page, "mock:google-disabled", "1")
    await page.reload()
    await expect(page.getByRole("heading", { level: 2, name: "Privacidade e dados" })).toBeVisible()
    // (o reload zera o mock e a sessão do mock continua válida pelo token do localStorage)
    await openDelete(page)
    await dialog(page).getByRole("button", { name: "Continuar" }).click()
    await dialog(page).getByLabel(/^Chave Pix/).fill("fulano@exemplo.com")
    await dialog(page).getByRole("button", { name: "Continuar" }).click()
    await expect(dialog(page).getByText(/login com o Google está indisponível/)).toBeVisible()
    await expect(dialog(page).getByRole("button", { name: "Excluir minha conta" })).toBeDisabled()
  })
})

test.describe("Exportar os dados", () => {
  test.use({ viewport: { width: 375, height: 812 } })

  test("baixa o arquivo JSON com o nome do dia, sem segredos, e avisa", async ({ page }) => {
    await login(page, "perfil@innoelektron.com")
    await openProfile(page)
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Baixar meus dados" }).click()])
    expect(download.suggestedFilename()).toMatch(/^innoflow-meus-dados-\d{8}\.json$/)
    const text = readFileSync((await download.path())!, "utf8")
    const json = JSON.parse(text) as { profile: { email: string; cpf: string | null } }
    expect(json.profile.email).toBe("perfil@innoelektron.com")
    expect(json.profile.cpf).toBe("52998224725") // o CPF INTEIRO é do titular
    expect(text).not.toMatch(/passwordHash|googleSub|ciphertext/i)
    await expect(page.getByTestId("export-done")).toHaveText("Cópia dos seus dados baixada.")
  })

  test("a 4ª exportação do dia é 429 com texto próprio; o aviso leva o foco; erros de rede e 5xx também", async ({ page }) => {
    await login(page, "exclusao-zero@innoelektron.com")
    await openProfile(page)
    const botao = page.getByRole("button", { name: "Baixar meus dados" })
    for (let i = 0; i < 3; i++) {
      const [d] = await Promise.all([page.waitForEvent("download"), botao.click()])
      await d.path()
    }
    await botao.click()
    await expect(page.getByTestId("export-error")).toHaveText("Você já baixou 3 cópias hoje. Tente de novo amanhã.")
    await expect(page.getByTestId("export-error")).toBeFocused()
    await setKnob(page, "mock:export-fail", "429-header")
    await botao.click()
    await expect(page.getByTestId("export-error")).toContainText("Tente de novo em 2 horas.")
    await setKnob(page, "mock:export-fail", "500")
    await botao.click()
    await expect(page.getByTestId("export-error")).toContainText("instável")
    await setKnob(page, "mock:export-fail", "network")
    await botao.click()
    await expect(page.getByTestId("export-error")).toContainText("Sem conexão")
  })
})

test.describe("Notificações (L1.6)", () => {
  test.use({ viewport: { width: 375, height: 812 } })

  test("padrão (ligado, ligado, R$ 20,00), 'Sempre ativos' sem interruptor, salva só o que mudou e o limiar só vale com o aviso ligado", async ({ page }) => {
    await login(page, "exclusao-zero@innoelektron.com")
    await openProfile(page)
    const recibo = page.getByRole("switch", { name: "Recibo da recarga por e-mail" })
    const saldo = page.getByRole("switch", { name: "Aviso de saldo baixo" })
    const limiar = page.getByLabel("Avisar quando o saldo ficar abaixo de (R$)")
    await expect(recibo).toBeChecked()
    await expect(saldo).toBeChecked()
    await expect(limiar).toHaveValue("20,00")
    await expect(page.getByTestId("always-on-notices")).toContainText("Troca de senha e exclusão de conta.")
    await expect(page.getByTestId("always-on-notices")).toContainText("falha e fica valor em aberto")
    await expect(page.getByTestId("always-on-notices")).toContainText("Pix creditado")
    expect(await page.getByTestId("always-on-notices").getByRole("switch").count()).toBe(0)
    const salvar = page.getByRole("button", { name: "Salvar preferências" })
    await expect(salvar).toBeDisabled() // nada mudou

    const bodies: unknown[] = []
    page.on("request", (r) => r.method() === "PATCH" && r.url().includes("/api/me/notification-preferences") && bodies.push(r.postDataJSON()))
    await recibo.click()
    await limiar.fill("35,50")
    await salvar.click()
    await expect(page.getByText("Preferências salvas.")).toBeVisible()
    expect(bodies.at(-1)).toEqual({ sessionReceiptEmail: false, lowBalanceThresholdCents: 3550 })
    await expect(limiar).toHaveValue("35,50")
    await expect(salvar).toBeDisabled()

    // Limiar fora do intervalo: erro no campo, com foco, nada enviado.
    const antes = bodies.length
    await limiar.fill("4,99")
    await salvar.click()
    await expect(page.getByText("Informe um valor entre R$ 5,00 e R$ 500,00, por exemplo 20,00.")).toBeVisible()
    await expect(limiar).toBeFocused()
    expect(bodies).toHaveLength(antes)

    // Desligado: o campo fica inativo e um valor inválido digitado não impede de salvar o interruptor.
    await saldo.click()
    await expect(limiar).toBeDisabled()
    await salvar.click()
    await expect(page.getByText("Preferências salvas.")).toBeVisible()
    expect(bodies.at(-1)).toEqual({ lowBalanceEnabled: false })
  })

  test("erros por code: 429 e 500 no salvar, e 500 no carregar com 'Tentar de novo'", async ({ page }) => {
    await login(page, "exclusao-zero@innoelektron.com")
    await openProfile(page)
    await page.getByRole("switch", { name: "Recibo da recarga por e-mail" }).click()
    await setKnob(page, "mock:notif-patch", "429")
    await page.getByRole("button", { name: "Salvar preferências" }).click()
    await expect(page.getByRole("alert").filter({ hasText: "Muitas alterações em pouco tempo." })).toBeFocused()
    await setKnob(page, "mock:notif-patch", "500")
    await page.getByRole("button", { name: "Salvar preferências" }).click()
    await expect(page.getByRole("alert").filter({ hasText: "instável" })).toBeVisible()

    await setKnob(page, "mock:notif-get", "500")
    await page.goto("/app/perfil") // zera o cache do app (e o mock): o GET de preferências falha de verdade
    await expect(page.getByTestId("notifications-error")).toContainText("instável", { timeout: 15_000 })
    // O resto do perfil NÃO cai junto.
    await expect(page.getByRole("heading", { level: 2, name: "Privacidade e dados" })).toBeVisible()
    await setKnob(page, "mock:notif-get", null)
    await page.getByTestId("notifications-error").getByRole("button", { name: "Tentar de novo" }).click()
    await expect(page.getByRole("switch", { name: "Aviso de saldo baixo" })).toBeVisible()
  })
})

test.describe("Aceite dos Termos no cadastro e no Google (L1.9)", () => {
  test.use({ viewport: { width: 375, height: 812 } })

  async function fillRegister(page: Page, email: string) {
    await page.getByLabel(/^Nome/).fill("Nova Pessoa")
    await page.getByLabel(/^E-mail/).fill(email)
    await page.getByLabel(/^Senha/).fill("senha-nova-123")
  }
  const aceite = (page: Page) => page.getByRole("checkbox", { name: /Li e aceito os Termos de Uso.*Política de Privacidade/ })

  test("sem marcar o aceite o cadastro não vai; com ele, manda a versão vigente; links abrem em outra aba; alvo de 44 px; axe", async ({ page }) => {
    await page.goto("/cadastro")
    await fillRegister(page, "nova.pessoa@exemplo.com")
    const posts: Array<Record<string, unknown>> = []
    page.on("request", (r) => r.method() === "POST" && r.url().endsWith("/api/auth/register") && posts.push(r.postDataJSON()))
    await page.getByRole("button", { name: "Criar conta" }).click()
    await expect(page.getByText("Aceite os Termos de Uso e a Política de Privacidade para criar a conta.")).toBeVisible()
    expect(posts).toHaveLength(0)
    const links = page.locator("label", { has: aceite(page) }).getByRole("link")
    await expect(links.nth(0)).toHaveAttribute("target", "_blank")
    await expect(links.nth(0)).toHaveAttribute("href", "/termos")
    await expect(links.nth(1)).toHaveAttribute("href", "/privacidade")
    const row = await page.locator("label", { has: aceite(page) }).boundingBox()
    expect(row!.height).toBeGreaterThanOrEqual(44)
    expect(await noHScroll(page)).toBe(0)
    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()
    expect(axe.violations.map((v) => v.id)).toEqual([])

    await aceite(page).check()
    await page.getByRole("button", { name: "Criar conta" }).click()
    await expect(page).toHaveURL(/\/$/)
    expect(posts).toHaveLength(1)
    expect(posts[0]).toMatchObject({ acceptedTermsVersion: "2026-10-01", email: "nova.pessoa@exemplo.com" })
    expect(posts[0]).not.toHaveProperty("acceptTerms")
  })

  test("versão mudou entre carregar e enviar (409): recarrega a vigente, desmarca a caixa, pede de novo e o 2º envio passa", async ({ page }) => {
    await page.goto("/cadastro")
    await setKnob(page, "mock:legal-bump", "1")
    await fillRegister(page, "bump@exemplo.com")
    await aceite(page).check()
    await page.getByRole("button", { name: "Criar conta" }).click()
    await expect(page.getByText("Os Termos de Uso foram atualizados. Leia a versão atual e aceite de novo.")).toBeVisible()
    await expect(aceite(page)).not.toBeChecked()
    await expect(aceite(page)).toBeFocused()
    const posts: Array<Record<string, unknown>> = []
    page.on("request", (r) => r.method() === "POST" && r.url().endsWith("/api/auth/register") && posts.push(r.postDataJSON()))
    await aceite(page).check()
    await page.getByRole("button", { name: "Criar conta" }).click()
    await expect(page).toHaveURL(/\/$/)
    expect(posts[0]).toMatchObject({ acceptedTermsVersion: "2026-10-02" })
  })

  test("versão vigente não carrega: erro com 'Tentar de novo' no cadastro; o LOGIN de quem já tem conta não é afetado", async ({ page }) => {
    await page.goto("/login") // (o MSW roda no navegador: o gatilho é por localStorage, não por page.route)
    await setKnob(page, "mock:legal-get", "network")
    await page.goto("/cadastro")
    await expect(page.getByText("Não foi possível carregar a versão atual dos Termos. Tente de novo.")).toBeVisible()
    await fillRegister(page, "sem-versao@exemplo.com")
    await aceite(page).check()
    await page.getByRole("button", { name: "Criar conta" }).click()
    await expect(page).toHaveURL(/\/cadastro$/) // nada foi enviado sem versão
    // Login normal e Google de quem já tem conta seguem funcionando.
    await login(page, "motorista@innoelektron.com")
  })

  test("Google no cadastro: com a caixa marcada manda a versão direto; sem marcar e conta NOVA, pede o aceite e REENVIA a mesma credencial", async ({ page }) => {
    await page.goto("/cadastro")
    await setKnob(page, "mock:google-new", "1")
    const posts: Array<Record<string, unknown>> = []
    page.on("request", (r) => r.method() === "POST" && r.url().endsWith("/api/auth/google") && posts.push(r.postDataJSON()))
    await page.getByRole("button", { name: MOCK_GOOGLE }).click()
    // 400 acceptedTermsVersion -> pedido de aceite na própria seção (a pessoa NÃO clica no Google de novo).
    const prompt = page.getByTestId("google-terms-prompt")
    await expect(prompt).toBeVisible()
    await expect(prompt.getByRole("checkbox")).toBeFocused()
    expect(posts[0]).toEqual({ credential: "mock-google-credential" })
    await prompt.getByRole("button", { name: "Aceitar e continuar" }).click()
    await expect(prompt.getByText("Aceite os Termos de Uso e a Política de Privacidade para criar a conta.")).toBeVisible()
    await prompt.getByRole("checkbox").check()
    await prompt.getByRole("button", { name: "Aceitar e continuar" }).click()
    await expect(page).toHaveURL(/\/app$/)
    expect(posts.at(-1)).toEqual({ credential: "mock-google-credential", acceptedTermsVersion: "2026-10-01" })
  })

  test("Google no cadastro com a caixa JÁ marcada: 1 só chamada, com a versão", async ({ page }) => {
    await page.goto("/cadastro")
    await setKnob(page, "mock:google-new", "1")
    await aceite(page).check()
    const posts: Array<Record<string, unknown>> = []
    page.on("request", (r) => r.method() === "POST" && r.url().endsWith("/api/auth/google") && posts.push(r.postDataJSON()))
    await page.getByRole("button", { name: MOCK_GOOGLE }).click()
    await expect(page).toHaveURL(/\/app$/)
    expect(posts).toEqual([{ credential: "mock-google-credential", acceptedTermsVersion: "2026-10-01" }])
  })

  test("Google no LOGIN: conta existente entra sem aceite; conta nova pede e, com a versão velha (409), recarrega e pede de novo", async ({ page }) => {
    await page.goto("/login")
    await page.getByRole("button", { name: MOCK_GOOGLE }).click()
    await expect(page).toHaveURL(/\/app$/) // existente: nenhum pedido de aceite

    await page.evaluate(() => localStorage.clear())
    await page.goto("/login")
    await setKnob(page, "mock:google-new", "1")
    await setKnob(page, "mock:legal-bump", "1")
    await page.getByRole("button", { name: MOCK_GOOGLE }).click()
    const prompt = page.getByTestId("google-terms-prompt")
    await prompt.getByRole("checkbox").check()
    await prompt.getByRole("button", { name: "Aceitar e continuar" }).click() // 409: a versão subiu
    await expect(prompt.getByText("Os Termos de Uso foram atualizados. Leia a versão atual e aceite de novo.")).toBeVisible()
    await prompt.getByRole("checkbox").check()
    await prompt.getByRole("button", { name: "Aceitar e continuar" }).click()
    await expect(page).toHaveURL(/\/app$/)
  })

  test("pedir o aceite do Google pode ser cancelado (credencial descartada)", async ({ page }) => {
    await page.goto("/login")
    await setKnob(page, "mock:google-new", "1")
    await page.getByRole("button", { name: MOCK_GOOGLE }).click()
    await page.getByTestId("google-terms-prompt").getByRole("button", { name: "Cancelar" }).click()
    await expect(page.getByTestId("google-terms-prompt")).toHaveCount(0)
    await expect(page).toHaveURL(/\/login$/)
  })
})

test.describe("Novo aceite dos Termos no app (L1.9)", () => {
  test.use({ viewport: { width: 375, height: 812 } })
  const reaccept = (page: Page) => page.getByRole("dialog", { name: "Atualizamos nossos Termos" })

  test("quem está em dia não vê nada", async ({ page }) => {
    await login(page, "motorista@innoelektron.com")
    await page.waitForTimeout(600)
    await expect(reaccept(page)).toHaveCount(0)
  })

  test("aceite antigo: abre o aviso; 'Agora não' dispensa na aba (não reaparece ao navegar); aceitar exige a caixa e some depois", async ({ page }) => {
    await login(page, "termos@innoelektron.com")
    await expect(reaccept(page)).toBeVisible()
    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()
    expect(axe.violations.map((v) => v.id)).toEqual([])
    await reaccept(page).getByRole("button", { name: "Agora não" }).click()
    await expect(reaccept(page)).toHaveCount(0)
    await page.getByRole("link", { name: /^Meu perfil/ }).click()
    await page.waitForTimeout(400)
    await expect(reaccept(page)).toHaveCount(0)

    // No acesso seguinte (aba nova = sessionStorage novo) volta, e aceitar registra.
    await page.evaluate(() => sessionStorage.clear())
    await page.getByRole("link", { name: "Início" }).first().click()
    await page.getByRole("link", { name: /^Meu perfil/ }).click()
    await page.reload()
    await expect(reaccept(page)).toBeVisible()
    const posts: Array<Record<string, unknown>> = []
    page.on("request", (r) => r.method() === "POST" && r.url().includes("/api/me/consents") && posts.push(r.postDataJSON()))
    await reaccept(page).getByRole("button", { name: "Aceitar e continuar" }).click()
    await expect(reaccept(page).getByText("Aceite os Termos de Uso e a Política de Privacidade para criar a conta.")).toBeVisible()
    await reaccept(page).getByRole("checkbox").check()
    await reaccept(page).getByRole("button", { name: "Aceitar e continuar" }).click()
    await expect(reaccept(page)).toHaveCount(0)
    expect(posts).toEqual([{ termsVersion: "2026-10-01", privacyVersion: "2026-10-01" }])
  })

  test("falha ao registrar o aceite mostra o erro e mantém o diálogo; falha ao LER o status não atrapalha o app", async ({ page }) => {
    await login(page, "termos@innoelektron.com")
    await expect(reaccept(page)).toBeVisible()
    await setKnob(page, "mock:consents-post", "500")
    await reaccept(page).getByRole("checkbox").check()
    await reaccept(page).getByRole("button", { name: "Aceitar e continuar" }).click()
    await expect(reaccept(page).getByRole("alert").filter({ hasText: "O serviço está instável agora." })).toBeVisible()
    await expect(reaccept(page)).toBeVisible()

    await page.evaluate(() => sessionStorage.clear())
    await setKnob(page, "mock:consents-get", "500")
    await page.goto("/app") // zera o mock: mesma conta, mesmo token
    await expect(page.getByRole("navigation", { name: "Navegação do aplicativo" })).toBeVisible()
    await page.waitForTimeout(500)
    await expect(reaccept(page)).toHaveCount(0)
  })
})

test.describe("Páginas /termos e /privacidade (L1.9)", () => {
  for (const viewport of [
    { name: "mobile (375px)", width: 375, height: 812 },
    { name: "desktop (1440px)", width: 1440, height: 900 },
  ]) {
    test.describe(viewport.name, () => {
      test.use({ viewport: { width: viewport.width, height: viewport.height } })

      for (const doc of [
        { path: "/termos", h1: "Termos de Uso", other: "Política de Privacidade" },
        { path: "/privacidade", h1: "Política de Privacidade", other: "Termos de Uso" },
      ]) {
        test(`${doc.path}: abre sem login, estrutura em seções, índice, sem rolagem lateral e axe sem violações`, async ({ page }) => {
          await page.goto(doc.path)
          await expect(page.getByRole("heading", { level: 1, name: doc.h1 })).toBeVisible()
          await expect(page).toHaveTitle(new RegExp(doc.h1))
          const nav = page.getByRole("navigation", { name: "Neste documento" })
          const items = await nav.getByRole("link").count()
          expect(items).toBeGreaterThanOrEqual(7)
          expect(await page.getByRole("heading", { level: 2 }).count()).toBe(items)
          await expect(page.getByTestId("legal-version")).toContainText("Versão 2026-10-01")
          expect(await noHScroll(page)).toBe(0)
          // Índice leva à seção (âncora) e o link cruzado existe.
          await nav.getByRole("link").nth(2).click()
          await expect(page).toHaveURL(/#sec-/)
          await expect(page.getByRole("link", { name: doc.other, exact: true }).last()).toBeVisible()
          if (viewport.width === 375) expect((await nav.getByRole("link").first().boundingBox())!.height).toBeGreaterThanOrEqual(44)
          const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()
          expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([])
        })
      }

      test("dados da empresa: vazios NÃO aparecem (em dev/mock só um aviso interno); preenchidos aparecem só os que existem", async ({ page }) => {
        await page.goto("/privacidade")
        await expect(page.getByTestId("legal-company")).toHaveCount(0)
        await expect(page.getByTestId("legal-company-missing")).toContainText("dados da empresa ainda não informados")
        await expect(page.getByText("Responsável", { exact: true })).toHaveCount(0)

        await setKnob(page, "mock:legal-company", "full")
        await page.goto("/privacidade")
        const company = page.getByTestId("legal-company")
        await expect(company).toContainText("11.222.333/0001-81")
        await expect(company.getByRole("link", { name: "dpo@exemplo.invalid" })).toHaveAttribute("href", "mailto:dpo@exemplo.invalid")
        await expect(page.getByTestId("legal-company-missing")).toHaveCount(0)
      })

      test("a busca dos dados falhar não quebra a página (texto legível; sem versão, sem bloco de empresa)", async ({ page }) => {
        await page.goto("/login")
        await setKnob(page, "mock:legal-get", "network")
        await page.goto("/privacidade")
        await expect(page.getByRole("heading", { level: 1, name: "Política de Privacidade" })).toBeVisible()
        await expect(page.getByText("Ao excluir a conta, apagamos o IP e o dispositivo (user-agent)", { exact: false })).toBeVisible()
        await expect(page.getByTestId("legal-version")).toHaveText("")
      })

      test("o texto de retenção definido está na política, palavra por palavra", async ({ page }) => {
        await page.goto("/privacidade")
        await expect(page.locator("article")).toContainText(
          "Ao excluir a conta, apagamos o IP e o dispositivo (user-agent) registrados no início das suas recargas e o IP do aceite dos termos. Mantemos, sem identificação, as sessões, o extrato e os pagamentos por 5 anos (obrigação legal e fiscal). Registros de auditoria de segurança anteriores à exclusão podem conter e-mail, nome e IP do titular e são apagados por expurgo automático por idade (24 meses).",
        )
      })
    })
  }

  test.describe("links nos rodapés", () => {
    test.use({ viewport: { width: 375, height: 812 } })
    test("landing, páginas públicas, Login e Cadastro levam a /termos e /privacidade", async ({ page }) => {
      for (const from of ["/", "/eletropostos", "/login", "/cadastro", "/esqueci-senha", "/termos"]) {
        await page.goto(from)
        const nav = page.getByRole("navigation", { name: "Documentos legais" })
        await expect(nav.getByRole("link", { name: "Termos de Uso" }), from).toBeVisible()
        await expect(nav.getByRole("link", { name: "Política de Privacidade" }), from).toHaveAttribute("href", "/privacidade")
        if (from !== "/") expect((await nav.getByRole("link").first().boundingBox())!.height, from).toBeGreaterThanOrEqual(36)
      }
      await page.goto("/login")
      await page.getByRole("navigation", { name: "Documentos legais" }).getByRole("link", { name: "Termos de Uso" }).click()
      await expect(page).toHaveURL(/\/termos$/)
    })
  })
})
