/**
 * Regra ÚNICA de "online" e de "livre agora" dos eletropostos (mapa do PWA,
 * QR do carregador, início de recarga remoto, dashboard). Função pura (sem
 * Prisma/Express/relógio implícito) de propósito: reescrever o limiar ou a
 * fórmula em qualquer outro lugar é bug garantido — foi exatamente assim que
 * `GET /api/sites` chegou a mostrar "Disponível" para carregador offline
 * (Nova, decisoes-mapa-eletropostos.md, decisão 2 e 3).
 *
 * Único ponto que NÃO passa por aqui: a contagem online/offline do dashboard
 * é uma agregação SQL (`api/services/dashboardService.ts`) — ela usa a mesma
 * `CHARGE_POINT_ONLINE_THRESHOLD_MS` e a mesma condição sobre
 * `lastSeenAt`/`disconnectedAt`, escrita à parte porque roda no banco.
 */

/** "Online" = reportou (`lastSeenAt`) há menos que isto. Constante nomeada — nunca número mágico espalhado pelo código. */
export const CHARGE_POINT_ONLINE_THRESHOLD_MS = 5 * 60 * 1000

/**
 * Intervalo de Heartbeat que o gateway devolve no `BootNotification.conf`.
 * Tem que caber VÁRIAS vezes dentro do limiar de online: com os dois em 300s
 * (o valor antigo) um carregador saudável e ocioso "piscava" offline a cada
 * ciclo, porque o próximo heartbeat chegava exatamente quando o limiar
 * vencia. `HEARTBEAT_INTERVALS_PER_THRESHOLD` (teste unitário) trava a razão.
 */
export const OCPP_HEARTBEAT_INTERVAL_SECONDS = 60

export interface PresencaCarregador {
  /** Última mensagem/conexão vista do carregador (`ChargePoint.lastSeenAt`). */
  lastSeenAt: Date | null
  /** Instante do último close do WebSocket (`ChargePoint.disconnectedAt`); `null`/`undefined` = nunca registrado. */
  disconnectedAt?: Date | null
}

export function isChargePointOnline(presenca: PresencaCarregador, now: Date = new Date()): boolean {
  const { lastSeenAt, disconnectedAt } = presenca
  if (!lastSeenAt) return false
  // Fechou DEPOIS (ou no mesmo instante) da última mensagem = caiu. Qualquer
  // mensagem/conexão posterior move `lastSeenAt` para frente e o carregador
  // volta a online sozinho — ninguém precisa limpar `disconnectedAt`.
  if (disconnectedAt && disconnectedAt.getTime() >= lastSeenAt.getTime()) return false
  return now.getTime() - lastSeenAt.getTime() < CHARGE_POINT_ONLINE_THRESHOLD_MS
}

/** "Livre agora" — estado de AGORA, não existe reserva. Carregador offline NUNCA é livre, qualquer que seja o último status persistido do conector. */
export function isConnectorFree(online: boolean, status: string): boolean {
  return online && status === 'AVAILABLE'
}

export interface ConectorParaResumo<TType extends string = string> {
  type: TType
  maxPowerKw: number | null
  free: boolean
}

export interface GrupoDeConectores<TType extends string = string> {
  type: TType
  maxPowerKw: number | null
  total: number
  free: number
}

export interface ResumoDeConectores<TType extends string = string> {
  total: number
  free: number
  groups: GrupoDeConectores<TType>[]
}

/**
 * Agrega conectores por (tipo, potência) — o que o mapa/lista mostra sem
 * somar conector por conector. Ordem determinística (tipo A→Z, potência
 * maior primeiro, sem potência por último) para a resposta não "dançar"
 * entre requisições.
 */
export function resumirConectores<TType extends string>(conectores: readonly ConectorParaResumo<TType>[]): ResumoDeConectores<TType> {
  const groups = new Map<string, GrupoDeConectores<TType>>()
  let free = 0

  for (const c of conectores) {
    if (c.free) free++
    const key = `${c.type}|${c.maxPowerKw ?? 'null'}`
    const group = groups.get(key) ?? { type: c.type, maxPowerKw: c.maxPowerKw, total: 0, free: 0 }
    group.total++
    if (c.free) group.free++
    groups.set(key, group)
  }

  const ordered = [...groups.values()].sort((a, b) => {
    if (a.type !== b.type) return a.type < b.type ? -1 : 1
    if (a.maxPowerKw === b.maxPowerKw) return 0
    if (a.maxPowerKw === null) return 1
    if (b.maxPowerKw === null) return -1
    return b.maxPowerKw - a.maxPowerKw
  })

  return { total: conectores.length, free, groups: ordered }
}
