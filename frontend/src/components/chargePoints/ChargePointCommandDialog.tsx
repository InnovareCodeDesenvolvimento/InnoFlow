import { useState } from "react"
import { Send, X } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/Dialog"
import { Input } from "@/components/ui/Input"
import { Select } from "@/components/ui/Select"
import { Button } from "@/components/ui/Button"
import { useSendChargePointCommand } from "@/hooks/useChargePoints"
import type { ChargePointCommandType } from "@/types/api"

const TRIGGER_MESSAGE_OPTIONS = [
  { value: "BootNotification", label: "BootNotification" },
  { value: "DiagnosticsStatusNotification", label: "DiagnosticsStatusNotification" },
  { value: "FirmwareStatusNotification", label: "FirmwareStatusNotification" },
  { value: "Heartbeat", label: "Heartbeat" },
  { value: "MeterValues", label: "MeterValues" },
  { value: "StatusNotification", label: "StatusNotification" },
]

const AVAILABILITY_OPTIONS = [
  { value: "Operative", label: "Operativo" },
  { value: "Inoperative", label: "Inoperativo" },
]

/**
 * Formulário do comando remoto (unlock / change-availability / trigger-message
 * — os que precisam de parâmetro). `reset` não passa por aqui: dispara direto
 * do menu, com `type` fixo escolhido no próprio item (soft/hard).
 *
 * Fire-and-forget: o 202 só confirma o ENFILEIRAMENTO, não o resultado (sem
 * canal de retorno nesta fase — ver `useSendChargePointCommand`).
 */
export function ChargePointCommandDialog({
  open,
  onOpenChange,
  chargePointId,
  command,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  chargePointId: string
  command: Extract<ChargePointCommandType, "unlock" | "change-availability" | "trigger-message"> | null
}) {
  const sendCommand = useSendChargePointCommand()
  const [connectorId, setConnectorId] = useState(1)
  const [availabilityType, setAvailabilityType] = useState<"Operative" | "Inoperative">("Operative")
  const [requestedMessage, setRequestedMessage] = useState(TRIGGER_MESSAGE_OPTIONS[0].value)

  if (!command) return null

  const titles: Record<typeof command, string> = {
    unlock: "Destravar conector",
    "change-availability": "Alterar disponibilidade",
    "trigger-message": "Solicitar mensagem",
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (command === "unlock") {
      await sendCommand.mutateAsync({ id: chargePointId, command, params: { connectorId } })
    } else if (command === "change-availability") {
      await sendCommand.mutateAsync({ id: chargePointId, command, params: { connectorId, type: availabilityType } })
    } else {
      await sendCommand.mutateAsync({
        id: chargePointId,
        command,
        params: { requestedMessage: requestedMessage as never, connectorId: connectorId || undefined },
      })
    }
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent widthClassName="sm:max-w-sm">
        <DialogHeader icon={Send}>
          <DialogTitle>{titles[command]}</DialogTitle>
          <DialogDescription>Comando enviado ao carregador via OCPP — sem confirmação em tempo real nesta fase.</DialogDescription>
        </DialogHeader>

        <form className="space-y-4" onSubmit={handleSubmit}>
          {command === "unlock" && (
            <Input
              type="number"
              min={1}
              label="Número do conector"
              required
              value={connectorId}
              onChange={(e) => setConnectorId(Number(e.target.value))}
            />
          )}

          {command === "change-availability" && (
            <>
              <Input
                type="number"
                min={0}
                label="Número do conector"
                hint="0 = o ponto de recarga inteiro."
                required
                value={connectorId}
                onChange={(e) => setConnectorId(Number(e.target.value))}
              />
              <Select
                label="Disponibilidade"
                required
                options={AVAILABILITY_OPTIONS}
                value={availabilityType}
                onChange={(e) => setAvailabilityType(e.target.value as "Operative" | "Inoperative")}
              />
            </>
          )}

          {command === "trigger-message" && (
            <>
              <Select
                label="Mensagem solicitada"
                required
                options={TRIGGER_MESSAGE_OPTIONS}
                value={requestedMessage}
                onChange={(e) => setRequestedMessage(e.target.value)}
              />
              <Input
                type="number"
                min={0}
                label="Número do conector (opcional)"
                value={connectorId}
                onChange={(e) => setConnectorId(Number(e.target.value))}
              />
            </>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              <X className="h-4 w-4" aria-hidden="true" />
              Cancelar
            </Button>
            <Button type="submit" loading={sendCommand.isPending}>
              {!sendCommand.isPending && <Send className="h-4 w-4" aria-hidden="true" />}
              Enviar comando
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
