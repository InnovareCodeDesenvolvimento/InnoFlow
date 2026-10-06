import { afterEach, describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { RequireAuth } from "./RequireAuth"
import { peekReturnTo } from "@/lib/authRedirect"
import { useAuthStore } from "@/store/authStore"

function LoginProbe() {
  const l = useLocation()
  return <p data-testid="login-url">{`Tela de login em ${l.pathname}${l.search}`}</p>
}

function renderWithAuth(initialPath = "/admin") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/login" element={<LoginProbe />} />
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
    expect(screen.getByText(/Tela de login/)).toBeInTheDocument()
  })

  it("vai para /login LIMPO (sem querystring) e guarda pathname + search para depois do login", () => {
    sessionStorage.clear()
    renderWithAuth("/admin?aba=geral")
    expect(screen.getByTestId("login-url")).toHaveTextContent("Tela de login em /login")
    expect(screen.getByTestId("login-url").textContent).not.toContain("?")
    expect(peekReturnTo()).toBe("/admin?aba=geral")
    sessionStorage.clear()
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
