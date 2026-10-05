import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { ResolveChargebackDialog } from "./ResolveChargebackDialog"
import { UnblockCardDialog } from "./UnblockCardDialog"
import { DeadlineBadge } from "./DeadlineBadge"
import { RegisterChargebackDialog } from "@/pages/Admin/Pagamentos/RegisterChargebackDialog"
import type { ChargebackDTO, PaymentListRow } from "@/types/api"

/** Função comum (não `vi.fn`) onde a promise é devolvida: o vitest rastreia o retorno de um mock. */
const calls: Array<{ name: string; payload: unknown }> = []
const recorder = (name: string, value: unknown) => (payload: unknown) => {
  calls.push({ name, payload })
  return Promise.resolve(value)
}
vi.mock("@/hooks/useReversals", () => ({
  useResolveChargeback: () => ({ mutateAsync: recorder("resolve", {}), reset: vi.fn(), isPending: false }),
  useUnblockCard: () => ({ mutateAsync: recorder("unblock", {}), reset: vi.fn(), isPending: false }),
  useRegisterChargeback: () => ({ mutateAsync: recorder("register", { chargebackId: "cb_9", dossierId: "cb_9" }), reset: vi.fn(), isPending: false }),
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock("@/services/reversals", () => ({ reversalsService: { dossier: vi.fn() } }))

const chargeback = (patch: Partial<ChargebackDTO> = {}): ChargebackDTO => ({
  id: "cb_1",
  paymentIntentId: "pi_1",
  amountCents: 3782,
  caseReference: "CASO-2026-0187",
  outcome: null,
  notifiedAt: "2026-10-01T12:00:00.000Z",
  responseDeadline: null,
  dossierId: "cb_1",
  chargingSessionId: "s1",
  reasonCode: null,
  status: "OPEN",
  debtId: null,
  createdAt: "2026-10-01T12:00:00.000Z",
  resolvedAt: null,
  cardBlocked: true,
  cardUnblockedAt: null,
  cardUnblockReason: null,
  ...patch,
})

const onClose = vi.fn()
beforeEach(() => {
  calls.length = 0
  onClose.mockClear()
})

async function confirmWithPassword(buttonName: string, dialogName: string) {
  const confirm = await screen.findByRole("dialog", { name: dialogName })
  expect(calls).toHaveLength(0) // nada enviado antes da senha
  await userEvent.type(within(confirm).getByLabelText(/Sua senha atual/), "senha1234")
  await userEvent.click(within(confirm).getByRole("button", { name: buttonName }))
  await waitFor(() => expect(onClose).toHaveBeenCalled())
}

describe("ResolveChargebackDialog — desfecho e dívida", () => {
  it("Ganho: sem checkbox de dívida e sem `debtPolicy` no corpo", async () => {
    render(<ResolveChargebackDialog chargeback={chargeback()} onClose={onClose} />)
    expect(screen.getByRole("radio", { name: /^Ganho/ })).toBeChecked()
    expect(screen.queryByLabelText(/Criar dívida para o motorista/)).toBeNull()
    await userEvent.click(screen.getByRole("button", { name: /Revisar desfecho/ }))
    await confirmWithPassword("Registrar desfecho", "Confirmar desfecho")
    expect(calls).toEqual([{ name: "resolve", payload: { chargebackId: "cb_1", outcome: "WON", currentPassword: "senha1234" } }])
  })

  it("Perdido sem marcar a dívida = ABSORB (a plataforma absorve); o resumo diz que o cartão continua bloqueado", async () => {
    render(<ResolveChargebackDialog chargeback={chargeback()} onClose={onClose} />)
    await userEvent.click(screen.getByRole("radio", { name: /^Perdido/ }))
    expect(screen.getByLabelText(/Criar dívida para o motorista/)).not.toBeChecked()
    await userEvent.click(screen.getByRole("button", { name: /Revisar desfecho/ }))
    const confirm = await screen.findByRole("dialog", { name: "Confirmar desfecho" })
    expect(within(confirm).getByTestId("save-summary").textContent).toMatch(/Não — a plataforma absorve/)
    expect(within(confirm).getByTestId("save-summary").textContent).toMatch(/Continua bloqueado/)
    await confirmWithPassword("Registrar desfecho", "Confirmar desfecho")
    expect(calls[0].payload).toEqual({ chargebackId: "cb_1", outcome: "LOST", debtPolicy: "ABSORB", currentPassword: "senha1234" })
  })

  it("Aceito com a dívida marcada = CREATE_DEBT; voltar para Ganho desmarca e some o checkbox", async () => {
    render(<ResolveChargebackDialog chargeback={chargeback()} onClose={onClose} />)
    await userEvent.click(screen.getByRole("radio", { name: /^Aceito/ }))
    await userEvent.click(screen.getByLabelText(/Criar dívida para o motorista/))
    await userEvent.click(screen.getByRole("radio", { name: /^Ganho/ }))
    expect(screen.queryByLabelText(/Criar dívida para o motorista/)).toBeNull()
    await userEvent.click(screen.getByRole("radio", { name: /^Aceito/ }))
    expect(screen.getByLabelText(/Criar dívida para o motorista/)).not.toBeChecked() // desmarcou ao voltar para Ganho
    await userEvent.click(screen.getByLabelText(/Criar dívida para o motorista/))
    await userEvent.click(screen.getByRole("button", { name: /Revisar desfecho/ }))
    const confirm = await screen.findByRole("dialog", { name: "Confirmar desfecho" })
    expect(within(confirm).getByTestId("save-summary").textContent).toMatch(/Criar dívida de/)
    await confirmWithPassword("Registrar desfecho", "Confirmar desfecho")
    expect(calls[0].payload).toEqual({ chargebackId: "cb_1", outcome: "ACCEPTED", debtPolicy: "CREATE_DEBT", currentPassword: "senha1234" })
  })
})

describe("UnblockCardDialog", () => {
  it("motivo de 10+ caracteres, depois senha; o corpo leva só motivo e senha", async () => {
    render(<UnblockCardDialog chargeback={chargeback({ status: "LOST", outcome: "LOST" })} onClose={onClose} />)
    await userEvent.type(screen.getByLabelText(/Por que liberar o cartão/), "curto")
    await userEvent.click(screen.getByRole("button", { name: "Revisar" }))
    expect(await screen.findByText(/mínimo de 10 caracteres/)).toBeInTheDocument()
    await userEvent.clear(screen.getByLabelText(/Por que liberar o cartão/))
    await userEvent.type(screen.getByLabelText(/Por que liberar o cartão/), "Titularidade comprovada com o banco")
    await userEvent.click(screen.getByRole("button", { name: "Revisar" }))
    await confirmWithPassword("Desbloquear cartão", "Confirmar desbloqueio do cartão")
    expect(calls).toEqual([{ name: "unblock", payload: { chargebackId: "cb_1", reason: "Titularidade comprovada com o banco", currentPassword: "senha1234" } }])
  })
})

describe("RegisterChargebackDialog", () => {
  const row: PaymentListRow = {
    id: "demo_pi_7",
    purpose: "SESSION_CARD_CAPTURE",
    provider: "CIELO_CARD",
    status: "CAPTURED",
    amountRequestedCents: 3782,
    amountCapturedCents: 3782,
    userName: "Carla Motorista",
    chargingSessionId: "s1",
    siteId: null,
    siteName: null,
    createdAt: "2026-10-01T12:00:00.000Z",
  }

  it("não pede senha; o corpo leva o mínimo do contrato; depois do registro mostra o bloqueio do cartão e o dossiê", async () => {
    render(
      <MemoryRouter>
        <RegisterChargebackDialog row={row} onClose={onClose} />
      </MemoryRouter>,
    )
    expect(screen.queryByLabelText(/Sua senha atual/)).toBeNull()
    expect(screen.getByLabelText(/Valor contestado/)).toHaveValue("37,82") // preenchido com o capturado
    await userEvent.click(screen.getByRole("button", { name: "Registrar chargeback" }))
    expect(await screen.findByText(/Informe a referência do caso/)).toBeInTheDocument()
    expect(calls).toHaveLength(0)

    await userEvent.type(screen.getByLabelText(/Referência do caso na Cielo/), "CASO-1")
    await userEvent.click(screen.getByRole("button", { name: "Registrar chargeback" }))
    await waitFor(() => expect(calls).toHaveLength(1))
    const payload = calls[0].payload as Record<string, unknown>
    expect(payload).toMatchObject({ paymentIntentId: "demo_pi_7", amountCents: 3782, caseReference: "CASO-1" })
    expect(typeof payload.notifiedAt).toBe("string")
    expect(payload).not.toHaveProperty("responseDeadline")
    expect(payload).not.toHaveProperty("reasonCode")
    expect(payload).not.toHaveProperty("currentPassword")

    expect(await screen.findByTestId("chargeback-card-blocked")).toHaveTextContent("O modo cartão deste motorista foi bloqueado. Pix e carteira continuam.")
    expect(screen.getByRole("button", { name: /Baixar dossiê/ })).toBeInTheDocument()
  })
})

describe("DeadlineBadge — a cor nunca vai sozinha", () => {
  const now = new Date(2026, 9, 5, 14, 0, 0)
  const at = (day: number) => new Date(2026, 9, day, 23, 59, 0).toISOString()
  it("vencido e próximo trazem texto; resolvido não mostra prazo vivo; aberto sem prazo diz que não é vigiado", () => {
    const { rerender } = render(<DeadlineBadge chargeback={{ status: "OPEN", responseDeadline: at(2) }} now={now} />)
    expect(screen.getByText("Vencido há 3 dias")).toBeInTheDocument()
    rerender(<DeadlineBadge chargeback={{ status: "OPEN", responseDeadline: at(7) }} now={now} />)
    expect(screen.getByText("Vence em 2 dias")).toBeInTheDocument()
    rerender(<DeadlineBadge chargeback={{ status: "WON", responseDeadline: at(2) }} now={now} />)
    expect(screen.queryByText(/Vencido|Vence/)).toBeNull()
    rerender(<DeadlineBadge chargeback={{ status: "OPEN", responseDeadline: null }} now={now} />)
    expect(screen.getByText("Sem prazo cadastrado")).toBeInTheDocument()
  })
})
