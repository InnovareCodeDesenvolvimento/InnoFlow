import { useEffect, useMemo, useRef, useState } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { CheckCircle2, KeyRound, TriangleAlert } from "lucide-react"
import { Alert } from "@/components/ui/Alert"
import { Button } from "@/components/ui/Button"
import { Input } from "@/components/ui/Input"
import { ProfileSection } from "@/components/perfil/ProfileSection"
import { useChangePassword } from "@/hooks/useMeProfile"
import { passwordChangeError } from "@/lib/profileErrors"
import { buildChangePasswordSchema, PASSWORD_MIN_CHARS, type ChangePasswordFormValues } from "@/schemas/profile.schema"

export const PASSWORD_CHANGED_MESSAGE = "Senha alterada. Neste aparelho você continua conectado; nos outros será preciso entrar de novo."
export const PASSWORD_DEFINED_MESSAGE = "Senha definida. Agora você também pode entrar com e-mail e senha. Nos outros aparelhos será preciso entrar de novo."

/**
 * Troca de senha (`POST /api/auth/password`). Conta COM senha pede a atual; conta só-Google (`hasPassword=false`) DEFINE a primeira, sem campo de senha atual.
 * Regras da nova senha = as do servidor (10 caracteres a 72 bytes). Depois do sucesso o servidor revoga todos os tokens e devolve um novo - o hook já o grava
 * (`useChangePassword`), então a tela NÃO desloga: segue na sessão nova, e só os OUTROS aparelhos precisam entrar de novo (a mensagem diz isso).
 * Erro de um campo (senha atual errada, nova igual à atual) vai no campo, com o foco nele; rede/5xx/429 vão num aviso do formulário, com o foco nele.
 * "Mostrar senhas" é um único controle para os três campos (um alvo de toque de 44 px, em vez de três olhos de 16 px dentro dos campos).
 */
export function ChangePasswordForm({ hasPassword }: { hasPassword: boolean }) {
  const change = useChangePassword()
  const [show, setShow] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const errorRef = useRef<HTMLDivElement>(null)
  // O aviso só existe no DOM depois do render que o mostra: o foco vai para ele aqui, não no `catch` (o `setFormError(null)` do início de cada envio o desmonta, então
  // repetir o MESMO erro também remonta e refoca).
  useEffect(() => {
    if (formError) errorRef.current?.focus()
  }, [formError])
  // O schema depende de `hasPassword`: sem memo, cada render criaria um schema novo e o resolver seria refeito à toa.
  const schema = useMemo(() => buildChangePasswordSchema(hasPassword), [hasPassword])

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors },
  } = useForm<ChangePasswordFormValues>({
    resolver: zodResolver(schema),
    defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" },
  })

  const onSubmit = async (values: ChangePasswordFormValues) => {
    setDone(null)
    setFormError(null)
    try {
      await change.mutateAsync(hasPassword ? { currentPassword: values.currentPassword, newPassword: values.newPassword } : { newPassword: values.newPassword })
      reset()
      setShow(false)
      setDone(hasPassword ? PASSWORD_CHANGED_MESSAGE : PASSWORD_DEFINED_MESSAGE)
    } catch (err) {
      const mapped = passwordChangeError(err)
      if (mapped.field) {
        setError(mapped.field, { message: mapped.message }, { shouldFocus: true })
        return
      }
      setFormError(mapped.message)
    } finally {
      change.reset() // a senha atual e a nova não ficam guardadas em `variables` (ver `useChangePassword`)
    }
  }

  const type = show ? "text" : "password"

  return (
    <ProfileSection
      icon={KeyRound}
      title={hasPassword ? "Alterar senha" : "Definir senha"}
      description={hasPassword ? "Use uma senha que você não usa em outros lugares." : "Sua conta entra pelo Google. Defina uma senha para também entrar com e-mail e senha."}
    >
      <form className="space-y-4" onSubmit={handleSubmit(onSubmit)} onChange={() => setDone(null)} noValidate>
        {hasPassword && (
          <Input type={type} label="Senha atual" autoComplete="current-password" required error={errors.currentPassword?.message} {...register("currentPassword")} />
        )}
        <Input
          type={type}
          label="Nova senha"
          autoComplete="new-password"
          required
          hint={`Mínimo de ${PASSWORD_MIN_CHARS} caracteres.`}
          error={errors.newPassword?.message}
          {...register("newPassword")}
        />
        <Input type={type} label="Repita a nova senha" autoComplete="new-password" required error={errors.confirmPassword?.message} {...register("confirmPassword")} />

        <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm font-medium text-ink-soft">
          <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} className="h-5 w-5 shrink-0 cursor-pointer accent-primary" />
          Mostrar senhas
        </label>

        {formError && (
          <Alert ref={errorRef} tone="danger" icon={TriangleAlert} role="alert" tabIndex={-1} className="outline-none">
            {formError}
          </Alert>
        )}
        {done && (
          <Alert tone="success" icon={CheckCircle2} role="status">
            {done}
          </Alert>
        )}

        <Button type="submit" size="lg" className="w-full" loading={change.isPending}>
          {hasPassword ? "Alterar senha" : "Definir senha"}
        </Button>
      </form>
    </ProfileSection>
  )
}
