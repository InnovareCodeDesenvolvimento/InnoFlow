import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { AxiosError, AxiosHeaders } from "axios"
import { RefundFormDialog } from "./RefundFormDialog"
import { ConfirmRefundDialog } from "./RefundPendingDialogs"
import type { SessionDetail, SessionRefundDTO } from "@/types/api"

/**
 * Estorno de sessão (diálogos). Função comum (não `vi.fn`) nos mocks que rejeitam: o vitest rastreia a promise de um mock e uma rejeição tratada vira "unhandled rejection".
 * O que se prova aqui: nada é enviado antes da confirmação com SENHA; o motivo não pode citar o motorista; erro de regra volta ao formulário, erro de senha fica na confirmação;
 * o corpo enviado é exatamente o do contrato (sem campos a mais).
 */

const calls: unknown[] = []
let outcome: { ok: true; value: unknown } | { ok: false; status: number; body: unknown } = { ok: true, value: { refundId: "r1", status: "CONFIRMED" } }
function respond(payload: unknown) {
  calls.push(payload)
  if (outcome.ok) return Promise.resolve(outcome.value)
  return Promise.reject(new AxiosError("falhou", String(outcome.status), undefined, undefined, { status: outcome.status, statusText: "", headers: {}, config: { headers: new AxiosHeaders() }, data: outcome.body }))
}

