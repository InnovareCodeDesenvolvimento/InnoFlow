import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { AxiosError, type AxiosResponse } from "axios"
import { ResetPassword } from "./ResetPassword"
import { PASSWORD_RESET_FLASH } from "@/lib/passwordReset"

const resetPassword = vi.fn()
vi.mock("@/services/auth", () => ({ authService: { resetPassword: (...a: unknown[]) => resetPassword(...a) } }))

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"
const SENHA = "uma senha nova bem longa"

const apiError = (status: number | null, code?: string, extra?: { headers?: Record<string, string>; details?: Array<{ path: string; message: string }> }) =>
  new AxiosError("falhou", undefined, undefined, undefined, status === null ? undefined : ({ status, data: { error: "texto do backend", code, details: extra?.details }, headers: extra?.headers ?? {} } as AxiosResponse))

function LoginProbe() {
  const location = useLocation()
  return <p data-testid="login">{JSON.stringify(location.state)}</p>
}

function renderPage(hash: string) {
  window.history.pushState(null, "", `/redefinir-senha${hash}`)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/redefinir-senha"]}>
        <Routes>
          <Route path="/redefinir-senha" element={<ResetPassword />} />
          <Route path="/login" element={<LoginProbe />} />
          <Route path="/esqueci-senha" element={<p>tela esqueci</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { ...utils, queryClient }
}

async function fill(user: ReturnType<typeof userEvent.setup>, password = SENHA, confirm = password) {
  await user.type(screen.getByLabelText(/^Nova senha/), password)
  await user.type(screen.getByLabelText(/^Repita a nova senha/), confirm)
}

beforeEach(() => {
  resetPassword.mockReset()
  localStorage.clear()
  sessionStorage.clear()
  document.head.querySelectorAll('meta[name="referrer"]').forEach((m) => m.remove())
})

describe("ResetPassword - leitura e limpeza do fragmento", () => {
  it("lê o token do fragmento, APAGA o fragmento da URL na hora e o manda no CORPO", async () => {
    const user = userEvent.setup()
    resetPassword.mockResolvedValueOnce(undefined)
    renderPage(`#t=${TOKEN}`)

    // Fragmento fora da barra de endereço assim que a tela montou - antes de qualquer envio.
    expect(window.location.hash).toBe("")
    expect(window.location.href).not.toContain(TOKEN)
    expect(screen.getByRole("heading", { level: 1, name: "Crie uma nova senha" })).toBeInTheDocument()

    await fill(user)
    await user.click(screen.getByRole("button", { name: "Redefinir senha" }))

    await waitFor(() => expect(resetPassword).toHaveBeenCalledTimes(1))
    expect(resetPassword).toHaveBeenCalledWith({ token: TOKEN, newPassword: SENHA })
  })

  it("nada vai para storage nem para atributos do DOM; a página liga `no-referrer` enquanto está montada e desliga ao sair", async () => {
    const { unmount, container } = renderPage(`#t=${TOKEN}`)
    expect(document.head.querySelector('meta[name="referrer"][content="no-referrer"]')).not.toBeNull()
    expect(JSON.stringify({ ...localStorage })).not.toContain(TOKEN)
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(TOKEN)
    expect(container.innerHTML).not.toContain(TOKEN)
    expect(container.querySelectorAll("a[href^='http']")).toHaveLength(0) // sem links para fora
    unmount()
    expect(document.head.querySelector('meta[name="referrer"]')).toBeNull()
  })

  it("sem token: estado 'link inválido' com botão para /esqueci-senha, sem formulário", async () => {
    const user = userEvent.setup()
    renderPage("")
    expect(screen.getByRole("heading", { level: 1, name: "Link inválido" })).toBeInTheDocument()
    expect(screen.getByText("Este link é inválido ou expirou. Peça um novo.")).toBeInTheDocument()
    expect(screen.queryByLabelText(/^Nova senha/)).not.toBeInTheDocument()
    await user.click(screen.getByRole("link", { name: "Pedir novo link" }))
    expect(screen.getByText("tela esqueci")).toBeInTheDocument()
    expect(resetPassword).not.toHaveBeenCalled()
  })

  it("token fora do formato (curto) também é 'link inválido' e NÃO chama a API", () => {
    renderPage("#t=curto")
    expect(screen.getByRole("heading", { level: 1, name: "Link inválido" })).toBeInTheDocument()
    expect(resetPassword).not.toHaveBeenCalled()
    expect(window.location.hash).toBe("") // o fragmento sai mesmo quando não serve
  })
})

describe("ResetPassword - validação do cliente espelha o servidor", () => {
  it("senha curta, longa demais em BYTES e confirmação diferente: erros nos campos e nenhuma chamada", async () => {
    const user = userEvent.setup()
    renderPage(`#t=${TOKEN}`)

    await fill(user, "curta")
    await user.click(screen.getByRole("button", { name: "Redefinir senha" }))
    expect(await screen.findByText("A nova senha precisa de pelo menos 10 caracteres.")).toBeInTheDocument()

    await user.clear(screen.getByLabelText(/^Nova senha/))
    await user.clear(screen.getByLabelText(/^Repita a nova senha/))
    await fill(user, "ã".repeat(37)) // 37 caracteres = 74 bytes
    await user.click(screen.getByRole("button", { name: "Redefinir senha" }))
    expect(await screen.findByText(/no máximo 72 bytes/i, { selector: "p" })).toBeInTheDocument()

    await user.clear(screen.getByLabelText(/^Nova senha/))
    await user.clear(screen.getByLabelText(/^Repita a nova senha/))
    await fill(user, SENHA, `${SENHA}x`)
    await user.click(screen.getByRole("button", { name: "Redefinir senha" }))
    expect(await screen.findByText("As senhas não conferem.")).toBeInTheDocument()
    expect(resetPassword).not.toHaveBeenCalled()
  })

  it("dicas ao vivo: 'pelo menos 10 caracteres' passa de pendente para atendido enquanto digita", async () => {
    const user = userEvent.setup()
    renderPage(`#t=${TOKEN}`)
    const rules = screen.getByRole("list", { name: "Requisitos da nova senha" })
    expect(rules).toHaveTextContent("Pelo menos 10 caracteres (pendente)")
    await user.type(screen.getByLabelText(/^Nova senha/), "1234567890")
    expect(rules).toHaveTextContent("Pelo menos 10 caracteres (atendido)")
  })
})

describe("ResetPassword - respostas do servidor", () => {
  it("sucesso (204): vai para /login com o aviso no ESTADO DA ROTA e nunca cria sessão", async () => {
    const user = userEvent.setup()
    resetPassword.mockResolvedValueOnce(undefined)
    renderPage(`#t=${TOKEN}`)
    await fill(user)
    await user.click(screen.getByRole("button", { name: "Redefinir senha" }))
    expect(await screen.findByTestId("login")).toHaveTextContent(JSON.stringify({ flash: PASSWORD_RESET_FLASH }))
    expect(localStorage.length).toBe(0)
  })

  it("RESET_TOKEN_INVALID: troca o formulário por 'link inválido' (a senha digitada some)", async () => {
    const user = userEvent.setup()
    resetPassword.mockRejectedValueOnce(apiError(400, "RESET_TOKEN_INVALID"))
    renderPage(`#t=${TOKEN}`)
    await fill(user)
    await user.click(screen.getByRole("button", { name: "Redefinir senha" }))
    expect(await screen.findByRole("heading", { level: 1, name: "Link inválido" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { level: 1, name: "Link inválido" })).toHaveFocus()
    expect(screen.queryByDisplayValue(SENHA)).not.toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Pedir novo link" })).toHaveAttribute("href", "/esqueci-senha")
  })

  it("VALIDATION_ERROR do servidor: erro NO CAMPO com foco, formulário e senha MANTIDOS, mesmo token reenviável", async () => {
    const user = userEvent.setup()
    resetPassword.mockRejectedValueOnce(apiError(400, "VALIDATION_ERROR", { details: [{ path: "newPassword", message: "x" }] }))
    resetPassword.mockResolvedValueOnce(undefined)
    renderPage(`#t=${TOKEN}`)
    await fill(user)
    await user.click(screen.getByRole("button", { name: "Redefinir senha" }))
    const field = screen.getByLabelText(/^Nova senha/)
    expect(await screen.findByText("A nova senha precisa ter de 10 caracteres a 72 bytes.")).toBeInTheDocument()
    expect(field).toHaveFocus()
    expect(field).toHaveValue(SENHA)
    expect(field).toHaveAttribute("aria-invalid", "true")

    // O token não foi gasto: a segunda tentativa usa o MESMO token (que continua só na memória).
    await user.click(screen.getByRole("button", { name: "Redefinir senha" }))
    await waitFor(() => expect(resetPassword).toHaveBeenCalledTimes(2))
    expect(resetPassword).toHaveBeenLastCalledWith({ token: TOKEN, newPassword: SENHA })
  })

  it("429 com Retry-After legível: aviso com o tempo, foco no aviso, formulário mantido", async () => {
    const user = userEvent.setup()
    resetPassword.mockRejectedValueOnce(apiError(429, "RATE_LIMITED_AUTH", { headers: { "retry-after": "300" } }))
    renderPage(`#t=${TOKEN}`)
    await fill(user)
    await user.click(screen.getByRole("button", { name: "Redefinir senha" }))
    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("Muitas tentativas. Tente de novo em 5 minutos.")
    await waitFor(() => expect(alert).toHaveFocus())
    expect(screen.getByLabelText(/^Nova senha/)).toHaveValue(SENHA)
  })

  it("503 e rede: avisos do formulário com os textos de authErrors; o formulário fica", async () => {
    const user = userEvent.setup()
    resetPassword.mockRejectedValueOnce(apiError(503, "SERVICE_UNAVAILABLE"))
    renderPage(`#t=${TOKEN}`)
    await fill(user)
    await user.click(screen.getByRole("button", { name: "Redefinir senha" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("O serviço está instável agora. Tente novamente em instantes.")

    resetPassword.mockRejectedValueOnce(apiError(null))
    await user.click(screen.getByRole("button", { name: "Redefinir senha" }))
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Sem conexão com o servidor."))
    expect(screen.getByLabelText(/^Nova senha/)).toHaveValue(SENHA)
  })

  it("a mutation não guarda token nem senha depois da resposta (gcTime 0 + reset)", async () => {
    const user = userEvent.setup()
    resetPassword.mockRejectedValueOnce(apiError(503, "SERVICE_UNAVAILABLE"))
    const { queryClient } = renderPage(`#t=${TOKEN}`)
    await fill(user)
    await user.click(screen.getByRole("button", { name: "Redefinir senha" }))
    await screen.findByRole("alert")
    const cached = queryClient.getMutationCache().getAll()
    expect(JSON.stringify(cached.map((m) => m.state.variables))).not.toContain(TOKEN)
    expect(JSON.stringify(cached.map((m) => m.state.variables))).not.toContain(SENHA)
  })
})
