import { useState } from "react"
import { Pencil, Plug, Plus, Tag, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { PageHeader } from "@/components/painel/PageHeader"
import { Button } from "@/components/ui/Button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table"
import { AdminErrorState as ErrorState, AdminFirstUseState } from "@/components/admin/AdminStates"
import { TableSkeleton } from "@/components/ui/Skeleton"
import { Pagination } from "@/components/ui/Pagination"
import { ConfirmDialog } from "@/components/ui/ConfirmDialog"
import { ConnectorStatusBadge } from "@/components/connectors/ConnectorStatusBadge"
import { Badge } from "@/components/ui/Badge"
import { useChargePoints } from "@/hooks/useChargePoints"
import { useConnectors, useDeleteConnector } from "@/hooks/useConnectors"
import { useAllTariffAssignments } from "@/hooks/useTariffAssignments"
import { ChargePointTariffsDialog } from "@/components/tariffAssignments/ChargePointTariffsDialog"
import { resolveEffectiveAssignment } from "@/lib/tariffAssignments"
import { getApiErrorMessage } from "@/services/api"
import { CONNECTOR_TYPE_LABELS, formatPowerKw } from "@/lib/utils"
import { ConnectorFormDialog } from "./ConnectorFormDialog"
import type { ChargePoint, Connector } from "@/types/api"

const PAGE_SIZE = 20

export default function ConnectorsPage() {
  const [page, setPage] = useState(1)
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Connector | null>(null)
  const [deleting, setDeleting] = useState<Connector | null>(null)
  const [tariffsFor, setTariffsFor] = useState<ChargePoint | null>(null)

  const { data, isLoading, isError, error, refetch } = useConnectors({ page, pageSize: PAGE_SIZE })
  const deleteConnector = useDeleteConnector()
  const assignmentsQuery = useAllTariffAssignments()
  const chargePointsQuery = useChargePoints({ page: 1, pageSize: 100 })
  const chargePointById = new Map((chargePointsQuery.data?.items ?? []).map((cp) => [cp.id, cp]))

  /** `undefined` = ainda não dá para afirmar (carregando, erro, lista truncada ou carregador fora da lista); `null` = sem tarifa. */
  const effectiveTariffOf = (c: Connector) => {
    const cp = chargePointById.get(c.chargePointId)
    if (!cp || !assignmentsQuery.data || assignmentsQuery.data.truncated) return undefined
    return resolveEffectiveAssignment(assignmentsQuery.data.items, cp, c)
  }

  const openCreate = () => {
    setEditing(null)
    setFormOpen(true)
  }
  const openEdit = (c: Connector) => {
    setEditing(c)
    setFormOpen(true)
  }

  const confirmDelete = async () => {
    if (!deleting) return
    try {
      await deleteConnector.mutateAsync(deleting.id)
      toast.success("Conector marcado como indisponível.")
      setDeleting(null)
    } catch (err) {
      toast.error("Não foi possível remover.", { description: getApiErrorMessage(err) })
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Conectores"
        description="Cada tomada de um ponto de recarga — tipo, potência e status."
        icon={Plug}
        actions={
          <Button variant="lime" onClick={openCreate}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Novo conector
          </Button>
        }
      />

      {isLoading && <TableSkeleton cols={6} />}
      {isError && <ErrorState message={getApiErrorMessage(error, "Não foi possível carregar os conectores.")} onRetry={() => refetch()} />}

      {!isLoading && !isError && data && data.items.length === 0 && (
        <AdminFirstUseState
          icon={Plug}
          title="Nenhum conector cadastrado"
          description="Cadastre um ponto de recarga primeiro, depois adicione os conectores dele aqui."
          action={
            <Button variant="glass" onClick={openCreate}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              Novo conector
            </Button>
          }
        />
      )}

      {!isLoading && !isError && data && data.items.length > 0 && (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nº</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Potência</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Tarifa</TableHead>
                <TableHead className="text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-semibold text-ink">#{c.connectorId}</TableCell>
                  <TableCell>{CONNECTOR_TYPE_LABELS[c.type]}</TableCell>
                  <TableCell>{formatPowerKw(c.maxPowerKw)}</TableCell>
                  <TableCell>
                    <ConnectorStatusBadge status={c.status} />
                  </TableCell>
                  <TableCell>
                    {(() => {
                      const effective = effectiveTariffOf(c)
                      if (effective === undefined) return <span className="text-ink-softer">—</span>
                      if (effective === null) return <Badge variant="warning">Sem tarifa</Badge>
                      return <span className="font-medium text-ink-soft">{effective.tariff?.name ?? "Tarifa"}</span>
                    })()}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Tarifas do conector ${c.connectorId}`}
                        title="Tarifas"
                        disabled={!chargePointById.has(c.chargePointId)}
                        onClick={() => setTariffsFor(chargePointById.get(c.chargePointId) ?? null)}
                      >
                        <Tag className="h-4 w-4" aria-hidden="true" />
                      </Button>
                      <Button variant="ghost" size="icon" aria-label={`Editar conector ${c.connectorId}`} title="Editar" onClick={() => openEdit(c)}>
                        <Pencil className="h-4 w-4" aria-hidden="true" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Remover conector ${c.connectorId}`}
                        title="Marcar como indisponível"
                        onClick={() => setDeleting(c)}
                      >
                        <Trash2 className="h-4 w-4 text-danger-600" aria-hidden="true" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <Pagination
            page={data.meta.page}
            totalPages={data.meta.totalPages}
            total={data.meta.total}
            pageSize={data.meta.pageSize}
            onPageChange={setPage}
            label="conectores"
          />
        </>
      )}

      <ConnectorFormDialog open={formOpen} onOpenChange={setFormOpen} connector={editing} />

      <ChargePointTariffsDialog chargePoint={tariffsFor} onOpenChange={(open) => !open && setTariffsFor(null)} />

      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Marcar conector #${deleting?.connectorId} como indisponível?`}
        description="Conector não tem exclusão de verdade — fica com status UNAVAILABLE até ser reativado."
        confirmLabel="Marcar indisponível"
        loading={deleteConnector.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  )
}
