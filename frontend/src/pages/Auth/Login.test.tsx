import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { Login } from "./Login"
import { Register } from "./Register"
import { RequireAuth } from "@/components/layout/RequireAuth"
import { RETURN_TO_STORAGE_KEY, RETURN_TO_TTL_MS } from "@/lib/authRedirect"
import { useAuthStore } from "@/store/authStore"
import type { Role, User } from "@/types/api"

/**
 * Destino de retorno SEM `?redirect=` (sessionStorage): rota protegida -> /login limpo -> entra -> volta. Também os links antigos (`/login?redirect=`), valor hostil,
 * validade de 30 min e sessionStorage bloqueado. O fluxo do QR (`/c/CP-01/1`) usa a mesma rota guardada; o E2E (`e2e/login-redirect-limpo.spec.ts`) o prova no navegador.
 */

const userOf = (role: Role): User => ({ id: "u1", name: "Ana", email: "ana@example.com", role, operatorId: null, operatorName: null }) as User

vi.mock("@/components/auth/GoogleAuthSection", () => ({
  GoogleAuthSection: ({ onSuccess }: { onSuccess: (user: User) => void }) => (
    <button
      type="button"
      onClick={() => {
        const u = { id: "u1", name: "Ana", email: "ana@example.com", role: "DRIVER", operatorId: null, operatorName: null } as User
        useAuthStore.setState({ user: u, token: "tok", isAuthenticated: true })
        onSuccess(u)
      }}
    >
      Google de mentira
    </button>
  ),
}))
vi.mock("@/hooks/useLegal", () => ({ usePublicLegal: () => ({ data: { termsVersion: "v1" }, isError: false, isFetching: false, refetch: vi.fn() }) }))

/** Mostra pathname+search ATUAIS: a barra de endereço do teste. */
function Where() {
  const l = useLocation()
  return <output data-testid="where">{`${l.pathname}${l.search}`}</output>
}

function renderApp(initial: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initial]}>
        <Where />
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/cadastro" element={<Register />} />
          <Route
            path="/admin/dashboard"
            element={
              <RequireAuth roles={["ADMIN"]}>
                <p>Painel</p>
              </RequireAuth>
            }
          />
          <Route
            path="/c/:ocpp/:conn"
            element={
              <RequireAuth>
                <p>Carregador</p>
              </RequireAuth>
            }
          />
          <Route path="/app" element={<p>Casa do motorista</p>} />
          <Route path="/admin" element={<p>Casa do admin</p>} />
          <Route path="/app/carteira" element={<p>Carteira</p>} />
          <Route path="/" element={<p>Home pública</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const where = () => screen.getByTestId("where").textContent

async function entrar(role: Role) {
  // O `login` de verdade grava a sessão; sem isso a rota protegida mandaria a pessoa de volta ao /login.
  const login = vi.fn().mockImplementation(async () => {
    const u = userOf(role)
    useAuthStore.setState({ user: u, token: "tok", isAuthenticated: true })
    return u
  })
  useAuthStore.setState({ login })
  const user = userEvent.setup()
  await user.type(screen.getByLabelText(/^E-mail/), "ana@example.com")
  await user.type(screen.getByLabelText(/^Senha/), "senha-correta-123")
  await user.click(screen.getByRole("button", { name: "Entrar" }))
}

beforeEach(() => sessionStorage.clear())
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  sessionStorage.clear()
  useAuthStore.setState({ user: null, token: null, isAuthenticated: false })
})

