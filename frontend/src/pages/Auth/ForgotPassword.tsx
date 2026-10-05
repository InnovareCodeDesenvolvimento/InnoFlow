import { useEffect, useRef, useState } from "react"
import { Link } from "react-router-dom"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { ArrowLeft, KeyRound, MailCheck, TriangleAlert } from "lucide-react"
import { AuthAlert } from "@/components/auth/AuthAlert"
import { AuthShell } from "@/components/auth/AuthShell"
import { Button } from "@/components/ui/Button"
import { Card } from "@/components/ui/Card"
import { Input } from "@/components/ui/Input"
import { useForgotPassword } from "@/hooks/usePasswordReset"
import { forgotPasswordError } from "@/lib/passwordReset"
import { forgotPasswordSchema, type ForgotPasswordFormValues } from "@/schemas/passwordReset.schema"

/**
 * "Esqueci minha senha" (L1.3, rota pública `/esqueci-senha`). `POST /api/auth/password/forgot` responde SEMPRE 202 para e-mail bem formado - exista a conta ou não,
 * seja ADMIN ou não. Por isso o estado de sucesso é NEUTRO: nunca confirma nem nega a conta e não promete e-mail para ninguém ("Se este e-mail tiver uma conta..."). O endereço
 * digitado aparece só para quem errou a digitação perceber - é eco do que a pessoa escreveu, não confirmação do servidor.
 *
 * Reenvio: botão com contagem regressiva de 60 s. É SÓ UX (o limite de verdade - por IP e, em silêncio, por e-mail - é do servidor); evita a pessoa martelar o botão.
 * Erros: e-mail malformado no campo; 429, rede e 5xx num aviso com o foco nele (textos em `lib/passwordReset.ts`). Nada fica guardado: o e-mail só vive no estado do componente
 * e a mutation tem `gcTime: 0` + `reset()`.
 */

export const RESEND_COOLDOWN_SECONDS = 60
export const FORGOT_SENT_MESSAGE = "Se este e-mail tiver uma conta, enviamos um link para redefinir a senha. Ele vale por 30 minutos."

/** Contagem regressiva em segundos. `start()` rearma. Só re-renderiza (1x por segundo) enquanto há tempo a contar. */
function useCooldown(seconds: number) {
  const [state, setState] = useState({ until: 0, now: 0 })
  const remaining = Math.max(0, Math.ceil((state.until - state.now) / 1000))
  const counting = remaining > 0
  useEffect(() => {
    if (!counting) return
    const id = window.setInterval(() => setState((s) => ({ ...s, now: Date.now() })), 1000)
    return () => window.clearInterval(id)
  }, [counting])
  const start = () => {
    const t = Date.now()
    setState({ until: t + seconds * 1000, now: t })
  }
  return { remaining, start }
}

