import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { AxiosError, type AxiosResponse } from "axios"
import { TariffAssignmentFormDialog } from "./TariffAssignmentFormDialog"
import type { ChargePoint, Connector, CreateTariffAssignmentInput, Site, Tariff } from "@/types/api"

// Função comum (não `vi.fn`): o vitest rastreia a promise devolvida por um mock e uma rejeição legítima (tratada pelo componente) vira "unhandled rejection".
const created: CreateTariffAssignmentInput[] = []
let createOutcome: { ok: true } | { ok: false; error: unknown } = { ok: true }
const createMutateAsync = (payload: CreateTariffAssignmentInput) => {
  created.push(payload)
  return createOutcome.ok ? Promise.resolve({ id: "ta_novo" }) : Promise.reject(createOutcome.error)
}
const authState: { role: "ADMIN" | "OPERATOR" } = { role: "OPERATOR" }

const page = <T,>(items: T[]) => ({ data: { items, meta: { page: 1, pageSize: 100, total: items.length, totalPages: 1 } }, isLoading: false, isError: false })

const A = "op_a"
const B = "op_b"
const tariff = (id: string, name: string, operatorId: string): Tariff =>
  ({ id, operatorId, name, model: "PER_KWH", pricePerKwh: "2.0000", pricePerMinute: null, sessionFeeCents: null, minChargeCents: null, idleFeePerMinute: 0, idleGracePeriodSeconds: 0, currency: "BRL", active: true, createdAt: "", updatedAt: "" }) as Tariff
const site = (id: string, name: string, operatorId: string): Site => ({ id, operatorId, name, city: "SP", state: "SP", active: true }) as Site
const connector = (id: string, n: number, chargePointId: string, operatorId: string): Connector => ({ id, operatorId, chargePointId, connectorId: n, type: "DC_CCS2" }) as Connector
const cpA: ChargePoint = { id: "cpA", operatorId: A, siteId: "siteA", ocppIdentity: "CP-A", active: true, connectors: [connector("cA1", 1, "cpA", A), connector("cA2", 2, "cpA", A)] } as ChargePoint
const cpB: ChargePoint = { id: "cpB", operatorId: B, siteId: "siteB", ocppIdentity: "CP-B", active: true, connectors: [connector("cB1", 1, "cpB", B)] } as ChargePoint

vi.mock("@/hooks/useTariffs", () => ({ useTariffs: () => page([tariff("tA", "Tarifa A", A), tariff("tB", "Tarifa B", B)]) }))
vi.mock("@/hooks/useSites", () => ({ useSites: () => page([site("siteA", "Local A", A), site("siteB", "Local B", B)]) }))
vi.mock("@/hooks/useChargePoints", () => ({ useChargePoints: () => page([cpA, cpB]) }))
vi.mock("@/hooks/useTariffAssignments", () => ({
  useCreateTariffAssignment: () => ({ mutateAsync: createMutateAsync }),
  useUpdateTariffAssignment: () => ({ mutateAsync: vi.fn() }),
}))
vi.mock("@/store/authStore", () => ({ useAuthStore: (select: (s: { user: { role: string } }) => unknown) => select({ user: { role: authState.role } }) }))

function validationError(messages: string[]) {
  const response = { status: 400, data: { error: "Dados inválidos.", code: "VALIDATION_ERROR", details: messages.map((message) => ({ path: "connectorId", message })) } } as AxiosResponse
  return new AxiosError("Request failed", "ERR_BAD_REQUEST", undefined, undefined, response)
}

const open = (props: Partial<React.ComponentProps<typeof TariffAssignmentFormDialog>> = {}) =>
  render(<TariffAssignmentFormDialog open onOpenChange={vi.fn()} {...props} />)

beforeEach(() => {
  created.length = 0
  createOutcome = { ok: true }
  authState.role = "OPERATOR"
})