vi.mock("@/hooks/useReversals", () => ({
  useCreateRefund: () => ({ mutateAsync: respond, reset: vi.fn(), isPending: false }),
  useConfirmRefund: () => ({ mutateAsync: respond, reset: vi.fn(), isPending: false }),
  useCancelRefund: () => ({ mutateAsync: respond, reset: vi.fn(), isPending: false }),
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const session = { id: "s1", ocppTransactionId: 990002, driver: { name: "Tiago Travado", email: "travado@innoelektron.com" } } as unknown as SessionDetail
const onClose = vi.fn()
const flat = (s: string | null) => (s ?? "").split(String.fromCharCode(160)).join(" ")

async function fillForm(amount: string, reason: string) {
  const value = screen.getByLabelText(/Valor \(R\$\)/)
  await userEvent.clear(value)
  await userEvent.type(value, amount)
  await userEvent.clear(screen.getByLabelText(/Motivo/))
  await userEvent.type(screen.getByLabelText(/Motivo/), reason)
}

describe("RefundFormDialog", () => {
  beforeEach(() => {
    calls.length = 0
    onClose.mockClear()
    outcome = { ok: true, value: { refundId: "r1", status: "CONFIRMED" } }
  })

  const renderForm = (cardAvailable = true) => render(<RefundFormDialog session={session} refundableCents={1882} cardAvailable={cardAvailable} onClose={onClose} />)

  it("abre com o teto preenchido e carteira como destino; cartão desabilitado com o motivo quando a sessão não foi paga com cartão", () => {
    renderForm(false)
    expect(screen.getByLabelText(/Valor \(R\$\)/)).toHaveValue("18,82")
    expect(screen.getByRole("radio", { name: /Carteira do motorista/ })).toBeChecked()
    expect(screen.getByRole("radio", { name: /Cartão \(portal da Cielo\)/ })).toBeDisabled()
    expect(screen.getByText(/Esta sessão não foi paga com cartão/)).toBeInTheDocument()
  })

  it("não envia nada antes da confirmação com senha; mostra o resumo e só então chama a API com o corpo exato do contrato", async () => {
    renderForm()
    await fillForm("5,00", "Cortesia por demora no atendimento")
    await userEvent.click(screen.getByRole("button", { name: /Revisar estorno/ }))

    const confirm = await screen.findByRole("dialog", { name: "Confirmar estorno" })
    expect(calls).toHaveLength(0)
    expect(flat(within(confirm).getByTestId("save-summary").textContent)).toContain("R$ 5,00")
    expect(within(confirm).queryByTestId("parque-alert-notice")).toBeNull() // carteira não passa pela Cielo

    await userEvent.type(within(confirm).getByLabelText(/Sua senha atual/), "senha1234")
    await userEvent.click(within(confirm).getByRole("button", { name: "Registrar estorno" }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(calls).toEqual([{ amountCents: 500, reason: "Cortesia por demora no atendimento", destination: "WALLET", currentPassword: "senha1234" }])
  })

  it("cartão: o aviso do Parque aparece no formulário e na confirmação; a referência do portal vai no corpo", async () => {
    renderForm()
    await userEvent.click(screen.getByRole("radio", { name: /Cartão \(portal da Cielo\)/ }))
    expect(screen.getByTestId("parque-alert-notice")).toHaveTextContent("Este estorno vai gerar um alerta falso no sistema do Parque (pedido IF-…). Avise o operador de lá para ignorar.")
    await userEvent.type(screen.getByLabelText(/Referência do estorno no portal/), "PORTAL-0042")
    await fillForm("8,00", "Estorno parcial por energia não entregue")
    await userEvent.click(screen.getByRole("button", { name: /Revisar estorno/ }))
    const confirm = await screen.findByRole("dialog", { name: "Confirmar estorno" })
    expect(within(confirm).getByTestId("parque-alert-notice")).toBeInTheDocument()
    await userEvent.type(within(confirm).getByLabelText(/Sua senha atual/), "senha1234")
    await userEvent.click(within(confirm).getByRole("button", { name: "Registrar estorno" }))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toEqual({ amountCents: 800, reason: "Estorno parcial por energia não entregue", destination: "CARD_VIA_PORTAL", portalReference: "PORTAL-0042", currentPassword: "senha1234" })
  })

  it("motivo que cita o motorista é barrado ANTES da confirmação (o texto fica gravado)", async () => {
    renderForm()
    await fillForm("5,00", "Cortesia para o Tiago pela demora")
    await userEvent.click(screen.getByRole("button", { name: /Revisar estorno/ }))
    expect(await screen.findByText(/cita o nome ou o e-mail do motorista/)).toBeInTheDocument()
    expect(screen.queryByRole("dialog", { name: "Confirmar estorno" })).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it("quebra de linha colada no motivo vira espaço (o servidor recusaria)", async () => {
    renderForm()
    const reason = screen.getByLabelText(/Motivo/)
    await userEvent.click(reason)
    await userEvent.paste("linha um\nlinha dois")
    expect(reason).toHaveValue("linha um linha dois")
  })

  it("senha errada (403) fica no campo da confirmação, com o diálogo aberto e o campo zerado", async () => {
    outcome = { ok: false, status: 403, body: { code: "INVALID_CURRENT_PASSWORD", error: "Senha atual incorreta." } }
    renderForm()
    await fillForm("5,00", "Cortesia por demora no atendimento")
    await userEvent.click(screen.getByRole("button", { name: /Revisar estorno/ }))
    const confirm = await screen.findByRole("dialog", { name: "Confirmar estorno" })
    await userEvent.type(within(confirm).getByLabelText(/Sua senha atual/), "errada")
    await userEvent.click(within(confirm).getByRole("button", { name: "Registrar estorno" }))
    expect(await within(confirm).findByText("Senha incorreta.")).toBeInTheDocument()
    expect(within(confirm).getByLabelText(/Sua senha atual/)).toHaveValue("")
    expect(onClose).not.toHaveBeenCalled()
  })

  it("erro de regra (409 teto) volta ao formulário com o aviso; erro de rede de senha (503) fica na confirmação", async () => {
    outcome = { ok: false, status: 409, body: { code: "AMOUNT_EXCEEDS_REFUNDABLE", details: { refundableCents: 100 } } }
    renderForm()
    await fillForm("5,00", "Cortesia por demora no atendimento")
    await userEvent.click(screen.getByRole("button", { name: /Revisar estorno/ }))
    let confirm = await screen.findByRole("dialog", { name: "Confirmar estorno" })
    await userEvent.type(within(confirm).getByLabelText(/Sua senha atual/), "senha1234")
    await userEvent.click(within(confirm).getByRole("button", { name: "Registrar estorno" }))
    const form = await screen.findByRole("dialog", { name: /Estornar sessão/ })
    expect(within(form).getAllByRole("alert")[0]).toHaveTextContent("passa do que ainda dá para estornar")

    outcome = { ok: false, status: 503, body: { code: "STEPUP_UNAVAILABLE" } }
    await userEvent.click(within(form).getByRole("button", { name: /Revisar estorno/ }))
    // O teto da tela (prop) segue 18,82 neste teste isolado, então o valor 5,00 é válido de novo.
    confirm = await screen.findByRole("dialog", { name: "Confirmar estorno" })
    await userEvent.type(within(confirm).getByLabelText(/Sua senha atual/), "senha1234")
    await userEvent.click(within(confirm).getByRole("button", { name: "Registrar estorno" }))
    expect(await within(confirm).findByRole("alert")).toHaveTextContent("Não foi possível confirmar sua senha agora")
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe("ConfirmRefundDialog (confirmar à mão)", () => {
  const refund: SessionRefundDTO = {
    id: "r1",
    sessionId: "s1",
    paymentIntentId: "pi1",
    destination: "CARD_VIA_PORTAL",
    status: "PENDING_CONFIRMATION",
    amountCents: 1000,
    reason: "Desconto acordado",
    portalReference: "PORTAL-0042",
    confirmedManually: false,
    walletEntryId: null,
    createdAt: "2026-10-03T12:00:00.000Z",
    resolvedAt: null,
  }
  beforeEach(() => {
    calls.length = 0
    onClose.mockClear()
    outcome = { ok: true, value: { refundId: "r1", status: "CONFIRMED", confirmedManually: true, proofReference: "COMP-123" } }
  })

  it("a referência do comprovante é validada como CÓDIGO e só vai ao servidor depois da senha", async () => {
    render(<ConfirmRefundDialog sessionId="s1" refund={refund} onClose={onClose} />)
    const input = screen.getByLabelText(/Referência do comprovante/)
    await userEvent.type(input, "com espaço")
    await userEvent.click(screen.getByRole("button", { name: /Revisar/ }))
    expect(await screen.findByText(/sem espaços nem e-mail/)).toBeInTheDocument()
    expect(calls).toHaveLength(0)

    await userEvent.clear(input)
    await userEvent.type(input, "COMP-123")
    await userEvent.click(screen.getByRole("button", { name: /Revisar/ }))
    const confirm = await screen.findByRole("dialog", { name: "Confirmar devolução à mão" })
    expect(calls).toHaveLength(0)
    await userEvent.type(within(confirm).getByLabelText(/Sua senha atual/), "senha1234")
    await userEvent.click(within(confirm).getByRole("button", { name: "Confirmar devolução" }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(calls).toEqual([{ refundId: "r1", proofReference: "COMP-123", currentPassword: "senha1234" }])
  })

  it("409 REFUND_NOT_CONFIRMABLE (o job chegou antes) aparece como aviso, sem fechar", async () => {
    outcome = { ok: false, status: 409, body: { code: "REFUND_NOT_CONFIRMABLE" } }
    render(<ConfirmRefundDialog sessionId="s1" refund={refund} onClose={onClose} />)
    await userEvent.type(screen.getByLabelText(/Referência do comprovante/), "COMP-123")
    await userEvent.click(screen.getByRole("button", { name: /Revisar/ }))
    const confirm = await screen.findByRole("dialog", { name: "Confirmar devolução à mão" })
    await userEvent.type(within(confirm).getByLabelText(/Sua senha atual/), "senha1234")
    await userEvent.click(within(confirm).getByRole("button", { name: "Confirmar devolução" }))
    expect(await within(confirm).findByRole("alert")).toHaveTextContent("não pode mais ser confirmada")
    expect(onClose).not.toHaveBeenCalled()
  })
})
