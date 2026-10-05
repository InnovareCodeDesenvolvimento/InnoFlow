import { Gavel, ShieldAlert, ShieldCheck } from "lucide-react"
import { Badge } from "@/components/ui/Badge"
import { Button } from "@/components/ui/Button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/Dialog"
import { DossierButton } from "@/components/admin/DossierButton"
import { CopyButton } from "@/pages/Admin/GatewayPagamento/CopyButton"
import { CHARGEBACK_STATUS_LABELS, CHARGEBACK_STATUS_VARIANT } from "@/lib/reversals"
import { formatCents, formatDate, formatDateTime } from "@/lib/utils"
import type { ChargebackDTO } from "@/types/api"
import { DeadlineBadge } from "./DeadlineBadge"

/**
 * Detalhe de um chargeback (todos os dados já vêm da lista — sem outra chamada). Nenhum dado do motorista: a Cielo avisa o dono, e o servidor só guarda ids. As ações (desfecho,
 * desbloqueio) abrem os diálogos próprios, que pedem a senha.
 */
export function ChargebackDetailDialog({
  chargeback,
  onResolve,
  onUnblock,
  onClose,
}: {
  chargeback: ChargebackDTO
  onResolve: () => void
  onUnblock: () => void
  onClose: () => void
}) {
  const open = chargeback.status === "OPEN"
  const canUnblock = chargeback.cardBlocked && (chargeback.status === "LOST" || chargeback.status === "ACCEPTED")

  return (
    <Dialog open onOpenChange={(value) => !value && onClose()}>
      <DialogContent widthClassName="sm:max-w-xl">
        <DialogHeader icon={ShieldAlert}>
          <DialogTitle>Chargeback · caso {chargeback.caseReference}</DialogTitle>
          <DialogDescription>Contestação avisada pela Cielo. O dossiê foi gravado no momento do registro.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={CHARGEBACK_STATUS_VARIANT[chargeback.status]}>{CHARGEBACK_STATUS_LABELS[chargeback.status]}</Badge>
            <Badge variant={chargeback.cardBlocked ? "warning" : "success"}>
              {chargeback.cardBlocked ? <ShieldAlert className="h-3 w-3" aria-hidden="true" /> : <ShieldCheck className="h-3 w-3" aria-hidden="true" />}
              {chargeback.cardBlocked ? "Cartão bloqueado" : "Cartão liberado"}
            </Badge>
          </div>

          <dl className="grid grid-cols-2 gap-3">
            <Field label="Valor contestado" value={formatCents(chargeback.amountCents)} />
            <Field label="Aviso da Cielo" value={formatDate(chargeback.notifiedAt)} />
            <div className="min-w-0">
              <dt className="text-[11px] font-bold uppercase tracking-wide text-ink-softer">Prazo de resposta</dt>
              <dd className="mt-0.5">
                <DeadlineBadge chargeback={chargeback} />
              </dd>
            </div>
            <Field label="Código do motivo" value={chargeback.reasonCode ?? "—"} />
            <Field label="Registrado em" value={formatDateTime(chargeback.createdAt)} />
            <Field label="Desfecho em" value={chargeback.resolvedAt ? formatDateTime(chargeback.resolvedAt) : "—"} />
          </dl>

          <div className="space-y-2 rounded-xl border border-border-subtle p-3">
            <IdRow label="Venda (id)" value={chargeback.paymentIntentId} />
            {chargeback.chargingSessionId && <IdRow label="Sessão (id)" value={chargeback.chargingSessionId} />}
          </div>

          {(chargeback.status === "LOST" || chargeback.status === "ACCEPTED") && (
            <p className="rounded-xl bg-muted/60 px-3 py-2.5 text-ink-soft">
              {chargeback.debtId ? "Dívida criada para o motorista (bloqueia a próxima recarga até ser quitada por Pix)." : "A plataforma absorveu o prejuízo. Nenhuma dívida foi criada para o motorista."}
            </p>
          )}

          {chargeback.cardUnblockedAt && (
            <p className="rounded-xl bg-success-50 px-3 py-2.5 text-success-700">
              Cartão desbloqueado em {formatDateTime(chargeback.cardUnblockedAt)}
              {chargeback.cardUnblockReason ? ` — motivo: ${chargeback.cardUnblockReason}` : ""}.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" size="touch" onClick={onClose}>
            Fechar
          </Button>
          <DossierButton chargebackId={chargeback.id} caseReference={chargeback.caseReference} size="touch" />
          {canUnblock && (
            <Button type="button" variant="outline" size="touch" onClick={onUnblock}>
              <ShieldCheck className="h-4 w-4" aria-hidden="true" />
              Desbloquear cartão
            </Button>
          )}
          {open && (
            <Button type="button" size="touch" onClick={onResolve}>
              <Gavel className="h-4 w-4" aria-hidden="true" />
              Registrar desfecho
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-bold uppercase tracking-wide text-ink-softer">{label}</dt>
      <dd className="font-semibold text-ink [overflow-wrap:anywhere]">{value}</dd>
    </div>
  )
}

function IdRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="min-w-0">
        <p className="text-[11px] font-bold uppercase tracking-wide text-ink-softer">{label}</p>
        <p className="break-all font-mono text-xs text-ink-soft">{value}</p>
      </div>
      <CopyButton value={value} label={`Copiar ${label}`} />
    </div>
  )
}
