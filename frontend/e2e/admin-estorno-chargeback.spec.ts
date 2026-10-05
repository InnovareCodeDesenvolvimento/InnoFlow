import { expect, test, type Page } from "@playwright/test"

/**
 * Admin → estorno de sessão, chargeback e devolução de conta excluída (L1.8 / L1.4), contra os mocks MSW (`src/mocks/reversalsData.ts` + `handlers.ts`).
 * NADA aqui foi provado contra o backend real. Cenários por `localStorage["mock:estorno" | "mock:chargeback" | "mock:devolucoes"]` (ver o cabeçalho de `reversalsData.ts`).
 * O estado do mock vive na PÁGINA: `page.goto` zera tudo — por isso cada teste navega UMA vez por login e usa links/botões depois.
 *
 * Sessão de demo: "Tiago Travado — Encerrada" (`demo_stuck_late_stop`, cartão, R$ 37,82) nasce com 4 devoluções: carteira R$ 5,00 confirmada, cartão R$ 10,00 PENDENTE,
 * cartão R$ 3,00 cancelada, cartão R$ 4,00 confirmada à mão -> estornado R$ 19,00, estornável R$ 18,82.
 */

const PASSWORD = "senha1234"
const nbsp = String.fromCharCode(160)

async function login(page: Page, email = "admin@innoelektron.com") {
  await page.goto("/login")
  await page.getByLabel("E-mail").fill(email)
  await page.getByLabel("Senha").fill(PASSWORD)
  await page.getByRole("button", { name: "Entrar" }).click()
  await expect(page).toHaveURL(/\/admin\/dashboard/)
}

async function scenario(page: Page, key: string, value: string | null) {
  await page.evaluate(([k, v]) => (v === null ? localStorage.removeItem(k as string) : localStorage.setItem(k as string, v as string)), [key, value])
}

async function openLateStopSession(page: Page) {
  await page.getByRole("navigation", { name: "Navegação do painel administrativo" }).getByRole("link", { name: "Sessões" }).click()
  const row = page.getByRole("row").filter({ hasText: "Tiago Travado" }).filter({ hasText: "Encerrada" })
  await expect(row).toHaveCount(1)
  await row.click()
  const dialog = page.getByRole("dialog", { name: /Detalhe da sessão/ })
  await expect(dialog.getByTestId("admin-refunds")).toBeVisible()
  return dialog
}

const refunds = (page: Page) => page.getByTestId("admin-refunds")
// Bloco Cobrado/Estornado/Estornável. SEMPRE por `await expect(amounts(page)).toHaveText(...)` (auto-retry): logo após o toast o refetch da sessão ainda pode não ter chegado,
// e uma leitura única (`expect(await ...textContent())`) pegava o valor de ANTES (flake ~1 em 6). o valor vem com nbsp (U+00A0) entre "R$" e o número e o regex NÃO é normalizado: use `R\$\s`, nunca `R\$ ` (espaço comum).
const amounts = (page: Page) => refunds(page).locator("dl").first()

