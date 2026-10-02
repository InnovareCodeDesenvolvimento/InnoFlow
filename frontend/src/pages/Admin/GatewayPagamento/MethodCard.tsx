import { useId } from "react"
import { CheckCircle2, CircleAlert, type LucideIcon } from "lucide-react"
import { Badge } from "@/components/ui/Badge"
import { Card, CardContent } from "@/components/ui/Card"
import { Switch } from "@/components/ui/Switch"
import { readinessSummary } from "@/lib/paymentGateway"
import type { PaymentMethodReadiness } from "@/types/api"
import { RequirementList } from "./RequirementList"

/**
 * Prontidão de UM meio de pagamento (Pix ou Cartão) + interruptor de
 * habilitar. "Pronto" = todos os pré-requisitos presentes NO QUE JÁ ESTÁ
 * SALVO (o servidor calcula; o que está só no rascunho não conta). O
 * interruptor só LIGA com `ready`, mas DESLIGAR é sempre permitido — senão um
 * meio habilitado que perdeu um pré-requisito ficaria sem como ser desligado.
 */
export function MethodCard({
  id,
  title,
  icon: Icon,
  readiness,
  enabled,
  onEnabledChange,
  offEffect,
  disabled,
}: {
  /** Prefixo estável de testid/ids ("pix" | "card"). */
  id: "pix" | "card"
  title: string
  icon: LucideIcon
  readiness: PaymentMethodReadiness
  /** Valor EFETIVO (rascunho sobre o salvo). */
  enabled: boolean
  onEnabledChange: (enabled: boolean) => void
  /** Frase do que "desabilitar" bloqueia — só NOVAS cobranças/cadastros. */
  offEffect: string
  disabled?: boolean
}) {
  const helpId = useId()
  const blocked = !readiness.ready && !enabled

  return (
    <Card className="card-premium" data-testid={`method-${id}`}>
      <CardContent className="space-y-4 p-5 sm:p-6">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="shadow-tinted-primary flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary" aria-hidden="true">
              <Icon className="h-5 w-5" />
            </span>
            <h2 className="text-base font-bold text-ink">
              {title}
            </h2>
          </div>
          <Badge variant={readiness.ready ? "success" : "warning"} className="whitespace-nowrap" data-testid={`method-${id}-readiness`}>
            {readiness.ready ? <CheckCircle2 className="h-3 w-3" aria-hidden="true" /> : <CircleAlert className="h-3 w-3" aria-hidden="true" />}
            {readinessSummary(readiness)}
          </Badge>
        </div>

        {!readiness.ready && <RequirementList codes={readiness.missing} testId={`method-${id}-missing`} />}

        <div className="flex items-start justify-between gap-4 rounded-xl border border-border-subtle bg-muted/50 p-3.5">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink">
              {enabled ? "Habilitado" : "Desabilitado"}
            </p>
            <p id={helpId} className="mt-0.5 text-xs text-ink-softer">
              {blocked ? "Só pode ser habilitado quando todos os itens acima estiverem resolvidos e salvos. " : ""}
              {offEffect}
            </p>
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={onEnabledChange}
            disabled={blocked || disabled}
            aria-label={`Habilitar ${title}`}
            aria-describedby={helpId}
            data-testid={`switch-${id}`}
          />
        </div>
      </CardContent>
    </Card>
  )
}
