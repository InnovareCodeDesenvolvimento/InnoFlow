import { type ReactNode, useId } from "react"
import type { LucideIcon } from "lucide-react"
import { CardDescription, CardHeader, CardTitle } from "@/components/ui/Card"
import { IconBadge } from "@/components/ui/IconBadge"
import { Switch } from "@/components/ui/Switch"

/** Cabeçalho de um cartão da tela: selo de ícone + título (h2: cada cartão é uma seção de 1º nível logo abaixo do h1) + descrição + um canto opcional (selo de estado). */
export function SectionHeader({ icon, title, description, aside }: { icon: LucideIcon; title: string; description?: string; aside?: ReactNode }) {
  return (
    <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <IconBadge icon={icon} size="md" tinted />
        <div className="min-w-0">
          <CardTitle as="h2">{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </div>
      </div>
      {aside && <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">{aside}</div>}
    </CardHeader>
  )
}

/** Um dado do "estado geral": rótulo pequeno em cima, valor embaixo (e uma linha de apoio opcional). */
export function Fact({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div className="min-w-0 space-y-1" data-testid={testId}>
      <dt className="text-xs font-bold uppercase tracking-wide text-ink-softer">{label}</dt>
      <dd className="space-y-0.5 text-sm font-semibold text-ink">{children}</dd>
    </div>
  )
}

/** Interruptor "ligado/desligado" com a explicação logo abaixo (o `aria-describedby` do interruptor). `error` aparece em vermelho e é anunciado. */
export function ToggleRow({
  id,
  name,
  enabled,
  onChange,
  disabled,
  help,
  error,
  children,
}: {
  id: string
  name: string
  enabled: boolean
  onChange: (enabled: boolean) => void
  disabled?: boolean
  help: string
  error?: string
  children?: ReactNode
}) {
  const helpId = useId()
  return (
    <div className="space-y-3 rounded-xl border border-border-subtle bg-muted/50 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink">{enabled ? "Ligado" : "Desligado"}</p>
          <p id={helpId} className="mt-0.5 text-xs text-ink-softer">
            {help}
          </p>
        </div>
        <Switch checked={enabled} onCheckedChange={onChange} disabled={disabled} aria-label={`Ligar ${name}`} aria-describedby={helpId} data-testid={`switch-${id}`} />
      </div>
      {error && (
        <p role="alert" className="text-xs font-medium text-danger-700" data-testid={`${id}-error`}>
          {error}
        </p>
      )}
      {children}
    </div>
  )
}
