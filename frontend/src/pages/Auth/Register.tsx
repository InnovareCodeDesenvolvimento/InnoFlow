import { useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { Input } from "@/components/ui/Input"
import { Button } from "@/components/ui/Button"
import { useAuthStore } from "@/store/authStore"
import { getApiErrorMessage } from "@/services/api"
import { registerSchema, type RegisterFormValues } from "@/schemas/auth.schema"
import logoIcon from "@/assets/logo-icon.png"

/** `POST /api/auth/register` sempre cria um DRIVER (motorista) — não existe cadastro de ADMIN/OPERATOR pela UI, ver PROGRESSO.md. */
export function Register() {
  const navigate = useNavigate()
  const register_ = useAuthStore((s) => s.register)
  const [formError, setFormError] = useState<string | null>(null)

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<RegisterFormValues>({ resolver: zodResolver(registerSchema) })

  const onSubmit = async (values: RegisterFormValues) => {
    setFormError(null)
    try {
      await register_({ ...values, phone: values.phone || undefined })
      navigate("/", { replace: true })
    } catch (err) {
      setFormError(getApiErrorMessage(err, "Não foi possível criar sua conta."))
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-gradient-to-b from-primary-50 via-background to-background px-4 py-12">
      {/* Mesmo wash de marca sutil da Landing/Login — fecha a consistência
          visual das três telas de "primeira impressão" do PWA. */}
      <div
        className="pointer-events-none absolute -right-20 -top-24 h-72 w-72 rounded-full bg-accent-glow/10 blur-3xl animate-float-soft"
        aria-hidden="true"
      />
      <div
        className="pointer-events-none absolute -bottom-28 -left-20 h-80 w-80 rounded-full bg-brand-teal/10 blur-3xl animate-float-soft"
        style={{ animationDelay: "1.2s" }}
        aria-hidden="true"
      />

      <div className="relative w-full max-w-sm">
        <Link to="/" className="mb-8 flex items-center justify-center gap-2 font-black tracking-tight text-ink">
          <img src={logoIcon} alt="" className="h-9 w-9 shrink-0" />
          InnoFlow
        </Link>

        <div className="card-premium animate-fade-in-up p-6">
          <h1 className="text-xl font-bold text-ink">Criar conta</h1>
          <p className="mt-1 text-sm text-ink-softer">Cadastre-se como motorista para acompanhar sua recarga.</p>

          <form className="mt-6 space-y-4" onSubmit={handleSubmit(onSubmit)} noValidate>
            <Input label="Nome" autoComplete="name" required error={errors.name?.message} {...register("name")} />
            <Input type="email" label="E-mail" autoComplete="email" required error={errors.email?.message} {...register("email")} />
            <Input
              type="password"
              label="Senha"
              autoComplete="new-password"
              hint="Mínimo de 8 caracteres."
              required
              error={errors.password?.message}
              {...register("password")}
            />
            <Input type="tel" label="Telefone (opcional)" autoComplete="tel" error={errors.phone?.message} {...register("phone")} />

            {formError && (
              <p role="alert" className="rounded-lg bg-danger-50 px-3 py-2 text-sm font-medium text-danger-700">
                {formError}
              </p>
            )}

            <Button type="submit" className="w-full btn-glow-primary" size="lg" loading={isSubmitting}>
              Criar conta
            </Button>
          </form>
        </div>

        <p className="mt-6 text-center text-sm text-ink-softer">
          Já tem conta?{" "}
          <Link to="/login" className="font-semibold text-primary hover:underline">
            Entrar
          </Link>
        </p>
      </div>
    </div>
  )
}
