import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { makeSite } from "@/test/siteFixtures"
import { PublicSiteCard } from "./PublicSiteCard"

describe("PublicSiteCard", () => {
  it("mostra estado, '3 de 4 conectores livres', distância pt-BR e chips com livres/total", () => {
    const site = makeSite({ name: "Shopping Paulista" }, [
      { connectors: [{ type: "DC_CCS2", maxPowerKw: 60 }, { type: "DC_CCS2", maxPowerKw: 60 }, { type: "AC_TYPE2", maxPowerKw: 22 }, { type: "AC_TYPE2", maxPowerKw: 22, status: "CHARGING" }] },
    ])
    render(<PublicSiteCard site={site} distanceKm={1.234} />)
    expect(screen.getByText("Livre agora")).toBeInTheDocument()
    expect(screen.getByText("3 de 4 conectores livres")).toBeInTheDocument()
    expect(screen.getByText("1,2 km")).toBeInTheDocument()
    expect(screen.getByText("DC CCS2 60 kW · 2/2")).toBeInTheDocument()
    expect(screen.getByText("AC Tipo 2 22 kW · 1/2")).toBeInTheDocument()
  })

  it("carregador OFFLINE com conector AVAILABLE aparece como 'Fora do ar' e 0 livres (não 'Disponível')", () => {
    const site = makeSite({}, [{ online: false, connectors: [{ status: "AVAILABLE" }, { status: "AVAILABLE" }] }])
    render(<PublicSiteCard site={site} />)
    expect(screen.getByText("Fora do ar")).toBeInTheDocument()
    expect(screen.getByText("0 de 2 conectores livres")).toBeInTheDocument()
    expect(screen.queryByText("Livre agora")).not.toBeInTheDocument()
  })

  it("tudo ocupado", () => {
    render(<PublicSiteCard site={makeSite({}, [{ connectors: [{ status: "CHARGING" }] }])} />)
    expect(screen.getByText("Tudo ocupado")).toBeInTheDocument()
  })

  it("ação primária é 'Como chegar' (deep link do Google Maps) — e NÃO existe 'Iniciar recarga'", () => {
    render(<PublicSiteCard site={makeSite({ latitude: -23.5614, longitude: -46.6559 })} onSelect={() => {}} />)
    const link = screen.getByRole("link", { name: /Como chegar/ })
    expect(link).toHaveAttribute("href", "https://www.google.com/maps/dir/?api=1&destination=-23.5614,-46.6559")
    expect(link).toHaveAttribute("target", "_blank")
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"))
    expect(screen.queryByText(/iniciar recarga/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/estará livre/i)).not.toBeInTheDocument()
  })

  it("com onSelect a área de informação é um botão que abre o detalhe; o link fica fora dele", async () => {
    const onSelect = vi.fn()
    render(<PublicSiteCard site={makeSite({ name: "Osasco Plaza" })} onSelect={onSelect} />)
    const button = screen.getByRole("button", { name: /Osasco Plaza: ver detalhes/ })
    await userEvent.click(button)
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(button.querySelector("a")).toBeNull() // link dentro de botão seria HTML inválido
  })
})
