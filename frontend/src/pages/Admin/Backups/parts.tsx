import { type ReactNode, useId, useState } from "react"
import { Info } from "lucide-react"
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card"
import { Switch } from "@/components/ui/Switch"
import { cn } from "@/lib/utils"

/**
 * Botão "ⓘ" que abre/fecha uma explicação (padrão do InnoChat). Botão de verdade com `aria-expanded` e `aria-controls`; o rótulo é fixo ("Como funciona: …") e quem diz se está aberto é o
 * `aria-expanded`. Alvo de toque de 44 px (o círculo visível tem 32 px, como no InnoChat); o `-m` devolve o espaço para o círculo alinhar com o canto do cartão.
 */
export function HelpToggle({ open, onToggle, panelId, label, testId, className }: { open: boolean; onToggle: () => void; panelId: string; label: string; testId: string; className?: string }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={panelId}
      aria-label={`Como funciona: ${label}`}
      className={cn("group/help inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus", className)}
      data-testid={testId}
    >
      <span
        aria-hidden="true"
        className={cn(
          "flex h-8 w-8 items-center justify-center rounded-full border border-border bg-surface text-ink-soft transition-colors group-hover/help:bg-muted",
          open && "border-primary-600 bg-primary-50 text-primary-700",
        )}
      >
        <Info className="h-[18px] w-[18px]" />
      </span>
    </button>
  )
}

/** O painel da explicação: sempre no DOM (para o `aria-controls` apontar para algo), escondido com `hidden` enquanto fechado. */
export function HelpPanel({ id, open, children, testId, className }: { id: string; open: boolean; children: ReactNode; testId: string; className?: string }) {
  return (
    <div id={id} hidden={!open} className={cn("space-y-2 rounded-xl border border-border-subtle bg-muted/50 p-4 text-sm text-ink-soft", className)} data-testid={testId}>
      {children}
    </div>
  )
}

/**
 * Cartão da tela no padrão do InnoChat: título (h2) + subtítulo + "ⓘ" no canto superior direito que abre a explicação logo abaixo do cabeçalho. O estado aberto/fechado é do cartão
 * (estado local: nada disso interessa a outros componentes). `className` vai no cartão (`h-full` para igualar a altura na grade).
 */
export function HelpCard({
  testId,
  title,
  description,
  help,
  children,
  className,
}: {
  testId: string
  title: string
  description: string
  help: ReactNode
  children: ReactNode
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  return (
    <Card data-testid={testId} className={cn("flex flex-col", className)}>
      <CardHeader className="flex items-start justify-between gap-3 pb-4 sm:pb-4">
        <div className="min-w-0">
          <CardTitle as="h2">{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
        <HelpToggle open={open} onToggle={() => setOpen((v) => !v)} panelId={panelId} label={title} testId={`${testId}-help`} className="-mr-2.5 -mt-2.5" />
      </CardHeader>
      <HelpPanel id={panelId} open={open} testId={`${testId}-help-panel`} className="mx-5 mb-4 sm:mx-6">
        {help}
      </HelpPanel>
      {children}
    </Card>
  )
}

/** Um dado da faixa de estado: rótulo pequeno em cima, valor embaixo (e linhas de apoio opcionais). */
export function Fact({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div className="min-w-0 space-y-1" data-testid={testId}>
      <dt className="text-xs font-bold uppercase tracking-wide text-ink-softer">{label}</dt>
      <dd className="space-y-0.5 text-sm font-semibold text-ink">{children}</dd>
    </div>
  )
}

/** Interruptor "ligado/desligado" com a explicação logo abaixo do nome (o `aria-describedby` do interruptor). `error` aparece em vermelho e é anunciado. */
export function ToggleRow({
  id,
  label,
  name,
  enabled,
  onChange,
  disabled,
  help,
  error,
  children,
}: {
  id: string
  /** O que se vê ao lado do interruptor ("Backup automático"). */
  label: string
  /** O nome acessível: "Ligar {name}". */
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
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink">{label}</p>
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
