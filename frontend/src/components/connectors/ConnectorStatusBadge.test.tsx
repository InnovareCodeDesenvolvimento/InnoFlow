import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import { ConnectorStatusBadge } from "./ConnectorStatusBadge"

describe("ConnectorStatusBadge", () => {
  it("traduz o status para português", () => {
    render(<ConnectorStatusBadge status="AVAILABLE" />)
    expect(screen.getByText("Disponível")).toBeInTheDocument()
  })

  it("traduz um status com falha", () => {
    render(<ConnectorStatusBadge status="FAULTED" />)
    expect(screen.getByText("Com falha")).toBeInTheDocument()
  })
})
