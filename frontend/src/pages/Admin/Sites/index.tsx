import { useState } from "react"
import { MapPin, Pencil, Plus, Trash2 } from "lucide-react"
import { PageHeader } from "@/components/painel/PageHeader"
import { Button } from "@/components/ui/Button"
import { Badge } from "@/components/ui/Badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table"
import { AdminErrorState as ErrorState, AdminFirstUseState } from "@/components/admin/AdminStates"
import { TableSkeleton } from "@/components/ui/Skeleton"
import { Pagination } from "@/components/ui/Pagination"
import { ConfirmDialog } from "@/components/ui/ConfirmDialog"
import { useDeleteSite, useSites } from "@/hooks/useSites"
import { getApiErrorMessage } from "@/services/api"
import { toast } from "sonner"
import { SiteFormDialog } from "./SiteFormDialog"
import type { Site } from "@/types/api"

const PAGE_SIZE = 20

export default function SitesPage() {
  const [page, setPage] = useState(1)
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Site | null>(null)
  const [deleting, setDeleting] = useState<Site | null>(null)

  const { data, isLoading, isError, error, refetch } = useSites({ page, pageSize: PAGE_SIZE })
  const deleteSite = useDeleteSite()

  const openCreate = () => {
    setEditing(null)
    setFormOpen(true)
  }
  const openEdit = (site: Site) => {
    setEditing(site)
    setFormOpen(true)
  }

  const confirmDelete = async () => {
    if (!deleting) return
    try {
      await deleteSite.mutateAsync(deleting.id)
      toast.success("Site desativado.")
      setDeleting(null)
    } catch (err) {
      toast.error("Não foi possível desativar o site.", { description: getApiErrorMessage(err) })
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sites"
        description="Endereços físicos onde ficam os pontos de recarga."
        icon={MapPin}
        actions={
          <Button variant="lime" onClick={openCreate}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Novo site
          </Button>
        }
      />

      {isLoading && <TableSkeleton cols={5} />}
      {isError && <ErrorState message={getApiErrorMessage(error, "Não foi possível carregar os sites.")} onRetry={() => refetch()} />}

      {!isLoading && !isError && data && data.items.length === 0 && (
        <AdminFirstUseState
          icon={MapPin}
          title="Nenhum site cadastrado"
          description="Crie o primeiro site para começar a cadastrar pontos de recarga."
          action={
            <Button variant="glass" onClick={openCreate}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              Novo site
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
                <TableHead>Endereço</TableHead>
                <TableHead>Cidade/UF</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((site) => (
                <TableRow key={site.id}>
                  <TableCell className="font-semibold text-ink">{site.name}</TableCell>
                  <TableCell>{site.addressLine}</TableCell>
                  <TableCell>
                    {site.city}/{site.state}
                  </TableCell>
                  <TableCell>
                    <Badge variant={site.active ? "success" : "neutral"}>{site.active ? "Ativo" : "Inativo"}</Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" aria-label={`Editar ${site.name}`} title="Editar" onClick={() => openEdit(site)}>
                        <Pencil className="h-4 w-4" aria-hidden="true" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Desativar ${site.name}`}
                        title="Desativar"
                        onClick={() => setDeleting(site)}
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
            label="sites"
          />
        </>
      )}

      <SiteFormDialog open={formOpen} onOpenChange={setFormOpen} site={editing} />

      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Desativar "${deleting?.name}"?`}
        description="O site fica marcado como inativo — não some do histórico, mas deixa de aparecer para o motorista."
        confirmLabel="Desativar"
        loading={deleteSite.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  )
}