test.describe("ADMIN — estorno de sessão (Sessões > detalhe > Devoluções)", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("mostra cobrado/estornado/estornável e a lista com os 3 estados; pendente tem as duas ações", async ({ page }) => {
    await login(page)
    await openLateStopSession(page)
    await expect(refunds(page).getByRole("heading").or(refunds(page).getByText("Devoluções", { exact: true })).first()).toBeVisible()
    await expect(amounts(page)).toHaveText(/Cobrado\s*R\$\s37,82\s*Estornado\s*R\$\s19,00\s*Estornável\s*R\$\s18,82/)

    const items = refunds(page).getByTestId("refund-item")
    await expect(items).toHaveCount(4)
    await expect(items.filter({ hasText: "Aguardando confirmação" })).toHaveCount(1)
    await expect(items.filter({ hasText: "Cancelado" })).toHaveCount(1)
    await expect(items.filter({ hasText: "Confirmado" })).toHaveCount(2)
    await expect(items.filter({ hasText: "confirmada à mão" })).toHaveCount(1)
    await expect(items.filter({ hasText: "Comprovante do portal: COMP-2026-0099" })).toHaveCount(1)

    const pending = items.filter({ hasText: "Aguardando confirmação" })
    await expect(pending.getByRole("button", { name: "Confirmar à mão" })).toBeVisible()
    await expect(pending.getByRole("button", { name: "Cancelar registro" })).toBeVisible()
    // Aviso fixo do Parque aparece enquanto houver devolução no cartão.
    await expect(refunds(page).getByTestId("parque-alert-notice")).toContainText("Este estorno vai gerar um alerta falso no sistema do Parque (pedido IF-…). Avise o operador de lá para ignorar.")
  })

  test("carteira: preencher -> revisar (nada enviado) -> senha errada não registra -> senha certa credita e atualiza o teto", async ({ page }) => {
    await login(page)
    await openLateStopSession(page)
    await refunds(page).getByRole("button", { name: "Estornar" }).click()

    const form = page.getByRole("dialog", { name: /Estornar sessão/ })
    await expect(form.getByText(/Ainda dá para estornar/)).toContainText("18,82")
    // Textos do destino
    await expect(form.getByText("Crédito imediato no saldo do motorista. Recomendado — não passa pela Cielo.")).toBeVisible()
    await expect(form.getByText("Faça o estorno no portal da Cielo e registre aqui. Fica pendente até a Cielo mostrar o estorno; estorno PARCIAL não é confirmado automaticamente.")).toBeVisible()
    // Dica do motivo
    await expect(form.getByText(/Não escreva o nome do motorista/)).toBeVisible()

    // Validações do cliente
    await form.getByLabel(/Valor \(R\$\)/).fill("19,00")
    await form.getByLabel(/Motivo/).fill("curto")
    await form.getByRole("button", { name: /Revisar estorno/ }).click()
    await expect(form.getByText(/passa do que ainda dá para estornar/)).toBeVisible()
    await expect(form.getByText(/mínimo de 10 caracteres/)).toBeVisible()
    // PII: o nome do motorista no motivo é barrado.
    await form.getByLabel(/Valor \(R\$\)/).fill("5,00")
    await form.getByLabel(/Motivo/).fill("Cortesia para o Tiago pela demora")
    await form.getByRole("button", { name: /Revisar estorno/ }).click()
    await expect(form.getByText(/cita o nome ou o e-mail do motorista/)).toBeVisible()

    await form.getByLabel(/Motivo/).fill("Cortesia por demora no atendimento")
    await form.getByRole("button", { name: /Revisar estorno/ }).click()
    const confirm = page.getByRole("dialog", { name: "Confirmar estorno" })
    await expect(confirm).toBeVisible()
    await expect(confirm.getByTestId("save-summary")).toContainText("R$ 5,00".replace(" ", nbsp))
    await expect(confirm.getByTestId("save-summary")).toContainText("Carteira do motorista")
    // Nada foi enviado ainda: o teto é o mesmo.
    await expect(confirm.getByTestId("parque-alert-notice")).toHaveCount(0) // carteira não passa pela Cielo

    // Senha errada: erro no campo, diálogo aberto, nada registrado.
    await confirm.getByLabel("Sua senha atual").fill("errada123")
    await confirm.getByRole("button", { name: "Registrar estorno" }).click()
    await expect(confirm.getByText("Senha incorreta.")).toBeVisible()
    await expect(confirm.getByLabel("Sua senha atual")).toHaveValue("")
    await expect(confirm.getByLabel("Sua senha atual")).toBeFocused()

    await confirm.getByLabel("Sua senha atual").fill(PASSWORD)
    await confirm.getByRole("button", { name: "Registrar estorno" }).click()
    await expect(page.getByText(/Estorno de R\$\s5,00 creditado na carteira do motorista/)).toBeVisible()
    await expect(confirm).toHaveCount(0)
    await expect(page.getByRole("dialog", { name: /Estornar sessão/ })).toHaveCount(0)

    await expect(amounts(page)).toHaveText(/Estornado\s*R\$\s24,00\s*Estornável\s*R\$\s13,82/)
    await expect(refunds(page).getByTestId("refund-item")).toHaveCount(5)
    await expect(refunds(page).getByTestId("refund-item").first()).toContainText("Cortesia por demora no atendimento")
  })

  test("cartão no portal: mostra o aviso do Parque, fica PENDENTE e segura o teto", async ({ page }) => {
    await login(page)
    await openLateStopSession(page)
    await refunds(page).getByRole("button", { name: "Estornar" }).click()
    const form = page.getByRole("dialog", { name: /Estornar sessão/ })
    await expect(form.getByTestId("parque-alert-notice")).toHaveCount(0)
    await form.getByText("Cartão (portal da Cielo)").click()
    await expect(form.getByTestId("parque-alert-notice")).toBeVisible()
    await form.getByLabel(/Referência do estorno no portal/).fill("PORTAL-2026-0100")
    await form.getByLabel(/Valor \(R\$\)/).fill("8,00")
    await form.getByLabel(/Motivo/).fill("Estorno parcial por energia não entregue")
    await form.getByRole("button", { name: /Revisar estorno/ }).click()
    const confirm = page.getByRole("dialog", { name: "Confirmar estorno" })
    await expect(confirm.getByTestId("parque-alert-notice")).toBeVisible()
    await expect(confirm.getByTestId("save-summary")).toContainText("PORTAL-2026-0100")
    await confirm.getByLabel("Sua senha atual").fill(PASSWORD)
    await confirm.getByRole("button", { name: "Registrar estorno" }).click()
    await expect(page.getByText("Devolução registrada.")).toBeVisible()
    const items = refunds(page).getByTestId("refund-item")
    await expect(items.filter({ hasText: "Aguardando confirmação" })).toHaveCount(2)
    await expect(amounts(page)).toHaveText(/Estornado\s*R\$\s27,00\s*Estornável\s*R\$\s10,82/)
  })

  test("confirmar à mão: referência inválida é barrada; válida confirma e marca 'confirmada à mão'", async ({ page }) => {
    await login(page)
    await openLateStopSession(page)
    const pending = refunds(page).getByTestId("refund-item").filter({ hasText: "Aguardando confirmação" })
    await pending.getByRole("button", { name: "Confirmar à mão" }).click()
    const form = page.getByRole("dialog", { name: "Confirmar devolução à mão" })
    await form.getByLabel(/Referência do comprovante/).fill("comprovante com espaço")
    await form.getByRole("button", { name: /Revisar/ }).click()
    await expect(form.getByText(/sem espaços nem e-mail/)).toBeVisible()
    await form.getByLabel(/Referência do comprovante/).fill("4111111111111111")
    await form.getByRole("button", { name: /Revisar/ }).click()
    await expect(form.getByText(/parece um CPF ou número de cartão/)).toBeVisible()

    await form.getByLabel(/Referência do comprovante/).fill("COMP-2026-0123")
    await form.getByRole("button", { name: /Revisar/ }).click()
    const confirm = page.getByRole("dialog", { name: "Confirmar devolução à mão" }).last()
    await confirm.getByLabel("Sua senha atual").fill(PASSWORD)
    await confirm.getByRole("button", { name: "Confirmar devolução" }).click()
    await expect(page.getByText("Devolução confirmada à mão.")).toBeVisible()
    const items = refunds(page).getByTestId("refund-item")
    await expect(items.filter({ hasText: "Aguardando confirmação" })).toHaveCount(0)
    await expect(items.filter({ hasText: "Comprovante do portal: COMP-2026-0123" })).toHaveCount(1)
  })

  test("cancelar registro: libera o teto (o cancelado não conta)", async ({ page }) => {
    await login(page)
    await openLateStopSession(page)
    const pending = refunds(page).getByTestId("refund-item").filter({ hasText: "Aguardando confirmação" })
    await pending.getByRole("button", { name: "Cancelar registro" }).click()
    const confirm = page.getByRole("dialog", { name: "Cancelar registro da devolução" })
    await expect(confirm.getByText(/Só cancele se o estorno NÃO foi feito/)).toBeVisible()
    // O "Cancelar" do diálogo virou "Voltar": não há dois "Cancelar" com sentidos opostos.
    await expect(confirm.getByRole("button", { name: "Voltar" })).toBeVisible()
    await confirm.getByLabel("Sua senha atual").fill(PASSWORD)
    await confirm.getByRole("button", { name: "Cancelar registro" }).click()
    await expect(page.getByText(/Registro cancelado/)).toBeVisible()
    await expect(amounts(page)).toHaveText(/Estornado\s*R\$\s9,00\s*Estornável\s*R\$\s28,82/)
    await expect(refunds(page).getByTestId("refund-item").filter({ hasText: "Cancelado" })).toHaveCount(2)
  })

  test("concorrência (409 AMOUNT_EXCEEDS_REFUNDABLE): volta ao formulário com o teto atualizado", async ({ page }) => {
    await login(page)
    await openLateStopSession(page)
    await scenario(page, "mock:estorno", "concurrent")
    await refunds(page).getByRole("button", { name: "Estornar" }).click()
    const form = page.getByRole("dialog", { name: /Estornar sessão/ })
    await form.getByLabel(/Valor \(R\$\)/).fill("10,00")
    await form.getByLabel(/Motivo/).fill("Desconto combinado com o cliente")
    await form.getByRole("button", { name: /Revisar estorno/ }).click()
    const confirm = page.getByRole("dialog", { name: "Confirmar estorno" })
    await confirm.getByLabel("Sua senha atual").fill(PASSWORD)
    await confirm.getByRole("button", { name: "Registrar estorno" }).click()
    await expect(confirm).toHaveCount(0)
    await expect(form.getByRole("alert").first()).toContainText("passa do que ainda dá para estornar")
    await expect(form.getByText(/Ainda dá para estornar/)).toContainText("1,00")
  })

  test("erros por code: conta do motorista excluída, rede de senha (503/429) e erro interno ficam na confirmação, sem registrar", async ({ page }) => {
    await login(page)
    await openLateStopSession(page)
    await refunds(page).getByRole("button", { name: "Estornar" }).click()
    const form = page.getByRole("dialog", { name: /Estornar sessão/ })
    await form.getByLabel(/Valor \(R\$\)/).fill("2,00")
    await form.getByLabel(/Motivo/).fill("Ajuste de tarifa conferido")
    await form.getByRole("button", { name: /Revisar estorno/ }).click()
    const confirm = page.getByRole("dialog", { name: "Confirmar estorno" })

    await confirm.getByLabel("Sua senha atual").fill("stepup-503")
    await confirm.getByRole("button", { name: "Registrar estorno" }).click()
    await expect(confirm.getByRole("alert")).toContainText("Não foi possível confirmar sua senha agora")

    await confirm.getByLabel("Sua senha atual").fill("stepup-429")
    await confirm.getByRole("button", { name: "Registrar estorno" }).click()
    await expect(confirm.getByRole("alert")).toContainText("Muitas tentativas de senha")

    await scenario(page, "mock:estorno", "5xx")
    await confirm.getByLabel("Sua senha atual").fill(PASSWORD)
    await confirm.getByRole("button", { name: "Registrar estorno" }).click()
    await expect(confirm.getByRole("alert")).toContainText("Não foi possível concluir e nada foi registrado")

    await scenario(page, "mock:estorno", "driver-deleted")
    await confirm.getByLabel("Sua senha atual").fill(PASSWORD)
    await confirm.getByRole("button", { name: "Registrar estorno" }).click()
    // Erro de regra: volta ao formulário com o aviso.
    await expect(confirm).toHaveCount(0)
    await expect(form.getByRole("alert").first()).toContainText("A conta deste motorista foi excluída")
    await form.getByRole("button", { name: "Cancelar" }).click()
    await expect(amounts(page)).toHaveText(/Estornado\s*R\$\s19,00/) // nada foi registrado em nenhum dos erros
  })

  test("OPERATOR não vê o bloco de devoluções (ADMIN-only)", async ({ page }) => {
    await login(page, "operador@innoelektron.com")
    await page.getByRole("navigation", { name: "Navegação do painel administrativo" }).getByRole("link", { name: "Sessões" }).click()
    const row = page.getByRole("row").filter({ hasText: "Encerrada" }).first()
    await row.click()
    await expect(page.getByRole("dialog", { name: /Detalhe da sessão/ })).toBeVisible()
    await expect(page.getByTestId("admin-refunds")).toHaveCount(0)
  })
})

