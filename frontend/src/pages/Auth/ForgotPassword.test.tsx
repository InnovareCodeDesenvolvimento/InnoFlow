import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter } from "react-router-dom"
import { AxiosError, type AxiosResponse } from "axios"
import { ForgotPassword, FORGOT_SENT_MESSAGE, RESEND_COOLDOWN_SECONDS } from "./ForgotPassword"

const forgotPassword = vi.fn()
vi.mock("@/services/auth", () => ({ authService: { forgotPassword: (...a: unknown[]) => forgotPassword(...a) } }))

const apiError = (status: number | null, code?: string) =>
  new AxiosError("falhou", undefined, undefined, undefined, status === null ? undefined : ({ status, data: { error: "texto do backend", code }, headers: {} } as AxiosResponse))

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ForgotPassword />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => forgotPassword.mockReset())
afterEach(() => vi.useRealTimers())

describe("ForgotPassword", () => {
  it("e-mail malformado: erro no campo e nenhuma chamada", async () => {
    const user = userEvent.setup()
    renderPage()
    await user.type(screen.getByLabelText(/^E-mail/), "sem-arroba")
    await user.click(screen.getByRole("button", { name: "Enviar link" }))
    expect(await screen.findByText("E-mail inválido.")).toBeInTheDocument()
    expect(forgotPassword).not.toHaveBeenCalled()
  })

  it("202: estado de sucesso NEUTRO (nunca confirma nem nega a conta), foco no título, voltar ao login presente", async () => {
    const user = userEvent.setup()
    forgotPassword.mockResolvedValueOnce({ ok: true })
    renderPage()
    await user.type(screen.getByLabelText(/^E-mail/), "alguem@example.com")
    await user.click(screen.getByRole("button", { name: "Enviar link" }))

    const heading = await screen.findByRole("heading", { level: 1, name: "Confira seu e-mail" })
    expect(heading).toHaveFocus()
    expect(forgotPassword).toHaveBeenCalledWith({ email: "alguem@example.com" })
    expect(screen.getByText(FORGOT_SENT_MESSAGE)).toBeInTheDocument()
    expect(FORGOT_SENT_MESSAGE).toBe("Se este e-mail tiver uma conta, enviamos um link para redefinir a senha. Ele vale por 30 minutos.")
    expect(document.body.textContent).not.toMatch(/n[ãa]o existe|n[ãa]o encontramos|conta encontrada|n[ãa]o h[áa] conta|administrador|admin/i)
    expect(screen.getByRole("link", { name: "Voltar ao login" })).toHaveAttribute("href", "/login")
  })

  it("reenvio: desabilitado com contagem regressiva, libera em 60 s, chama de novo e rearma a contagem", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    forgotPassword.mockResolvedValue({ ok: true })
    renderPage()
    await user.type(screen.getByLabelText(/^E-mail/), "alguem@example.com")
    await user.click(screen.getByRole("button", { name: "Enviar link" }))
    await screen.findByRole("heading", { level: 1, name: "Confira seu e-mail" })

    const resend = () => screen.getByRole("button", { name: /^Reenviar/ })
    expect(resend()).toBeDisabled()
    expect(resend()).toHaveTextContent(`Reenviar em ${RESEND_COOLDOWN_SECONDS} s`)

    await act(async () => {
      vi.advanceTimersByTime(30_000)
    })
    expect(resend()).toHaveTextContent(/Reenviar em (2\d|30) s/)
    expect(resend()).toBeDisabled()

    await act(async () => {
      vi.advanceTimersByTime(31_000)
    })
    expect(resend()).toBeEnabled()
    expect(resend()).toHaveTextContent("Reenviar e-mail")

    await user.click(resend())
    await waitFor(() => expect(forgotPassword).toHaveBeenCalledTimes(2))
    expect(forgotPassword).toHaveBeenLastCalledWith({ email: "alguem@example.com" })
    await waitFor(() => expect(resend()).toBeDisabled())
  })

  it("429: aviso do formulário com o texto pedido, foco no aviso, e-mail mantido", async () => {
    const user = userEvent.setup()
    forgotPassword.mockRejectedValueOnce(apiError(429, "RATE_LIMITED_AUTH"))
    renderPage()
    await user.type(screen.getByLabelText(/^E-mail/), "alguem@example.com")
    await user.click(screen.getByRole("button", { name: "Enviar link" }))
    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("Muitas tentativas. Tente de novo em alguns minutos.")
    await waitFor(() => expect(alert).toHaveFocus())
    expect(screen.getByLabelText(/^E-mail/)).toHaveValue("alguem@example.com")
  })

  it("rede e 5xx: textos de authErrors", async () => {
    const user = userEvent.setup()
    forgotPassword.mockRejectedValueOnce(apiError(null))
    renderPage()
    await user.type(screen.getByLabelText(/^E-mail/), "alguem@example.com")
    await user.click(screen.getByRole("button", { name: "Enviar link" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Sem conexão com o servidor. Confira sua internet e tente de novo.")

    forgotPassword.mockRejectedValueOnce(apiError(500))
    await user.click(screen.getByRole("button", { name: "Enviar link" }))
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("O serviço está instável agora. Tente novamente em instantes."))
  })

  it("'Usar outro e-mail' volta ao formulário vazio", async () => {
    const user = userEvent.setup()
    forgotPassword.mockResolvedValueOnce({ ok: true })
    renderPage()
    await user.type(screen.getByLabelText(/^E-mail/), "alguem@example.com")
    await user.click(screen.getByRole("button", { name: "Enviar link" }))
    await user.click(await screen.findByRole("button", { name: "Usar outro e-mail" }))
    expect(screen.getByLabelText(/^E-mail/)).toHaveValue("")
  })
})
