import { afterEach, describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { RequireAuth } from "./RequireAuth"
import { useAuthStore } from "@/store/authStore"

function renderWithAuth(initialPath = "/admin") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/login" element={<p>Tela de login</p>} />
        <Route
          path="/admin"
          element={
            <RequireAuth roles={["ADMIN", "OPERATOR"]}>
              <p>Conteúdo do painel</p>
            </RequireAuth>
          }
        />
      </Routes>
    </MemoryRouter>,
  )
}

describe("RequireAuth", () => {
  afterEach(() => {
    useAuthStore.setState({ user: null, token: null, isAuthenticated: false })
  })

  it("manda para o login quando não autenticado", () => {
    renderWithAuth()
    expect(screen.getByText("Tela de login")).toBeInTheDocument()
  })

  it("mostra acesso restrito quando o papel não bate", () => {
    useAuthStore.setState({
      user: { id: "1", name: "Ana", email: "ana@ex.com", role: "DRIVER", operatorId: null, operatorName: null },
      token: "tok",
      isAuthenticated: true,
    })
    renderWithAuth()
    expect(screen.getByText("Acesso restrito")).toBeInTheDocument()
  })

  it("libera o conteúdo quando autenticado com o papel certo", () => {
    useAuthStore.setState({
      user: { id: "1", name: "Ana", email: "ana@ex.com", role: "ADMIN", operatorId: null, operatorName: null },
      token: "tok",
      isAuthenticated: true,
    })
    renderWithAuth()
    expect(screen.getByText("Conteúdo do painel")).toBeInTheDocument()
  })
})
