import { expect, test, type Page } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"

/**
 * L1.2 - tela "Meu perfil" do motorista (`/app/perfil`) + troca de senha, contra os mocks MSW (`mocks/profileData.ts`). NADA aqui foi provado contra o backend real
 * (o `meProfile.routes.ts` está sendo feito em paralelo): o mock segue o contrato de `types/api.ts` e as regras lidas em `backend/src/api/{schemas,routes}`.
 * O estado do mock vive na PÁGINA: cada teste faz UM login e o resto é navegação interna (`page.goto` zeraria o mock - e, depois de trocar a senha, a senha também).
 * Contas (ver `mocks/data.ts`): `motorista@` (sem telefone/CPF), `perfil@` (telefone e CPF já salvos), `so-google@` (sem senha; entra pelo "Google (mock)" com
 * `localStorage["mock:google-as"]`). Falhas por `localStorage`: `mock:profile-get|profile-patch|password-fail` (ver o cabeçalho de `mocks/profileData.ts`).
 */

const PASSWORD = "senha1234"
const NEW_PASSWORD = "uma-senha-nova-123"
const TOKEN_KEY = "innoelektron_token"
const NETWORK = "Sem conexão com o servidor. Confira sua internet e tente de novo."
const UNSTABLE = "O serviço está instável agora. Tente novamente em instantes."
const RATE_LIMIT = "Muitas tentativas para esta conta. Aguarde alguns minutos e tente novamente."
const CPF_VALIDO = "529.982.247-25"
const CPF_EM_USO = "111.444.777-35"

async function login(page: Page, email = "motorista@innoelektron.com") {
  await page.goto("/login?redirect=%2Fapp")
  await page.getByLabel("E-mail").fill(email)
  await page.getByLabel("Senha").fill(PASSWORD)
  await page.getByRole("button", { name: "Entrar" }).click()
  await expect(page).toHaveURL(/\/app$/)
}

async function openProfile(page: Page) {
  await page.getByRole("link", { name: /^Meu perfil/ }).click()
  await expect(page).toHaveURL(/\/app\/perfil$/)
  await expect(page.getByRole("heading", { level: 1, name: "Meu perfil" })).toBeVisible()
  await expect(page.getByLabel("Nome")).toBeVisible()
}

const nome = (page: Page) => page.getByLabel("Nome")
const telefone = (page: Page) => page.getByLabel("Telefone")
const cpf = (page: Page) => page.getByLabel("CPF", { exact: true })
const salvar = (page: Page) => page.getByRole("button", { name: "Salvar alterações" })
const senhaAtual = (page: Page) => page.getByLabel(/^Senha atual/)
const novaSenha = (page: Page) => page.getByLabel(/^Nova senha/)
const repita = (page: Page) => page.getByLabel(/^Repita a nova senha/)
const alterarSenha = (page: Page) => page.getByRole("button", { name: "Alterar senha" })
const token = (page: Page) => page.evaluate((k) => localStorage.getItem(k), TOKEN_KEY)
const setKnob = (page: Page, key: string, value: string | null) =>
  page.evaluate(([k, v]) => (v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v)), [key, value] as const)
const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

