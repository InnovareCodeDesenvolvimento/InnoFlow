import { useEffect, useRef, useState, type RefObject } from "react"
import { Link } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"
import { ArrowLeft, ArrowRight, Check, ScrollText, TriangleAlert, X, Zap } from "lucide-react"
import { Alert } from "@/components/ui/Alert"
import { Button } from "@/components/ui/Button"
import { buttonVariants } from "@/components/ui/buttonVariants"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/Dialog"
import { Textarea } from "@/components/ui/Textarea"
import { driversKeys } from "@/hooks/useDrivers"
import { chargePointsKeys } from "@/hooks/useChargePoints"
import { useCommandPolling, useRemoteStart } from "@/hooks/useRemoteStart"
import { cn, formatCents } from "@/lib/utils"
import {
  isTerminalPhase,
  REMOTE_START_REASON_MAX,
  REMOTE_START_REASON_MIN,
  isConnectorStartable,
  remoteStartError,
  remoteStartSummary,
  validateReason,
  type RemoteStartError,
} from "@/lib/remoteStart"
import type { Connector, DriverListRow } from "@/types/api"
import { ConnectorChoice } from "./ConnectorChoice"
import { DriverBalanceLine, DriverPicker } from "./DriverPicker"
import { RemoteStartProgress } from "./RemoteStartProgress"

type Stage = "form" | "confirm" | "progress"

/**
 * "Iniciar recarga" (L1.5, só ADMIN — DL4): o suporte inicia uma recarga NA CARTEIRA de um motorista (sem cartão). Três passos, no mesmo padrão do ajuste de saldo
 * (é a carteira de uma PESSOA): (1) conector + motorista + motivo, (2) CONFIRMAR uma frase inequívoca — "Vai debitar a carteira de <nome>" —, (3) acompanhar o
 * resultado do carregador (consulta a cada 2 s por até 60 s). Fechar o diálogo (ou desmontar) para o acompanhamento; o comando já enviado continua no carregador.
 *
 * Montar só quando aberto (`{open && <RemoteStartDialog />}`): cada abertura começa do zero e o acompanhamento nasce e morre com o diálogo.
 */
