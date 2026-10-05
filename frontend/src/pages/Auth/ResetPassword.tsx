import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { useForm, useWatch } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { ArrowLeft, Check, Circle, KeyRound, LinkIcon, TriangleAlert, X } from "lucide-react"
import { AuthAlert } from "@/components/auth/AuthAlert"
import { AuthShell } from "@/components/auth/AuthShell"
import { Button } from "@/components/ui/Button"
import { buttonVariants } from "@/components/ui/buttonVariants"
import { Card } from "@/components/ui/Card"
import { Input } from "@/components/ui/Input"
import { useNoReferrer } from "@/hooks/useNoReferrer"
import { useResetPassword } from "@/hooks/usePasswordReset"
import { PASSWORD_RESET_FLASH, readResetToken, RESET_LINK_INVALID_MESSAGE, resetPasswordError, scrubFragment } from "@/lib/passwordReset"
import { passwordRuleStatus, resetPasswordFormSchema, type ResetPasswordFormValues } from "@/schemas/passwordReset.schema"
import { PASSWORD_MAX_BYTES, PASSWORD_MIN_CHARS } from "@/schemas/profile.schema"
import { cn } from "@/lib/utils"

/**
 * "Redefinir senha" (L1.3, rota pública `/redefinir-senha#t=<token>`). O link do e-mail leva o token no FRAGMENTO: a tela o LÊ de `location.hash`, o manda no CORPO do
 * `POST /api/auth/password/reset` e APAGA o fragmento da URL assim que a tela monta (`scrubFragment`, `history.replaceState`) - depois disso o token só existe na memória deste
 * componente (nunca em storage, atributo, log nem querystring). A tela não tem link para fora e liga `no-referrer` enquanto está montada (`useNoReferrer`).
 *
 * Estados: sem token (ou fora do formato) -> "link inválido"; token presente -> formulário; `RESET_TOKEN_INVALID` -> volta para "link inválido" (o formulário some, a senha digitada
 * também); `VALIDATION_ERROR` -> erro no campo, formulário MANTIDO (o servidor não gasta o token); 429/503/rede/5xx -> aviso no formulário, token e campos mantidos.
 * Sucesso (204) -> `/login` com um aviso de uso único (estado de rota limpo na chegada). NUNCA auto-login: o 204 não traz sessão.
 *
 * Recarregar a página depois da leitura cai em "link inválido" (o fragmento já foi apagado): é a consequência desejada de não deixar o token na barra de endereço nem no histórico.
 */

function RuleItem({ ok, bad, children }: { ok: boolean; bad?: boolean; children: React.ReactNode }) {
  const Icon = bad ? X : ok ? Check : Circle
  return (
    <li className={cn("flex items-start gap-2 text-xs", bad ? "font-medium text-danger-700" : ok ? "text-success-700" : "text-ink-softer")}>
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" strokeWidth={ok || bad ? 3 : 2} />
      <span>
        {children}
        <span className="sr-only">{bad ? " (não atendido)" : ok ? " (atendido)" : " (pendente)"}</span>
      </span>
    </li>
  )
}

function InvalidLinkPanel() {
  const headingRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    headingRef.current?.focus()
  }, [])
  return (
    <Card className="animate-enter p-6 shadow-tinted-card sm:p-8">
      <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-xs font-bold uppercase tracking-wide text-primary-700">
        <LinkIcon className="h-3.5 w-3.5" aria-hidden="true" />
        Recuperar acesso
      </span>
      <h1 ref={headingRef} tabIndex={-1} className="mt-3 text-2xl font-extrabold tracking-tight text-ink outline-none focus-visible:ring-0 focus-visible:ring-offset-0">
        Link inválido
      </h1>
      <p className="mt-1.5 text-sm text-ink-softer">{RESET_LINK_INVALID_MESSAGE}</p>
      <Link to="/esqueci-senha" className={buttonVariants({ variant: "lime", size: "lg", className: "mt-6 w-full" })}>
        Pedir novo link
      </Link>
    </Card>
  )
}