describe("TariffAssignmentFormDialog — contrato do POST", () => {
  it("escopo CONNECTOR no contexto de um carregador: manda SÓ connectorId (nunca chargePointId/siteId, que o servidor recusa com 400)", async () => {
    open({ chargePoint: cpA })
    await userEvent.selectOptions(screen.getByLabelText(/^Tarifa/), "tA")
    await userEvent.selectOptions(screen.getByLabelText(/^Onde vale/), "CONNECTOR")
    await userEvent.selectOptions(screen.getByLabelText(/^Tomada/), "cA2")
    await userEvent.click(screen.getByRole("button", { name: "Vincular tarifa" }))

    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({ tariffId: "tA", scope: "CONNECTOR", connectorId: "cA2", priority: 0 })
    expect(created[0]).not.toHaveProperty("chargePointId")
    expect(created[0]).not.toHaveProperty("siteId")
    expect(created[0]).not.toHaveProperty("operatorId") // OPERATOR: o servidor usa o do token
  })

  it("escopo OPERATOR não leva nenhum alvo", async () => {
    open({ chargePoint: cpA })
    await userEvent.selectOptions(screen.getByLabelText(/^Tarifa/), "tA")
    await userEvent.selectOptions(screen.getByLabelText(/^Onde vale/), "OPERATOR")
    await userEvent.click(screen.getByRole("button", { name: "Vincular tarifa" }))

    expect(created[0]).toMatchObject({ tariffId: "tA", scope: "OPERATOR" })
    for (const field of ["connectorId", "chargePointId", "siteId"]) expect(created[0]).not.toHaveProperty(field)
  })

  it("alvo vazio: erro no campo e NADA enviado", async () => {
    open({ chargePoint: cpA })
    await userEvent.selectOptions(screen.getByLabelText(/^Tarifa/), "tA")
    await userEvent.selectOptions(screen.getByLabelText(/^Onde vale/), "SITE")
    await userEvent.click(screen.getByRole("button", { name: "Vincular tarifa" }))

    expect(await screen.findByText("Selecione o local.")).toBeInTheDocument()
    expect(created).toHaveLength(0)
  })

  it("400 do servidor: mostra cada mensagem de `details` num alerta e mantém o formulário aberto", async () => {
    createOutcome = { ok: false, error: validationError(["connectorId é obrigatório quando scope=CONNECTOR.", "siteId não deve ser informado quando scope=CONNECTOR."]) }
    open({ chargePoint: cpA })
    await userEvent.selectOptions(screen.getByLabelText(/^Tarifa/), "tA")
    await userEvent.click(screen.getByRole("button", { name: "Vincular tarifa" })) // escopo padrão: carregador (alvo já preenchido)

    const alert = await screen.findByTestId("assignment-server-error")
    expect(within(alert).getByText("connectorId é obrigatório quando scope=CONNECTOR.")).toBeInTheDocument()
    expect(within(alert).getByText("siteId não deve ser informado quando scope=CONNECTOR.")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Vincular tarifa" })).toBeEnabled()
  })
})

describe("TariffAssignmentFormDialog — multi-tenant", () => {
  it("OPERATOR no carregador A: só tarifa e alvos do operador A", () => {
    open({ chargePoint: cpA })
    const tarifas = within(screen.getByLabelText(/^Tarifa/))
    expect(tarifas.getByRole("option", { name: /Tarifa A/ })).toBeInTheDocument()
    expect(tarifas.queryByRole("option", { name: /Tarifa B/ })).not.toBeInTheDocument()
  })

  it("ADMIN sem contexto: a tarifa escolhida (operador B) restringe os locais a B e manda o operatorId dela", async () => {
    authState.role = "ADMIN"
    open({ defaultScope: "SITE" })
    await userEvent.selectOptions(screen.getByLabelText(/^Tarifa/), "tB")

    const locais = within(screen.getByLabelText(/^Local/))
    expect(locais.getByRole("option", { name: /Local B/ })).toBeInTheDocument()
    expect(locais.queryByRole("option", { name: /Local A/ })).not.toBeInTheDocument()

    await userEvent.selectOptions(screen.getByLabelText(/^Local/), "siteB")
    await userEvent.click(screen.getByRole("button", { name: "Vincular tarifa" }))
    expect(created[0]).toMatchObject({ operatorId: B, tariffId: "tB", scope: "SITE", siteId: "siteB" })
  })

  it("ADMIN trocando para a tarifa de OUTRO operador descarta o alvo já escolhido (não envia local de A com tarifa de B)", async () => {
    authState.role = "ADMIN"
    open({ defaultScope: "SITE" })
    await userEvent.selectOptions(screen.getByLabelText(/^Tarifa/), "tA")
    await userEvent.selectOptions(screen.getByLabelText(/^Local/), "siteA")
    await userEvent.selectOptions(screen.getByLabelText(/^Tarifa/), "tB")

    expect(screen.getByLabelText(/^Local/)).toHaveValue("")
    await userEvent.click(screen.getByRole("button", { name: "Vincular tarifa" }))
    expect(created).toHaveLength(0)
    expect(await screen.findByText("Selecione o local.")).toBeInTheDocument()
  })
})
