import { useEffect, useRef, useState } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { AlertTriangle, Loader2, WifiOff, Zap } from "lucide-react"
import { Button } from "@/components/ui/Button"
import { ConfirmDialog } from "@/components/ui/ConfirmDialog"
import { Card, CardContent } from "@/components/ui/Card"
import { SessionTimer } from "@/components/sessao/SessionTimer"
import { useActiveSession, useCommandStatus, useStopSession } from "@/hooks/useMeSessions"
import { useWakeLock } from "@/hooks/useWakeLock"
import { getApiErrorMessage } from "@/services/api"
import { formatCents } from "@/lib/utils"
import type { MeActiveSession } from "@/types/api"

interface StartLocationState {
  correlationId?: string
}

/**
 * `/app/sessao` — máquina de estados visual: conectando → carregando →
 * parando → recibo (o recibo é outra rota, `/app/sessoes/:id`, para onde
 * navegamos assim que a sessão ativa desaparece). Tudo é DERIVADO de
 * `location.state` + das duas queries (comando/sessão ativa) durante o
 * render — nenhum `useEffect` sincroniza estado próprio a partir delas
 * (só efeitos colaterais reais: navegar, avisar, e o timer do aviso de
 * 40s), para não empilhar re-renders em cascata.
 */
export function Sessao() {
  const location = useLocation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const initialCorrelationId = (location.state as StartLocationState | null)?.correlationId ?? null

  const [stopRequested, setStopRequested] = useState(false)
  const [confirmStopOpen, setConfirmStopOpen] = useState(false)
  const [startWarning, setStartWarning] = useState(false)

  const activeQuery = useActiveSession({ pollWhileIdle: true, fastPollMs: stopRequested ? 3000 : undefined })
  const startCommand = useCommandStatus(initialCorrelationId, 2000)
  const stopSession = useStopSession()

  const session = activeQuery.data?.session ?? null
  const commandStatus = startCommand.data?.status
  const startFailed = commandStatus === "REJECTED" || commandStatus === "TIMEOUT"
  const awaitingStart = !!initialCorrelationId && !session && !startFailed

  useWakeLock(!!session || awaitingStart)

  // Timeout de AVISO (não bloqueante) aos 40s sem o comando de início
  // confirmar — efeito de disparo único por tentativa de início (a
  // dependência não muda durante a vida deste componente).
  useEffect(() => {
    if (!initialCorrelationId) return
    const timer = setTimeout(() => setStartWarning(true), 40_000)
    return () => clearTimeout(timer)
  }, [initialCorrelationId])

  // Comando de início recusado/expirado: avisa e volta pra Home (não tem
  // pra onde "tentar de novo" automaticamente sem o QR).
  const startFailNotifiedRef = useRef(false)
  useEffect(() => {
    if (startFailed && !startFailNotifiedRef.current) {
      startFailNotifiedRef.current = true
      toast.error(
        commandStatus === "REJECTED"
          ? "O carregador recusou o comando de iniciar. Escaneie o QR code de novo para tentar outra vez."
          : "O carregador não respondeu a tempo. Escaneie o QR code de novo para tentar outra vez.",
      )
      navigate("/app", { replace: true })
    }
  }, [startFailed, commandStatus, navigate])

  // Assim que a sessão que estava ativa desaparece, ela terminou (parada
  // por nós, por auto-stop de teto, ou por qualquer outro caminho) — o
  // recibo mora em `/app/sessoes/:id`, então navegamos usando o último id
  // conhecido (guardado em ref porque `session` já virou `null` nesse ponto).
  const previousSessionRef = useRef<MeActiveSession | null>(null)
  useEffect(() => {
    if (previousSessionRef.current && !session) {
      // A carteira já foi debitada no servidor a essa altura (liquidação no
      // encerramento) — sem isso, telas que já tinham buscado a carteira
      // antes (Home, ao montar) ficariam com o saldo ANTIGO em cache até o
      // `staleTime` global (60s) vencer sozinho. `useStopSession` já invalida
      // isso quando SOMOS nós que paramos, mas a sessão também pode terminar
      // por outro caminho (auto-stop de teto, outro dispositivo) — aqui cobre
      // os dois casos.
      queryClient.invalidateQueries({ queryKey: ["me", "wallet"] })
      queryClient.invalidateQueries({ queryKey: ["me", "sessions"] })
      navigate(`/app/sessoes/${previousSessionRef.current.id}`, { replace: true, state: { justCompleted: true } })
      return
    }
    if (session) previousSessionRef.current = session
  }, [session, navigate, queryClient])

  const handleConfirmStop = async () => {
    if (!session) return
    setConfirmStopOpen(false)
    setStopRequested(true)
    try {
      await stopSession.mutateAsync(session.id)
    } catch (err) {
      setStopRequested(false)
      toast.error(getApiErrorMessage(err, "Não foi possível parar a recarga. Tente novamente."))
    }
  }

  // ---- Conectando -----------------------------------------------------------
  if (awaitingStart) {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center px-4 py-16 text-center">
        <span className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
          <Loader2 className="h-8 w-8 animate-spin text-primary" aria-hidden="true" />
        </span>
        <h1 className="mt-5 text-lg font-black text-ink">Conectando ao carregador…</h1>
        <p className="mt-1 text-sm text-ink-softer">
          {commandStatus === "ACCEPTED" ? "Comando aceito — aguardando o carregador iniciar a recarga." : "Enviando o comando de início."}
        </p>
        {startWarning && (
          <p className="mt-4 flex items-center gap-2 rounded-xl bg-warning-50 px-4 py-3 text-left text-xs font-semibold text-warning-700">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
            Isso está demorando mais que o esperado. Continue aguardando ou verifique o carregador.
          </p>
        )}
      </div>
    )
  }

  // ---- Sem sessão ativa -------------------------------------------------------
  if (!session) {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center px-4 py-16 text-center">
        <span className="flex h-16 w-16 items-center justify-center rounded-full bg-muted text-ink-subtle">
          <Zap className="h-7 w-7" aria-hidden="true" />
        </span>
        <h1 className="mt-5 text-lg font-black text-ink">Nenhuma recarga em andamento</h1>
        <p className="mt-1 text-sm text-ink-softer">Escaneie o QR code de um carregador para iniciar.</p>
      </div>
    )
  }

  // ---- Carregando / parando ---------------------------------------------------
  const belowMinimum = session.minChargeCents !== null && session.estimatedCostCents < session.minChargeCents
  const energyKwh = (session.energyDeliveredWh / 1000).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 2 })

  return (
    <div className="mx-auto max-w-md px-4 py-5">
      {activeQuery.isError && (
        <div
          role="status"
          className="mb-4 flex items-center gap-2 rounded-xl bg-warning-50 px-4 py-3 text-sm font-semibold text-warning-700"
        >
          <WifiOff className="h-4 w-4 shrink-0" aria-hidden="true" />
          Sem conexão — sua recarga continua.
        </div>
      )}

      <p className="text-xs font-bold uppercase tracking-wide text-ink-subtle">{session.site.name}</p>
      <p className="text-sm text-ink-softer">
        {session.chargePoint.ocppIdentity} · Conector {session.connector.connectorId}
      </p>

      <Card className="mt-4">
        <CardContent className="p-5 text-center">
          {stopRequested && (
            <p className="mb-3 flex items-center justify-center gap-2 text-xs font-bold uppercase tracking-wide text-warning-700">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              Parando a recarga…
            </p>
          )}

          <p className="text-6xl font-black leading-none tracking-tight text-ink">
            {energyKwh}
            <span className="ml-1.5 text-xl font-bold text-ink-softer">kWh</span>
          </p>
          <p className="mt-3 text-lg font-bold text-primary-700">{formatCents(session.estimatedCostCents)}</p>

          {belowMinimum && (
            <p className="mx-auto mt-3 inline-flex items-center gap-1.5 rounded-full bg-warning-50 px-3 py-1 text-xs font-semibold text-warning-700">
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
              Mínimo da sessão: {formatCents(session.minChargeCents)}
            </p>
          )}

          <p className="mt-5 text-3xl font-black tabular-nums text-ink">
            <SessionTimer startedAt={session.startedAt} />
          </p>

          <div className="mt-5 grid grid-cols-2 gap-3 text-left">
            <div className="rounded-xl bg-muted px-3 py-2.5">
              <p className="text-[10px] font-bold uppercase tracking-wide text-ink-subtle">Potência</p>
              <p className="text-sm font-bold text-ink">{session.lastPowerW !== null ? `${(session.lastPowerW / 1000).toFixed(1)} kW` : "—"}</p>
            </div>
            <div className="rounded-xl bg-muted px-3 py-2.5">
              <p className="text-[10px] font-bold uppercase tracking-wide text-ink-subtle">Bateria</p>
              <p className="text-sm font-bold text-ink">{session.lastSoc !== null ? `${session.lastSoc}%` : "—"}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Button
        type="button"
        variant="destructive"
        size="lg"
        className="mt-5 w-full"
        loading={stopRequested}
        disabled={stopRequested}
        onClick={() => setConfirmStopOpen(true)}
      >
        Parar recarga
      </Button>

      <ConfirmDialog
        open={confirmStopOpen}
        onOpenChange={setConfirmStopOpen}
        title="Parar a recarga agora?"
        description="O carregador vai encerrar a sessão e o valor consumido até aqui será cobrado da sua carteira."
        confirmLabel="Parar recarga"
        destructive
        onConfirm={handleConfirmStop}
      />
    </div>
  )
}
