import { AlertTriangle, Check, X } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./Dialog"
import { Button } from "./Button"

/**
 * Confirmação para ações destrutivas (excluir site, bloquear token...).
 * Controlado (`open`/`onOpenChange`) para o chamador guardar QUAL registro
 * está prestes a apagar — este componente não guarda estado nenhum de "qual".
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirmar",
  cancelLabel = "Cancelar",
  destructive = true,
  loading,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
  loading?: boolean
  onConfirm: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent widthClassName="sm:max-w-sm">
        <DialogHeader>
          <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-card bg-danger-100 text-danger-600">
            <AlertTriangle className="h-5 w-5" aria-hidden="true" />
          </div>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            <X className="h-4 w-4" aria-hidden="true" />
            {cancelLabel}
          </Button>
          <Button type="button" variant={destructive ? "destructive" : "default"} loading={loading} onClick={onConfirm}>
            <Check className="h-4 w-4" aria-hidden="true" />
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
