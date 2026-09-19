import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { GoogleAuthSection } from "./GoogleAuthSection"

const usePublicConfigMock = vi.fn()
vi.mock("@/hooks/usePublicConfig", () => ({ usePublicConfig: () => usePublicConfigMock() }))

// O GIS REAL monta o botão (div + iframe) de forma SÍNCRONA dentro de
// `renderButton` — comportamento medido em produção (19/09/2026). O double
// anterior montava de forma assíncrona e escondeu uma corrida: o observer era
// ligado DEPOIS do render, nunca via a mutação, e o botão ficava invisível
// (opacity-0) sob o skeleton para sempre.
const renderGoogleButtonMock = vi.fn((host: HTMLElement) => {
  const wrapper = document.createElement("div")
  wrapper.appendChild(document.createElement("iframe"))
  host.appendChild(wrapper)
})
vi.mock("@/lib/googleIdentity", () => ({
  loadGoogleScript: () => Promise.resolve(),
  initGoogleIdentity: vi.fn(),
  releaseGoogleHandler: vi.fn(),
  renderGoogleButton: (host: HTMLElement) => renderGoogleButtonMock(host),
}))

describe("GoogleAuthSection — feature nasce desligada", () => {
  beforeEach(() => usePublicConfigMock.mockReset())

  it("sem Client ID (googleClientId: null): não renderiza botão NEM o divisor", () => {
    usePublicConfigMock.mockReturnValue({ data: { googleClientId: null }, isLoading: false })
    const { container } = render(<GoogleAuthSection onSuccess={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByText(/ou continue com e-mail/i)).not.toBeInTheDocument()
  })

  it("config que falhou (sem data, fora de loading): some em silêncio, sem erro na tela", () => {
    usePublicConfigMock.mockReturnValue({ data: undefined, isLoading: false, isError: true })
    const { container } = render(<GoogleAuthSection onSuccess={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("enquanto a config carrega: reserva o espaço (skeleton + divisor), marcado aria-busy", () => {
    usePublicConfigMock.mockReturnValue({ data: undefined, isLoading: true })
    const { container } = render(<GoogleAuthSection onSuccess={vi.fn()} />)
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull()
    expect(screen.getByText(/ou continue com e-mail/i)).toBeInTheDocument()
  })

  it("Google real monta o botão SÍNCRONO: sai do skeleton e fica visível (regressão de produção)", async () => {
    class ImmediateResizeObserver {
      constructor(private cb: (entries: { contentRect: { width: number } }[]) => void) {}
      observe() {
        this.cb([{ contentRect: { width: 300 } }])
      }
      disconnect() {}
      unobserve() {}
    }
    vi.stubGlobal("ResizeObserver", ImmediateResizeObserver)
    usePublicConfigMock.mockReturnValue({ data: { googleClientId: "id.apps.googleusercontent.com" }, isLoading: false })
    const { container } = render(<GoogleAuthSection onSuccess={vi.fn()} />)

    await waitFor(() => expect(container.querySelector('[aria-busy="false"]')).not.toBeNull())
    expect(container.querySelector("iframe")).not.toBeNull()
    // o host do botão não pode ficar invisível depois de montado
    expect(container.querySelector(".opacity-0")).toBeNull()
    vi.unstubAllGlobals()
  })
})
