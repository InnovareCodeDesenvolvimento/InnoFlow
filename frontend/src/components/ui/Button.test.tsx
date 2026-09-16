import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Button } from "./Button"

describe("Button", () => {
  it("renderiza o texto e responde a clique", async () => {
    const onClick = vi.fn()
    render(<Button onClick={onClick}>Salvar</Button>)
    await userEvent.click(screen.getByRole("button", { name: "Salvar" }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it("fica desabilitado e com aria-busy quando `loading`", () => {
    render(<Button loading>Salvar</Button>)
    const button = screen.getByRole("button", { name: "Salvar" })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute("aria-busy", "true")
  })
})
