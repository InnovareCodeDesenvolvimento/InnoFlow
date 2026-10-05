import { useState } from "react"
import { Pencil, Plus, Tag, Trash2, TriangleAlert, Zap } from "lucide-react"
import { toast } from "sonner"
import { PageHeader } from "@/components/painel/PageHeader"
import { Button } from "@/components/ui/Button"
import { Badge } from "@/components/ui/Badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table"
import { AdminErrorState as ErrorState, AdminFirstUseState } from "@/components/admin/AdminStates"
import { TableSkeleton } from "@/components/ui/Skeleton"
import { Pagination } from "@/components/ui/Pagination"
import { ConfirmDialog } from "@/components/ui/ConfirmDialog"
import { ChargePointCommandsMenu } from "@/components/chargePoints/ChargePointCommandsMenu"
import { useChargePoints, useDeleteChargePoint } from "@/hooks/useChargePoints"
import { useAllTariffAssignments } from "@/hooks/useTariffAssignments"
import { ChargePointTariffsDialog } from "@/components/tariffAssignments/ChargePointTariffsDialog"
import { TariffCoverageBadge } from "@/components/tariffAssignments/TariffCoverageBadge"
import { getChargePointCoverage } from "@/lib/tariffAssignments"
import { getApiErrorMessage } from "@/services/api"
import { ChargePointFormDialog } from "./ChargePointFormDialog"
import type { ChargePoint } from "@/types/api"

const PAGE_SIZE = 20

export default function ChargePointsPage() {
  const [page, setPage] = useState(1)
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<ChargePoint | null>(null)
  const [deleting, setDeleting] = useState<ChargePoint | null>(null)
  const [tariffsFor, setTariffsFor] = useState<ChargePoint | null>(null)

  const { data, isLoading, isError, error, refetch } = useChargePoints({ page, pageSize: PAGE_SIZE })
  const deleteChargePoint = useDeleteChargePoint()
  const assignmentsQuery = useAllTariffAssignments()

  // "Sem tarifa" só é afirmado com a lista COMPLETA de vínculos em mãos (carregada, sem erro e sem truncar) — nunca por palpite.
  const coverageOf = (cp: ChargePoint) =>
    cp.active && assignmentsQuery.data && !assignmentsQuery.data.truncated ? getChargePointCoverage(assignmentsQuery.data.items, cp) : null
  const withoutTariff = (data?.items ?? []).filter((cp) => {
    const state = coverageOf(cp)?.state
    return state === "none" || state === "partial"
  })

  const openCreate = () => {
    setEditing(null)
    setFormOpen(true)
  }
  const openEdit = (cp: ChargePoint) => {
    setEditing(cp)
    setFormOpen(true)
  }

  const confirmDelete = async () => {
    if (!deleting) return
    try {
      await deleteChargePoint.mutateAsync(deleting.id)
      toast.success("Ponto de recarga desativado.")
      setDeleting(null)
    } catch (err) {
      toast.error("Não foi possível desativar.", { description: getApiErrorMessage(err) })
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Pontos de recarga"
        description="Carregadores OCPP 1.6-J — reinicie, destrave ou altere disponibilidade remotamente."
        icon={Zap}
        actions={
          <Button variant="lime" onClick={openCreate}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Novo ponto de recarga
          </Button>
        }
      />

      {isLoading && <TableSkeleton cols={6} />}
      {isError && <ErrorState message={getApiErrorMessage(error, "Não foi possível carregar os pontos de recarga.")} onRetry={() => refetch()} />}

      {!isLoading && !isError && data && data.items.length === 0 && (
        <AdminFirstUseState
          icon={Zap}
          title="Nenhum ponto de recarga cadastrado"
          description="Cadastre um site primeiro, depois adicione os carregadores dele aqui."
          action={
            <Button variant="glass" onClick={openCreate}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              Novo ponto de recarga
            </Button>
          }
        />
      )}

      {!isLoading && !isError && withoutTariff.length > 0 && (
        <div role="status" className="flex items-start gap-3 rounded-xl border border-warning-600/40 bg-warning-50 p-4 text-warning-700" data-testid="cp-without-tariff-alert">
          <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
          <p className="min-w-0 text-sm">
            <span className="font-bold">
              {withoutTariff.length === 1 ? "1 carregador sem tarifa nesta página." : `${withoutTariff.length} carregadores sem tarifa nesta página.`}
            </span>{" "}
            Sem tarifa válida o QR não inicia a recarga. Use o botão de tarifa na linha para vincular uma.
          </p>
        </div>
      )}

      {!isLoading && !isError && data && data.items.length > 0 && (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Identidade OCPP</TableHead>
                <TableHead>Fabricante/Modelo</TableHead>
                <TableHead>Site</TableHead>
                <TableHead>Conectores</TableHead>
                <TableHead>Tarifa</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((cp) => (
                <TableRow key={cp.id}>
                  <TableCell className="font-semibold text-ink">{cp.ocppIdentity}</TableCell>
                  <TableCell>{[cp.vendor, cp.model].filter(Boolean).join(" · ") || "—"}</TableCell>
                  <TableCell>{cp.site?.name ?? "—"}</TableCell>
                  <TableCell>{cp.connectors?.length ?? 0}</TableCell>
                  <TableCell>
                    <TariffCoverageBadge coverage={coverageOf(cp)} loading={cp.active && assignmentsQuery.isLoading} />
                  </TableCell>
                  <TableCell>
                    <Badge variant={cp.active ? "success" : "neutral"}>{cp.active ? "Ativo" : "Inativo"}</Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <ChargePointCommandsMenu chargePointId={cp.id} chargePointName={cp.ocppIdentity} />
                      <Button variant="ghost" size="icon" aria-label={`Tarifas de ${cp.ocppIdentity}`} title="Tarifas" onClick={() => setTariffsFor(cp)}>
                        <Tag className="h-4 w-4" aria-hidden="true" />
                      </Button>
                      <Button variant="ghost" size="icon" aria-label={`Editar ${cp.ocppIdentity}`} title="Editar" onClick={() => openEdit(cp)}>
                        <Pencil className="h-4 w-4" aria-hidden="true" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Desativar ${cp.ocppIdentity}`}
                        title="Desativar"
                        onClick={() => setDeleting(cp)}
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
            label="pontos de recarga"
          />
        </>
      )}

      <ChargePointFormDialog open={formOpen} onOpenChange={setFormOpen} chargePoint={editing} />

      <ChargePointTariffsDialog chargePoint={tariffsFor} onOpenChange={(open) => !open && setTariffsFor(null)} />

      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Desativar "${deleting?.ocppIdentity}"?`}
        description="O ponto de recarga fica marcado como inativo — o histórico é preservado."
        confirmLabel="Desativar"
        loading={deleteChargePoint.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  )
}
