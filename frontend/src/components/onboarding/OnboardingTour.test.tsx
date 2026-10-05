import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getAdminNav } from "@/components/admin/adminNav"
import { AUTOSTART_DELAY_MS, TourProvider } from "./TourProvider"
import { ONBOARDING_OFF_KEY, readTourRecord, tourStorageKey, writeTourRecord } from "./onboardingStorage"
import { useTour } from "./tourContext"

/** jsdom não tem layout nem ResizeObserver: o tour só precisa que os dois existam para medir (valores 0 → alvo "oculto" → fallback centralizado, que é o que se quer provar). */
class FakeResizeObserver {
  constructor(private cb: () => void) {}
  observe() {
    this.cb()
  }
  unobserve() {}
  disconnect() {}
}

function Opener() {
  const tour = useTour()
  return (
    <button type="button" onClick={tour.restart} data-testid="opener">
      Rever tour
    </button>
  )
}

function renderTour(opts: { role?: "DRIVER" | "ADMIN" | "OPERATOR"; userId?: string | undefined } = {}) {
  const role = opts.role ?? "DRIVER"
  const userId = "userId" in opts ? opts.userId : "u1"
  return render(
    <div id="root">
      <TourProvider userId={userId} role={role} nav={role === "DRIVER" ? undefined : getAdminNav(role)}>
        <Opener />
        <a href="#alvo" data-tour="app-nav-mapa">
          Mapa
        </a>
      </TourProvider>
    </div>,
  )
}

const dialog = () => screen.queryByRole("dialog", { name: /tour do aplicativo/i })

async function autostart() {
  await act(async () => {
    vi.advanceTimersByTime(AUTOSTART_DELAY_MS + 50)
  })
  // o chunk do overlay é um import() dinâmico (lazy)
  await waitFor(() => expect(dialog()).not.toBeNull(), { timeout: 3000 })
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.stubGlobal("ResizeObserver", FakeResizeObserver)
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("abertura automática", () => {
  it("1ª visita (sem registro): abre sozinho, depois da pausa que deixa a página assentar", async () => {
    renderTour()
    expect(dialog()).toBeNull()
    await autostart()
    expect(screen.getByText("Bem-vindo à InnoFlow!")).toBeInTheDocument()
  })

  it("quem já concluiu a versão atual NÃO vê o tour de novo", async () => {
    writeTourRecord("u1", "driver", { version: 1, status: "completed", at: "2026-10-05T00:00:00.000Z" })
    renderTour()
    await act(async () => {
      vi.advanceTimersByTime(AUTOSTART_DELAY_MS + 500)
    })
    expect(dialog()).toBeNull()
  })

  it("quem PULOU também não", async () => {
    writeTourRecord("u1", "driver", { version: 1, status: "skipped", at: "2026-10-05T00:00:00.000Z" })
    renderTour()
    await act(async () => {
      vi.advanceTimersByTime(AUTOSTART_DELAY_MS + 500)
    })
    expect(dialog()).toBeNull()
  })

  it("roteiro de versão maior que a do registro: reexibe", async () => {
    writeTourRecord("u1", "driver", { version: 0, status: "completed", at: "2025-01-01T00:00:00.000Z" })
    renderTour()
    await autostart()
  })

  it("é por usuário: o registro de OUTRO usuário no mesmo aparelho não vale", async () => {
    writeTourRecord("outro", "driver", { version: 1, status: "completed", at: "2026-10-05T00:00:00.000Z" })
    renderTour()
    await autostart()
  })

  it("interruptor do aparelho ligado: não abre sozinho (mas 'Rever tour' continua abrindo)", async () => {
    window.localStorage.setItem(ONBOARDING_OFF_KEY, "1")
    renderTour()
    await act(async () => {
      vi.advanceTimersByTime(AUTOSTART_DELAY_MS + 500)
    })
    expect(dialog()).toBeNull()
    fireEvent.click(screen.getByTestId("opener"))
    await waitFor(() => expect(dialog()).not.toBeNull(), { timeout: 3000 })
  })

  it("sem usuário (ninguém logado): não há tour", async () => {
    renderTour({ userId: undefined })
    await act(async () => {
      vi.advanceTimersByTime(AUTOSTART_DELAY_MS + 500)
    })
    expect(dialog()).toBeNull()
  })

  it("armazenamento bloqueado: não derruba e não abre sozinho", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("bloqueado", "SecurityError")
    })
    renderTour()
    await act(async () => {
      vi.advanceTimersByTime(AUTOSTART_DELAY_MS + 500)
    })
    expect(dialog()).toBeNull()
    vi.restoreAllMocks()
  })
})

describe("fallback: alvo ausente ou oculto", () => {
  it("o balão fica centralizado (nunca erro) e o passo continua legível", async () => {
    renderTour()
    await autostart()
    fireEvent.click(screen.getByRole("button", { name: /vamos lá/i }))
    // passo "Mapa": o link existe no DOM mas jsdom o mede com 0 x 0 (= oculto): sem destaque, balão no centro
    await waitFor(() => expect(screen.getByText("Eletropostos perto de você")).toBeInTheDocument())
    expect(screen.getByRole("dialog").getAttribute("data-layout")).toBe("center")
    expect(document.querySelector("[data-tour-spot]")).toBeNull()
  })
})

