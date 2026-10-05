import { useEffect, useState } from "react"
import { useMutation } from "@tanstack/react-query"
import { chargePointsService } from "@/services/chargePoints"
import { adminCommandsService } from "@/services/adminCommands"
import { getApiErrorStatus } from "@/services/api"
import { COMMAND_POLL_INTERVAL_MS, COMMAND_POLL_MAX_FAILURES, COMMAND_POLL_TIMEOUT_MS, type CommandPhase, type CommandProgress } from "@/lib/remoteStart"
import type { RemoteStartRequest } from "@/types/api"

/**
 * Dispara a recarga remota (ADMIN). SEM toast aqui: quem decide o que mostrar é o diálogo (o 202 só quer dizer "enfileirado" — o resultado vem do acompanhamento).
 * Não retenta sozinho: reenviar um POST que debita carteira é decisão da pessoa, não do cliente HTTP.
 */
export function useRemoteStart(chargePointId: string) {
  return useMutation({
    mutationFn: (payload: RemoteStartRequest) => chargePointsService.remoteStart(chargePointId, payload),
    retry: false,
    gcTime: 0,
  })
}

export interface CommandPollingOptions {
  intervalMs?: number
  timeoutMs?: number
  maxFailures?: number
}

/**
 * Acompanha o resultado de UM comando (`GET /api/admin/commands/:id`): consulta já ao começar e depois a cada `intervalMs`, até um desfecho do carregador
 * (`ACCEPTED`/`REJECTED`/`TIMEOUT`), até `timeoutMs` (`NO_ANSWER`), 404 (`UNAVAILABLE`, "resultado indisponível") ou `maxFailures` falhas de conexão/5xx
 * seguidas (`ERROR`; uma falha isolada não derruba o acompanhamento). 403 também vira `ERROR`.
 *
 * `ACCEPTED` com `sessionId: string` já termina (devolve o id da sessão). `ACCEPTED` com `sessionId: null` = o carregador aceitou mas a sessão ainda não nasceu: fase
 * `STARTING` (NÃO terminal) e segue consultando no mesmo ritmo, dentro do MESMO limite de `timeoutMs`. Passou do limite, ou o registro do comando expirou (404) DEPOIS do
 * aceito: termina em `ACCEPTED` sem `sessionId` (o link vai para a lista de Sessões) - já sabemos que o carregador aceitou, então não vira "indisponível" nem "sem resposta".
 * `ACCEPTED` sem a chave `sessionId` (servidor antigo) termina na hora, como antes.
 *
 * Para de consultar ao desmontar, ao trocar/zerar o `correlationId` e ao chegar a um desfecho — o `AbortController` cancela o pedido em voo. `null` = ocioso.
 * O estado é guardado COM o id a que pertence: trocar de comando nunca mostra o desfecho do anterior (derivado no render, sem `setState` síncrono em efeito).
 */
export function useCommandPolling(correlationId: string | null, options: CommandPollingOptions = {}): CommandProgress {
  const { intervalMs = COMMAND_POLL_INTERVAL_MS, timeoutMs = COMMAND_POLL_TIMEOUT_MS, maxFailures = COMMAND_POLL_MAX_FAILURES } = options
  const [outcome, setOutcome] = useState<{ id: string; phase: CommandPhase; sessionId: string | null } | null>(null)

  useEffect(() => {
    if (!correlationId) return
    const id = correlationId
    const controller = new AbortController()
    const startedAt = Date.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    let failures = 0
    let stopped = false
    let accepted = false // o carregador já disse "aceito" (só falta a sessão): muda o que 404 e "passou do limite" querem dizer

    const finish = (phase: CommandPhase, sessionId: string | null = null) => {
      if (!stopped) setOutcome({ id, phase, sessionId })
    }

    const tick = async () => {
      try {
        const res = await adminCommandsService.status(id, controller.signal)
        if (stopped) return
        failures = 0
        if (res.status === "ACCEPTED") {
          if (typeof res.sessionId === "string" && res.sessionId !== "") return finish("ACCEPTED", res.sessionId)
          if (res.sessionId === undefined) return finish("ACCEPTED") // sem a chave: nada a esperar (servidor antigo)
          accepted = true
          finish("STARTING") // `sessionId: null`: aceito, a sessão ainda não nasceu - segue consultando
        } else if (res.status !== "PENDING") {
          return finish(res.status)
        }
      } catch (err) {
        if (stopped) return
        const httpStatus = getApiErrorStatus(err)
        if (httpStatus === 404) return accepted ? finish("ACCEPTED") : finish("UNAVAILABLE")
        if (httpStatus === 403) return finish("ERROR")
        failures += 1
        if (failures >= maxFailures) return finish("ERROR")
      }
      if (Date.now() - startedAt >= timeoutMs) return accepted ? finish("ACCEPTED") : finish("NO_ANSWER")
      timer = setTimeout(() => void tick(), intervalMs)
    }

    void tick()

    return () => {
      stopped = true
      controller.abort()
      if (timer) clearTimeout(timer)
    }
  }, [correlationId, intervalMs, timeoutMs, maxFailures])

  if (!correlationId) return { phase: "IDLE", sessionId: null }
  return outcome?.id === correlationId ? { phase: outcome.phase, sessionId: outcome.sessionId } : { phase: "POLLING", sessionId: null }
}
