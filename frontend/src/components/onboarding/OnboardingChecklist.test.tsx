import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { deriveChecklist } from "./checklistLogic"
import { ONBOARDING_OFF_KEY, isChecklistDismissed } from "./onboardingStorage"
import { OnboardingChecklist } from "./OnboardingChecklist"
import { useAdminChecklist } from "./useAdminChecklist"

vi.mock("./useAdminChecklist", () => ({ useAdminChecklist: vi.fn() }))

const ALL_DONE = { site: true, chargePoint: true, connector: true, tariff: true, assignment: true, gateway: true, communication: true }

function mockChecklist(facts: Parameters<typeof deriveChecklist>[0], loading = false) {
  vi.mocked(useAdminChecklist).mockReturnValue({ loading, view: deriveChecklist(facts) })
}

const renderCard = (userId = "u1") =>
  render(
    <MemoryRouter>
      <OnboardingChecklist userId={userId} />
    </MemoryRouter>,
  )

beforeEach(() => window.localStorage.clear())
afterEach(() => cleanup())

describe("OnboardingChecklist", () => {
  it("falta algo: mostra o progresso e leva cada item à tela certa", () => {
    mockChecklist({ ...ALL_DONE, gateway: false, communication: false })
    renderCard()
    expect(screen.getByRole("region", { name: "Primeiros passos" })).toBeInTheDocument()
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuetext", "5 de 7 passos")
    expect(screen.getByRole("link", { name: /configurar: configurar o gateway de pagamento/i })).toHaveAttribute("href", "/admin/gateway-pagamento")
    expect(screen.getByRole("link", { name: /configurar: configurar os avisos/i })).toHaveAttribute("href", "/admin/comunicacao")
    // itens feitos aparecem como feitos (texto para leitor de tela), sem botão de ação
    expect(screen.getByText(/cadastrar um site/i).textContent).toContain("Feito")
    expect(screen.queryByRole("link", { name: /cadastrar: cadastrar um site/i })).toBeNull()
  })

  it("tudo configurado: NADA na tela (sem ruído)", () => {
    mockChecklist(ALL_DONE)
    const { container } = renderCard()
    expect(screen.queryByRole("region")).toBeNull()
    expect(container.textContent).toBe("")
  })

  it("carregando: nada (não pisca nem empurra o Dashboard)", () => {
    mockChecklist({ site: false }, true)
    renderCard()
    expect(screen.queryByRole("region")).toBeNull()
  })

  it("dispensar: some na hora, persiste por usuário e anuncia para leitor de tela", () => {
    mockChecklist({ ...ALL_DONE, gateway: false })
    renderCard("u1")
    fireEvent.click(screen.getByRole("button", { name: /dispensar o checklist/i }))
    expect(screen.queryByRole("region")).toBeNull()
    expect(screen.getByRole("status")).toHaveTextContent(/checklist dispensado/i)
    expect(isChecklistDismissed("u1")).toBe(true)
    expect(isChecklistDismissed("u2")).toBe(false)
  })

  it("já dispensado neste aparelho: não aparece e NEM consulta a API", () => {
    window.localStorage.setItem("innoflow:checklist:v1:u1", "dismissed")
    mockChecklist({ ...ALL_DONE, gateway: false })
    vi.mocked(useAdminChecklist).mockClear()
    renderCard("u1")
    expect(screen.queryByRole("region")).toBeNull()
    expect(useAdminChecklist).not.toHaveBeenCalled()
  })

  it("interruptor do aparelho (harness/quiosque): não aparece e não consulta", () => {
    window.localStorage.setItem(ONBOARDING_OFF_KEY, "1")
    mockChecklist({ ...ALL_DONE, gateway: false })
    vi.mocked(useAdminChecklist).mockClear()
    renderCard()
    expect(screen.queryByRole("region")).toBeNull()
    expect(useAdminChecklist).not.toHaveBeenCalled()
  })

  it("sem usuário: nada", () => {
    mockChecklist({ ...ALL_DONE, gateway: false })
    render(
      <MemoryRouter>
        <OnboardingChecklist userId={undefined} />
      </MemoryRouter>,
    )
    expect(screen.queryByRole("region")).toBeNull()
  })
})
