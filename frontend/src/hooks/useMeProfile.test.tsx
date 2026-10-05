import { type ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { profileKeys, useChangePassword, useUpdateMeProfile } from "./useMeProfile"
import { useAuthStore } from "@/store/authStore"
import { TOKEN_STORAGE_KEY } from "@/lib/storageKeys"
import type { MeProfile, User } from "@/types/api"

const updateProfile = vi.fn()
const changePassword = vi.fn()
vi.mock("@/services/me", () => ({ meService: { getProfile: vi.fn(), updateProfile: (...a: unknown[]) => updateProfile(...a) } }))
vi.mock("@/services/auth", () => ({ authService: { changePassword: (...a: unknown[]) => changePassword(...a) } }))

const user: User = { id: "u1", name: "Carla Motorista", email: "c@x.com", role: "DRIVER", operatorId: null, operatorName: null, hasPassword: false }
const profile: MeProfile = {
  id: "u1",
  name: "Carla Motorista",
  email: "c@x.com",
  phone: null,
  cpfMasked: null,
  hasPassword: false,
  googleLinked: true,
  identityVerified: true,
  createdAt: "2026-08-15T12:00:00.000Z",
}

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  queryClient.setQueryData(profileKeys.profile, profile)
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  return { queryClient, wrapper }
}

beforeEach(() => {
  updateProfile.mockReset()
  changePassword.mockReset()
  localStorage.setItem(TOKEN_STORAGE_KEY, "token-velho")
  useAuthStore.setState({ user, token: "token-velho", isAuthenticated: true })
})

describe("useUpdateMeProfile", () => {
  it("o DTO devolvido vai direto para o cache do perfil (sem refetch) e o NOME novo chega ao authStore (cabeçalho)", async () => {
    updateProfile.mockResolvedValueOnce({ ...profile, name: "Carla M. Silva" })
    const { queryClient, wrapper } = setup()
    const { result } = renderHook(() => useUpdateMeProfile(), { wrapper })

    await act(async () => {
      await result.current.mutateAsync({ name: "Carla M. Silva" })
    })

    expect(updateProfile).toHaveBeenCalledWith({ name: "Carla M. Silva" })
    expect(queryClient.getQueryData<MeProfile>(profileKeys.profile)?.name).toBe("Carla M. Silva")
    expect(useAuthStore.getState().user?.name).toBe("Carla M. Silva")
  })

  it("se o servidor recusa, nada muda no cache nem no authStore", async () => {
    updateProfile.mockRejectedValueOnce(new Error("409"))
    const { queryClient, wrapper } = setup()
    const { result } = renderHook(() => useUpdateMeProfile(), { wrapper })

    await act(async () => {
      await expect(result.current.mutateAsync({ cpf: "52998224725" })).rejects.toThrow()
    })

    expect(queryClient.getQueryData<MeProfile>(profileKeys.profile)?.name).toBe("Carla Motorista")
    expect(useAuthStore.getState().user?.name).toBe("Carla Motorista")
  })

  it("depois de reset(), o corpo (CPF) não sobrevive no MutationCache", async () => {
    updateProfile.mockResolvedValueOnce(profile)
    const { queryClient, wrapper } = setup()
    const { result } = renderHook(() => useUpdateMeProfile(), { wrapper })
    await act(async () => {
      await result.current.mutateAsync({ cpf: "52998224725" })
    })
    await act(async () => {
      result.current.reset()
    })
    await waitFor(() => expect(queryClient.getMutationCache().getAll()).toHaveLength(0))
    expect(JSON.stringify(queryClient.getMutationCache().getAll().map((m) => m.state.variables))).not.toContain("52998224725")
  })
})

describe("useChangePassword", () => {
  it("SUBSTITUI o token (store E localStorage) pelo devolvido - o antigo foi revogado no servidor - e marca hasPassword no perfil", async () => {
    changePassword.mockResolvedValueOnce({ token: "token-novo", user: { ...user, hasPassword: true } })
    const { queryClient, wrapper } = setup()
    const { result } = renderHook(() => useChangePassword(), { wrapper })

    await act(async () => {
      await result.current.mutateAsync({ newPassword: "uma-senha-nova-123" })
    })

    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBe("token-novo")
    expect(useAuthStore.getState().token).toBe("token-novo")
    expect(useAuthStore.getState().isAuthenticated).toBe(true)
    expect(useAuthStore.getState().user?.hasPassword).toBe(true)
    expect(queryClient.getQueryData<MeProfile>(profileKeys.profile)?.hasPassword).toBe(true)
  })

  it("erro (senha atual errada): mantém token e sessão; nada de logout", async () => {
    changePassword.mockRejectedValueOnce(new Error("403"))
    const { wrapper } = setup()
    const { result } = renderHook(() => useChangePassword(), { wrapper })

    await act(async () => {
      await expect(result.current.mutateAsync({ currentPassword: "errada", newPassword: "uma-senha-nova-123" })).rejects.toThrow()
    })

    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBe("token-velho")
    expect(useAuthStore.getState().isAuthenticated).toBe(true)
  })

  it("depois de reset(), nem a senha atual nem a nova ficam no MutationCache", async () => {
    changePassword.mockResolvedValueOnce({ token: "token-novo", user })
    const { queryClient, wrapper } = setup()
    const { result } = renderHook(() => useChangePassword(), { wrapper })
    await act(async () => {
      await result.current.mutateAsync({ currentPassword: "SENHA-ATUAL-SECRETA", newPassword: "SENHA-NOVA-SECRETA" })
    })
    await act(async () => {
      result.current.reset()
    })
    await waitFor(() => expect(queryClient.getMutationCache().getAll()).toHaveLength(0))
    const memory = JSON.stringify(queryClient.getMutationCache().getAll().map((m) => ({ v: m.state.variables, e: String(m.state.error ?? "") })))
    expect(memory).not.toContain("SECRETA")
  })
})