export function RemoteStartDialog({
  chargePointId,
  chargePointName,
  connectors,
  isAdmin = true,
  restoreFocusTo,
  onOpenChange,
}: {
  chargePointId: string
  chargePointName: string
  connectors: Connector[]
  isAdmin?: boolean
  /** Para onde o foco volta ao fechar (o botão do menu da linha — o item do menu que abriu o diálogo já não existe). */
  restoreFocusTo?: RefObject<HTMLElement | null>
  onOpenChange: (open: boolean) => void
}) {
  const [stage, setStage] = useState<Stage>("form")
  const [connectorChoice, setConnectorChoice] = useState<number | null>(null)
  const [driver, setDriver] = useState<DriverListRow | null>(null)
  const [reasonInput, setReasonInput] = useState("")
  const [showErrors, setShowErrors] = useState(false)
  const [serverError, setServerError] = useState<RemoteStartError | null>(null)
  const [correlationId, setCorrelationId] = useState<string | null>(null)

  const queryClient = useQueryClient()
  const mutation = useRemoteStart(chargePointId)
  const phase = useCommandPolling(correlationId)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const errorRef = useRef<HTMLDivElement>(null)

  // Escolha de conector derivada: vale só se ainda estiver livre (a lista muda por tempo real enquanto o diálogo está aberto); com um único livre, já vem escolhido.
  const startable = connectors.filter((c) => isConnectorStartable(c.status))
  const connectorId = startable.some((c) => c.connectorId === connectorChoice) ? connectorChoice : startable.length === 1 ? startable[0].connectorId : null

  const reason = validateReason(reasonInput)
  const reasonError = serverError?.field === "reason" ? serverError.message : showErrors ? reason.error : null
  const formValid = connectorId !== null && driver !== null && reason.error === null
  const sending = mutation.isPending

  // Foco no título do passo novo: o botão que a pessoa apertou some do DOM e, sem isto, o foco cairia no corpo do diálogo (teclado/leitor de tela perdem o lugar).
  useEffect(() => {
    if (stage !== "form") headingRef.current?.focus()
  }, [stage])

  // Falha ao enviar: o botão "Iniciar recarga" fica desabilitado enquanto envia e o foco cairia no corpo do diálogo — leva o foco ao aviso (que já é `role="alert"`).
  // Ao reenviar o erro some e volta (remonta), então o foco vai de novo mesmo repetindo a mesma mensagem.
  useEffect(() => {
    if (stage === "confirm" && serverError && serverError.field !== "reason") errorRef.current?.focus()
  }, [stage, serverError])

  // Aceito: a lista de motoristas ("Em recarga") e a de carregadores podem ter mudado.
  useEffect(() => {
    if (phase === "ACCEPTED") {
      void queryClient.invalidateQueries({ queryKey: driversKeys.lists })
      void queryClient.invalidateQueries({ queryKey: chargePointsKeys.all })
    }
  }, [phase, queryClient])

  const handleReview = () => {
    setShowErrors(true)
    if (!formValid) return
    setServerError(null)
    setStage("confirm")
  }

  const handleConfirm = async () => {
    if (!formValid || sending) return
    setServerError(null)
    try {
      const res = await mutation.mutateAsync({ connectorId, userId: driver.id, reason: reason.reason })
      setCorrelationId(res.correlationId)
      setStage("progress")
    } catch (err) {
      const e = remoteStartError(err)
      setServerError(e)
      if (e.field === "reason") setStage("form")
    }
  }

  const handleRetry = () => {
    setCorrelationId(null)
    setServerError(null)
    mutation.reset()
    setStage("confirm")
  }

  const finished = isTerminalPhase(phase)
  const canRetry = phase === "REJECTED" || phase === "TIMEOUT"

  return (
    <Dialog open onOpenChange={(open) => !sending && onOpenChange(open)}>
      <DialogContent
        widthClassName="sm:max-w-lg"
        onCloseAutoFocus={(e) => {
          if (restoreFocusTo?.current) {
            e.preventDefault()
            restoreFocusTo.current.focus()
          }
        }}
      >
        <DialogHeader icon={Zap}>
          <DialogTitle>Iniciar recarga</DialogTitle>
          <DialogDescription>
            {chargePointName} · debita a carteira do motorista — sem cartão.
          </DialogDescription>
        </DialogHeader>

        {stage === "form" && (
          <form
            className="space-y-5"
            noValidate
            onSubmit={(e) => {
              e.preventDefault()
              handleReview()
            }}
          >
            <ConnectorChoice
              connectors={connectors}
              value={connectorId}
              onChange={setConnectorChoice}
              error={showErrors && connectorId === null ? "Escolha o conector em que a recarga vai começar." : undefined}
            />

            <div className="space-y-2">
              <p className="text-sm font-medium text-ink-soft">
                Motorista <span className="text-danger">*</span>
              </p>
              <DriverPicker isAdmin={isAdmin} selected={driver} onSelect={setDriver} error={showErrors && !driver ? "Escolha o motorista que vai receber a recarga." : undefined} />
              {driver && (
                <div className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2" data-testid="remote-start-driver-selected">
                  <p className="text-[11px] font-bold uppercase tracking-wide text-ink-softer">Motorista escolhido</p>
                  <p className="font-semibold text-ink">{driver.name}</p>
                  <DriverBalanceLine driver={driver} />
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <Textarea
                label="Motivo"
                required
                rows={3}
                placeholder="Ex.: motorista sem bateria no celular, recarga iniciada pelo suporte por telefone"
                value={reasonInput}
                onChange={(e) => {
                  setReasonInput(e.target.value)
                  if (serverError?.field === "reason") setServerError(null)
                }}
                error={reasonError ?? undefined}
              />
              <p
                className={cn("text-right text-xs tabular-nums", reason.reason.length > REMOTE_START_REASON_MAX ? "font-bold text-danger-700" : "text-ink-softer")}
                data-testid="reason-counter"
              >
                {reason.reason.length}/{REMOTE_START_REASON_MAX} · mínimo {REMOTE_START_REASON_MIN}
              </p>
            </div>

            <Alert tone="muted" size="sm" icon={ScrollText}>
              O motivo fica registrado na auditoria, junto com o seu nome, o motorista e o horário.
            </Alert>

            <DialogFooter>
              <Button type="button" variant="ghost" size="touch" onClick={() => onOpenChange(false)}>
                Cancelar
              </Button>
              <Button type="submit" size="touch">
                Revisar recarga
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Button>
            </DialogFooter>
          </form>
        )}

        {stage === "confirm" && driver && connectorId !== null && (
          <div className="space-y-4">
            <h3 ref={headingRef} tabIndex={-1} className="text-base font-bold text-ink outline-none">
              Confirme a recarga
            </h3>
            <div className="rounded-xl border border-primary/30 bg-primary/5 p-4">
              <p className="text-lg font-black tracking-tight text-ink" data-testid="remote-start-summary">
                {remoteStartSummary(driver.name)}
              </p>
              <p className="mt-1 text-sm text-ink-softer">O valor é debitado só ao fim da recarga, pelo que for consumido. Nada é cobrado agora.</p>
              <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
                <div>
                  <dt className="text-[11px] font-bold uppercase tracking-wide text-ink-softer">Carregador</dt>
                  <dd className="break-words font-semibold text-ink">
                    {chargePointName} · conector {connectorId}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] font-bold uppercase tracking-wide text-ink-softer">Motorista</dt>
                  <dd className="break-words font-semibold text-ink">{driver.name}</dd>
                  {driver.email && <dd className="break-all text-xs text-ink-softer">{driver.email}</dd>}
                </div>
                <div>
                  <dt className="text-[11px] font-bold uppercase tracking-wide text-ink-softer">Saldo da carteira</dt>
                  <dd className="font-semibold tabular-nums text-ink" data-testid="remote-start-balance">
                    {formatCents(driver.walletBalanceCents)}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] font-bold uppercase tracking-wide text-ink-softer">Dívida em aberto</dt>
                  <dd className="font-semibold tabular-nums text-ink" data-testid="remote-start-debt">
                    {driver.openDebtCents > 0 ? formatCents(driver.openDebtCents) : "Nenhuma"}
                  </dd>
                </div>
                <div className="col-span-2">
                  <dt className="text-[11px] font-bold uppercase tracking-wide text-ink-softer">Motivo</dt>
                  <dd className="break-words text-ink-soft">{reason.reason}</dd>
                </div>
              </dl>
            </div>

            {driver.openDebtCents > 0 && (
              <Alert tone="warning" size="sm" icon={TriangleAlert} role="status">
                Este motorista tem {formatCents(driver.openDebtCents)} de dívida em aberto. O servidor costuma recusar o início enquanto houver dívida.
              </Alert>
            )}

            {serverError && (
              <Alert ref={errorRef} tabIndex={-1} tone="danger" role="alert" className="outline-none" data-testid="remote-start-error">
                {serverError.message}
              </Alert>
            )}

            <DialogFooter>
              <Button type="button" variant="ghost" size="touch" disabled={sending} onClick={() => setStage("form")}>
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                Voltar
              </Button>
              <Button type="button" size="touch" loading={sending} onClick={() => void handleConfirm()}>
                {!sending && <Check className="h-4 w-4" aria-hidden="true" />}
                Iniciar recarga
              </Button>
            </DialogFooter>
          </div>
        )}

        {stage === "progress" && driver && connectorId !== null && (
          <div className="space-y-4">
            <h3 ref={headingRef} tabIndex={-1} className="text-base font-bold text-ink outline-none">
              Acompanhando a recarga
            </h3>
            <p className="text-sm text-ink-softer">
              {chargePointName} · conector {connectorId} · carteira de {driver.name}
            </p>
            {phase !== "IDLE" && <RemoteStartProgress phase={phase} />}
            {!finished && <p className="text-xs text-ink-softer">Você pode fechar esta janela: o comando já foi enviado, mas o resultado deixa de aparecer aqui.</p>}

            <DialogFooter>
              {canRetry && (
                <Button type="button" variant="outline" size="touch" onClick={handleRetry}>
                  <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                  Tentar de novo
                </Button>
              )}
              {finished && phase !== "REJECTED" && (
                <Link to="/admin/sessoes" className={buttonVariants({ variant: phase === "ACCEPTED" ? "default" : "outline", size: "touch" })}>
                  Ver sessões
                </Link>
              )}
              <Button type="button" variant="ghost" size="touch" onClick={() => onOpenChange(false)}>
                <X className="h-4 w-4" aria-hidden="true" />
                {finished ? "Concluir" : "Fechar janela"}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