test.describe("ADMIN — Pagamentos: busca pela Cielo e registro de chargeback", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("filtros Tid / código de autorização / NSU (exatos) e botão 'Registrar chargeback' só em venda de cartão capturada", async ({ page }) => {
    await login(page)
    await page.getByRole("navigation", { name: "Navegação do painel administrativo" }).getByRole("link", { name: "Pagamentos" }).click()
    await expect(page.getByRole("heading", { name: "Pagamentos", level: 1 })).toBeVisible()
    await page.getByRole("button", { name: "Buscar venda da Cielo" }).click()
    const filters = page.locator("#acquirer-filters")
    await filters.getByLabel("Tid").fill("10069930690000999001")
    await filters.getByRole("button", { name: "Buscar" }).click()
    await expect(page.getByRole("row")).toHaveCount(2) // cabeçalho + 1 venda
    await expect(page.getByRole("row").nth(1)).toContainText("Cielo (cartão)")
    // Busca exata: um pedaço do Tid não acha nada.
    await filters.getByLabel("Tid").fill("1006993069")
    await filters.getByRole("button", { name: "Buscar" }).click()
    await expect(page.getByText("Nenhum pagamento encontrado")).toBeVisible()
    // NSU + código juntos.
    await filters.getByLabel("Tid").fill("")
    await filters.getByLabel("Código de autorização").fill("654321")
    await filters.getByLabel("NSU").fill("112233")
    await filters.getByRole("button", { name: "Buscar" }).click()
    await expect(page.getByRole("row")).toHaveCount(2)
    await filters.getByRole("button", { name: "Limpar" }).click()
    await expect(page.getByRole("row").nth(2)).toBeVisible()

    const buttons = page.getByRole("button", { name: /Registrar chargeback/ })
    const total = await buttons.count()
    expect(total).toBeGreaterThan(0)
    // Linha de Pix/carteira nunca tem o botão.
    const walletRows = page.getByRole("row").filter({ hasText: "Carteira" })
    if ((await walletRows.count()) > 0) await expect(walletRows.first().getByRole("button", { name: /Registrar chargeback/ })).toHaveCount(0)
  })

  test("venda que já tem chargeback: 409 por code com atalho para a lista", async ({ page }) => {
    await login(page)
    await page.getByRole("navigation", { name: "Navegação do painel administrativo" }).getByRole("link", { name: "Pagamentos" }).click()
    await page.getByRole("button", { name: "Buscar venda da Cielo" }).click()
    await page.locator("#acquirer-filters").getByLabel("Tid").fill("10069930690000999001")
    await page.locator("#acquirer-filters").getByRole("button", { name: "Buscar" }).click()
    // Espera a lista FILTRADA (cabeçalho + 1 venda) ANTES de clicar: sem isso o clique pegava a lista de antes do refetch (11 botões -> strict mode violation, flake ~1 em 10).
    await expect(page.getByRole("row")).toHaveCount(2)
    await page.getByRole("button", { name: /Registrar chargeback/ }).click()
    const dialog = page.getByRole("dialog", { name: "Registrar chargeback" })
    await dialog.getByLabel(/Referência do caso na Cielo/).fill("CASO-NOVO-1")
    await dialog.getByRole("button", { name: "Registrar chargeback" }).click()
    await expect(dialog.getByRole("alert")).toContainText("Já existe um chargeback registrado para esta venda.")
    await expect(dialog.getByRole("link", { name: "Ver chargebacks" })).toBeVisible()
  })

  test("registrar: valida o formulário, bloqueia o cartão (aviso) e oferece o dossiê para baixar", async ({ page }) => {
    await login(page)
    await page.getByRole("navigation", { name: "Navegação do painel administrativo" }).getByRole("link", { name: "Pagamentos" }).click()
    // A 1ª venda de cartão capturada da lista QUE NÃO É a do Tiago Travado: a demo `demo_pi_stuck_1` já tem chargeback e nasce em "agora - 200 min"; sem outra venda de cartão mais
    // recente do que isso (as demais são sorteadas por horário do dia) ela vira a 1ª da lista e o 2º passo falhava com o 409 "já existe" (determinístico de madrugada / UTC).
    await page.getByRole("button", { name: /^Registrar chargeback — (?!Tiago Travado)/ }).first().click()
    const dialog = page.getByRole("dialog", { name: "Registrar chargeback" })
    await expect(dialog.getByText(/o modo cartão deste motorista é bloqueado na hora/)).toBeVisible()
    // Sem pedir senha (contrato): NÃO há campo de senha neste diálogo.
    await expect(dialog.getByLabel("Sua senha atual")).toHaveCount(0)

    await dialog.getByLabel(/Valor contestado/).fill("999999,00")
    await dialog.getByRole("button", { name: "Registrar chargeback" }).click()
    await expect(dialog.getByText(/passa do que foi capturado/)).toBeVisible()
    await expect(dialog.getByText(/Informe a referência do caso/)).toBeVisible()

    const captured = (await dialog.getByText(/capturado/).first().textContent()) ?? ""
    expect(captured).toMatch(/R\$/)
    await dialog.getByLabel(/Valor contestado/).fill("1,00")
    await dialog.getByLabel(/Referência do caso na Cielo/).fill("CASO-E2E-001")
    await dialog.getByLabel(/Código do motivo/).fill("4837")
    const deadline = new Date(Date.now() + 5 * 86_400_000)
    await dialog.getByLabel("Prazo de resposta").fill(`${deadline.getFullYear()}-${String(deadline.getMonth() + 1).padStart(2, "0")}-${String(deadline.getDate()).padStart(2, "0")}`)
    await dialog.getByRole("button", { name: "Registrar chargeback" }).click()

    await expect(page.getByRole("dialog", { name: "Chargeback registrado" })).toBeVisible()
    await expect(page.getByTestId("chargeback-card-blocked")).toHaveText("O modo cartão deste motorista foi bloqueado. Pix e carteira continuam.")
    const downloadPromise = page.waitForEvent("download")
    await page.getByRole("button", { name: /Baixar dossiê/ }).click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toMatch(/^dossie-chargeback-.*\.json$/)
    await page.getByRole("dialog", { name: "Chargeback registrado" }).getByRole("link", { name: "Ver chargebacks" }).click()
    await expect(page).toHaveURL(/\/admin\/chargebacks$/)
  })
})

