import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { meService } from "@/services/me"
import type { MeSessionsQuery, MeStartSessionRequest } from "@/types/api"

export const meKeys = {
  activeSession: ["me", "activeSession"] as const,
  sessions: (params: MeSessionsQuery) => ["me", "sessions", params] as const,
  sessionDetail: (id: string) => ["me", "sessions", id] as const,
  commandStatus: (correlationId: string | null) => ["me", "commandStatus", correlationId] as const,
  wallet: (params: MeSessionsQuery) => ["me", "wallet", params] as const,
}

export function useStartSession() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (payload: MeStartSessionRequest) => meService.startSession(payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: meKeys.activeSession }),
  })
}

/**
 * Sessão ativa do motorista — máquina de estados por polling (sem SSE nesta
 * fase, mesmo padrão do dashboard admin). Intervalo varia com o status:
 * `STARTED`/`CHARGING` a cada 5s, `FINISHING` a cada 3s (mais perto do fim),
 * parado quando não há sessão. `refetchIntervalInBackground: false` — não
 * bate na API com a tela em segundo plano (bateria do celular do motorista).
 *
 * - `pollWhileIdle`: continua o polling mesmo com `session: null` — usado só
 *   pela tela `/app/sessao` enquanto aguarda a sessão aparecer (comando
 *   aceito, mas o `StartTransaction` real do carregador ainda não chegou) ou
 *   confirmar que sumiu (parou). Consumidores "leves" (badge da navegação,
 *   banner da Home) usam o padrão (`false`): um fetch ao montar + refetch
 *   normal do TanStack Query, sem polling contínuo — não faz sentido gastar
 *   bateria do motorista em polling de fundo em toda tela do app.
 * - `fastPollMs`: força o intervalo (usado ao clicar "Parar recarga", para
 *   feedback mais rápido que o intervalo baseado em status).
 */
export function useActiveSession(options: { pollWhileIdle?: boolean; fastPollMs?: number } = {}) {
  const { pollWhileIdle = false, fastPollMs } = options
  return useQuery({
    queryKey: meKeys.activeSession,
    queryFn: () => meService.activeSession(),
    refetchInterval: (query) => {
      if (fastPollMs) return fastPollMs
      const status = query.state.data?.session?.status
      if (status === "FINISHING") return 3000
      if (status === "STARTED" || status === "CHARGING") return 5000
      return pollWhileIdle ? 5000 : false
    },
    refetchIntervalInBackground: false,
    // Requisito duro (ver PROGRESSO.md §PWA): uma falha de rede nunca pode
    // fazer a tela cair para 0 kWh/R$0,00 — TanStack Query já mantém
    // `data` do último sucesso enquanto uma query falha (não limpa em erro),
    // então a tela só precisa ler `isError` para mostrar o banner "sem
    // conexão" sem trocar os números exibidos.
  })
}

/**
 * Comando fire-and-forget (start/stop) devolve só `correlationId` — esta
 * query consulta o resultado real (ACCEPTED/REJECTED/TIMEOUT) até resolver.
 * `enabled: false` quando não há correlationId pendente. Intervalo default
 * 2s (comando de início); a tela de sessão passa 3s ao parar.
 */
export function useCommandStatus(correlationId: string | null, intervalMs = 2000) {
  return useQuery({
    queryKey: meKeys.commandStatus(correlationId),
    queryFn: () => meService.commandStatus(correlationId as string),
    enabled: !!correlationId,
    refetchInterval: (query) => {
      const status = query.state.data?.status
      if (!status || status === "PENDING") return intervalMs
      return false
    },
    refetchIntervalInBackground: false,
  })
}

export function useStopSession() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => meService.stopSession(id),
    // Parar a sessão débita a carteira (liquidação no StopTransaction, ver
    // PROGRESSO.md §F4) — invalidar só `activeSession` deixaria `useMeWallet`
    // com o saldo ANTIGO em cache (`staleTime: 60s` do QueryClient global)
    // em qualquer tela que já tivesse buscado a carteira antes (ex.: a Home,
    // que busca saldo ao montar). Achado testando o fluxo completo no
    // navegador — sem isso o motorista veria o saldo de antes da recarga.
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: meKeys.activeSession })
      queryClient.invalidateQueries({ queryKey: ["me", "wallet"] })
      queryClient.invalidateQueries({ queryKey: ["me", "sessions"] })
    },
  })
}

export function useMeSessions(params: MeSessionsQuery = {}) {
  return useQuery({
    queryKey: meKeys.sessions(params),
    queryFn: () => meService.listSessions(params),
    placeholderData: (prev) => prev,
  })
}

export function useMeSessionDetail(id: string | undefined) {
  return useQuery({
    queryKey: meKeys.sessionDetail(id ?? ""),
    queryFn: () => meService.sessionDetail(id as string),
    enabled: !!id,
  })
}

/**
 * `enabled` explícito: a rota é DRIVER-only, então quem chama (ex.: a
 * landing pós-QR) precisa poder desligar a query para ADMIN/OPERATOR/
 * visitante sem sessão — senão bate 401/403 à toa a cada render.
 */
export function useMeWallet(params: MeSessionsQuery = {}, enabled = true) {
  return useQuery({
    queryKey: meKeys.wallet(params),
    queryFn: () => meService.wallet(params),
    enabled,
    placeholderData: (prev) => prev,
  })
}
