import { useEffect, useId, useRef, useState } from "react"
import { Bell, CheckCircle2, Lock, TriangleAlert } from "lucide-react"
import { Alert } from "@/components/ui/Alert"
import { Button } from "@/components/ui/Button"
import { Input } from "@/components/ui/Input"
import { Skeleton } from "@/components/ui/Skeleton"
import { Switch } from "@/components/ui/Switch"
import { ProfileSection } from "@/components/perfil/ProfileSection"
import { useMeNotificationPreferences, useUpdateNotificationPreferences } from "@/hooks/useMeNotifications"
import {
  ALWAYS_ON_EXTRA,
  ALWAYS_ON_NOTICES,
  buildNotificationPatch,
  formStateFrom,
  NOTIFICATIONS_SAVED_MESSAGE,
  notificationLoadError,
  notificationSaveError,
  THRESHOLD_RANGE_HINT,
  type NotificationFormState,
} from "@/lib/notificationPrefs"
import type { MeNotificationPreferences } from "@/types/api"

/** Uma linha "texto + interruptor": o nome e a descrição do `role="switch"` vêm do texto ao lado (`aria-labelledby`/`aria-describedby`). */
function SwitchRow({ title, description, checked, onChange, disabled }: { title: string; description: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  const id = useId()
  return (
    <div className="flex min-h-11 items-start justify-between gap-4">
      <div className="min-w-0">
        <p id={`${id}-t`} className="text-sm font-semibold text-ink">
          {title}
        </p>
        <p id={`${id}-d`} className="mt-0.5 text-sm text-ink-softer">
          {description}
        </p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} aria-labelledby={`${id}-t`} aria-describedby={`${id}-d`} className="mt-0.5" />
    </div>
  )
}

