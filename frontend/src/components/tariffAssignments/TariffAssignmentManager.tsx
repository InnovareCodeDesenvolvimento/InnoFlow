import { useState } from "react"
import { History, Link2, Pencil, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/Button"
import { Badge } from "@/components/ui/Badge"
import { ConfirmDialog } from "@/components/ui/ConfirmDialog"
import { EmptyState } from "@/components/ui/EmptyState"
import { ErrorState } from "@/components/ui/ErrorState"
import { Skeleton } from "@/components/ui/Skeleton"
import { useRemoveTariffAssignment } from "@/hooks/useTariffAssignments"
import { getApiErrorMessage } from "@/services/api"
import { formatDate } from "@/lib/utils"
import { SCOPE_LABELS, getAssignmentStatus, type AssignmentStatus } from "@/lib/tariffAssignments"
import { describeAssignmentTarget, describeTariffPrice, type AssignmentLookup } from "@/lib/tariffAssignmentTargets"
import type { ChargePoint, Tariff, TariffAssignment } from "@/types/api"
import { TariffAssignmentFormDialog } from "./TariffAssignmentFormDialog"

const STATUS_BADGE: Record<AssignmentStatus, { label: string; variant: "success" | "info" | "neutral" }> = {
  active: { label: "Vigente", variant: "success" },
  scheduled: { label: "Agendado", variant: "info" },
  expired: { label: "Encerrado", variant: "neutral" },
}

/**
 * Lista + ações dos vínculos de tarifa (vincular, editar, remover), reaproveitada pela tela "Tarifas do carregador" e por "Onde esta tarifa vale".
 * Quem chama decide QUAIS vínculos mostrar (`assignments`) e quais "valem hoje" (`effectiveIds`, calculado por `lib/tariffAssignments`).
 * Remover = `DELETE`, que no servidor só expira o vínculo (`validTo = agora`): ele passa para "Encerrados", não some.
 */
export function TariffAssignmentManager({
  assignments,
  isLoading,
  error,
  onRetry,
  effectiveIds,
  lookup,
  tariffsById,
  showTariff = true,
  chargePoint,
  fixedTariffId,
  emptyDescription,
}: {
  assignments: TariffAssignment[]
  isLoading: boolean
  error: unknown | null
  onRetry: () => void
  effectiveIds: ReadonlySet<string>
  lookup: AssignmentLookup
  tariffsById: ReadonlyMap<string, Tariff>
  showTariff?: boolean
  chargePoint?: ChargePoint
  fixedTariffId?: string
  emptyDescription: string
}) {
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<TariffAssignment | null>(null)
  const [removing, setRemoving] = useState<TariffAssignment | null>(null)
  const [showExpired, setShowExpired] = useState(false)
  const removeAssignment = useRemoveTariffAssignment()

  const now = new Date()
  const current = assignments.filter((a) => getAssignmentStatus(a, now) !== "expired")
  const expired = assignments.filter((a) => getAssignmentStatus(a, now) === "expired")
  const visible = showExpired ? [...current, ...expired] : current

  const openCreate = () => {
    setEditing(null)
    setFormOpen(true)
  }

  const confirmRemove = async () => {
    if (!removing) return
    try {
      await removeAssignment.mutateAsync(removing.id)
      toast.success("Vínculo encerrado.")
      setRemoving(null)
    } catch (err) {
      toast.error("Não foi possível remover o vínculo.", { description: getApiErrorMessage(err) })
    }
  }

  const removingTarget = removing ? describeAssignmentTarget(removing, lookup) : null

  return (
    <section aria-label="Vínculos de tarifa" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-bold text-ink">Vínculos</h3>
        <Button size="sm" onClick={openCreate} disabled={isLoading || Boolean(error)}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          Vincular tarifa
        </Button>
      </div>

      {isLoading && (
        <div className="space-y-2" aria-busy="true" aria-label="Carregando vínculos">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      )}

      {!isLoading && error != null && <ErrorState message={getApiErrorMessage(error, "Não foi possível carregar os vínculos de tarifa.")} onRetry={onRetry} />}

      {!isLoading && error == null && visible.length === 0 && (
        <EmptyState
          icon={Link2}
          title="Nenhuma tarifa vinculada"
          description={emptyDescription}
          action={
            <Button onClick={openCreate}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              Vincular tarifa
            </Button>
          }
        />
      )}

      {!isLoading && error == null && visible.length > 0 && (
        <ul className="space-y-2" data-testid="assignment-list">
          {visible.map((a) => {
            const status = getAssignmentStatus(a, now)
            const target = describeAssignmentTarget(a, lookup)
            const tariff = tariffsById.get(a.tariffId)
            const tariffName = a.tariff?.name ?? tariff?.name ?? "Tarifa"
            const isEffective = effectiveIds.has(a.id)
            return (
              <li
                key={a.id}
                className={`rounded-xl border p-3.5 ${isEffective ? "border-primary/40 bg-primary/5" : "border-border-subtle bg-surface"} ${status === "expired" ? "opacity-70" : ""}`}
                data-testid="assignment-item"
                data-effective={isEffective || undefined}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-[11px] font-bold uppercase tracking-wide text-ink-softer">{SCOPE_LABELS[a.scope]}</p>
                    <p className="break-words font-semibold text-ink">{target.name}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {isEffective && <Badge variant="primary">Vale hoje</Badge>}
                    <Badge variant={STATUS_BADGE[status].variant}>{STATUS_BADGE[status].label}</Badge>
                  </div>
                </div>

                <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-sm text-ink-soft sm:grid-cols-3">
                  {showTariff && (
                    <div className="min-w-0">
                      <dt className="text-xs text-ink-softer">Tarifa</dt>
                      <dd className="break-words">
                        <span className="font-medium text-ink">{tariffName}</span>
                        {tariff ? <span className="text-ink-softer"> · {describeTariffPrice(tariff)}</span> : null}
                        {tariff && !tariff.active ? <span className="font-medium text-warning-700"> (desativada)</span> : null}
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt className="text-xs text-ink-softer">Prioridade</dt>
                    <dd>{a.priority}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-ink-softer">Vigência</dt>
                    <dd>
                      {formatDate(a.validFrom)} até {a.validTo ? formatDate(a.validTo) : "sem data final"}
                    </dd>
                  </div>
                </dl>

                {isEffective && tariff && !tariff.active && (
                  <p className="mt-2 text-xs text-warning-700" role="note">
                    Esta tarifa está desativada, mas o servidor ainda a aplica enquanto o vínculo existir. Para parar de cobrá-la, remova o vínculo.
                  </p>
                )}

                <div className="mt-2 flex justify-end gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Editar vínculo: ${tariffName} em ${target.name}`}
                    title="Editar"
                    onClick={() => {
                      setEditing(a)
                      setFormOpen(true)
                    }}
                  >
                    <Pencil className="h-4 w-4" aria-hidden="true" />
                  </Button>
                  {status !== "expired" && (
                    <Button variant="ghost" size="icon" aria-label={`Remover vínculo: ${tariffName} em ${target.name}`} title="Remover" onClick={() => setRemoving(a)}>
                      <Trash2 className="h-4 w-4 text-danger-600" aria-hidden="true" />
                    </Button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {!isLoading && error == null && expired.length > 0 && (
        <Button variant="ghost" size="sm" aria-pressed={showExpired} onClick={() => setShowExpired((v) => !v)}>
          <History className="h-4 w-4" aria-hidden="true" />
          {showExpired ? "Ocultar encerrados" : `Mostrar encerrados (${expired.length})`}
        </Button>
      )}

      <TariffAssignmentFormDialog open={formOpen} onOpenChange={setFormOpen} assignment={editing} chargePoint={chargePoint} fixedTariffId={fixedTariffId} />

      <ConfirmDialog
        open={Boolean(removing)}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Remover "${removing?.tariff?.name ?? "o vínculo"}" de ${removingTarget?.name ?? ""}?`}
        description="A tarifa deixa de valer aqui a partir de agora e o vínculo vai para os encerrados (o histórico fica). Se nenhuma outra tarifa cobrir a tomada, o QR deixa de iniciar recarga."
        confirmLabel="Remover vínculo"
        loading={removeAssignment.isPending}
        onConfirm={confirmRemove}
      />
    </section>
  )
}
