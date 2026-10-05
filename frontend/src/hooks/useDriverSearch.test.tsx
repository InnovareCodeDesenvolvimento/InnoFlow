import { type ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { DRIVER_SEARCH_DEBOUNCE_MS, OPERATOR_MIN_SEARCH, useDriverSearch } from "./useDriverSearch"

const list = vi.fn()
vi.mock("@/services/drivers", () => ({ driversService: { list: (...a: unknown[]) => list(...a) } }))

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  list.mockReset()
  list.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 5 })
})
afterEach(() => {
  vi.useRealTimers()
})

const type = async (result: { current: ReturnType<typeof useDriverSearch> }, value: string) => {
  act(() => result.current.setSearchInput(value))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(DRIVER_SEARCH_DEBOUNCE_MS + 10)
  })
}

describe("useDriverSearch — a regra ÚNICA de busca de motorista do Admin", () => {
  it("OPERATOR: não consulta nada até ter 3 caracteres (não baixa a base inteira)", async () => {
    const { result } = renderHook(() => useDriverSearch({ isAdmin: false, pageSize: 5 }), { wrapper })
    expect(result.current.needsMoreChars).toBe(true)
    expect(result.current.minChars).toBe(OPERATOR_MIN_SEARCH)
    await type(result, "ca")
    expect(result.current.needsMoreChars).toBe(true)
    expect(list).not.toHaveBeenCalled()
    await type(result, "car")
    expect(result.current.needsMoreChars).toBe(false)
    expect(list).toHaveBeenCalledWith({ search: "car", page: 1, pageSize: 5 })
  })

  it("ADMIN (padrão da tela Carteiras): consulta sem digitar nada", async () => {
    renderHook(() => useDriverSearch({ isAdmin: true, pageSize: 20 }), { wrapper })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })
    expect(list).toHaveBeenCalledWith({ search: undefined, page: 1, pageSize: 20 })
  })

  it("minChars sobrescreve por tela: o diálogo de recarga exige ≥ 1 caractere também do ADMIN", async () => {
    const { result } = renderHook(() => useDriverSearch({ isAdmin: true, pageSize: 5, minChars: 1 }), { wrapper })
    expect(result.current.needsMoreChars).toBe(true)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })
    expect(list).not.toHaveBeenCalled()
    await type(result, "  c  ")
    expect(result.current.needsMoreChars).toBe(false)
    expect(list).toHaveBeenCalledWith({ search: "c", page: 1, pageSize: 5 }) // aparado
  })

  it("debounce: digitar rápido não dispara uma chamada por tecla", async () => {
    const { result } = renderHook(() => useDriverSearch({ isAdmin: true, pageSize: 5, minChars: 1 }), { wrapper })
    for (const v of ["c", "ca", "car", "carl"]) {
      act(() => result.current.setSearchInput(v))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100)
      })
    }
    expect(list).not.toHaveBeenCalled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRIVER_SEARCH_DEBOUNCE_MS)
    })
    expect(list).toHaveBeenCalledTimes(1)
    expect(list).toHaveBeenCalledWith({ search: "carl", page: 1, pageSize: 5 })
  })
})