for (const viewport of [
  { name: "mobile (375px)", width: 375, height: 812 },
  { name: "desktop (1440px)", width: 1440, height: 900 },
]) {
  test.describe(`Meu perfil - ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } })

    test("abre pelo cabeçalho (não pela barra de baixo), mostra os dados e o e-mail só para leitura; sem rolagem horizontal", async ({ page }) => {
      await login(page)
      // A barra inferior continua com os 5 destinos de sempre.
      await expect(page.getByRole("navigation", { name: "Navegação do aplicativo" }).getByRole("link")).toHaveCount(5)
      await openProfile(page)

      await expect(nome(page)).toHaveValue("Carla Motorista")
      const email = page.getByLabel("E-mail", { exact: true })
      await expect(email).toHaveValue("motorista@innoelektron.com")
      await expect(email).toHaveAttribute("readonly", "")
      await expect(page.getByText("O e-mail não pode ser alterado por aqui.")).toBeVisible()
      // Seções de L1.6 e L1.4/L1.9 (cobertas em `privacidade-lgpd.spec.ts`): aqui só a presença e a ordem na pilha.
      await expect(page.getByRole("heading", { level: 2, name: "Notificações" })).toBeVisible()
      await expect(page.getByRole("heading", { level: 2, name: "Privacidade e dados" })).toBeVisible()
      // Cabeçalho marca a página atual e a barra inferior segue sem aba ativa nova.
      await expect(page.getByRole("link", { name: /^Meu perfil/ })).toHaveAttribute("aria-current", "page")
      expect(await noHorizontalScroll(page)).toBe(0)
    })

    test("salvar o nome: manda SÓ o que mudou, mostra 'Dados salvos.' e o cabeçalho muda sem relogar", async ({ page }) => {
      await login(page)
      await openProfile(page)
      const bodies: unknown[] = []
      page.on("request", (r) => r.method() === "PATCH" && r.url().includes("/api/me/profile") && bodies.push(r.postDataJSON()))

      await expect(salvar(page)).toBeDisabled() // nada mudou
      await nome(page).fill("Ana Beatriz Souza")
      await expect(salvar(page)).toBeEnabled()
      await salvar(page).click()

      await expect(page.getByText("Dados salvos.")).toBeVisible()
      expect(bodies).toEqual([{ name: "Ana Beatriz Souza" }])
      await expect(page.getByRole("link", { name: "Meu perfil, Ana" })).toBeVisible()
      await expect(page.getByRole("heading", { level: 1, name: "Meu perfil" })).toBeVisible()
      await expect(salvar(page)).toBeDisabled() // o formulário voltou a "limpo" com os dados salvos
      // Escrever de novo apaga o aviso de sucesso (não fica "salvo" velho na tela).
      await nome(page).fill("Ana B. Souza")
      await expect(page.getByText("Dados salvos.")).toHaveCount(0)
    })

    test("telefone e CPF: validação no cliente com foco no primeiro erro; CPF de outra conta (409) vai no campo CPF", async ({ page }) => {
      await login(page)
      await openProfile(page)
      let patches = 0
      page.on("request", (r) => r.method() === "PATCH" && r.url().includes("/api/me/profile") && patches++)

      // Nome vazio -> erro no campo, foco nele, nada vai ao servidor.
      await nome(page).fill("")
      await salvar(page).click()
      await expect(page.getByText("Informe o nome.")).toBeVisible()
      await expect(nome(page)).toBeFocused()
      await expect(nome(page)).toHaveAttribute("aria-invalid", "true")

      // Telefone inválido e CPF inválido: o PRIMEIRO campo com erro recebe o foco.
      await nome(page).fill("Carla Motorista")
      await telefone(page).fill("12ab")
      await cpf(page).fill("111.111.111-11")
      await salvar(page).click()
      await expect(page.getByText("Use apenas números, espaço, +, ( ) e -.")).toBeVisible()
      await expect(page.getByText("CPF inválido.")).toBeVisible()
      await expect(telefone(page)).toBeFocused()
      expect(patches).toBe(0)

      // CPF válido, mas de outra conta: o servidor responde 409 e a tela mostra no campo CPF (por code).
      await telefone(page).fill("(11) 91234-5678")
      await cpf(page).fill(CPF_EM_USO)
      await salvar(page).click()
      await expect(page.getByText("Este CPF já está cadastrado em outra conta.")).toBeVisible()
      await expect(cpf(page)).toBeFocused()
      expect(patches).toBe(1)

      // CPF próprio válido: salva, o campo some e o CPF volta SÓ mascarado.
      await cpf(page).fill(CPF_VALIDO)
      await salvar(page).click()
      await expect(page.getByText("Dados salvos.")).toBeVisible()
      await expect(page.getByTestId("cpf-masked")).toHaveText("***.982.247-**")
      await expect(cpf(page)).toHaveCount(0)
      await expect(page.getByText(CPF_VALIDO)).toHaveCount(0)
    })

    test("conta com CPF e telefone salvos: CPF mascarado, 'Alterar CPF' abre campo vazio, apagar o telefone manda null", async ({ page }) => {
      await login(page, "perfil@innoelektron.com")
      await openProfile(page)
      const bodies: unknown[] = []
      page.on("request", (r) => r.method() === "PATCH" && r.url().includes("/api/me/profile") && bodies.push(r.postDataJSON()))

      await expect(page.getByTestId("cpf-masked")).toHaveText("***.982.247-**")
      await expect(telefone(page)).toHaveValue("(11) 91234-5678")
      await page.getByRole("button", { name: "Alterar CPF" }).click()
      await expect(cpf(page)).toHaveValue("")
      await expect(page.getByText("Cadastrado: ***.982.247-**. Preencha só para trocar.")).toBeVisible()
      await page.getByRole("button", { name: "Manter o CPF atual" }).click()
      await expect(page.getByTestId("cpf-masked")).toBeVisible()

      await telefone(page).fill("")
      await salvar(page).click()
      await expect(page.getByText("Dados salvos.")).toBeVisible()
      expect(bodies).toEqual([{ phone: null }]) // CPF NÃO é apagado por estar vazio
      await expect(page.getByTestId("cpf-masked")).toHaveText("***.982.247-**")
    })

    test("falha ao salvar: rede fora, 5xx e 429 viram aviso do formulário (com foco), por code, e os dados digitados ficam", async ({ page }) => {
      await login(page)
      await openProfile(page)
      await nome(page).fill("Nome Novo")

      for (const [knob, message] of [
        ["network", NETWORK],
        ["500", UNSTABLE],
        ["429", RATE_LIMIT],
      ] as const) {
        await setKnob(page, "mock:profile-patch", knob)
        await salvar(page).click()
        const alert = page.getByRole("alert").filter({ hasText: message })
        await expect(alert).toBeVisible()
        await expect(alert).toBeFocused()
        await expect(nome(page)).toHaveValue("Nome Novo")
      }
      // Voltou a rede: a mesma tela salva sem recarregar.
      await setKnob(page, "mock:profile-patch", null)
      await salvar(page).click()
      await expect(page.getByText("Dados salvos.")).toBeVisible()
    })

    test("troca de senha: validação no cliente (curta, confirmação diferente, igual à atual) com foco no primeiro erro", async ({ page }) => {
      await login(page)
      await openProfile(page)
      let posts = 0
      page.on("request", (r) => r.method() === "POST" && r.url().includes("/api/auth/password") && posts++)

      await alterarSenha(page).click()
      await expect(page.getByText("Informe a senha atual.")).toBeVisible()
      await expect(senhaAtual(page)).toBeFocused()

      await senhaAtual(page).fill(PASSWORD)
      await novaSenha(page).fill("curta123")
      await repita(page).fill("outra-coisa")
      await alterarSenha(page).click()
      await expect(page.getByText("A nova senha precisa de pelo menos 10 caracteres.")).toBeVisible()
      await expect(page.getByText("As senhas não conferem.")).toBeVisible()
      await expect(novaSenha(page)).toBeFocused()

      await novaSenha(page).fill(PASSWORD + "12")
      await repita(page).fill(PASSWORD + "12")
      await senhaAtual(page).fill(PASSWORD + "12")
      await alterarSenha(page).click()
      await expect(page.getByText("A nova senha precisa ser diferente da atual.")).toBeVisible()
      expect(posts).toBe(0)
    })

    test("senha atual errada (403): erro no campo, foco nele, e a sessão NÃO cai (token e tela intactos)", async ({ page }) => {
      await login(page)
      await openProfile(page)
      const before = await token(page)

      await senhaAtual(page).fill("senha-errada-123")
      await novaSenha(page).fill(NEW_PASSWORD)
      await repita(page).fill(NEW_PASSWORD)
      await alterarSenha(page).click()

      await expect(page.getByText("Senha atual incorreta.")).toBeVisible()
      await expect(senhaAtual(page)).toBeFocused()
      await expect(page).toHaveURL(/\/app\/perfil$/)
      expect(await token(page)).toBe(before)
      // Nenhum texto do backend vaza (o mock responde "Senha atual incorreta." de propósito igual; o que prova é o code - ver profileErrors.test.ts).
      await expect(novaSenha(page)).toHaveValue(NEW_PASSWORD)
    })

    test("troca de senha com sucesso: token NOVO, o antigo é revogado (401), a sessão segue e o formulário limpa", async ({ page }) => {
      await login(page)
      await openProfile(page)
      const oldToken = await token(page)

      await senhaAtual(page).fill(PASSWORD)
      await novaSenha(page).fill(NEW_PASSWORD)
      await repita(page).fill(NEW_PASSWORD)
      await alterarSenha(page).click()

      await expect(page.getByText("Senha alterada. Neste aparelho você continua conectado; nos outros será preciso entrar de novo.")).toBeVisible()
      await expect(senhaAtual(page)).toHaveValue("")
      await expect(novaSenha(page)).toHaveValue("")
      const newToken = await token(page)
      expect(newToken).toBeTruthy()
      expect(newToken).not.toBe(oldToken)

      // O servidor (mock) revogou o token anterior e aceita o novo.
      const status = (t: string) => page.evaluate(async (tk) => (await fetch("/api/me/profile", { headers: { Authorization: `Bearer ${tk}` } })).status, t)
      expect(await status(oldToken!)).toBe(401)
      expect(await status(newToken!)).toBe(200)

      // Segue logada: navegar dentro do app continua funcionando (sem redirecionar para o login).
      await page.getByRole("navigation", { name: "Navegação do aplicativo" }).getByRole("link", { name: "Carteira" }).click()
      await expect(page).toHaveURL(/\/app\/carteira$/)
      await expect(page.getByText("Saldo disponível")).toBeVisible()
    })

    test("troca de senha: rede fora, 5xx e 429 viram aviso (com foco), sem derrubar a sessão nem apagar o que foi digitado", async ({ page }) => {
      await login(page)
      await openProfile(page)
      const before = await token(page)
      await senhaAtual(page).fill(PASSWORD)
      await novaSenha(page).fill(NEW_PASSWORD)
      await repita(page).fill(NEW_PASSWORD)

      for (const [knob, message] of [
        ["network", NETWORK],
        ["500", UNSTABLE],
        ["429", RATE_LIMIT],
      ] as const) {
        await setKnob(page, "mock:password-fail", knob)
        await alterarSenha(page).click()
        const alert = page.getByRole("alert").filter({ hasText: message })
        await expect(alert).toBeVisible()
        await expect(alert).toBeFocused()
        // Nunca "senha incorreta" por falha de rede (era o bug do login, L1.1).
        await expect(page.getByText("Senha atual incorreta.")).toHaveCount(0)
        expect(await token(page)).toBe(before)
        await expect(novaSenha(page)).toHaveValue(NEW_PASSWORD)
      }
      await setKnob(page, "mock:password-fail", null)
      await alterarSenha(page).click()
      await expect(page.getByText(/^Senha alterada\./)).toBeVisible()
    })

    test("'Mostrar senhas' revela e oculta os três campos juntos", async ({ page }) => {
      await login(page)
      await openProfile(page)
      for (const field of [senhaAtual(page), novaSenha(page), repita(page)]) await expect(field).toHaveAttribute("type", "password")
      await page.getByLabel("Mostrar senhas").check()
      for (const field of [senhaAtual(page), novaSenha(page), repita(page)]) await expect(field).toHaveAttribute("type", "text")
      await page.getByLabel("Mostrar senhas").uncheck()
      await expect(novaSenha(page)).toHaveAttribute("type", "password")
    })

    for (const forced of [
      { knob: "network", message: NETWORK },
      { knob: "500", message: UNSTABLE },
      { knob: "empty", message: "Não foi possível carregar seu perfil. Tente novamente." },
    ]) {
      test(`carregamento do perfil falha (${forced.knob}): estado de erro com mensagem por code e 'Tentar novamente' que recupera`, async ({ page }) => {
        await login(page)
        await setKnob(page, "mock:profile-get", forced.knob)
        await gotoProfile(page)
        await expect(page.getByRole("alert").filter({ hasText: forced.message })).toBeVisible()
        await expect(nome(page)).toHaveCount(0)
        // A faixa escura continua dizendo quem é (vem do login, não da rede).
        await expect(page.getByRole("heading", { level: 1, name: "Meu perfil" })).toBeVisible()

        await setKnob(page, "mock:profile-get", null)
        await page.getByRole("button", { name: "Tentar novamente" }).click()
        await expect(nome(page)).toHaveValue("Carla Motorista")
      })
    }

    test("acessibilidade: axe sem violações (inclui contraste) no estado normal e com erros na tela", async ({ page }) => {
      await login(page)
      await openProfile(page)
      const run = async () => (await new AxeBuilder({ page }).analyze()).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)
      expect(await run()).toEqual([])

      await nome(page).fill("")
      await salvar(page).click()
      await alterarSenha(page).click()
      await expect(page.getByText("Informe o nome.")).toBeVisible()
      await expect(page.getByText("Informe a senha atual.")).toBeVisible()
      expect(await run()).toEqual([])
    })
  })
}

/** Abre o perfil sem exigir o campo "Nome" (o teste de falha de carregamento não o tem). */
async function gotoProfile(page: Page) {
  await page.getByRole("link", { name: /^Meu perfil/ }).click()
  await expect(page).toHaveURL(/\/app\/perfil$/)
}

test.describe("Meu perfil - conta só-Google (sem senha)", () => {
  test.use({ viewport: { width: 375, height: 812 } })

  test("'Definir senha' sem campo de senha atual; depois de definir vira 'Alterar senha' com o campo", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("mock:google-as", "user_driver_so_google"))
    await page.goto("/login")
    await page.getByRole("button", { name: /Continuar com o Google \(mock\)/ }).click()
    await expect(page).toHaveURL(/\/app$/)
    await openProfile(page)

    await expect(page.getByRole("heading", { level: 2, name: "Definir senha" })).toBeVisible()
    await expect(senhaAtual(page)).toHaveCount(0)
    const bodies: unknown[] = []
    page.on("request", (r) => r.method() === "POST" && r.url().includes("/api/auth/password") && bodies.push(r.postDataJSON()))

    await novaSenha(page).fill(NEW_PASSWORD)
    await repita(page).fill(NEW_PASSWORD)
    await page.getByRole("button", { name: "Definir senha" }).click()

    await expect(page.getByText(/^Senha definida\./)).toBeVisible()
    expect(bodies).toEqual([{ newPassword: NEW_PASSWORD }]) // nenhuma senha atual no corpo
    await expect(page.getByRole("heading", { level: 2, name: "Alterar senha" })).toBeVisible()
    await expect(senhaAtual(page)).toBeVisible()
  })
})

test.describe("Meu perfil - alvos de toque e estabilidade de layout a 375 px", () => {
  test.use({ viewport: { width: 375, height: 812 } })

  test("controles interativos >= 44 px de altura e sem deslocamento de layout ao carregar", async ({ page }) => {
    await page.addInitScript(() => {
      ;(window as unknown as { __cls: number }).__cls = 0
      new PerformanceObserver((list) => {
        for (const e of list.getEntries() as unknown as Array<{ value: number; hadRecentInput: boolean }>) if (!e.hadRecentInput) (window as unknown as { __cls: number }).__cls += e.value
      }).observe({ type: "layout-shift", buffered: true })
    })
    await login(page, "perfil@innoelektron.com")
    await page.goto("/app/perfil") // recarrega o módulo do mock (as contas e o token persistem)
    await expect(nome(page)).toBeVisible()
    await page.waitForTimeout(600)

    const small: string[] = []
    for (const [label, locator] of [
      ["link do perfil no cabeçalho", page.getByRole("link", { name: /^Meu perfil/ })],
      ["botão Sair", page.getByRole("button", { name: "Sair" })],
      ["campo Nome", nome(page)],
      ["campo Telefone", telefone(page)],
      ["botão Alterar CPF", page.getByRole("button", { name: "Alterar CPF" })],
      ["botão Salvar alterações", salvar(page)],
      ["campo Senha atual", senhaAtual(page)],
      ["campo Nova senha", novaSenha(page)],
      ["campo Repita a nova senha", repita(page)],
      ["rótulo Mostrar senhas", page.getByText("Mostrar senhas")],
      ["botão Alterar senha", alterarSenha(page)],
      ["voltar (Início)", page.getByRole("link", { name: "Início" }).first()],
    ] as const) {
      const box = await locator.boundingBox()
      if (!box || box.height < 43.5) small.push(`${label}: ${box?.height ?? "sem caixa"}`)
    }
    expect(small).toEqual([])
    expect(await noHorizontalScroll(page)).toBe(0)
    const cls = await page.evaluate(() => (window as unknown as { __cls: number }).__cls)
    expect(cls).toBeLessThanOrEqual(0.02)
  })
})
