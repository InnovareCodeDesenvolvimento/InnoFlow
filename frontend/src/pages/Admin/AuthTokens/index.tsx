import { useState } from "react"
import { KeyRound, Pencil, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { PageHeader } from "@/components/painel/PageHeader"
import { Button } from "@/components/ui/Button"
import { Badge } from "@/components/ui/Badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table"
import { AdminErrorState as ErrorState, AdminFirstUseState } from "@/components/admin/AdminStates"
import { TableSkeleton } from "@/components/ui/Skeleton"
import { Pagination } from "@/components/ui/Pagination"
import { ConfirmDialog } from "@/components/ui/ConfirmDialog"
import { useAuthTokens, useDeleteAuthToken } from "@/hooks/useAuthTokens"
import { getApiErrorMessage } from "@/services/api"
import { formatDate } from "@/lib/utils"
import { AuthTokenFormDialog } from "./AuthTokenFormDialog"
import type { AuthToken, AuthTokenStatus } from "@/types/api"

const PAGE_SIZE = 20

const STATUS_VARIANT: Record<AuthTokenStatus, "success" | "danger" | "warning" | "neutral"> = {
  ACCEPTED: "success",
  BLOCKED: "danger",
  EXPIRED: "warning",
  INVALID: "neutral",
}

export default function AuthTokensPage() {
  const [page, setPage] = useState(1)
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<AuthToken | null>(null)
  const [deleting, setDeleting] = useState<AuthToken | null>(null)

  const { data, isLoading, isError, error, refetch } = useAuthTokens({ page, pageSize: PAGE_SIZE })
  const deleteToken = useDeleteAuthToken()

  const openCreate = () => {
    setEditing(null)
    setFormOpen(true)
  }
  const openEdit = (t: AuthToken) => {
    setEditing(t)
    setFormOpen(true)
  }

  const confirmDelete = async () => {
    if (!deleting) return
    try {
      await deleteToken.mutateAsync(deleting.id)
      toast.success("Token bloqueado.")
      setDeleting(null)
    } catch (err) {
      toast.error("Não foi possível bloquear.", { description: getApiErrorMessage(err) })
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Tokens de autenticação"
        description="RFID e tokens de app usados para iniciar recarga — identidade de rede, válida em qualquer operador."
        icon={KeyRound}
        actions={
          <Button variant="lime" onClick={openCreate}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Novo token
          </Button>
        }
      />

      {isLoading && <TableSkeleton cols={5} />}
      {isError && <ErrorState message={getApiErrorMessage(error, "Não foi possível carregar os tokens.")} onRetry={() => refetch()} />}

      {!isLoading && !isError && data && data.items.length === 0 && (
        <AdminFirstUseState
          icon={KeyRound}
          title="Nenhum token cadastrado"
          action={
            <Button variant="glass" onClick={openCreate}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              Novo token
            </Button>
          }
        />
      )}

      {!isLoading && !isError && data && data.items.length > 0 && (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>idTag</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Expira em</TableHead>
                <TableHead className="text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-semibold text-ink">{t.idTag}</TableCell>
                  <TableCell>{t.type}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[t.status]}>{t.status}</Badge>
                  </TableCell>
                  <TableCell>{formatDate(t.expiresAt)}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" aria-label={`Editar token ${t.idTag}`} title="Editar" onClick={() => openEdit(t)}>
                        <Pencil className="h-4 w-4" aria-hidden="true" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Bloquear token ${t.idTag}`}
                        title="Bloquear"
                        onClick={() => setDeleting(t)}
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
            label="tokens"
          />
        </>
      )}

      <AuthTokenFormDialog open={formOpen} onOpenChange={setFormOpen} authToken={editing} />

      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Bloquear o token "${deleting?.idTag}"?`}
        description="O token deixa de autenticar recargas até ser desbloqueado."
        confirmLabel="Bloquear"
        loading={deleteToken.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  )
}