describe("teclado, foco e saída", () => {
  it("setas navegam; Esc pula e GRAVA o registro como 'skipped'", async () => {
    renderTour()
    await autostart()
    expect(screen.getByText("Passo 1 de 8")).toBeInTheDocument()
    fireEvent.keyDown(window, { key: "ArrowRight" })
    await waitFor(() => expect(screen.getByText("Passo 2 de 8")).toBeInTheDocument())
    fireEvent.keyDown(window, { key: "ArrowLeft" })
    await waitFor(() => expect(screen.getByText("Passo 1 de 8")).toBeInTheDocument())
    fireEvent.keyDown(window, { key: "Escape" })
    await waitFor(() => expect(dialog()).toBeNull())
    const read = readTourRecord("u1", "driver")
    expect(read.kind === "record" && read.record.status).toBe("skipped")
  })

  it("percorrer até o fim e 'Concluir' grava 'completed' com a versão do roteiro", async () => {
    renderTour()
    await autostart()
    for (let i = 0; i < 7; i++) fireEvent.click(screen.getByRole("button", { name: /vamos lá|próximo/i }))
    await waitFor(() => expect(screen.getByText("Passo 8 de 8")).toBeInTheDocument())
    expect(screen.queryByRole("button", { name: /pular tour/i })).toBeNull() // no último passo só resta concluir
    fireEvent.click(screen.getByRole("button", { name: /concluir/i }))
    await waitFor(() => expect(dialog()).toBeNull())
    const read = readTourRecord("u1", "driver")
    expect(read).toMatchObject({ kind: "record", record: { version: 1, status: "completed" } })
    expect(window.localStorage.getItem(tourStorageKey("u1", "driver"))).toContain('"completed"')
  })

  it("Voltar não existe no 1º passo; 'Pular tour' fecha e grava", async () => {
    renderTour()
    await autostart()
    expect(screen.queryByRole("button", { name: /voltar/i })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: /pular tour/i }))
    await waitFor(() => expect(dialog()).toBeNull())
    expect(readTourRecord("u1", "driver").kind).toBe("record")
  })

  it("o resto do app fica inerte enquanto o tour está aberto e volta ao fechar", async () => {
    renderTour()
    await autostart()
    expect(document.getElementById("root")?.hasAttribute("inert")).toBe(true)
    fireEvent.keyDown(window, { key: "Escape" })
    await waitFor(() => expect(dialog()).toBeNull())
    expect(document.getElementById("root")?.hasAttribute("inert")).toBe(false)
  })

  it("foco: entra no botão principal e, ao fechar, volta a quem o tinha ('Rever tour')", async () => {
    renderTour()
    const opener = screen.getByTestId("opener")
    opener.focus()
    fireEvent.click(opener)
    await waitFor(() => expect(dialog()).not.toBeNull(), { timeout: 3000 })
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: /vamos lá/i })))
    fireEvent.keyDown(window, { key: "Escape" })
    await waitFor(() => expect(dialog()).toBeNull())
    expect(document.activeElement).toBe(opener)
  })

  it("Tab fica preso no balão (dá a volta nas pontas)", async () => {
    renderTour()
    await autostart()
    const next = screen.getByRole("button", { name: /vamos lá/i })
    await waitFor(() => expect(document.activeElement).toBe(next))
    const buttons = screen.getByRole("dialog").querySelectorAll("button")
    const last = buttons[buttons.length - 1]
    expect(last).toBe(next) // o primário é o último focável: Tab dá a volta para o primeiro
    fireEvent.keyDown(window, { key: "Tab" })
    expect(document.activeElement).toBe(buttons[0])
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true })
    expect(document.activeElement).toBe(next)
  })

  it("anuncia o passo por leitor de tela: região aria-live, diálogo modal nomeado e progresso", async () => {
    renderTour()
    await autostart()
    const d = screen.getByRole("dialog")
    expect(d).toHaveAttribute("aria-modal", "true")
    expect(d.querySelector("[aria-live='polite']")).not.toBeNull()
    expect(screen.getByRole("progressbar", { name: /progresso do tour/i })).toHaveAttribute("aria-valuetext", "Passo 1 de 8")
    // o mascote é decorativo: nada dele entra na árvore de acessibilidade
    expect(d.querySelector(".tm")?.getAttribute("aria-hidden")).toBe("true")
  })
})

describe("papéis", () => {
  it("OPERATOR: tour próprio (não o do ADMIN) e sem passos só-ADMIN", async () => {
    renderTour({ role: "OPERATOR" })
    await act(async () => {
      vi.advanceTimersByTime(AUTOSTART_DELAY_MS + 50)
    })
    await waitFor(() => expect(screen.getByRole("dialog", { name: /operador/i })).toBeInTheDocument(), { timeout: 3000 })
    expect(window.localStorage.getItem(tourStorageKey("u1", "operator"))).toBeNull()
  })
})