test.describe("ADMIN — Chargebacks", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  async function openChargebacks(page: Page) {
    await login(page)
    await page.getByRole("navigation", { name: "Navegação do painel administrativo" }).getByRole("link", { name: "Chargebacks" }).click()
    await expect(page).toHaveURL(/\/admin\/chargebacks$/)
    await expect(page.getByRole("heading", { name: "Chargebacks", level: 1 })).toBeVisible()
  }
  const caseButton = (page: Page, caso: string) => page.getByRole("button", { name: `Ver chargeback do caso ${caso}` })

  test("lista os 7 casos, destaca prazo vencido e próximo (com texto, não só cor) e avisa quantos precisam de atenção", async ({ page }) => {
    await openChargebacks(page)
    await expect(page.getByRole("row")).toHaveCount(8)
    await expect(page.getByTestId("chargebacks-urgent")).toContainText("2 chargebacks em aberto estão com o prazo de resposta vencido ou nos próximos 3 dias")
    const overdue = page.getByRole("row").filter({ hasText: "CASO-2026-0166" })
    await expect(overdue).toContainText("Vencido há 3 dias")
    const near = page.getByRole("row").filter({ hasText: "CASO-2026-0187" })
    await expect(near).toContainText(/Vence em [12] dias?/)
    await expect(page.getByRole("row").filter({ hasText: "CASO-2026-0201" })).toContainText("Sem prazo cadastrado")
    // Resolvidos não mostram prazo vivo.
    await expect(page.getByRole("row").filter({ hasText: "CASO-2026-0102" })).not.toContainText("Vence")
    await expect(page.getByRole("row").filter({ hasText: "CASO-2026-0098" })).toContainText("Bloqueado")
    await expect(page.getByRole("row").filter({ hasText: "CASO-2026-0102" })).toContainText("Liberado")

    // Filtro por estado
    await page.getByLabel("Estado").selectOption("OPEN")
    await expect(page.getByRole("row")).toHaveCount(4)
    await page.getByLabel("Estado").selectOption("WON")
    await expect(page.getByRole("row")).toHaveCount(2)
  })

  test("desfecho GANHO: revisar -> senha errada -> senha certa; libera o cartão e some o botão", async ({ page }) => {
    await openChargebacks(page)
    await caseButton(page, "CASO-2026-0201").click()
    const detail = page.getByRole("dialog", { name: /Chargeback · caso CASO-2026-0201/ })
    await expect(detail.getByText("Cartão bloqueado")).toBeVisible()
    await detail.getByRole("button", { name: "Registrar desfecho" }).click()

    const form = page.getByRole("dialog", { name: "Registrar desfecho" })
    // Textos dos desfechos
    await expect(form.getByText("Ganhamos a disputa. O modo cartão do motorista volta sozinho. Não gera dívida.")).toBeVisible()
    await expect(form.getByText(/A plataforma absorve o prejuízo e o motorista continua sem o modo cartão/)).toBeVisible()
    // "Criar dívida" só em perdido/aceito
    await expect(form.getByLabel("Criar dívida para o motorista")).toHaveCount(0)
    await form.getByRole("button", { name: /Revisar desfecho/ }).click()

    const confirm = page.getByRole("dialog", { name: "Confirmar desfecho" })
    await expect(confirm.getByTestId("save-summary")).toContainText("Ganho")
    await confirm.getByLabel("Sua senha atual").fill("errada123")
    await confirm.getByRole("button", { name: "Registrar desfecho" }).click()
    await expect(confirm.getByText("Senha incorreta.")).toBeVisible()
    await confirm.getByLabel("Sua senha atual").fill(PASSWORD)
    await confirm.getByRole("button", { name: "Registrar desfecho" }).click()
    await expect(page.getByText("Desfecho registrado: Ganho.")).toBeVisible()

    // O detalhe (que continua aberto por baixo) já mostra o novo estado.
    await expect(detail.getByText("Cartão liberado")).toBeVisible()
    await expect(detail.getByRole("button", { name: "Registrar desfecho" })).toHaveCount(0)
  })

  test("desfecho PERDIDO com dívida: checkbox aparece só aqui, resumo diz o que acontece; depois dá para desbloquear o cartão", async ({ page }) => {
    await openChargebacks(page)
    await caseButton(page, "CASO-2026-0166").click()
    await page.getByRole("dialog", { name: /CASO-2026-0166/ }).getByRole("button", { name: "Registrar desfecho" }).click()
    const form = page.getByRole("dialog", { name: "Registrar desfecho" })
    await form.getByText("Perdido", { exact: true }).click()
    const debt = form.getByLabel("Criar dívida para o motorista")
    await expect(debt).toBeVisible()
    await expect(debt).not.toBeChecked()
    await debt.check()
    await form.getByRole("button", { name: /Revisar desfecho/ }).click()
    const confirm = page.getByRole("dialog", { name: "Confirmar desfecho" })
    await expect(confirm.getByTestId("save-summary")).toContainText("Criar dívida de")
    await expect(confirm.getByTestId("save-summary")).toContainText("Continua bloqueado")
    await confirm.getByLabel("Sua senha atual").fill(PASSWORD)
    await confirm.getByRole("button", { name: "Registrar desfecho" }).click()
    await expect(page.getByText("Desfecho registrado: Perdido.")).toBeVisible()

    const detail = page.getByRole("dialog", { name: /CASO-2026-0166/ })
    await expect(detail.getByText(/Dívida criada para o motorista/)).toBeVisible()
    await expect(detail.getByText("Cartão bloqueado")).toBeVisible()

    // Desbloquear: motivo + senha
    await detail.getByRole("button", { name: "Desbloquear cartão" }).click()
    const unblock = page.getByRole("dialog", { name: "Desbloquear cartão" })
    await unblock.getByLabel(/Por que liberar o cartão/).fill("curto")
    await unblock.getByRole("button", { name: "Revisar" }).click()
    await expect(unblock.getByText(/mínimo de 10 caracteres/)).toBeVisible()
    await unblock.getByLabel(/Por que liberar o cartão/).fill("Motorista comprovou a titularidade do cartão")
    await unblock.getByRole("button", { name: "Revisar" }).click()
    const confirmUnblock = page.getByRole("dialog", { name: "Confirmar desbloqueio do cartão" })
    await confirmUnblock.getByLabel("Sua senha atual").fill(PASSWORD)
    await confirmUnblock.getByRole("button", { name: "Desbloquear cartão" }).click()
    await expect(page.getByText("Cartão desbloqueado.")).toBeVisible()
    await expect(detail.getByText("Cartão liberado")).toBeVisible()
    await expect(detail.getByText(/Cartão desbloqueado em/)).toContainText("Motorista comprovou a titularidade do cartão")
    await expect(detail.getByRole("button", { name: "Desbloquear cartão" })).toHaveCount(0)
  })

  test("desfecho já dado por outro (409 CHARGEBACK_ALREADY_RESOLVED) e erros de senha ficam na confirmação", async ({ page }) => {
    await openChargebacks(page)
    await caseButton(page, "CASO-2026-0201").click()
    await page.getByRole("dialog", { name: /CASO-2026-0201/ }).getByRole("button", { name: "Registrar desfecho" }).click()
    const form = page.getByRole("dialog", { name: "Registrar desfecho" })
    await form.getByRole("button", { name: /Revisar desfecho/ }).click()
    const confirm = page.getByRole("dialog", { name: "Confirmar desfecho" })
    await confirm.getByLabel("Sua senha atual").fill("stepup-503")
    await confirm.getByRole("button", { name: "Registrar desfecho" }).click()
    await expect(confirm.getByRole("alert")).toContainText("Não foi possível confirmar sua senha agora")
    await scenario(page, "mock:chargeback", "rate-limited")
    await confirm.getByLabel("Sua senha atual").fill(PASSWORD)
    await confirm.getByRole("button", { name: "Registrar desfecho" }).click()
    await expect(confirm.getByRole("alert")).toContainText("Muitas tentativas em pouco tempo")
  })

  test("baixar dossiê: cada clique é um download (e o botão aparece no detalhe)", async ({ page }) => {
    await openChargebacks(page)
    await caseButton(page, "CASO-2026-0187").click()
    const detail = page.getByRole("dialog", { name: /CASO-2026-0187/ })
    const downloadPromise = page.waitForEvent("download")
    await detail.getByRole("button", { name: /Baixar dossiê/ }).click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toBe("dossie-chargeback-cb_1.json")
    await expect(page.getByText("Dossiê baixado.")).toBeVisible()
    // Dossiê indisponível: erro por code, sem arquivo.
    await scenario(page, "mock:chargeback", "dossier-404")
    await detail.getByRole("button", { name: /Baixar dossiê/ }).click()
    await expect(page.getByText("Não foi possível baixar o dossiê.")).toBeVisible()
  })

  test("OPERATOR não vê o item no menu e a rota é restrita", async ({ page }) => {
    await login(page, "operador@innoelektron.com")
    await expect(page.getByRole("navigation", { name: "Navegação do painel administrativo" }).getByRole("link", { name: "Chargebacks" })).toHaveCount(0)
    await expect(page.getByRole("navigation", { name: "Navegação do painel administrativo" }).getByRole("link", { name: "Devoluções de saldo" })).toHaveCount(0)
    await page.getByRole("navigation", { name: "Navegação do painel administrativo" }).getByRole("link", { name: "Pagamentos" }).click()
    await expect(page.getByRole("link", { name: "Chargebacks" })).toHaveCount(0)
    await expect(page.getByRole("button", { name: /Registrar chargeback/ })).toHaveCount(0)
  })
})

