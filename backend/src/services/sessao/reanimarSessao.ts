import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { emitSessionUpdated } from '../../realtime/emit'
import type Redis from 'ioredis'
import { redis as redisPadrao } from '../../lib/redis'
import { withDeadline } from '../../lib/withDeadline'
import { incrWithTtl } from '../../lib/redisCounter'
import { alertarSessaoLimitado } from './alertasSessao'
import { travarSessao, fotoAindaVale, type FotoDaSessao } from './travarSessao'

/**
 * U1 (F5.9): o carregador continua mandando MeterValues DEPOIS de a sessão entrar em `STOP_UNCONFIRMED` — ele não encerrou nada
 * (cenário M5: aceitou/recusou o stop e seguiu entregando). Devolve a sessão ao estado aberto, sem mexer em dinheiro.
 *
 * Volta para `FINISHING` se já havia janela de ociosidade aberta (`chargingEndedAt`), senão `CHARGING` — o próximo StatusNotification do
 * conector é a fonte de verdade e corrige o que for preciso. Limpa `unconfirmedAt/Reason` e o custo provisório (deixaram de valer);
 * `stopRequestedAt/By/stopAttempts` ficam: se o stop havia sido pedido, o R3 o reenvia no ciclo seguinte (até o teto).
 *
 * A decisão de reanimar é do núcleo (`avaliarSessaoAberta`, que já barra o vai-e-vem); aqui só se reconfere sob o lock que a foto ainda
 * vale. Conflito de conector: `ux_charging_session_active_per_connector` só cobre STARTED/CHARGING/FINISHING — se, durante a janela,
 * OUTRA sessão abriu no mesmo conector (D7), reanimar violaria o índice; nesse caso NÃO reanima, alerta, e a janela segue até o U2.
 */
export interface ReanimarSessaoParams {
  sessionId: string
  fotoEsperada: FotoDaSessao
  /** Só teste: Redis injetado. */
  redis?: Redis
}

export type ReanimarSessaoResultado = 'REANIMADA' | 'NAO_ESTA_NAO_CONFIRMADA' | 'CONDICAO_MUDOU' | 'CONECTOR_OCUPADO' | 'TETO_DE_REANIMACOES'

/**
 * M7 (Órion): teto de reanimações por sessão. Com o conector AVAILABLE há > 5 min o R2 marcava de novo no ciclo seguinte e o U1 reanimava de novo — vai-e-vem sem teto,
 * com alertas e SSE sem limite (sem efeito no dinheiro, mas ruído que treina o plantão a ignorar). Passou de `MAX_REANIMACOES_POR_SESSAO`, a sessão fica em confirmação
 * até o U2 (que encerra com as amostras que chegaram) e o alerta de erro sai UMA vez por hora.
 */
export const MAX_REANIMACOES_POR_SESSAO = 5
const REANIMACOES_TTL_SEGUNDOS = 7 * 24 * 3600
const REDIS_PRAZO_MS = 3_000
export const chaveReanimacoes = (sessionId: string) => `session:revives:${sessionId}`

export async function reanimarSessao(params: ReanimarSessaoParams): Promise<ReanimarSessaoResultado> {
  const { sessionId } = params
  const redis = params.redis ?? redisPadrao

  // Teto de reanimações (Redis; fora do ar => sem teto, como antes). Só LÊ aqui; incrementa depois de reanimar de verdade.
  try {
    const feitas = Number((await withDeadline(redis.get(chaveReanimacoes(sessionId)), REDIS_PRAZO_MS, 'contador de reanimações')) ?? '0')
    if (feitas >= MAX_REANIMACOES_POR_SESSAO) {
      await alertarSessaoLimitado('session_revived_after_unconfirmed', { sessionId, outcome: 'revive_ceiling', revives: feitas }, `a sessão já foi reanimada ${feitas}x — NÃO reanima de novo; segue em confirmação até o encerramento pelo servidor (revisar o carregador/conector)`, { redis })
      return 'TETO_DE_REANIMACOES'
    }
  } catch (err) {
    logger.warn({ err, sessionId }, '[sessao] contador de reanimações indisponível (Redis) — seguindo sem teto')
  }

  let resultado: { tipo: 'REANIMADA'; chargePointId: string; operatorId: string; userId: string; para: 'CHARGING' | 'FINISHING' } | { tipo: Exclude<ReanimarSessaoResultado, 'REANIMADA'> }
  try {
    resultado = await prisma.$transaction(async (tx) => {
      const travada = await travarSessao(tx, sessionId)
      if (travada.status !== 'STOP_UNCONFIRMED') return { tipo: 'NAO_ESTA_NAO_CONFIRMADA' as const }
      if (!fotoAindaVale(travada, params.fotoEsperada)) return { tipo: 'CONDICAO_MUDOU' as const }

      const dados = await tx.chargingSession.findUniqueOrThrow({ where: { id: sessionId }, select: { chargingEndedAt: true, userId: true } })
      const para = dados.chargingEndedAt ? ('FINISHING' as const) : ('CHARGING' as const)
      const alteradas = await tx.chargingSession.updateMany({
        where: { id: sessionId, status: 'STOP_UNCONFIRMED' },
        data: { status: para, unconfirmedAt: null, unconfirmedReason: null, provisionalCostCents: null },
      })
      if (alteradas.count !== 1) return { tipo: 'NAO_ESTA_NAO_CONFIRMADA' as const }
      return { tipo: 'REANIMADA' as const, chargePointId: travada.chargePointId, operatorId: travada.operatorId, userId: dados.userId, para }
    })
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      // Outra sessão ativa no mesmo conector (índice único parcial). A transação inteira foi desfeita: a sessão segue STOP_UNCONFIRMED.
      await alertarSessaoLimitado('session_revived_after_unconfirmed', { sessionId, outcome: 'connector_busy' }, 'não foi possível reanimar: o conector já tem OUTRA sessão ativa — a sessão segue em confirmação até o U2', { redis })
      return 'CONECTOR_OCUPADO'
    }
    throw err
  }

  if (resultado.tipo !== 'REANIMADA') return resultado.tipo

  void withDeadline(incrWithTtl(redis, chaveReanimacoes(sessionId), REANIMACOES_TTL_SEGUNDOS), REDIS_PRAZO_MS, 'contador de reanimações').catch(() => undefined)
  // BAIXO-1: pelo limitador (1x/h por sessão); o teto acima já barra o vai-e-vem.
  await alertarSessaoLimitado('session_revived_after_unconfirmed', { sessionId, chargePointId: resultado.chargePointId, revivedTo: resultado.para }, 'o carregador voltou a entregar energia depois de STOP_UNCONFIRMED — sessão reanimada, nada foi cobrado', { redis })
  logger.info({ sessionId }, '[sessao] sessão reanimada (U1)')
  void emitSessionUpdated({ operatorId: resultado.operatorId, userId: resultado.userId, sessionId, chargePointId: resultado.chargePointId }).catch((err) =>
    logger.error({ err, sessionId }, '[realtime] falha ao publicar session.updated (não bloqueante)'),
  )
  return 'REANIMADA'
}
