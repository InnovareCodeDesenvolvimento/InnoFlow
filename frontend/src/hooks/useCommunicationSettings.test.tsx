import { type ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider, useMutation } from "@tanstack/react-query"
import { useTestEmail, useTestWhatsapp, useUpdateCommunicationSettings } from "./useCommunicationSettings"

const update = vi.fn()
const testEmail = vi.fn()
const testWhatsapp = vi.fn()
vi.mock("@/services/communicationSettings", () => ({
  communicationSettingsService: {
    get: vi.fn(),
    update: (...args: unknown[]) => update(...args),
    testEmail: (...args: unknown[]) => testEmail(...args),
    testWhatsapp: (...args: unknown[]) => testWhatsapp(...args),
  },
}))

const SECRET = "SEGREDO-SMTP-NA-MEMORIA-123"
const PASSWORD = "SENHA-ATUAL-NA-MEMORIA-456"

function setup<T>(useHook: () => T) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  const hook = renderHook(useHook, { wrapper })
  return { queryClient, ...hook }
}

/** Tudo o que o TanStack Query guarda sobre mutations, em texto — onde um segredo/senha sobrevivente apareceria. */
const dumpMutationMemory = (queryClient: QueryClient) =>
  JSON.stringify(queryClient.getMutationCache().getAll().map((m) => ({ variables: m.state.variables, error: String(m.state.error ?? "") })))

describe("mutations da tela de Comunicação — segredo e senha não ficam em `variables`", () => {
  it("PUT: depois do sucesso e de reset(), o MutationCache fica vazio e sem rastro do corpo", async () => {
    update.mockResolvedValueOnce({ source: "database" })
    const { queryClient, result } = setup(useUpdateCommunicationSettings)

    await act(async () => {
      await result.current.mutateAsync({ email: { password: SECRET }, currentPassword: PASSWORD })
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

  it("PUT: depois de um erro (senha incorreta) e reset(), idem", async () => {
    update.mockRejectedValueOnce(new Error("403"))
    const { queryClient, result } = setup(useUpdateCommunicationSettings)

    await act(async () => {
      await result.current.mutateAsync({ email: { password: SECRET }, currentPassword: PASSWORD }).catch(() => undefined)
    })
    await act(async () => {
      result.current.reset()
    })

    await waitFor(() => expect(queryClient.getMutationCache().getAll()).toHaveLength(0))
    expect(dumpMutationMemory(queryClient)).not.toContain(SECRET)
  })

  it("testes (`config` com senha SMTP / apikey digitadas): idem", async () => {
    testEmail.mockResolvedValueOnce({ channel: "email", ok: true })
    testWhatsapp.mockResolvedValueOnce({ channel: "whatsapp", ok: true })
    const email = setup(useTestEmail)
    const whatsapp = setup(useTestWhatsapp)

    await act(async () => {
      await email.result.current.mutateAsync({ config: { password: SECRET } })
      await whatsapp.result.current.mutateAsync({ config: { apiKey: SECRET } })
    })
    await act(async () => {
      email.result.current.reset()
      whatsapp.result.current.reset()
    })

    await waitFor(() => expect(email.queryClient.getMutationCache().getAll()).toHaveLength(0))
    await waitFor(() => expect(whatsapp.queryClient.getMutationCache().getAll()).toHaveLength(0))
    expect(dumpMutationMemory(email.queryClient)).not.toContain(SECRET)
    expect(dumpMutationMemory(whatsapp.queryClient)).not.toContain(SECRET)
  })

  it("controle: SEM `gcTime: 0` o corpo sobreviveria (prova que o teste enxerga o vazamento)", async () => {
    update.mockResolvedValueOnce({})
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    const control = renderHook(() => useMutation({ mutationFn: (p: unknown) => update(p) }), {
      wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
    })
    await act(async () => {
      await control.result.current.mutateAsync({ password: SECRET })
    })
    await act(async () => {
      control.result.current.reset()
    })
    expect(dumpMutationMemory(queryClient)).toContain(SECRET)
  })
})
