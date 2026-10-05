import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react"
import { ArrowRight, Check, ShieldCheck, X } from "lucide-react"
import { Button } from "@/components/ui/Button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/Dialog"
import { Input } from "@/components/ui/Input"

export interface ChangeSummaryItem {
  key: string
  label: string
  /** Valor anterior (omitido para segredos — nunca há valor a mostrar). */
  from?: string
  /** Valor novo; para segredos é um texto fixo ("Será substituída"), NUNCA o valor digitado. */
  to: string
  secret?: boolean
}

/**
 * Resumo do que vai ser enviado, antes do PUT, + step-up de SENHA — compartilhado pelas telas do Admin que mexem em configuração sensível (Gateway e Comunicação).
 * Segredos aparecem só como "Será substituída" — o valor digitado nunca é renderizado aqui (nem em atributo). `extra` abre espaço para um aviso específico da tela
 * (ex.: cobrança real em produção); `destructive` pinta o botão de confirmar de perigo.
 *
 * Senha atual: vive SÓ no estado local deste diálogo (que desmonta ao fechar, e com ele a senha), é entregue a `onConfirm` e zerada NA HORA — então nem durante a
 * requisição, nem depois de um erro, ela fica no campo. Não é aparada (senha pode ter espaço). "Confirmar" só habilita com algo digitado.
 * `passwordError` (403 `INVALID_CURRENT_PASSWORD`) aparece no próprio diálogo e devolve o foco ao campo; o rascunho da tela não é tocado.
 */
export function ConfirmSaveDialog({
  title,
  description,
  passwordHint,
  items,
  extra,
  destructive = false,
  confirmLabel = "Confirmar e salvar",
  cancelLabel = "Cancelar",
  loading,
  passwordError,
  onConfirm,
  onCancel,
}: {
  title: string
  description: string
  passwordHint: string
  items: ChangeSummaryItem[]
  extra?: ReactNode
  destructive?: boolean
  /** Texto do botão de confirmar (padrão "Confirmar e salvar"); outras ações com step-up de senha (gerar chave, conectar o Google) usam o verbo delas. */
  confirmLabel?: string
  /** Texto do botão de desistir (padrão: "Cancelar"). Quando a AÇÃO é cancelar algo, use "Voltar" para não haver dois "Cancelar" com sentidos opostos. */
  cancelLabel?: string
  loading: boolean
  passwordError?: string | null
  onConfirm: (currentPassword: string) => void
  onCancel: () => void
}) {
  const [password, setPassword] = useState("")
  const passwordRef = useRef<HTMLInputElement>(null)
  const formId = useId()

  // Senha errada: o campo já foi zerado ao enviar; só devolve o foco para digitar de novo.
  useEffect(() => {
    if (passwordError) passwordRef.current?.focus()
  }, [passwordError])

  const canConfirm = password.length > 0 && !loading

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()
    if (!canConfirm) return
    const typed = password
    setPassword("")
    onConfirm(typed)
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !loading && onCancel()}>
      <DialogContent widthClassName="sm:max-w-lg">
        <DialogHeader icon={ShieldCheck}>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <dl className="divide-y divide-border-subtle rounded-xl border border-border bg-surface" data-testid="save-summary">
          {items.map((item) => (
            <div key={item.key} className="flex flex-col gap-0.5 px-3.5 py-2.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
              <dt className="text-sm font-medium text-ink-soft">{item.label}</dt>
              <dd className="min-w-0 break-words text-sm font-semibold text-ink sm:text-right">
                {item.from !== undefined && (
                  <>
                    <span className="font-normal text-ink-softer">{item.from}</span>
                    <ArrowRight className="mx-1.5 inline h-3.5 w-3.5 text-ink-subtle" aria-label="para" />
                  </>
                )}
                <span className={item.secret ? "italic" : undefined}>{item.to}</span>
              </dd>
            </div>
          ))}
        </dl>

        {extra}

        <form id={formId} onSubmit={handleSubmit} className="mt-4" noValidate>
          <Input
            ref={passwordRef}
            type="password"
            name="currentPassword"
            label="Sua senha atual"
            required
            autoComplete="current-password"
            data-lpignore="true"
            data-1p-ignore="true"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={loading}
            error={passwordError ?? undefined}
            hint={passwordHint}
          />
        </form>

        <DialogFooter>
          <Button type="button" variant="outline" size="touch" onClick={onCancel} disabled={loading}>
            <X className="h-4 w-4" aria-hidden="true" />
            {cancelLabel}
          </Button>
          <Button type="submit" form={formId} size="touch" variant={destructive ? "destructive" : "default"} loading={loading} disabled={password.length === 0}>
            {!loading && <Check className="h-4 w-4" aria-hidden="true" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
