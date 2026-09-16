import { useState } from "react"
import { Lock, MoreVertical, Power, RotateCcw, Send } from "lucide-react"
import { Button } from "@/components/ui/Button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/DropdownMenu"
import { useSendChargePointCommand } from "@/hooks/useChargePoints"
import { ChargePointCommandDialog } from "./ChargePointCommandDialog"
import type { ChargePointCommandType } from "@/types/api"

/** Menu de comandos remotos do ponto de recarga — reset dispara direto, os demais abrem um mini-formulário (precisam de parâmetro). */
export function ChargePointCommandsMenu({ chargePointId, chargePointName }: { chargePointId: string; chargePointName: string }) {
  const [dialogCommand, setDialogCommand] = useState<Extract<ChargePointCommandType, "unlock" | "change-availability" | "trigger-message"> | null>(null)
  const sendCommand = useSendChargePointCommand()

  const reset = (type: "Soft" | "Hard") => sendCommand.mutate({ id: chargePointId, command: "reset", params: { type } })

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label={`Comandos de ${chargePointName}`} title="Comandos remotos">
            <MoreVertical className="h-4 w-4" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>Comandos remotos</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => reset("Soft")}>
            <RotateCcw className="h-4 w-4 text-ink-softer" aria-hidden="true" />
            Reiniciar (soft)
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => reset("Hard")}>
            <RotateCcw className="h-4 w-4 text-ink-softer" aria-hidden="true" />
            Reiniciar (hard)
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setDialogCommand("unlock")}>
            <Lock className="h-4 w-4 text-ink-softer" aria-hidden="true" />
            Destravar conector...
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setDialogCommand("change-availability")}>
            <Power className="h-4 w-4 text-ink-softer" aria-hidden="true" />
            Alterar disponibilidade...
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setDialogCommand("trigger-message")}>
            <Send className="h-4 w-4 text-ink-softer" aria-hidden="true" />
            Solicitar mensagem...
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ChargePointCommandDialog
        open={Boolean(dialogCommand)}
        onOpenChange={(open) => !open && setDialogCommand(null)}
        chargePointId={chargePointId}
        command={dialogCommand}
      />
    </>
  )
}
