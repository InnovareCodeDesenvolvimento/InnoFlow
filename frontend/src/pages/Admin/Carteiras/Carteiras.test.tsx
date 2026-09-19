import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { AxiosError } from "axios"
import { AdjustBalanceDialog } from "./AdjustBalanceDialog"
import { DriverWalletDrawer } from "./DriverWalletDrawer"
import type { DriverListRow, DriverWalletResponse } from "@/types/api"

// Função comum (não `vi.fn`): o vitest rastreia a promise devolvida por um mock e uma rejeição
// legítima (que o componente trata) vira "unhandled rejection" do próprio rastreador.
const calls: unknown[] = []
let outcome: { ok: true; entry: { balanceAfterCents: number } } | { ok: false; error: unknown } = { ok: true, entry: { balanceAfterCents: 10000 } }
const mutateAsync = (payload: unknown) => {
  calls.push(payload)
  return outcome.ok ? Promise.resolve(outcome.entry) : Promise.reject(outcome.error)
}
const walletState: { data: DriverWalletResponse | undefined } = { data: undefined }

vi.mock("@/hooks/useDrivers", () => ({
  useWalletAdjustment: () => ({ mutateAsync, isPending: false }),
  useDriverWallet: () => ({ data: walletState.data, isLoading: false, isError: false, error: null, refetch: vi.fn(), isFetching: false }),
}))

const driver: DriverListRow = { id: "d1", name: "Carla Motorista", email: "c@x.com", walletBalanceCents: 5000, openDebtCents: 0, activeSessionId: null, createdAt: "2026-09-01T12:00:00.000Z" }
const wallet: DriverWalletResponse = {
  driverId: "d1",
  driverName: "Carla Motorista",
  balanceCents: 5000,
  openDebtCents: 1850,
  entries: [
    { id: "e1", type: "ADJUSTMENT_CREDIT", amountCents: 2000, balanceAfterCents: 5000, referenceType: null, referenceId: null, description: "Cortesia por falha", createdAt: "2026-09-18T12:00:00.000Z" },
    { id: "e2", type: "CHARGE_DEBIT", amountCents: -1200, balanceAfterCents: 3000, referenceType: null, referenceId: null, description: null, createdAt: "2026-09-17T12:00:00.000Z" },
  ],
  total: 2,
  page: 1,
  pageSize: 10,
}

const flat = (s: string | null) => (s ?? "").split(String.fromCharCode(160)).join(" ")

async function fill(amount: string, reason: string) {
  await userEvent.type(screen.getByLabelText(/Valor \(R\$\)/), amount)
  await userEvent.type(screen.getByLabelText(/Motivo/), reason)
}

