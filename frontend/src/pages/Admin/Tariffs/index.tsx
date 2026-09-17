import { useState } from "react"
import { Pencil, Plus, Trash2, Wallet } from "lucide-react"
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
import { useDeleteTariff, useTariffs } from "@/hooks/useTariffs"
import { getApiErrorMessage } from "@/services/api"
import { formatCents, formatCurrency } from "@/lib/utils"
import { TariffFormDialog } from "./TariffFormDialog"
import type { Tariff } from "@/types/api"

const PAGE_SIZE = 20

const MODEL_LABELS: Record<Tariff["model"], string> = {
  PER_KWH: "Por kWh",
  PER_MINUTE: "Por minuto",
  PER_SESSION: "Por sessão",
  HYBRID: "Híbrido",
}

export default function TariffsPage() {
  const [page, setPage] = useState(1)
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Tariff | null>(null)
  const [deleting, setDeleting] = useState<Tariff | null>(null)

  const { data, isLoading, isError, error, refetch } = useTariffs({ page, pageSize: PAGE_SIZE })
  const deleteTariff = useDeleteTariff()

  const openCreate = () => {
    setEditing(null)
    setFormOpen(true)
  }
  const openEdit = (t: Tariff) => {
    setEditing(t)
    setFormOpen(true)
  }

  const confirmDelete = async () => {
    if (!deleting) return
    try {
      await deleteTariff.mutateAsync(deleting.id)
      toast.success("Tarifa desativada.")
      setDeleting(null)
    } catch (err) {
      toast.error("Não foi possível desativar.", { description: getApiErrorMessage(err) })
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Tarifas"
        description="Preço cobrado do motorista — por kWh, por minuto, taxa fixa e taxa de ociosidade."
        icon={Wallet}
        actions={
          <Button className="btn-glow-primary" onClick={openCreate}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Nova tarifa
          </Button>
        }
      />

      {isLoading && <TableSkeleton cols={5} />}
      {isError && <ErrorState message={getApiErrorMessage(error, "Não foi possível carregar as tarifas.")} onRetry={() => refetch()} />}

      {!isLoading && !isError && data && data.items.length === 0 && (
        <EmptyState
          icon={Wallet}
          title="Nenhuma tarifa cadastrada"
          description="Crie uma tarifa para poder associá-la aos pontos de recarga."
          action={
            <Button onClick={openCreate}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              Nova tarifa
            </Button>
          }
        />
      )}

      {!isLoading && !isError && data && data.items.length > 0 && (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nome</TableHead>
                <TableHead>Modelo</TableHead>
                <TableHead>Preço</TableHead>
                <TableHead>Ociosidade</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-semibold text-ink">{t.name}</TableCell>
                  <TableCell>{MODEL_LABELS[t.model]}</TableCell>
                  <TableCell>
                    {t.pricePerKwh ? `${formatCurrency(t.pricePerKwh)}/kWh` : null}
                    {t.pricePerKwh && t.pricePerMinute ? " + " : null}
                    {t.pricePerMinute ? `${formatCurrency(t.pricePerMinute)}/min` : null}
                    {!t.pricePerKwh && !t.pricePerMinute ? "—" : null}
                  </TableCell>
                  <TableCell>{formatCents(t.idleFeePerMinute)}/min</TableCell>
                  <TableCell>
                    <Badge variant={t.active ? "success" : "neutral"}>{t.active ? "Ativa" : "Inativa"}</Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" aria-label={`Editar ${t.name}`} title="Editar" onClick={() => openEdit(t)}>
                        <Pencil className="h-4 w-4" aria-hidden="true" />
                      </Button>
                      <Button variant="ghost" size="icon" aria-label={`Desativar ${t.name}`} title="Desativar" onClick={() => setDeleting(t)}>
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
            label="tarifas"
          />
        </>
      )}

      <TariffFormDialog open={formOpen} onOpenChange={setFormOpen} tariff={editing} />

      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Desativar "${deleting?.name}"?`}
        description="A tarifa fica marcada como inativa — não some do histórico."
        confirmLabel="Desativar"
        loading={deleteTariff.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  )
}