function SentPanel({ email, onChangeEmail }: { email: string; onChangeEmail: () => void }) {
  const resend = useForgotPassword()
  const { remaining, start } = useCooldown(RESEND_COOLDOWN_SECONDS)
  const [resentOnce, setResentOnce] = useState(false)
  const [error, setError] = useState<{ message: string; seq: number } | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)

  // O primeiro envio já foi feito na tela anterior: a contagem começa aqui, no mesmo instante em que o painel aparece, e o foco vai para o título.
  useEffect(() => {
    start()
    headingRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- só na montagem
  }, [])

  const onResend = async () => {
    setError(null)
    try {
      await resend.mutateAsync({ email })
      setResentOnce(true)
      start()
    } catch (err) {
      setError((prev) => ({ message: forgotPasswordError(err).message, seq: (prev?.seq ?? 0) + 1 }))
    } finally {
      resend.reset()
    }
  }

  const waiting = remaining > 0

  return (
    <Card className="animate-enter p-6 shadow-tinted-card sm:p-8">
      <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-xs font-bold uppercase tracking-wide text-primary-700">
        <MailCheck className="h-3.5 w-3.5" aria-hidden="true" />
        Recuperar acesso
      </span>
      <h1 ref={headingRef} tabIndex={-1} className="mt-3 text-2xl font-extrabold tracking-tight text-ink outline-none focus-visible:ring-0 focus-visible:ring-offset-0">
        Confira seu e-mail
      </h1>
      <p className="mt-1.5 text-sm text-ink-softer">{FORGOT_SENT_MESSAGE}</p>
      <p className="mt-3 break-words rounded-lg bg-muted px-3 py-2 text-sm text-ink-soft">
        <span className="text-ink-softer">Endereço informado: </span>
        <span className="font-semibold text-ink">{email}</span>
      </p>
      <p className="mt-3 text-sm text-ink-softer">Não chegou? Veja a caixa de spam ou peça outro link.</p>

      {error && (
        <AuthAlert key={error.seq} tone="danger" icon={TriangleAlert} role="alert" className="mt-4">
          {error.message}
        </AuthAlert>
      )}
      {resentOnce && !error && (
        <p role="status" className="mt-4 rounded-lg bg-success-50 px-3 py-2 text-sm font-medium text-success-700">
          Pedido enviado de novo. Confira a caixa de entrada.
        </p>
      )}

      <div className="mt-5 space-y-2">
        {/* Desabilitado durante a contagem; o texto mostra o que falta. Não é anunciado a cada segundo: só o aviso `sr-only` abaixo, quando libera. */}
        <Button type="button" variant="primary" size="lg" className="w-full" disabled={waiting} loading={resend.isPending} onClick={onResend}>
          {waiting ? `Reenviar em ${remaining} s` : "Reenviar e-mail"}
        </Button>
        <span role="status" className="sr-only">
          {!waiting && "Você já pode reenviar o e-mail."}
        </span>
        <Button type="button" variant="ghost" className="min-h-11 w-full" onClick={onChangeEmail}>
          Usar outro e-mail
        </Button>
      </div>
    </Card>
  )
}

export function ForgotPassword() {
  const forgot = useForgotPassword()
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [formError, setFormError] = useState<{ message: string; seq: number } | null>(null)

  const {
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors },
  } = useForm<ForgotPasswordFormValues>({ resolver: zodResolver(forgotPasswordSchema), defaultValues: { email: "" } })

  const onSubmit = async ({ email }: ForgotPasswordFormValues) => {
    setFormError(null)
    try {
      await forgot.mutateAsync({ email })
      reset()
      setSentTo(email)
    } catch (err) {
      const mapped = forgotPasswordError(err)
      if (mapped.kind === "field") setError("email", { message: mapped.message }, { shouldFocus: true })
      else setFormError((prev) => ({ message: mapped.message, seq: (prev?.seq ?? 0) + 1 }))
    } finally {
      forgot.reset() // o e-mail digitado não fica em `variables` depois da resposta
    }
  }

  return (
    <AuthShell
      below={
        <p className="mt-4 text-center text-sm">
          <Link to="/login" className="inline-flex min-h-11 items-center gap-1.5 px-2 font-semibold text-primary hover:underline">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Voltar ao login
          </Link>
        </p>
      }
    >
      {sentTo !== null ? (
        <SentPanel email={sentTo} onChangeEmail={() => setSentTo(null)} />
      ) : (
        <Card className="animate-enter p-6 shadow-tinted-card sm:p-8">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-xs font-bold uppercase tracking-wide text-primary-700">
            <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
            Recuperar acesso
          </span>
          <h1 className="mt-3 text-2xl font-extrabold tracking-tight text-ink">Esqueceu a senha?</h1>
          <p className="mt-1.5 text-sm text-ink-softer">Informe o e-mail da sua conta e enviamos um link para criar uma nova senha.</p>

          <form className="mt-6 space-y-4" onSubmit={handleSubmit(onSubmit)} noValidate>
            <Input type="email" inputMode="email" label="E-mail" autoComplete="email" required error={errors.email?.message} {...register("email")} />

            {formError && (
              <AuthAlert key={formError.seq} tone="danger" icon={TriangleAlert} role="alert">
                {formError.message}
              </AuthAlert>
            )}

            {/* CTA único da tela = lima (D2). */}
            <Button type="submit" variant="lime" className="w-full" size="lg" loading={forgot.isPending}>
              Enviar link
            </Button>
          </form>
        </Card>
      )}
    </AuthShell>
  )
}
