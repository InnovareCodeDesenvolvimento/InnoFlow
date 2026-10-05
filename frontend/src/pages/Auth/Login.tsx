import { useState } from "react"
import { Link, useNavigate, useSearchParams } from "react-router-dom"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { LogIn } from "lucide-react"
import { Input } from "@/components/ui/Input"
import { Button } from "@/components/ui/Button"
import { AuthShell } from "@/components/auth/AuthShell"
import { GoogleAuthSection } from "@/components/auth/GoogleAuthSection"
import { Card } from "@/components/ui/Card"
import { useAuthStore } from "@/store/authStore"
import { authErrorMessage } from "@/lib/authErrors"
import { resolvePostAuthPath, safeRedirect } from "@/lib/authRedirect"
import { loginSchema, type LoginFormValues } from "@/schemas/auth.schema"
import type { User } from "@/types/api"

export function Login() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const login = useAuthStore((s) => s.login)
  const [formError, setFormError] = useState<string | null>(null)

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginFormValues>({ resolver: zodResolver(loginSchema) })

  // `?redirect=` (fluxo do QR: escaneia → cai aqui → volta pro carregador) tem
  // prioridade; sem ele, cada papel vai pra própria casa — DRIVER pro app do
  // motorista (`/app`), o site público (`/`) é para visitante anônimo. Mesma
  // regra pro login normal e pro Google (`lib/authRedirect.ts`).
  const redirect = params.get("redirect")
  const goAfterAuth = (user: User) => navigate(resolvePostAuthPath(user, redirect), { replace: true })

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
          {/* Leva o `?redirect=` junto: senão o QR escaneado por quem ainda não tem conta se perde ao passar pelo cadastro. */}
          <Link
            to={safeRedirect(redirect) ? `/cadastro?redirect=${encodeURIComponent(redirect as string)}` : "/cadastro"}
            className="font-semibold text-primary hover:underline"
          >
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

        <GoogleAuthSection onSuccess={goAfterAuth} />

        <form className="mt-6 space-y-4" onSubmit={handleSubmit(onSubmit)} noValidate>
          <Input type="email" label="E-mail" autoComplete="email" required error={errors.email?.message} {...register("email")} />
          <Input type="password" label="Senha" autoComplete="current-password" required error={errors.password?.message} {...register("password")} />

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
