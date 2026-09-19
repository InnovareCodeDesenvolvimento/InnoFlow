import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { LocationPrompt } from "./LocationPrompt"

describe("LocationPrompt — estados da geolocalização em PT-BR", () => {
  it("idle: convite com botão 'Usar minha localização' (o pedido só acontece no clique) e aviso de privacidade", async () => {
    const onRequest = vi.fn()
    render(<LocationPrompt status="idle" hasPosition={false} onRequest={onRequest} />)
    expect(onRequest).not.toHaveBeenCalled()
    expect(screen.getByText(/fica só neste aparelho/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Usar minha localização" }))
    expect(onRequest).toHaveBeenCalledTimes(1)
  })

  it("pedindo: status acessível, sem botão", () => {
    render(<LocationPrompt status="requesting" hasPosition={false} onRequest={vi.fn()} />)
    expect(screen.getByRole("status")).toHaveTextContent("Obtendo sua localização")
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })

  it("negada: mensagem clara + aponta o fallback de busca; nunca bloqueia", () => {
    render(<LocationPrompt status="denied" hasPosition={false} onRequest={vi.fn()} />)
    expect(screen.getByRole("alert")).toHaveTextContent("Localização bloqueada")
    expect(screen.getByRole("alert")).toHaveTextContent("busque por cidade ou endereço")
  })

  it("timeout: cita os 10 s e oferece tentar de novo", async () => {
    const onRequest = vi.fn()
    render(<LocationPrompt status="timeout" hasPosition={false} onRequest={onRequest} />)
    expect(screen.getByRole("alert")).toHaveTextContent("10 segundos")
    await userEvent.click(screen.getByRole("button", { name: /Tentar de novo/ }))
    expect(onRequest).toHaveBeenCalled()
  })

  it("indisponível: mensagem e SEM botão de tentar (não adianta)", () => {
    render(<LocationPrompt status="unavailable" hasPosition={false} onRequest={vi.fn()} />)
    expect(screen.getByRole("alert")).toHaveTextContent("Localização indisponível")
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })

  it("concedida: some (não ocupa tela) — em modo compacto vira uma linha com 'Atualizar'", () => {
    const { container, rerender } = render(<LocationPrompt status="granted" hasPosition onRequest={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
    rerender(<LocationPrompt status="granted" hasPosition compact onRequest={vi.fn()} />)
    expect(screen.getByText("Usando sua localização")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Atualizar" })).toBeInTheDocument()
  })
})
