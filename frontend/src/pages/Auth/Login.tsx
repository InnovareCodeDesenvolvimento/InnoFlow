import { useState } from "react"
import { Link, useNavigate, useSearchParams } from "react-router-dom"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { Zap } from "lucide-react"
import { Input } from "@/components/ui/Input"
import { Button } from "@/components/ui/Button"
import { useAuthStore } from "@/store/authStore"
import { getApiErrorMessage } from "@/services/api"
import { loginSchema, type LoginFormValues } from "@/schemas/auth.schema"

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
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-sm">
        <Link to="/" className="mb-8 flex items-center justify-center gap-2 font-black tracking-tight text-ink">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-white">
            <Zap className="h-5 w-5" aria-hidden="true" />
          </span>
          InnoElektron
        </Link>

        <div className="card-elevated p-6">
          <h1 className="text-xl font-bold text-ink">Entrar</h1>
          <p className="mt-1 text-sm text-ink-softer">Acesse sua conta InnoElektron.</p>

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
  )
}
