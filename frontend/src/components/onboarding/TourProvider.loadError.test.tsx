import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AUTOSTART_DELAY_MS, TourProvider } from "./TourProvider"
import { useTour } from "./tourContext"

// O chunk do tour "não baixa" (aba velha depois de um deploy, rede caindo): o import() dinâmico rejeita.
vi.mock("./OnboardingTour", () => {
  throw new Error("Failed to fetch dynamically imported module")
})

function Probe() {
  const tour = useTour()
  return (
    <button type="button" onClick={tour.restart}>
      Rever tour ({tour.active ? "aberto" : "fechado"})
    </button>
  )
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  window.localStorage.clear()
  vi.spyOn(console, "error").mockImplementation(() => undefined) // o React loga o erro capturado pelo boundary
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("chunk do tour que falha ao carregar", () => {
  it("o app continua de pé: o tour não abre, nada vai para a tela de erro e o provider volta a 'fechado'", async () => {
    render(
      <TourProvider userId="u1" role="DRIVER">
        <p>conteúdo do app</p>
        <Probe />
      </TourProvider>,
    )
    await act(async () => {
      vi.advanceTimersByTime(AUTOSTART_DELAY_MS + 100) // 1ª visita: tentaria abrir sozinho
    })
    await waitFor(() => expect(screen.getByRole("button", { name: /rever tour \(fechado\)/i })).toBeInTheDocument(), { timeout: 3000 })
    expect(screen.getByText("conteúdo do app")).toBeInTheDocument()
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("e nada foi gravado: na próxima visita ele tenta de novo", async () => {
    render(
      <TourProvider userId="u1" role="DRIVER">
        <Probe />
      </TourProvider>,
    )
    await act(async () => {
      vi.advanceTimersByTime(AUTOSTART_DELAY_MS + 100)
    })
    await waitFor(() => expect(screen.getByRole("button", { name: /fechado/i })).toBeInTheDocument(), { timeout: 3000 })
    expect(Object.keys(window.localStorage).filter((k) => k.startsWith("innoflow:tour:"))).toEqual([])
  })
})