describe("AdjustBalanceDialog — dinheiro real: preencher, CONFIRMAR, só então enviar", () => {
  beforeEach(() => {
    calls.length = 0
    outcome = { ok: true, entry: { balanceAfterCents: 10000 } }
  })

  it("crédito: mostra 'Creditar R$ 50,00 para Carla Motorista' e NÃO envia antes da confirmação", async () => {
    const onOpenChange = vi.fn()
    render(<AdjustBalanceDialog driver={{ id: "d1", name: "Carla Motorista" }} balanceCents={5000} onOpenChange={onOpenChange} />)

    await fill("50,00", "Saldo de teste do fluxo")
    await userEvent.click(screen.getByRole("button", { name: /Revisar lançamento/ }))

    expect(calls).toHaveLength(0) // nada enviado ainda
    expect(flat(screen.getByTestId("adjust-summary").textContent)).toBe("Creditar R$ 50,00 para Carla Motorista")
    expect(flat(screen.getByTestId("adjust-balance-after").textContent)).toBe("R$ 100,00")

    await userEvent.click(screen.getByRole("button", { name: "Confirmar crédito" }))
    expect(calls).toEqual([{ amountCents: 5000, description: "Saldo de teste do fluxo" }])
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("débito vai com valor NEGATIVO em centavos inteiros ('12,34' → -1234)", async () => {
    outcome = { ok: true, entry: { balanceAfterCents: 3766 } }
    render(<AdjustBalanceDialog driver={{ id: "d1", name: "Carla Motorista" }} balanceCents={5000} onOpenChange={vi.fn()} />)
    await userEvent.click(screen.getByRole("radio", { name: /Débito/ }))
    await fill("12,34", "Estorno de lançamento indevido")
    await userEvent.click(screen.getByRole("button", { name: /Revisar lançamento/ }))
    expect(flat(screen.getByTestId("adjust-summary").textContent)).toBe("Debitar R$ 12,34 de Carla Motorista")
    await userEvent.click(screen.getByRole("button", { name: "Confirmar débito" }))
    expect(calls).toEqual([{ amountCents: -1234, description: "Estorno de lançamento indevido" }])
  })

  it("motivo curto e valor inválido: erros na tela, NÃO avança nem envia", async () => {
    render(<AdjustBalanceDialog driver={{ id: "d1", name: "Carla" }} balanceCents={5000} onOpenChange={vi.fn()} />)
    await fill("abc", "oi")
    await userEvent.click(screen.getByRole("button", { name: /Revisar lançamento/ }))
    expect(screen.getByText(/Valor inválido/)).toBeInTheDocument()
    expect(screen.getByText(/mínimo de 5 caracteres/)).toBeInTheDocument()
    expect(screen.queryByTestId("adjust-summary")).not.toBeInTheDocument()
    expect(calls).toHaveLength(0)
  })

  it("acima do teto de R$ 5.000 e débito maior que o saldo são barrados antes do servidor", async () => {
    render(<AdjustBalanceDialog driver={{ id: "d1", name: "Carla" }} balanceCents={5000} onOpenChange={vi.fn()} />)
    await fill("5.000,01", "Motivo qualquer")
    await userEvent.click(screen.getByRole("button", { name: /Revisar lançamento/ }))
    expect(screen.getByText(/O máximo por lançamento é/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole("radio", { name: /Débito/ }))
    await userEvent.clear(screen.getByLabelText(/Valor \(R\$\)/))
    await userEvent.type(screen.getByLabelText(/Valor \(R\$\)/), "60")
    expect(screen.getByText(/não pode passar do saldo atual/)).toBeInTheDocument()
    expect(calls).toHaveLength(0)
  })

  it("erro do servidor por CÓDIGO em português (409 INSUFFICIENT_BALANCE) e fica na confirmação, sem fechar", async () => {
    outcome = {
      ok: false,
      error: new AxiosError("x", "ERR_BAD_REQUEST", undefined, undefined, { status: 409, data: { error: "en", code: "INSUFFICIENT_BALANCE" } } as never),
    }
    const onOpenChange = vi.fn()
    render(<AdjustBalanceDialog driver={{ id: "d1", name: "Carla" }} balanceCents={5000} onOpenChange={onOpenChange} />)
    await userEvent.click(screen.getByRole("radio", { name: /Débito/ }))
    await fill("50", "Débito de teste válido")
    await userEvent.click(screen.getByRole("button", { name: /Revisar lançamento/ }))
    await userEvent.click(screen.getByRole("button", { name: "Confirmar débito" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Saldo insuficiente")
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect(screen.getByRole("button", { name: "Confirmar débito" })).toBeInTheDocument()
  })

  it("'Voltar' na confirmação retorna ao formulário com os dados preservados", async () => {
    render(<AdjustBalanceDialog driver={{ id: "d1", name: "Carla" }} balanceCents={5000} onOpenChange={vi.fn()} />)
    await fill("50", "Motivo preservado")
    await userEvent.click(screen.getByRole("button", { name: /Revisar lançamento/ }))
    await userEvent.click(screen.getByRole("button", { name: /Voltar/ }))
    expect(screen.getByLabelText(/Valor \(R\$\)/)).toHaveValue("50")
    expect(screen.getByLabelText(/Motivo/)).toHaveValue("Motivo preservado")
  })
})

describe("DriverWalletDrawer — papéis e extrato", () => {
  beforeEach(() => {
    walletState.data = wallet
  })

  it("ADMIN vê 'Ajustar saldo'", () => {
    render(<DriverWalletDrawer driver={driver} isAdmin onClose={vi.fn()} />)
    expect(screen.getByRole("button", { name: /Ajustar saldo/ })).toBeInTheDocument()
  })

  it("OPERATOR NÃO vê 'Ajustar saldo' — só consulta — e o e-mail ausente não vira 'undefined'", () => {
    render(<DriverWalletDrawer driver={{ ...driver, email: undefined }} isAdmin={false} onClose={vi.fn()} />)
    expect(screen.queryByRole("button", { name: /Ajustar saldo/ })).not.toBeInTheDocument()
    expect(screen.getByText(/Somente consulta/)).toBeInTheDocument()
    expect(screen.queryByText(/undefined/)).not.toBeInTheDocument()
  })

  it("mostra saldo, dívida em aberto e o extrato com sinal explícito (crédito +, débito −)", () => {
    render(<DriverWalletDrawer driver={driver} isAdmin onClose={vi.fn()} />)
    expect(flat(screen.getByTestId("wallet-balance").textContent)).toBe("R$ 50,00")
    expect(flat(screen.getByText(/Dívida em aberto de/).textContent)).toContain("R$ 18,50")
    const list = screen.getByRole("list")
    const rows = within(list).getAllByRole("listitem")
    expect(rows).toHaveLength(2)
    expect(flat(rows[0].textContent)).toContain("+ R$ 20,00")
    expect(flat(rows[1].textContent)).toContain("− R$ 12,00")
    expect(rows[0]).toHaveTextContent("Cortesia por falha")
  })

  it("avisa que consultar o extrato fica registrado na auditoria", () => {
    render(<DriverWalletDrawer driver={driver} isAdmin onClose={vi.fn()} />)
    expect(screen.getByText(/fica registrado na auditoria/)).toBeInTheDocument()
  })
})
