import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import { HelloPage } from "./HelloPage"

describe("HelloPage", () => {
  it("renderiza o título InnoElektron", () => {
    render(<HelloPage />)
    expect(screen.getByRole("heading", { name: "InnoElektron" })).toBeInTheDocument()
  })
})