describe("login sem ?redirect=", () => {
  it("(a) rota protegida sem sessão: a URL final é exatamente /login e, depois de entrar, volta para a rota original", async () => {
    renderApp("/admin/dashboard")
    await screen.findByRole("heading", { name: "Bem-vindo de volta" })
    expect(where()).toBe("/login") // sem querystring
    await entrar("ADMIN")
    await waitFor(() => expect(where()).toBe("/admin/dashboard"))
    expect(sessionStorage.getItem(RETURN_TO_STORAGE_KEY)).toBeNull() // uso único
  })

  it("(b) fluxo do QR: /c/CP-01/1 deslogado -> /login limpo -> entra -> volta para /c/CP-01/1", async () => {
    renderApp("/c/CP-01/1")
    await screen.findByRole("heading", { name: "Bem-vindo de volta" })
    expect(where()).toBe("/login")
    await entrar("DRIVER")
    await waitFor(() => expect(where()).toBe("/c/CP-01/1"))
  })

  it("o login com Google devolve ao mesmo destino guardado", async () => {
    renderApp("/c/CP-01/1")
    await screen.findByRole("heading", { name: "Bem-vindo de volta" })
    await userEvent.setup().click(screen.getByRole("button", { name: "Google de mentira" }))
    await waitFor(() => expect(where()).toBe("/c/CP-01/1"))
  })

  it("o destino sobrevive à passagem Login -> Cadastro e os links não carregam querystring", async () => {
    renderApp("/c/CP-01/1")
    const link = await screen.findByRole("link", { name: "Cadastre-se" })
    expect(link).toHaveAttribute("href", "/cadastro")
    await userEvent.setup().click(link)
    await screen.findByRole("heading", { name: "Criar conta" })
    expect(where()).toBe("/cadastro")
    expect(screen.getByRole("link", { name: "Entrar" })).toHaveAttribute("href", "/login")
    await userEvent.setup().click(screen.getByRole("button", { name: "Google de mentira" }))
    await waitFor(() => expect(where()).toBe("/c/CP-01/1"))
  })

  it("sem destino guardado: cada papel vai para a própria casa (ADMIN -> /admin, DRIVER -> /app)", async () => {
    const a = renderApp("/login")
    await entrar("ADMIN")
    await waitFor(() => expect(where()).toBe("/admin"))
    a.unmount()
    renderApp("/login")
    await entrar("DRIVER")
    await waitFor(() => expect(where()).toBe("/app"))
  })

  it("(c) link antigo /login?redirect=/x é aceito UMA vez, some da barra e o destino vale depois do login", async () => {
    renderApp("/login?redirect=%2Fapp%2Fcarteira")
    await waitFor(() => expect(where()).toBe("/login"))
    expect(JSON.parse(sessionStorage.getItem(RETURN_TO_STORAGE_KEY) as string).path).toBe("/app/carteira")
    await entrar("DRIVER")
    await waitFor(() => expect(where()).toBe("/app/carteira"))
  })

  it("(c) link antigo /cadastro?redirect=/x também é absorvido e removido da barra", async () => {
    renderApp(`/cadastro?redirect=${encodeURIComponent("/c/CP-01/1")}`)
    await waitFor(() => expect(where()).toBe("/cadastro"))
    await userEvent.setup().click(screen.getByRole("button", { name: "Google de mentira" }))
    await waitFor(() => expect(where()).toBe("/c/CP-01/1"))
  })

  it.each([["//evil.example"], ["https://evil.example"], ["/\\evil.example"], ["/a\tb"], ["evil"]])(
    "(d) valor hostil %j é descartado: a barra fica limpa e o login cai na casa do papel",
    async (hostil) => {
      renderApp(`/login?redirect=${encodeURIComponent(hostil)}`)
      await waitFor(() => expect(where()).toBe("/login"))
      expect(sessionStorage.getItem(RETURN_TO_STORAGE_KEY)).toBeNull()
      await entrar("DRIVER")
      await waitFor(() => expect(where()).toBe("/app"))
    },
  )

  it("(e) destino expirado (mais de 30 min) é ignorado: cai na casa do papel", async () => {
    sessionStorage.setItem(RETURN_TO_STORAGE_KEY, JSON.stringify({ path: "/app/carteira", at: Date.now() - RETURN_TO_TTL_MS - 1000 }))
    renderApp("/login")
    await entrar("DRIVER")
    await waitFor(() => expect(where()).toBe("/app"))
    expect(sessionStorage.getItem(RETURN_TO_STORAGE_KEY)).toBeNull()
  })

  it("(f) sessionStorage indisponível: a rota protegida ainda leva ao /login limpo e o login funciona (casa do papel)", async () => {
    // Só o sessionStorage falha (o `persist` do zustand usa o localStorage, que precisa seguir funcionando).
    const setItem = Storage.prototype.setItem
    const getItem = Storage.prototype.getItem
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, chave: string, valor: string) {
      if (this === window.sessionStorage) throw new DOMException("bloqueado", "SecurityError")
      return setItem.call(this, chave, valor)
    })
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, chave: string) {
      if (this === window.sessionStorage) throw new DOMException("bloqueado", "SecurityError")
      return getItem.call(this, chave)
    })
    renderApp("/admin/dashboard")
    await screen.findByRole("heading", { name: "Bem-vindo de volta" })
    expect(where()).toBe("/login")
    await entrar("ADMIN")
    await waitFor(() => expect(where()).toBe("/admin"))
  })
})
