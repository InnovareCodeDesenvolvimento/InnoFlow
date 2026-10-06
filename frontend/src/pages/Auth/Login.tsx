import { useEffect, useState } from "react"
import { Link, useLocation, useNavigate } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { CheckCircle2, LogIn } from "lucide-react"
import { Input } from "@/components/ui/Input"
import { Button } from "@/components/ui/Button"
import { AuthAlert } from "@/components/auth/AuthAlert"
import { AuthShell } from "@/components/auth/AuthShell"
import { GoogleAuthSection } from "@/components/auth/GoogleAuthSection"
import { Card } from "@/components/ui/Card"
import { useAuthStore } from "@/store/authStore"
import { accountDeletedNotice, readAccountDeletedFlash } from "@/lib/accountDeletion"
import { authErrorMessage } from "@/lib/authErrors"
import { isPasswordResetFlash, PASSWORD_RESET_NOTICE } from "@/lib/passwordReset"
import { clearReturnTo, consumeReturnTo, resolvePostAuthPath } from "@/lib/authRedirect"
import { useAbsorbLegacyRedirect } from "@/hooks/useAbsorbLegacyRedirect"
import { loginSchema, type LoginFormValues } from "@/schemas/auth.schema"
import type { User } from "@/types/api"

export function Login() {
  const navigate = useNavigate()
  const login = useAuthStore((s) => s.login)
  const [formError, setFormError] = useState<string | null>(null)
  const location = useLocation()

  // Aviso de "senha alterada" (L1.3): chega no ESTADO DA ROTA vindo de /redefinir-senha, vai para estado local e o estado da rota é apagado já na chegada (`history.state`
  // sobrevive ao F5; sem a limpeza o aviso voltaria a cada recarga). Não há auto-login: a pessoa entra com a senha nova.
  // Mesmo mecanismo para "conta excluída" (L1.4): depois da exclusão o token deixa de valer e a tela de perfil manda para cá com o desfecho (`DELETED` | `DELETED_PENDING_REFUND`).
  const [passwordResetNotice] = useState(() => isPasswordResetFlash(location.state))
  const [accountDeleted] = useState(() => readAccountDeletedFlash(location.state))
  const queryClient = useQueryClient()
  const logout = useAuthStore((s) => s.logout)
  // Link antigo `/login?redirect=/x`: o destino vai para o `sessionStorage` e a barra passa a mostrar `/login` limpo.
  useAbsorbLegacyRedirect()
  // Conta excluída: o token já não vale. Quem excluiu NÃO limpa a sessão antes de navegar (o `AppLayout` a mandaria para o `/login` SEM o aviso, que vive no estado da rota); a limpeza
  // do estado da sessão e do cache acontece aqui, já fora do app do motorista. A conta não volta: o destino de retorno que sobrou (de outra sessão) não deve levar o próximo login a lugar nenhum.
  useEffect(() => {
    if (accountDeleted) {
      logout()
      queryClient.clear()
      clearReturnTo()
    }
  }, [accountDeleted, logout, queryClient])
  useEffect(() => {
    if (isPasswordResetFlash(location.state) || readAccountDeletedFlash(location.state) !== null) navigate(`${location.pathname}${location.search}`, { replace: true, state: null })
  }, [location.state, location.pathname, location.search, navigate])

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginFormValues>({ resolver: zodResolver(loginSchema) })

  // O destino de retorno (fluxo do QR: escaneia → cai aqui → volta pro carregador;
  // ou a rota protegida que mandou pra cá), guardado em `sessionStorage`, tem
  // prioridade; sem ele, cada papel vai pra própria casa — DRIVER pro app do
  // motorista (`/app`), o site público (`/`) é para visitante anônimo. Mesma
  // regra pro login normal e pro Google (`lib/authRedirect.ts`). Só é lido DEPOIS de autenticar.
  const goAfterAuth = (user: User) => navigate(resolvePostAuthPath(user, consumeReturnTo()), { replace: true })

  const onSubmit = async (values: LoginFormValues) => {
    setFormError(null)
    try {
      goAfterAuth(await login(values))
    } catch (err) {
      setFormError(authErrorMessage(err, "E-mail ou senha inválidos."))
    }
  }

  return (
    <AuthShell
      below={
        <p className="mt-6 text-center text-sm text-ink-softer">
          Ainda não tem conta?{" "}
          {/* Sem querystring: o destino de retorno está no `sessionStorage` e sobrevive à passagem pelo cadastro (QR de quem ainda não tem conta). */}
          <Link to="/cadastro" className="font-semibold text-primary hover:underline">
            Cadastre-se
          </Link>
        </p>
      }
    >
      <Card className="animate-enter p-6 shadow-tinted-card sm:p-8">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-xs font-bold uppercase tracking-wide text-primary-700">
          <LogIn className="h-3.5 w-3.5" aria-hidden="true" />
          Acesso à plataforma
        </span>
        <h1 className="mt-3 text-2xl font-extrabold tracking-tight text-ink">Bem-vindo de volta</h1>
        <p className="mt-1.5 text-sm text-ink-softer">Entre com seu e-mail e senha para continuar.</p>

        {passwordResetNotice && (
          <AuthAlert tone="success" icon={CheckCircle2} role="status" className="mt-4">
            {PASSWORD_RESET_NOTICE}
          </AuthAlert>
        )}

        {accountDeleted && (
          <AuthAlert tone="success" icon={CheckCircle2} role="status" className="mt-4">
            {accountDeletedNotice(accountDeleted)}
          </AuthAlert>
        )}

        <GoogleAuthSection onSuccess={goAfterAuth} />

        <form className="mt-6 space-y-4" onSubmit={handleSubmit(onSubmit)} noValidate>
          <Input type="email" label="E-mail" autoComplete="email" required error={errors.email?.message} {...register("email")} />
          <div>
            <Input type="password" label="Senha" autoComplete="current-password" required error={errors.password?.message} {...register("password")} />
            {/* Alvo de 44 px (min-h-11) sem mudar o espaçamento do formulário além da própria linha. */}
            <div className="flex justify-end">
              <Link to="/esqueci-senha" className="inline-flex min-h-11 items-center px-1 text-sm font-semibold text-primary hover:underline">
                Esqueci minha senha
              </Link>
            </div>
          </div>

          {formError && (
            <p role="alert" className="rounded-lg bg-danger-50 px-3 py-2 text-sm font-medium text-danger-700">
              {formError}
            </p>
          )}

          {/* CTA único da tela = lima (D2). */}
          <Button type="submit" variant="lime" className="w-full" size="lg" loading={isSubmitting}>
            Entrar
          </Button>
        </form>
      </Card>
    </AuthShell>
  )
}
