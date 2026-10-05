import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { AxiosError, type AxiosResponse } from "axios"
import { useCommandPolling } from "./useRemoteStart"
import { COMMAND_POLL_INTERVAL_MS, COMMAND_POLL_TIMEOUT_MS } from "@/lib/remoteStart"

type Step = { status: string } | { http: number } | "network"
let script: Step[] = []
let calls = 0
const signals: AbortSignal[] = []

// Função comum (não `vi.fn`): uma rejeição legítima, tratada pelo hook, viraria "unhandled rejection" do rastreador de mocks.
vi.mock("@/services/adminCommands", () => ({
  adminCommandsService: {
    status: (_id: string, signal?: AbortSignal) => {
      calls += 1
      if (signal) signals.push(signal)
      const step = script[Math.min(calls - 1, script.length - 1)]
      if (step === "network") return Promise.reject(new AxiosError("Network Error"))
      if ("http" in step) {
        const err = new AxiosError("falhou")
        err.response = { status: step.http, data: { error: "x", code: "X" } } as AxiosResponse
        return Promise.reject(err)
      }
      return Promise.resolve(step)
    },
  },
}))

/** Deixa as promises pendentes resolverem e avança o relógio falso. */
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

beforeEach(() => {
  vi.useFakeTimers()
  script = []
  calls = 0
  signals.length = 0
})
afterEach(() => {
  vi.useRealTimers()
})

describe("useCommandPolling — a cada 2 s, por até 60 s", () => {
  it("sem correlationId: ocioso e nenhuma chamada", async () => {
    const { result } = renderHook(() => useCommandPolling(null))
    await advance(10_000)
    expect(result.current).toBe("IDLE")
    expect(calls).toBe(0)
  })

  it("consulta já ao começar e depois a cada 2 s; PENDING → PENDING → ACCEPTED para exatamente aí", async () => {
    script = [{ status: "PENDING" }, { status: "PENDING" }, { status: "ACCEPTED" }]
    const { result } = renderHook(() => useCommandPolling("c1"))
    await advance(0)
    expect(calls).toBe(1)
    expect(result.current).toBe("POLLING")
    await advance(COMMAND_POLL_INTERVAL_MS)
    expect(calls).toBe(2)
    expect(result.current).toBe("POLLING")
    await advance(COMMAND_POLL_INTERVAL_MS)
    expect(calls).toBe(3)
    expect(result.current).toBe("ACCEPTED")
    // desfecho = fim: nada mais é consultado
    await advance(30_000)
    expect(calls).toBe(3)
  })

  it.each([["REJECTED"], ["TIMEOUT"]])("desfecho %s do carregador é terminal", async (status) => {
    script = [{ status }]
    const { result } = renderHook(() => useCommandPolling("c1"))
    await advance(0)
    expect(result.current).toBe(status)
    await advance(10_000)
    expect(calls).toBe(1)
  })

  it("404 durante o acompanhamento = UNAVAILABLE ('resultado indisponível'), sem insistir", async () => {
    script = [{ status: "PENDING" }, { http: 404 }]
    const { result } = renderHook(() => useCommandPolling("c1"))
    await advance(COMMAND_POLL_INTERVAL_MS)
    expect(result.current).toBe("UNAVAILABLE")
    await advance(10_000)
    expect(calls).toBe(2)
  })

  it("403 vira ERROR na hora (não adianta insistir)", async () => {
    script = [{ http: 403 }]
    const { result } = renderHook(() => useCommandPolling("c1"))
    await advance(0)
    expect(result.current).toBe("ERROR")
    expect(calls).toBe(1)
  })

  it("passou de 60 s ainda PENDING = NO_ANSWER; foram ~31 consultas, nem uma a mais", async () => {
    script = [{ status: "PENDING" }]
    const { result } = renderHook(() => useCommandPolling("c1"))
    await advance(COMMAND_POLL_TIMEOUT_MS - 1)
    expect(result.current).toBe("POLLING")
    await advance(COMMAND_POLL_INTERVAL_MS)
    expect(result.current).toBe("NO_ANSWER")
    const total = calls
    expect(total).toBe(COMMAND_POLL_TIMEOUT_MS / COMMAND_POLL_INTERVAL_MS + 1)
    await advance(30_000)
    expect(calls).toBe(total)
  })

  it("uma falha de rede ISOLADA é tolerada; 3 seguidas viram ERROR", async () => {
    script = ["network", { status: "PENDING" }, "network", "network", "network"]
    const { result } = renderHook(() => useCommandPolling("c1"))
    await advance(0) // falha 1
    expect(result.current).toBe("POLLING")
    await advance(COMMAND_POLL_INTERVAL_MS) // PENDING zera a contagem
    await advance(COMMAND_POLL_INTERVAL_MS) // falha 1
    await advance(COMMAND_POLL_INTERVAL_MS) // falha 2
    expect(result.current).toBe("POLLING")
    await advance(COMMAND_POLL_INTERVAL_MS) // falha 3
    expect(result.current).toBe("ERROR")
  })

  it("5xx também conta como falha de conexão", async () => {
    script = [{ http: 500 }]
    const { result } = renderHook(() => useCommandPolling("c1"))
    await advance(COMMAND_POLL_INTERVAL_MS * 2)
    expect(result.current).toBe("ERROR")
    expect(calls).toBe(3)
  })

  it("DESMONTAR para o acompanhamento: nenhuma consulta depois, e o pedido em voo é abortado", async () => {
    script = [{ status: "PENDING" }]
    const { unmount } = renderHook(() => useCommandPolling("c1"))
    await advance(COMMAND_POLL_INTERVAL_MS)
    const before = calls
    expect(before).toBe(2)
    expect(signals.every((sg) => !sg.aborted)).toBe(true)
    unmount()
    expect(signals.every((sg) => sg.aborted)).toBe(true) // o pedido em voo é cancelado
    await advance(30_000)
    expect(calls).toBe(before)
  })

  it("zerar o id (fechar o diálogo) também para; trocar de id recomeça do POLLING e não mostra o desfecho do anterior", async () => {
    script = [{ status: "ACCEPTED" }]
    const { result, rerender } = renderHook(({ id }: { id: string | null }) => useCommandPolling(id), { initialProps: { id: "c1" as string | null } })
    await advance(0)
    expect(result.current).toBe("ACCEPTED")

    script = [{ status: "PENDING" }]
    rerender({ id: "c2" })
    expect(result.current).toBe("POLLING") // não herda o ACCEPTED do c1

    const before = calls
    rerender({ id: null })
    expect(result.current).toBe("IDLE")
    await advance(30_000)
    expect(calls).toBeLessThanOrEqual(before + 1) // no máximo a consulta que já estava saindo
  })
})
