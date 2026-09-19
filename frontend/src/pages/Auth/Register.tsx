import { useState } from "react"
import { Link, useNavigate, useSearchParams } from "react-router-dom"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { Input } from "@/components/ui/Input"
import { Button } from "@/components/ui/Button"
import { GoogleAuthSection } from "@/components/auth/GoogleAuthSection"
import { useAuthStore } from "@/store/authStore"
import { authErrorMessage } from "@/lib/authErrors"
import { resolvePostAuthPath, safeRedirect } from "@/lib/authRedirect"
import { registerSchema, type RegisterFormValues } from "@/schemas/auth.schema"
import logoIcon from "@/assets/logo-icon.png"

/**
 * `POST /api/auth/register` sempre cria um DRIVER (motorista) — não existe
 * cadastro de ADMIN/OPERATOR pela UI, ver PROGRESSO.md.
 *
 * Passe visual de 17/09/2026: tinha o MESMO padrão fraco que a
 * `ChargePointLanding` (card pequeno centralizado, blobs em 10% de opacidade
 * sobre fundo claro — baixo contraste demais pra aparecer) — mesmo
 * diagnóstico, mesmo tratamento: herói de marca cheio no topo (slogan em
 * destaque, blobs sobre fundo escuro), card "flutuando" por cima da
 * fronteira. Diferença deliberada da Landing: aqui a tela PODE rolar (é um
 * formulário mais longo, sem o requisito duro de "acima da dobra"), então o
 * herói pode respirar um pouco mais.
 */
export function Register() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const register_ = useAuthStore((s) => s.register)
  const [formError, setFormError] = useState<string | null>(null)

  // Mesmo `?redirect=` do Login (fluxo do QR): quem se cadastra — por e-mail
  // ou pelo Google — volta pro carregador que escaneou. Sem ele, o cadastro
  // por e-mail segue indo pra `/` (como sempre) e o Google segue a regra de
  // sempre do login (`resolvePostAuthPath`: motorista → `/app`).
  const redirect = params.get("redirect")
  const redirectQuery = safeRedirect(redirect) ? `?redirect=${encodeURIComponent(redirect as string)}` : ""

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<RegisterFormValues>({ resolver: zodResolver(registerSchema) })

  const onSubmit = async (values: RegisterFormValues) => {
    setFormError(null)
    try {
      await register_({ ...values, phone: values.phone || undefined })
      navigate(safeRedirect(redirect) ?? "/", { replace: true })
    } catch (err) {
      setFormError(authErrorMessage(err, "Não foi possível criar sua conta."))
    }
  }

  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-background">
      {/* Herói de marca — mesmo tratamento da Landing/Login: faixa cheia no
          topo (gradiente escuro), slogan em destaque, blobs bem mais
          visíveis (fundo escuro, opacidade maior). */}
      <div className="relative shrink-0 overflow-hidden bg-gradient-to-br from-primary-950 via-primary-900 to-primary-800 px-4 pb-16 pt-8 text-center">
        <div
          className="pointer-events-none absolute -right-10 -top-14 h-56 w-56 rounded-full bg-accent-glow/60 blur-2xl animate-float-soft"
          aria-hidden="true"
        />
        <div
          className="pointer-events-none absolute -bottom-14 -left-12 h-56 w-56 rounded-full bg-brand-teal/60 blur-2xl animate-float-soft"
          style={{ animationDelay: "1.2s" }}
          aria-hidden="true"
        />
        <div className="relative mx-auto flex max-w-sm flex-col items-center gap-2">
          <Link to="/" className="flex items-center gap-2">
            <img src={logoIcon} alt="" className="h-8 w-8 shrink-0" />
            <span className="text-lg font-black tracking-tight text-white">InnoFlow</span>
          </Link>
          <p className="text-xl font-black leading-snug tracking-tight text-white sm:text-2xl">
            Carregue um{" "}
            <span className="bg-gradient-to-r from-accent-300 to-accent-glow bg-clip-text text-transparent">futuro melhor</span>.
          </p>
        </div>
      </div>

      <div className="relative z-10 mx-auto -mt-8 w-full max-w-sm flex-1 px-4 pb-12">
        <div className="card-premium animate-fade-in-up p-6">
          <h1 className="text-xl font-bold text-ink">Criar conta</h1>
          <p className="mt-1 text-sm text-ink-softer">Cadastre-se como motorista para acompanhar sua recarga.</p>

          {/* Quem entra pelo Google não passa por senha nenhuma: o backend cria a conta direto. */}
          <GoogleAuthSection onSuccess={(user) => navigate(resolvePostAuthPath(user, redirect), { replace: true })} />

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
          <Link to={`/login${redirectQuery}`} className="font-semibold text-primary hover:underline">
            Entrar
          </Link>
        </p>
      </div>
    </div>
  )
}
