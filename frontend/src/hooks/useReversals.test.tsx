import { type ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useCancelRefund, useConfirmRefund, useCreateRefund, useRegisterChargeback, useResolveChargeback, useUnblockCard } from "./useReversals"

const calls: Record<string, unknown[]> = {}
const record =
  (name: string) =>
  (...args: unknown[]) => {
    calls[name] = args
    return Promise.resolve({ ok: true })
  }
vi.mock("@/services/reversals", () => ({
  reversalsService: {
    sessionRefunds: vi.fn(),
    createRefund: (...a: unknown[]) => record("createRefund")(...a),
    cancelRefund: (...a: unknown[]) => record("cancelRefund")(...a),
    confirmRefund: (...a: unknown[]) => record("confirmRefund")(...a),
    registerChargeback: (...a: unknown[]) => record("registerChargeback")(...a),
    resolveChargeback: (...a: unknown[]) => record("resolveChargeback")(...a),
    unblockCard: (...a: unknown[]) => record("unblockCard")(...a),
    listChargebacks: vi.fn(),
    dossier: vi.fn(),
  },
}))

const PASSWORD = "SENHA-NA-MEMORIA-456"
const REASON = "MOTIVO-DIGITADO-PELO-ADMIN"

function setup<T>(useHook: () => T) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  return { queryClient, ...renderHook(useHook, { wrapper }) }
}

/** Tudo o que o TanStack Query guarda sobre mutations, em texto — onde uma senha/motivo sobrevivente apareceria. */
const dumpMutationMemory = (queryClient: QueryClient) => JSON.stringify(queryClient.getMutationCache().getAll().map((m) => ({ variables: m.state.variables, error: String(m.state.error ?? "") })))

type AnyMutation = { mutateAsync: (v: never) => Promise<unknown>; reset: () => void; variables: unknown }

describe("mutations de dinheiro do Admin — a senha e o motivo não ficam em `variables`", () => {
  const cases: Array<[string, () => AnyMutation, unknown]> = [
    ["createRefund", () => useCreateRefund("s1") as unknown as AnyMutation, { amountCents: 100, reason: REASON, destination: "WALLET", currentPassword: PASSWORD }],
    ["cancelRefund", () => useCancelRefund("s1") as unknown as AnyMutation, { refundId: "r1", currentPassword: PASSWORD }],
    ["confirmRefund", () => useConfirmRefund("s1") as unknown as AnyMutation, { refundId: "r1", proofReference: "COMP-123", currentPassword: PASSWORD }],
    ["resolveChargeback", () => useResolveChargeback() as unknown as AnyMutation, { chargebackId: "c1", outcome: "LOST", currentPassword: PASSWORD }],
    ["unblockCard", () => useUnblockCard() as unknown as AnyMutation, { chargebackId: "c1", reason: REASON, currentPassword: PASSWORD }],
  ]

  for (const [name, hook, body] of cases) {
    it(`${name}: depois do sucesso e de reset(), o MutationCache fica vazio e sem rastro do corpo`, async () => {
      const { queryClient, result } = setup(hook)
      await act(async () => {
        await result.current.mutateAsync(body as never)
      })
      await act(async () => {
        result.current.reset()
      })
      await waitFor(() => expect(queryClient.getMutationCache().getAll()).toHaveLength(0))
      expect(result.current.variables).toBeUndefined()
      const memory = dumpMutationMemory(queryClient)
      expect(memory).not.toContain(PASSWORD)
      expect(memory).not.toContain(REASON)
    })
  }

  it("o id da rota sai do corpo (não vai no JSON) e a senha chega ao serviço", async () => {
    const { result } = setup(() => useCancelRefund("s1"))
    await act(async () => {
      await result.current.mutateAsync({ refundId: "r9", currentPassword: PASSWORD })
    })
    expect(calls.cancelRefund).toEqual(["r9", { currentPassword: PASSWORD }])
  })

  it("registrar chargeback NÃO pede senha (contrato): só o id da venda vai à rota e o resto ao corpo", async () => {
    const { result } = setup(() => useRegisterChargeback())
    await act(async () => {
      await result.current.mutateAsync({ paymentIntentId: "pi_1", amountCents: 100, notifiedAt: "2026-10-05T10:00:00.000Z", caseReference: "CASO-1" })
    })
    expect(calls.registerChargeback).toEqual(["pi_1", { amountCents: 100, notifiedAt: "2026-10-05T10:00:00.000Z", caseReference: "CASO-1" }])
    expect(JSON.stringify(calls.registerChargeback)).not.toMatch(/currentPassword/)
  })
})
