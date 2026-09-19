import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { GoogleAuthSection } from "./GoogleAuthSection"

const usePublicConfigMock = vi.fn()
vi.mock("@/hooks/usePublicConfig", () => ({ usePublicConfig: () => usePublicConfigMock() }))

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
})
