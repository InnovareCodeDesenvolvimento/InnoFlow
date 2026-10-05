import { useId } from "react"
import { CheckCircle2, CircleAlert, CircleMinus, type LucideIcon } from "lucide-react"
import { Badge } from "@/components/ui/Badge"
import { CardHeader, CardTitle } from "@/components/ui/Card"
import { IconBadge } from "@/components/ui/IconBadge"
import { Switch } from "@/components/ui/Switch"

type ChannelState = { enabled: boolean; active: boolean; source: "database" | "env" | "none" }

const SOURCE_LABEL = { database: "Configurado no painel", env: "Vem do servidor (env)", none: "Não configurado" } as const

/** Cabeçalho do cartão de um canal: ícone + título (h2) + estado (funcionando / com problema / desligado) e de onde vale a configuração. */
export function ChannelHeader({ icon, title, testId, state }: { icon: LucideIcon; title: string; testId: string; state: ChannelState }) {
  return (
    <CardHeader className="flex flex-row items-start justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <IconBadge icon={icon} size="md" tinted />
        <CardTitle as="h2">{title}</CardTitle>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        <Badge variant="neutral" data-testid={`${testId}-source`}>
          {SOURCE_LABEL[state.source]}
        </Badge>
        {state.enabled && state.active ? (
          <Badge variant="success" data-testid={`${testId}-status`}>
            <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
            Funcionando
          </Badge>
        ) : state.enabled ? (
          <Badge variant="danger" data-testid={`${testId}-status`}>
            <CircleAlert className="h-3 w-3" aria-hidden="true" />
            Com problema
          </Badge>
        ) : (
          <Badge variant="neutral" data-testid={`${testId}-status`}>
            <CircleMinus className="h-3 w-3" aria-hidden="true" />
            Desligado
          </Badge>
        )}
      </div>
    </CardHeader>
  )
}

/** Interruptor "ligado/desligado" do canal. Desligar é sempre permitido; ligar exige canal completo — quem decide é o servidor (409 `CHANNEL_INCOMPLETE`, com as pendências). */
export function EnabledRow({ id, name, enabled, onChange, disabled, help }: { id: string; name: string; enabled: boolean; onChange: (enabled: boolean) => void; disabled?: boolean; help: string }) {
  const helpId = useId()
  return (
    <div className="flex items-start justify-between gap-4 rounded-xl border border-border-subtle bg-muted/50 p-4">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-ink">{enabled ? "Ligado" : "Desligado"}</p>
        <p id={helpId} className="mt-0.5 text-xs text-ink-softer">
          {help}
        </p>
      </div>
      <Switch checked={enabled} onCheckedChange={onChange} disabled={disabled} aria-label={`Ligar ${name}`} aria-describedby={helpId} data-testid={`switch-${id}`} />
    </div>
  )
}