export function ResetPassword() {
  const navigate = useNavigate()
  const reset = useResetPassword()
  // Lido UMA vez, de forma PURA (a leitura não mexe na URL): em StrictMode a função roda duas vezes e as duas veem o mesmo fragmento. Quem apaga é o efeito abaixo.
  const [token, setToken] = useState<string | null>(() => readResetToken(window.location.hash))
  const [show, setShow] = useState(false)
  const [formError, setFormError] = useState<{ message: string; seq: number } | null>(null)
  useNoReferrer()
  // Layout effect: o fragmento sai da barra de endereço antes do primeiro quadro pintado, não depois de um passeio por efeitos de outros componentes.
  useLayoutEffect(() => {
    scrubFragment()
    // Colar OUTRO link na barra de endereço estando já nesta tela só troca o fragmento (mesmo documento: nada recarrega). Sem isto o token novo seria ignorado e a tela ficaria com o velho.
    const onHashChange = () => {
      const next = readResetToken(window.location.hash)
      if (next !== null) {
        setToken(next)
        setFormError(null)
      }
      scrubFragment()
    }
    window.addEventListener("hashchange", onHashChange)
    return () => window.removeEventListener("hashchange", onHashChange)
  }, [])

  const {
    register,
    handleSubmit,
    setError,
    reset: resetForm,
    control,
    formState: { errors },
  } = useForm<ResetPasswordFormValues>({ resolver: zodResolver(resetPasswordFormSchema), defaultValues: { newPassword: "", confirmPassword: "" } })

  const newPassword = useWatch({ control, name: "newPassword" }) ?? ""
  const rules = passwordRuleStatus(newPassword)
  const typed = newPassword !== ""

  const onSubmit = async ({ newPassword }: ResetPasswordFormValues) => {
    if (token === null) return
    setFormError(null)
    try {
      await reset.mutateAsync({ token, newPassword })
      // O aviso viaja no estado da rota (não em storage) e o Login o apaga ao chegar. Sem sessão: o 204 não traz token.
      navigate("/login", { replace: true, state: { flash: PASSWORD_RESET_FLASH } })
    } catch (err) {
      const mapped = resetPasswordError(err)
      if (mapped.kind === "invalid-link") {
        setToken(null)
        resetForm()
        setShow(false)
      } else if (mapped.kind === "field") {
        setError("newPassword", { message: mapped.message }, { shouldFocus: true })
      } else {
        setFormError((prev) => ({ message: mapped.message, seq: (prev?.seq ?? 0) + 1 }))
      }
    } finally {
      reset.reset() // token e senha nova não ficam guardados em `variables` depois da resposta
    }
  }

  const type = show ? "text" : "password"

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
      {token === null ? (
        <InvalidLinkPanel />
      ) : (
        <Card className="animate-enter p-6 shadow-tinted-card sm:p-8">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-xs font-bold uppercase tracking-wide text-primary-700">
            <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
            Recuperar acesso
          </span>
          <h1 className="mt-3 text-2xl font-extrabold tracking-tight text-ink">Crie uma nova senha</h1>
          <p className="mt-1.5 text-sm text-ink-softer">Escolha uma senha que você não usa em outros lugares. Depois você entra com ela.</p>

          <form className="mt-6 space-y-4" onSubmit={handleSubmit(onSubmit)} noValidate>
            <div className="space-y-2">
              <Input type={type} label="Nova senha" autoComplete="new-password" required error={errors.newPassword?.message} {...register("newPassword")} />
              <ul aria-label="Requisitos da nova senha" className="space-y-1 px-0.5">
                <RuleItem ok={typed && rules.minChars}>Pelo menos {PASSWORD_MIN_CHARS} caracteres</RuleItem>
                <RuleItem ok={typed && rules.maxBytes} bad={typed && !rules.maxBytes}>
                  No máximo {PASSWORD_MAX_BYTES} bytes (acentos e emojis ocupam mais de um)
                  {typed && rules.bytes > 60 ? ` - você usou ${rules.bytes}` : ""}
                </RuleItem>
              </ul>
            </div>
            <Input type={type} label="Repita a nova senha" autoComplete="new-password" required error={errors.confirmPassword?.message} {...register("confirmPassword")} />

            <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm font-medium text-ink-soft">
              <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} className="h-5 w-5 shrink-0 cursor-pointer accent-primary" />
              Mostrar senhas
            </label>

            {formError && (
              <AuthAlert key={formError.seq} tone="danger" icon={TriangleAlert} role="alert">
                {formError.message}
              </AuthAlert>
            )}

            {/* CTA único da tela = lima (D2). */}
            <Button type="submit" variant="lime" className="w-full" size="lg" loading={reset.isPending}>
              Redefinir senha
            </Button>
          </form>
        </Card>
      )}
    </AuthShell>
  )
}
