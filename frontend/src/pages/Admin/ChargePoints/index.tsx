import { useState } from "react"
import { Pencil, Plus, Trash2, Zap } from "lucide-react"
import { toast } from "sonner"
import { PageHeader } from "@/components/painel/PageHeader"
import { Button } from "@/components/ui/Button"
import { Badge } from "@/components/ui/Badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table"
import { EmptyState } from "@/components/ui/EmptyState"
import { ErrorState } from "@/components/ui/ErrorState"
import { TableSkeleton } from "@/components/ui/Skeleton"
import { Pagination } from "@/components/ui/Pagination"
import { ConfirmDialog } from "@/components/ui/ConfirmDialog"
import { ChargePointCommandsMenu } from "@/components/chargePoints/ChargePointCommandsMenu"
import { useChargePoints, useDeleteChargePoint } from "@/hooks/useChargePoints"
import { getApiErrorMessage } from "@/services/api"
import { ChargePointFormDialog } from "./ChargePointFormDialog"
import type { ChargePoint } from "@/types/api"

const PAGE_SIZE = 20

export default function ChargePointsPage() {
  const [page, setPage] = useState(1)
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<ChargePoint | null>(null)
  const [deleting, setDeleting] = useState<ChargePoint | null>(null)

  const { data, isLoading, isError, error, refetch } = useChargePoints({ page, pageSize: PAGE_SIZE })
  const deleteChargePoint = useDeleteChargePoint()

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
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Novo ponto de recarga
          </Button>
        }
      />

      {isLoading && <TableSkeleton cols={5} />}
      {isError && <ErrorState message={getApiErrorMessage(error, "Não foi possível carregar os pontos de recarga.")} onRetry={() => refetch()} />}

      {!isLoading && !isError && data && data.items.length === 0 && (
        <EmptyState
          icon={Zap}
          title="Nenhum ponto de recarga cadastrado"
          description="Cadastre um site primeiro, depois adicione os carregadores dele aqui."
          action={
            <Button onClick={openCreate}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              Novo ponto de recarga
            </Button>
          }
        />
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
                    <Badge variant={cp.active ? "success" : "neutral"}>{cp.active ? "Ativo" : "Inativo"}</Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <ChargePointCommandsMenu chargePointId={cp.id} chargePointName={cp.ocppIdentity} />
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
