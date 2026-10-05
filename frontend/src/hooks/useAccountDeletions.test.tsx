import { type ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { accountDeletionsKeys, useAccountDeletions, useRefundAccountDeletion } from "./useAccountDeletions"
import type { AdminAccountDeletionRow, PaginatedResponse } from "@/types/api"

const list = vi.fn()
const refund = vi.fn()
vi.mock("@/services/accountDeletions", () => ({
  accountDeletionsService: { list: (...a: unknown[]) => list(...a), refund: (...a: unknown[]) => refund(...a) },
}))

const row = (id: string, status: AdminAccountDeletionRow["refundStatus"] = "PENDING_REFUND"): AdminAccountDeletionRow => ({
  id,
  userId: `u_${id}`,
  requestedAt: "2026-09-01T00:00:00.000Z",
  balanceCentsAtRequest: 1000,
  refundStatus: status,
  refundPixKey: status === "PENDING_REFUND" ? "CHAVE-PIX-SECRETA" : null,
  refundedAt: null,
  refundedByUserId: null,
  ageDays: 10,
  overdue: false,
})
const page = (items: AdminAccountDeletionRow[]): PaginatedResponse<AdminAccountDeletionRow> => ({ items, meta: { page: 1, pageSize: 20, total: items.length, totalPages: 1 } })

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  return { queryClient, wrapper }
}

describe("useAccountDeletions — a chave Pix é lida e AUDITADA a cada GET", () => {
  it("não refaz sozinha (foco, remontagem) e não guarda a resposta depois que a tela sai", async () => {
    list.mockResolvedValue(page([row("a")]))
    const { queryClient, wrapper } = setup()
    const first = renderHook(() => useAccountDeletions({ status: "PENDING_REFUND", page: 1, pageSize: 20 }), { wrapper })
    await waitFor(() => expect(first.result.current.data?.items).toHaveLength(1))
    expect(list).toHaveBeenCalledTimes(1)

    // Foco da janela e uma 2ª montagem com o dado ainda em cache: nenhuma leitura nova (staleTime infinito, sem refetch em foco).
    window.dispatchEvent(new Event("focus"))
    const second = renderHook(() => useAccountDeletions({ status: "PENDING_REFUND", page: 1, pageSize: 20 }), { wrapper })
    await waitFor(() => expect(second.result.current.data).toBeDefined())
    expect(list).toHaveBeenCalledTimes(1)

    // `gcTime: 0`: ao sair da tela, a chave Pix não fica no cache do navegador.
    first.unmount()
    second.unmount()
    await waitFor(() => expect(queryClient.getQueryCache().findAll({ queryKey: accountDeletionsKeys.all })).toHaveLength(0))
    expect(JSON.stringify(queryClient.getQueryCache().getAll().map((q) => q.state.data))).not.toContain("CHAVE-PIX-SECRETA")
  })
})

describe("useRefundAccountDeletion — atualiza o cache em vez de reler (cada leitura é auditada)", () => {
  it("na fila de pendentes a linha sai e o total desce; em todas ela vira devolvida; sem novo GET; sem senha em memória", async () => {
    const { queryClient, wrapper } = setup()
    const pending = { status: "PENDING_REFUND" as const, page: 1, pageSize: 20 }
    const all = { page: 1, pageSize: 20 }
    queryClient.setQueryData(accountDeletionsKeys.list(pending), page([row("a"), row("b")]))
    queryClient.setQueryData(accountDeletionsKeys.list(all), page([row("a"), row("b"), row("c", "REFUNDED")]))
    // Observadores ativos mantêm as consultas vivas durante o teste (gcTime: 0).
    renderHook(() => useAccountDeletions(pending), { wrapper })
    renderHook(() => useAccountDeletions(all), { wrapper })
    list.mockClear()

    refund.mockResolvedValueOnce({ ...row("a", "REFUNDED"), refundedAt: "2026-10-05T10:00:00.000Z", refundedByUserId: "admin" })
    const { result } = renderHook(() => useRefundAccountDeletion(), { wrapper })
    await act(async () => {
      await result.current.mutateAsync({ requestId: "a", amountCents: 1000, proofReference: "COMP-1", currentPassword: "SENHA-NA-MEMORIA" })
    })
    await act(async () => {
      result.current.reset()
    })

    const pendingData = queryClient.getQueryData<PaginatedResponse<AdminAccountDeletionRow>>(accountDeletionsKeys.list(pending))
    expect(pendingData?.items.map((i) => i.id)).toEqual(["b"])
    expect(pendingData?.meta.total).toBe(1)
    const allData = queryClient.getQueryData<PaginatedResponse<AdminAccountDeletionRow>>(accountDeletionsKeys.list(all))
    expect(allData?.items.find((i) => i.id === "a")).toMatchObject({ refundStatus: "REFUNDED", refundPixKey: null })
    expect(allData?.meta.total).toBe(3)
    expect(list).not.toHaveBeenCalled()
    expect(refund).toHaveBeenCalledWith("a", { amountCents: 1000, proofReference: "COMP-1", currentPassword: "SENHA-NA-MEMORIA" })
    await waitFor(() => expect(queryClient.getMutationCache().getAll()).toHaveLength(0))
    expect(JSON.stringify(queryClient.getMutationCache().getAll())).not.toContain("SENHA-NA-MEMORIA")
  })
})