function NotificationsForm({ saved }: { saved: MeNotificationPreferences }) {
  const update = useUpdateNotificationPreferences()
  const [form, setForm] = useState<NotificationFormState>(() => formStateFrom(saved))
  const [thresholdError, setThresholdError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const errorRef = useRef<HTMLDivElement>(null)
  const thresholdRef = useRef<HTMLInputElement>(null)
  // O aviso só existe no DOM depois do render que o mostra: o foco vai para ele aqui (e remonta a cada envio, porque o início do envio o desmonta).
  useEffect(() => {
    if (formError) errorRef.current?.focus()
  }, [formError])

  const savedState = formStateFrom(saved)
  const dirty = form.sessionReceiptEmail !== savedState.sessionReceiptEmail || form.lowBalanceEnabled !== savedState.lowBalanceEnabled || (form.lowBalanceEnabled && form.thresholdText.trim() !== savedState.thresholdText)

  const change = (patch: Partial<NotificationFormState>) => {
    setDone(false)
    setForm((f) => ({ ...f, ...patch }))
  }

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setDone(false)
    setFormError(null)
    setThresholdError(null)
    const result = buildNotificationPatch(form, saved)
    if (!result.ok) {
      setThresholdError(result.thresholdError)
      thresholdRef.current?.focus()
      return
    }
    if (!result.patch) return
    try {
      const next = await update.mutateAsync(result.patch)
      setForm(formStateFrom(next))
      setDone(true)
    } catch (err) {
      const mapped = notificationSaveError(err)
      if (mapped.threshold) {
        setThresholdError(mapped.message)
        thresholdRef.current?.focus()
      } else setFormError(mapped.message)
    }
  }

  return (
    <form className="space-y-5" onSubmit={onSubmit} noValidate>
      <div className="space-y-4">
        <SwitchRow
          title="Recibo da recarga por e-mail"
          description="Enviamos o resumo quando a recarga termina, inclusive quando ela é encerrada pelo sistema."
          checked={form.sessionReceiptEmail}
          onChange={(v) => change({ sessionReceiptEmail: v })}
        />
        <SwitchRow
          title="Aviso de saldo baixo"
          description="Avisamos por e-mail quando o saldo da carteira ficar abaixo do valor que você escolher."
          checked={form.lowBalanceEnabled}
          onChange={(v) => change({ lowBalanceEnabled: v })}
        />
        <Input
          ref={thresholdRef}
          label="Avisar quando o saldo ficar abaixo de (R$)"
          inputMode="decimal"
          autoComplete="off"
          value={form.thresholdText}
          disabled={!form.lowBalanceEnabled}
          onChange={(e) => {
            setThresholdError(null)
            change({ thresholdText: e.target.value })
          }}
          hint={form.lowBalanceEnabled ? THRESHOLD_RANGE_HINT : "Ligue o aviso de saldo baixo para escolher o valor."}
          error={thresholdError ?? undefined}
        />
      </div>

      <div className="rounded-card border border-border bg-muted/50 p-4" data-testid="always-on-notices">
        <p className="flex items-center gap-2 text-sm font-bold text-ink">
          <Lock className="h-4 w-4 text-ink-softer" aria-hidden="true" />
          Sempre ativos
        </p>
        <p className="mt-1 text-sm text-ink-softer">Estes avisos são de segurança e de cobrança, por isso não têm interruptor.</p>
        <ul className="mt-3 space-y-2 text-sm text-ink-soft">
          {ALWAYS_ON_NOTICES.map((n) => (
            <li key={n.title}>
              <span className="font-semibold text-ink">{n.title}:</span> {n.text}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-ink-softer">{ALWAYS_ON_EXTRA}</p>
      </div>

      {formError && (
        <Alert ref={errorRef} tone="danger" icon={TriangleAlert} role="alert" tabIndex={-1} className="outline-none focus-visible:ring-0 focus-visible:ring-offset-0">
          {formError}
        </Alert>
      )}
      {done && (
        <Alert tone="success" icon={CheckCircle2} role="status">
          {NOTIFICATIONS_SAVED_MESSAGE}
        </Alert>
      )}

      <Button type="submit" size="lg" className="w-full" loading={update.isPending} disabled={!dirty}>
        Salvar preferências
      </Button>
    </form>
  )
}

/**
 * Seção "Notificações" do perfil (L1.6): dois interruptores (recibo por e-mail; aviso de saldo baixo) + o limiar em R$ (só ativo com o aviso ligado) e o bloco "Sempre ativos"
 * (segurança e cobrança, sem interruptor - DL5). Carrega as preferências sozinha (`GET /api/me/notification-preferences`): a falha dela NÃO derruba o resto do perfil; vira um aviso
 * dentro da própria seção, com "Tentar de novo". Um único botão "Salvar preferências" manda SÓ o que mudou.
 */
export function NotificationsSection() {
  const prefs = useMeNotificationPreferences()
  return (
    <ProfileSection icon={Bell} title="Notificações" description="Escolha quais avisos por e-mail você quer receber.">
      {prefs.isLoading && (
        <div className="space-y-4" data-testid="notifications-loading" aria-hidden="true">
          <Skeleton className="h-14 rounded-control" />
          <Skeleton className="h-14 rounded-control" />
          <Skeleton className="h-[4.5rem] rounded-control" />
          <Skeleton className="h-36 rounded-card" />
          <Skeleton className="h-12 rounded-control" />
        </div>
      )}
      {prefs.isError && (
        <Alert tone="danger" icon={TriangleAlert} role="alert" data-testid="notifications-error">
          <p>{notificationLoadError(prefs.error)}</p>
          <Button type="button" variant="outline" size="touch-sm" className="mt-2" onClick={() => void prefs.refetch()} loading={prefs.isFetching}>
            Tentar de novo
          </Button>
        </Alert>
      )}
      {prefs.data && <NotificationsForm saved={prefs.data} />}
      {!prefs.isLoading && !prefs.isError && !prefs.data && (
        <Alert tone="danger" icon={TriangleAlert} role="alert">
          <p>Não foi possível carregar as suas preferências. Tente novamente.</p>
          <Button type="button" variant="outline" size="touch-sm" className="mt-2" onClick={() => void prefs.refetch()}>
            Tentar de novo
          </Button>
        </Alert>
      )}
    </ProfileSection>
  )
}
