import { type ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useUpdatePaymentGateway } from "./usePaymentGateway"

const update = vi.fn()
vi.mock("@/services/paymentGateway", () => ({
  paymentGatewayService: { get: vi.fn(), update: (...args: unknown[]) => update(...args) },
}))

const SECRET = "SEGREDO-NA-MEMORIA-123"
const PASSWORD = "SENHA-NA-MEMORIA-456"
const body = { merchantKey: SECRET, currentPassword: PASSWORD }

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  const hook = renderHook(() => useUpdatePaymentGateway(), { wrapper })
  return { queryClient, ...hook }
}

/** Tudo o que o TanStack Query guarda sobre mutations, em texto — onde um segredo/senha sobrevivente apareceria. */
const dumpMutationMemory = (queryClient: QueryClient) =>
  JSON.stringify(queryClient.getMutationCache().getAll().map((m) => ({ variables: m.state.variables, error: String(m.state.error ?? "") })))

describe("useUpdatePaymentGateway — segredo e senha não ficam em `variables` (Órion B7)", () => {
  it("depois do sucesso e de reset(), o MutationCache fica vazio e sem rastro do corpo do PUT", async () => {
    update.mockResolvedValueOnce({ source: "database" })
    const { queryClient, result } = setup()

    await act(async () => {
      await result.current.mutateAsync(body as never)
    })
    await act(async () => {
      result.current.reset()
    })

    await waitFor(() => expect(queryClient.getMutationCache().getAll()).toHaveLength(0))
    expect(result.current.variables).toBeUndefined()
    const memory = dumpMutationMemory(queryClient)
    expect(memory).not.toContain(SECRET)
    expect(memory).not.toContain(PASSWORD)
  })

  it("depois de um ERRO (ex.: senha incorreta) e reset(), idem", async () => {
    update.mockRejectedValueOnce(new Error("403"))
    const { queryClient, result } = setup()

    await act(async () => {
      await result.current.mutateAsync(body as never).catch(() => undefined)
    })
    await act(async () => {
      result.current.reset()
    })

    await waitFor(() => expect(queryClient.getMutationCache().getAll()).toHaveLength(0))
    expect(dumpMutationMemory(queryClient)).not.toContain(PASSWORD)
    expect(result.current.variables).toBeUndefined()
  })

  it("sem gcTime: 0 o corpo SOBREVIVERIA no cache (prova de que o teste detecta o problema)", async () => {
    update.mockResolvedValueOnce({ source: "database" })
    const queryClient = new QueryClient()
    const { useMutation } = await import("@tanstack/react-query")
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    const { result } = renderHook(() => useMutation({ mutationFn: (b: typeof body) => update(b) }), { wrapper })
    await act(async () => {
      await result.current.mutateAsync(body)
    })
    await act(async () => {
      result.current.reset()
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(dumpMutationMemory(queryClient)).toContain(PASSWORD)
  })
})
