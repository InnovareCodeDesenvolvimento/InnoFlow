import { useRef, useState } from "react"
import { Lock, MoreVertical, Power, RotateCcw, Send, Zap } from "lucide-react"
import { Button } from "@/components/ui/Button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/DropdownMenu"
import { useSendChargePointCommand } from "@/hooks/useChargePoints"
import { useAuthStore } from "@/store/authStore"
import { ChargePointCommandDialog } from "./ChargePointCommandDialog"
import { RemoteStartDialog } from "./remoteStart/RemoteStartDialog"
import type { ChargePointCommandType, Connector } from "@/types/api"

/**
 * Menu de comandos remotos do ponto de recarga — reset dispara direto, os demais abrem um mini-formulário (precisam de parâmetro).
 * "Iniciar recarga" (L1.5) só aparece para ADMIN (DL4: o servidor também recusa OPERATOR com 403) e precisa dos conectores para oferecer a escolha.
 */
export function ChargePointCommandsMenu({
  chargePointId,
  chargePointName,
  connectors = [],
  online,
}: {
  chargePointId: string
  chargePointName: string
  connectors?: Connector[]
  /** `ChargePoint.online` (servidor). Alimenta só o aviso do "Iniciar recarga"; `undefined` não bloqueia. */
  online?: boolean
}) {
  const isAdmin = useAuthStore((s) => s.user?.role === "ADMIN")
  const [remoteStartOpen, setRemoteStartOpen] = useState(false)
  // Os diálogos abrem DEPOIS que o menu fecha: o foco "de antes" que o `DialogContent` guarda é o item do menu (que já sumiu) e, ao fechar, ia parar no <body>. Devolvemos ao botão da linha.
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [dialogCommand, setDialogCommand] = useState<Extract<ChargePointCommandType, "unlock" | "change-availability" | "trigger-message"> | null>(null)
  const sendCommand = useSendChargePointCommand()

  const reset = (type: "Soft" | "Hard") => sendCommand.mutate({ id: chargePointId, command: "reset", params: { type } })

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button ref={triggerRef} variant="ghost" size="icon" aria-label={`Comandos de ${chargePointName}`} title="Comandos remotos">
            <MoreVertical className="h-4 w-4" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>Comandos remotos</DropdownMenuLabel>
          {isAdmin && (
            <>
              <DropdownMenuItem onSelect={() => setRemoteStartOpen(true)}>
                <Zap className="h-4 w-4 text-ink-softer" aria-hidden="true" />
                Iniciar recarga...
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
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
        restoreFocusTo={triggerRef}
      />

      {isAdmin && remoteStartOpen && (
        <RemoteStartDialog
          chargePointId={chargePointId}
          chargePointName={chargePointName}
          connectors={connectors}
          online={online}
          restoreFocusTo={triggerRef}
          onOpenChange={setRemoteStartOpen}
        />
      )}
    </>
  )
}
