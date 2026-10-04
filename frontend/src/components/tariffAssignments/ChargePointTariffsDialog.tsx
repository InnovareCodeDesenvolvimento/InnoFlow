import { useMemo } from "react"
import { CircleAlert, Tag, TriangleAlert } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/Dialog"
import { Badge } from "@/components/ui/Badge"
import { useTariffAssignmentContext } from "@/hooks/useTariffAssignmentContext"
import { CONNECTOR_TYPE_LABELS } from "@/lib/utils"
import { getChargePointCoverage } from "@/lib/tariffAssignments"
import { describeTariffPrice } from "@/lib/tariffAssignmentTargets"
import type { ChargePoint } from "@/types/api"
import { TariffAssignmentManager } from "./TariffAssignmentManager"

/**
 * "Tarifas deste carregador": responde duas perguntas em poucos cliques — (1) qual tarifa vale HOJE em cada tomada e (2) como vincular uma.
 * A tarifa efetiva é calculada aqui com a mesma regra do servidor (`lib/tariffAssignments.ts`, prioridade > escopo mais específico > mais recente);
 * quem decide de fato no início da recarga continua sendo o servidor. Sem nenhuma tarifa válida o QR do carregador não inicia recarga — o aviso é explícito.
 */
export function ChargePointTariffsDialog({ chargePoint, onOpenChange }: { chargePoint: ChargePoint | null; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={Boolean(chargePoint)} onOpenChange={onOpenChange}>
      <DialogContent widthClassName="sm:max-w-3xl">{chargePoint && <ChargePointTariffsBody chargePoint={chargePoint} />}</DialogContent>
    </Dialog>
  )
}

function ChargePointTariffsBody({ chargePoint }: { chargePoint: ChargePoint }) {
  const ctx = useTariffAssignmentContext()

  // Só o que pode valer neste carregador: o operador inteiro, o local dele, ele mesmo e as tomadas dele.
  const connectorIds = useMemo(() => new Set((chargePoint.connectors ?? []).map((c) => c.id)), [chargePoint.connectors])
  const relevant = useMemo(
    () =>
      ctx.assignments.filter(
        (a) =>
          a.operatorId === chargePoint.operatorId &&
          (a.scope === "OPERATOR" ||
            (a.scope === "SITE" && a.siteId === chargePoint.siteId) ||
            (a.scope === "CHARGE_POINT" && a.chargePointId === chargePoint.id) ||
            (a.scope === "CONNECTOR" && a.connectorId !== null && connectorIds.has(a.connectorId))),
      ),
    [ctx.assignments, chargePoint, connectorIds],
  )

  const coverage = useMemo(() => getChargePointCoverage(ctx.assignments, chargePoint), [ctx.assignments, chargePoint])
  const effectiveIds = useMemo(() => new Set(coverage.perConnector.flatMap((p) => (p.effective ? [p.effective.id] : []))), [coverage])
  const ready = !ctx.isLoading && ctx.error == null && !ctx.truncated

  return (
    <>
      <DialogHeader icon={Tag}>
        <DialogTitle>Tarifas de {chargePoint.ocppIdentity}</DialogTitle>
        <DialogDescription>
          Qual tarifa vale hoje em cada tomada e como vincular uma. {chargePoint.site?.name ? `Local: ${chargePoint.site.name}.` : ""}
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-5">
        {ready && (coverage.state === "none" || coverage.state === "partial") && (
          <div role="alert" className="flex items-start gap-3 rounded-xl border border-warning-600/40 bg-warning-50 p-4 text-warning-700" data-testid="no-tariff-alert">
            <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
            <p className="min-w-0 text-sm">
              <span className="font-bold">
                {coverage.state === "none" ? "Este carregador está sem tarifa." : `Faltou tarifa em ${coverage.uncovered} ${coverage.uncovered === 1 ? "tomada" : "tomadas"}.`}
              </span>{" "}
              Sem tarifa válida o QR não inicia a recarga. Vincule uma tarifa ao carregador, ao local ou a todo o operador.
            </p>
          </div>
        )}

        {ctx.truncated && (
          <p role="status" className="flex items-start gap-2 rounded-lg bg-muted px-3 py-2 text-sm text-ink-soft">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            Há muitos vínculos e a lista está incompleta — não dá para afirmar qual tarifa vale.
          </p>
        )}

        <section aria-label="Tarifa que vale hoje em cada tomada" className="space-y-2">
          <h3 className="text-sm font-bold text-ink">Vale hoje em cada tomada</h3>
          {coverage.state === "no-connectors" ? (
            <p className="text-sm text-ink-softer">Este carregador ainda não tem tomadas cadastradas. Cadastre os conectores para poder cobrar.</p>
          ) : (
            <ul className="divide-y divide-border-subtle rounded-xl border border-border-subtle" data-testid="effective-list">
              {coverage.perConnector.map(({ connector, effective }) => {
                const tariff = effective ? ctx.tariffsById.get(effective.tariffId) : undefined
                return (
                  <li key={connector.id} className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5 text-sm" data-testid="effective-row">
                    <span className="font-semibold text-ink">
                      Tomada #{connector.connectorId} <span className="font-normal text-ink-softer">· {CONNECTOR_TYPE_LABELS[connector.type]}</span>
                    </span>
                    {!ready ? (
                      <span className="text-ink-softer">—</span>
                    ) : effective ? (
                      <span className="text-right text-ink-soft">
                        <span className="font-medium text-ink">{effective.tariff?.name ?? tariff?.name ?? "Tarifa"}</span>
                        {tariff ? <span className="text-ink-softer"> · {describeTariffPrice(tariff)}</span> : null}
                      </span>
                    ) : (
                      <Badge variant="warning">Sem tarifa — o QR não inicia</Badge>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <TariffAssignmentManager
          assignments={relevant}
          isLoading={ctx.isLoading}
          error={ctx.error}
          onRetry={ctx.refetch}
          effectiveIds={effectiveIds}
          lookup={ctx.lookup}
          tariffsById={ctx.tariffsById}
          chargePoint={chargePoint}
          emptyDescription="Vincule uma tarifa a este carregador, ao local dele ou a todo o operador para liberar a recarga por QR."
        />
      </div>
    </>
  )
}
