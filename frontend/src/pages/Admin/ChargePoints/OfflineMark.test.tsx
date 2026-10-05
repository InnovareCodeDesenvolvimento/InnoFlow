import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import { OfflineMark } from "./OfflineMark"

describe("OfflineMark — rótulo 'Offline' da lista de carregadores", () => {
  it("aparece SÓ com online === false e cadastro ativo", () => {
    render(<OfflineMark online={false} active />)
    expect(screen.getByTestId("cp-offline")).toHaveTextContent("Offline")
  })

  it("online: nada", () => {
    const { container } = render(<OfflineMark online active />)
    expect(container).toBeEmptyDOMElement()
  })

  it("inativo (mesmo offline): nada — já está fora de operação por decisão do admin", () => {
    const { container } = render(<OfflineMark online={false} active={false} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("não depende só de cor: tem o TEXTO 'Offline' (o ponto é decorativo, aria-hidden)", () => {
    const { container } = render(<OfflineMark online={false} active />)
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull()
    expect(screen.getByTestId("cp-offline").textContent).toBe("Offline")
  })
})
