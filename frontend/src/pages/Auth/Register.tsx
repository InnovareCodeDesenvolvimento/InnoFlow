import { useState } from "react"
import { Link, useNavigate, useSearchParams } from "react-router-dom"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { Input } from "@/components/ui/Input"
import { Button } from "@/components/ui/Button"
import { AuthShell } from "@/components/auth/AuthShell"
import { GoogleAuthSection } from "@/components/auth/GoogleAuthSection"
import { Card } from "@/components/ui/Card"
import { useAuthStore } from "@/store/authStore"
import { authErrorMessage } from "@/lib/authErrors"
import { resolvePostAuthPath, safeRedirect } from "@/lib/authRedirect"
import { registerSchema, type RegisterFormValues } from "@/schemas/auth.schema"

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
    <AuthShell
      below={
        <p className="mt-6 text-center text-sm text-ink-softer">
          Já tem conta?{" "}
          <Link to={`/login${redirectQuery}`} className="font-semibold text-primary hover:underline">
            Entrar
          </Link>
        </p>
      }
    >
      <Card className="animate-enter p-6 shadow-tinted-card">
        <h1 className="text-xl font-extrabold tracking-tight text-ink">Criar conta</h1>
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

          {/* CTA único da tela = lima (D2). */}
          <Button type="submit" variant="lime" className="w-full" size="lg" loading={isSubmitting}>
            Criar conta
          </Button>
        </form>
      </Card>
    </AuthShell>
  )
}