test.describe("ADMIN — Devoluções de contas excluídas", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  async function openDeletions(page: Page) {
    await login(page)
    await page.getByRole("navigation", { name: "Navegação do painel administrativo" }).getByRole("link", { name: "Devoluções de saldo" }).click()
    await expect(page).toHaveURL(/\/admin\/devolucoes-contas-excluidas$/)
    await expect(page.getByRole("heading", { name: "Devoluções de contas excluídas", level: 1 })).toBeVisible()
  }
  const rows = (page: Page) => page.getByTestId("deletion-row")

  test("fila dos pendentes do mais antigo: atrasada em destaque, chave Pix com copiar, chave ilegível explicada", async ({ page }) => {
    await openDeletions(page)
    await expect(rows(page)).toHaveCount(3)
    // Mais antigo primeiro (45 dias), depois 31 e 12.
    await expect(rows(page).nth(0)).toContainText("há 45 dias")
    await expect(rows(page).nth(1)).toContainText("há 31 dias")
    await expect(rows(page).nth(2)).toContainText("há 12 dias")
    await expect(rows(page).nth(0)).toHaveAttribute("data-overdue", "true")
    await expect(rows(page).nth(0)).toContainText("Atrasada")
    await expect(rows(page).nth(2)).toHaveAttribute("data-overdue", "false")
    await expect(page.getByTestId("deletions-overdue")).toContainText("2 devoluções estão atrasadas")
    await expect(rows(page).nth(0)).toContainText("2f6a1c3e-9b7d-4e51-a8c2-5d0e1f3b7a90")
    await expect(rows(page).nth(0).getByRole("button", { name: /Copiar chave Pix/ })).toBeVisible()
    await expect(rows(page).nth(1)).toContainText("Chave ilegível")
    await expect(rows(page).nth(1).getByRole("button", { name: /Copiar chave Pix/ })).toHaveCount(0)
    await expect(page.getByText(/cada abertura desta lista fica registrada na auditoria/)).toBeVisible()
    // Filtro: devolvidas (sem chave)
    await page.getByLabel("Situação").selectOption("REFUNDED")
    await expect(rows(page)).toHaveCount(1)
    await expect(rows(page).first()).toContainText("Apagada após a devolução.")
    await expect(rows(page).first().getByRole("button", { name: /Devolver/ })).toHaveCount(0)
  })

  test("Devolver: comprovante + valor integral + senha; a linha sai da fila e o total desce", async ({ page }) => {
    await openDeletions(page)
    await rows(page).nth(2).getByRole("button", { name: /Devolver/ }).click()
    const form = page.getByRole("dialog", { name: "Devolver saldo" })
    await expect(form.getByText("titular.exemplo@email.com")).toBeVisible()
    await expect(form.getByText(/não aceita devolução parcial/)).toBeVisible()
    await form.getByRole("button", { name: /Revisar devolução/ }).click()
    await expect(form.getByText(/Informe o comprovante/)).toBeVisible()
    await form.getByLabel(/Comprovante do Pix/).fill("E1234567820261005ABC")
    await form.getByRole("button", { name: /Revisar devolução/ }).click()

    const confirm = page.getByRole("dialog", { name: "Confirmar devolução do saldo" })
    await expect(confirm.getByTestId("save-summary")).toContainText("Valor (saldo integral)")
    await expect(confirm.getByTestId("save-summary")).toContainText("R$ 23,50".replace(" ", nbsp))
    await confirm.getByLabel("Sua senha atual").fill("errada123")
    await confirm.getByRole("button", { name: "Registrar devolução" }).click()
    await expect(confirm.getByText("Senha incorreta.")).toBeVisible()
    await confirm.getByLabel("Sua senha atual").fill(PASSWORD)
    await confirm.getByRole("button", { name: "Registrar devolução" }).click()
    await expect(page.getByText(/Devolução de R\$\s23,50 registrada/)).toBeVisible()
    await expect(rows(page)).toHaveCount(2)
    await expect(page.getByText("titular.exemplo@email.com")).toHaveCount(0)
  })

  test("erros por code na confirmação (429, 503 da chave, 409 já devolvida) e fila vazia / 500", async ({ page }) => {
    await openDeletions(page)
    await rows(page).nth(2).getByRole("button", { name: /Devolver/ }).click()
    const form = page.getByRole("dialog", { name: "Devolver saldo" })
    await form.getByLabel(/Comprovante do Pix/).fill("COMP-1")
    await form.getByRole("button", { name: /Revisar devolução/ }).click()
    const confirm = page.getByRole("dialog", { name: "Confirmar devolução do saldo" })

    await confirm.getByLabel("Sua senha atual").fill("stepup-429")
    await confirm.getByRole("button", { name: "Registrar devolução" }).click()
    await expect(confirm.getByRole("alert")).toContainText("Muitas tentativas de senha")
    await scenario(page, "mock:devolucoes", "key-missing")
    await confirm.getByLabel("Sua senha atual").fill(PASSWORD)
    await confirm.getByRole("button", { name: "Registrar devolução" }).click()
    await expect(confirm.getByRole("alert")).toContainText("chave de segredos do servidor está inválida ou indisponível")
    await scenario(page, "mock:devolucoes", "already-refunded")
    await confirm.getByLabel("Sua senha atual").fill(PASSWORD)
    await confirm.getByRole("button", { name: "Registrar devolução" }).click()
    await expect(confirm.getByRole("alert")).toContainText("Este pedido já foi devolvido")
    // Nada foi registrado: a linha continua na fila.
    await confirm.getByRole("button", { name: "Cancelar" }).click()
    await page.getByRole("dialog", { name: "Devolver saldo" }).getByRole("button", { name: "Cancelar" }).click()

    await scenario(page, "mock:devolucoes", "empty")
    await page.getByRole("button", { name: "Atualizar" }).click()
    await expect(page.getByText("Nenhuma devolução pendente")).toBeVisible()
    await scenario(page, "mock:devolucoes", "5xx")
    await page.getByRole("button", { name: "Atualizar" }).click()
    await expect(page.getByRole("button", { name: /Tentar novamente/ })).toBeVisible()
  })
})

test.describe("ADMIN — Auditoria: rótulos dos 6 valores novos", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("o filtro de ação lista Estorno, Chargeback, Exclusão de conta, Senha redefinida e os de pagamento", async ({ page }) => {
    await login(page)
    await page.getByRole("navigation", { name: "Navegação do painel administrativo" }).getByRole("link", { name: "Auditoria" }).click()
    await expect(page.getByRole("heading", { name: "Auditoria", level: 1 })).toBeVisible()
    const select = page.getByLabel("Tipo de ação")
    await expect(select).toBeVisible()
    const options = await select.locator("option").allTextContents()
    for (const label of ["Estorno", "Chargeback", "Exclusão de conta", "Senha redefinida", "Crédito de Pix", "Config. gateway"]) {
      expect(options, `opção "${label}" no filtro de ação`).toContain(label)
    }
  })
})
