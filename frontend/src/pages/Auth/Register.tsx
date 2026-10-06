import { useEffect, useRef, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { useForm, useWatch } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { Input } from "@/components/ui/Input"
import { Button } from "@/components/ui/Button"
import { AuthShell } from "@/components/auth/AuthShell"
import { GoogleAuthSection } from "@/components/auth/GoogleAuthSection"
import { TermsAcceptance } from "@/components/auth/TermsAcceptance"
import { Card } from "@/components/ui/Card"
import { usePublicLegal } from "@/hooks/useLegal"
import { useAuthStore } from "@/store/authStore"
import { authErrorMessage } from "@/lib/authErrors"
import { consumeReturnTo, resolvePostAuthPath } from "@/lib/authRedirect"
import { useAbsorbLegacyRedirect } from "@/hooks/useAbsorbLegacyRedirect"
import { isTermsOutdatedError, isTermsRequiredError, TERMS_LOAD_ERROR_MESSAGE, TERMS_OUTDATED_MESSAGE } from "@/lib/termsAcceptance"
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
  const register_ = useAuthStore((s) => s.register)
  const [formError, setFormError] = useState<string | null>(null)

  // Mesmo destino de retorno do Login (fluxo do QR, guardado em `sessionStorage`): quem se cadastra — por e-mail
  // ou pelo Google — volta pro carregador que escaneou. Sem ele, o cadastro
  // por e-mail segue indo pra `/` (como sempre) e o Google segue a regra de
  // sempre do login (`resolvePostAuthPath`: motorista → `/app`). Link antigo `/cadastro?redirect=/x` é absorvido e some da barra.
  useAbsorbLegacyRedirect()

  // L1.9: versão vigente dos Termos (o servidor a exige no cadastro). Falha ao carregar NÃO trava o login de ninguém (esta tela só cria conta): mostra o erro com "Tentar de novo".
  const legal = usePublicLegal()

  const {
    register,
    handleSubmit,
    setValue,
    setError,
    control,
    formState: { errors, isSubmitting },
  } = useForm<RegisterFormValues>({ resolver: zodResolver(registerSchema), defaultValues: { acceptTerms: false } })
  const accepted = useWatch({ control, name: "acceptTerms" })
  const { ref: termsFieldRef, ...termsField } = register("acceptTerms")
  const termsRef = useRef<HTMLInputElement | null>(null)
  // 409 (versão mudou): o foco vai para a caixa por efeito, DEPOIS do render que mostra o erro (o `shouldFocus` do RHF rodava com o botão ainda desabilitado pelo envio e o foco caía no `body`).
  const [termsFocusKey, setTermsFocusKey] = useState(0)
  useEffect(() => {
    if (termsFocusKey > 0) termsRef.current?.focus()
  }, [termsFocusKey])

  const onSubmit = async (values: RegisterFormValues) => {
    setFormError(null)
    if (!legal.data) {
      // Sem a versão vigente não há como mandar o aceite: tenta de novo e avisa (nada foi enviado).
      void legal.refetch()
      setFormError(TERMS_LOAD_ERROR_MESSAGE)
      return
    }
    try {
      await register_({ name: values.name, email: values.email, password: values.password, phone: values.phone || undefined, acceptedTermsVersion: legal.data.termsVersion })
      navigate(consumeReturnTo() ?? "/", { replace: true })
    } catch (err) {
      if (isTermsOutdatedError(err) || isTermsRequiredError(err)) {
        // A versão mudou entre o carregamento e o envio (409), ou o servidor não viu o aceite (400): recarrega a vigente e pede o aceite de novo, com a caixa desmarcada.
        void legal.refetch()
        setValue("acceptTerms", false)
        setError("acceptTerms", { message: TERMS_OUTDATED_MESSAGE })
        setTermsFocusKey((k) => k + 1)
        return
      }
      setFormError(authErrorMessage(err, "Não foi possível criar sua conta."))
    }
  }

  return (
    <AuthShell
      below={
        <p className="mt-6 text-center text-sm text-ink-softer">
          Já tem conta?{" "}
          <Link to="/login" className="font-semibold text-primary hover:underline">
            Entrar
          </Link>
        </p>
      }
    >
      <Card className="animate-enter p-6 shadow-tinted-card">
        <h1 className="text-xl font-extrabold tracking-tight text-ink">Criar conta</h1>
        <p className="mt-1 text-sm text-ink-softer">Cadastre-se como motorista para acompanhar sua recarga.</p>

        {/* Quem entra pelo Google não passa por senha nenhuma: o backend cria a conta direto. */}
        <GoogleAuthSection termsVersion={accepted ? (legal.data?.termsVersion ?? null) : null} onSuccess={(user) => navigate(resolvePostAuthPath(user, consumeReturnTo()), { replace: true })} />

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

          <TermsAcceptance
            ref={(el) => {
              termsFieldRef(el)
              termsRef.current = el
            }}
            error={errors.acceptTerms?.message}
            loadFailed={legal.isError}
            onRetry={() => void legal.refetch()}
            retrying={legal.isFetching}
            {...termsField}
          />

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
