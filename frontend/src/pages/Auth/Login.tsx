import { useState } from "react"
import { Link, useNavigate, useSearchParams } from "react-router-dom"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { LogIn, MapPin, ShieldCheck, Zap } from "lucide-react"
import { Input } from "@/components/ui/Input"
import { Button } from "@/components/ui/Button"
import { useAuthStore } from "@/store/authStore"
import { getApiErrorMessage } from "@/services/api"
import { loginSchema, type LoginFormValues } from "@/schemas/auth.schema"
import logoIcon from "@/assets/logo-icon.png"

/**
 * Mesmos três diferenciais já usados na Home (`pages/Public/Home.tsx`) —
 * reaproveitados aqui, não inventados, para o painel de marca do login.
 */
const VALUE_PROPS = [
  { icon: MapPin, title: "Cobertura multi-operador", description: "Eletropostos de várias empresas, numa única rede consultável." },
  { icon: Zap, title: "AC e DC, na mesma busca", description: "AC Tipo 2, DC CCS2 e DC CHAdeMO, com a potência de cada conector." },
  { icon: ShieldCheck, title: "Conta única de rede", description: "Cadastre-se uma vez e use em qualquer operador da plataforma." },
]

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

  const onSubmit = async (values: LoginFormValues) => {
    setFormError(null)
    try {
      const user = await login(values)
      const redirect = params.get("redirect")
      if (redirect) {
        navigate(redirect, { replace: true })
      } else if (user.role === "ADMIN" || user.role === "OPERATOR") {
        navigate("/admin", { replace: true })
      } else {
        navigate("/", { replace: true })
      }
    } catch (err) {
      setFormError(getApiErrorMessage(err, "E-mail ou senha inválidos."))
    }
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      {/* Painel de marca — só desktop (>=lg). No mobile a tela é só o formulário, como antes. */}
      <div className="relative hidden overflow-hidden bg-gradient-to-br from-primary-950 via-primary-900 to-primary-800 lg:flex lg:flex-col lg:justify-between lg:p-12 xl:p-16">
        <div
          className="pointer-events-none absolute -left-24 -top-24 h-80 w-80 rounded-full bg-accent-glow/10 blur-3xl"
          aria-hidden="true"
        />
        <div
          className="pointer-events-none absolute -bottom-32 -right-16 h-96 w-96 rounded-full bg-brand-teal/20 blur-3xl"
          aria-hidden="true"
        />

        <Link to="/" className="relative z-10 flex items-center gap-2.5 font-black tracking-tight text-white">
          <img src={logoIcon} alt="" className="h-10 w-10 shrink-0" />
          <span className="text-lg">InnoFlow</span>
        </Link>

        <div className="relative z-10 max-w-md">
          <h1 className="text-3xl font-black leading-tight tracking-tight text-white xl:text-4xl">
            Carregue um futuro melhor.
          </h1>
          <p className="mt-4 text-sm leading-relaxed text-white/70">
            O painel administrativo da InnoFlow reúne sites, eletropostos, tarifas e sessões de recarga de todos os
            operadores da rede num só lugar.
          </p>

          <ul className="mt-10 space-y-5">
            {VALUE_PROPS.map(({ icon: Icon, title, description }) => (
              <li key={title} className="flex items-start gap-3.5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/10 ring-1 ring-white/15">
                  <Icon className="h-4 w-4 text-accent-300" aria-hidden="true" />
                </span>
                <div>
                  <p className="text-sm font-bold text-white">{title}</p>
                  <p className="mt-0.5 text-xs leading-relaxed text-white/60">{description}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <p className="relative z-10 text-xs text-white/40">© {new Date().getFullYear()} InnoFlow. Carregue um futuro melhor.</p>
      </div>

      {/* Formulário */}
      <div className="flex flex-col items-center justify-center bg-background px-4 py-12 sm:px-6 lg:px-12">
        <div className="w-full max-w-sm">
          <Link to="/" className="mb-8 flex items-center justify-center gap-2 font-black tracking-tight text-ink lg:hidden">
            <img src={logoIcon} alt="" className="h-9 w-9 shrink-0" />
            InnoFlow
          </Link>

          <div className="card-elevated p-6 sm:p-8">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-xs font-bold uppercase tracking-wide text-primary-700">
              <LogIn className="h-3.5 w-3.5" aria-hidden="true" />
              Acesso à plataforma
            </span>
            <h2 className="mt-3 text-2xl font-black tracking-tight text-ink">Bem-vindo de volta</h2>
            <p className="mt-1.5 text-sm text-ink-softer">Entre com seu e-mail e senha para continuar.</p>

            <form className="mt-6 space-y-4" onSubmit={handleSubmit(onSubmit)} noValidate>
              <Input
                type="email"
                label="E-mail"
                autoComplete="email"
                required
                error={errors.email?.message}
                {...register("email")}
              />
              <Input
                type="password"
                label="Senha"
                autoComplete="current-password"
                required
                error={errors.password?.message}
                {...register("password")}
              />

              {formError && (
                <p role="alert" className="rounded-lg bg-danger-50 px-3 py-2 text-sm font-medium text-danger-700">
                  {formError}
                </p>
              )}

              <Button type="submit" className="w-full" size="lg" loading={isSubmitting}>
                Entrar
              </Button>
            </form>
          </div>

          <p className="mt-6 text-center text-sm text-ink-softer">
            Ainda não tem conta?{" "}
            <Link to="/cadastro" className="font-semibold text-primary hover:underline">
              Cadastre-se
            </Link>
          </p>
        </div>
      </div>
    </div>
  )
}
