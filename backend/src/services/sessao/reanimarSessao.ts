import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { alertarSessao } from './alertasSessao'
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
}

export type ReanimarSessaoResultado = 'REANIMADA' | 'NAO_ESTA_NAO_CONFIRMADA' | 'CONDICAO_MUDOU' | 'CONECTOR_OCUPADO'

export async function reanimarSessao(params: ReanimarSessaoParams): Promise<ReanimarSessaoResultado> {
  const { sessionId } = params

  let resultado: { tipo: 'REANIMADA'; chargePointId: string; para: 'CHARGING' | 'FINISHING' } | { tipo: Exclude<ReanimarSessaoResultado, 'REANIMADA'> }
  try {
    resultado = await prisma.$transaction(async (tx) => {
      const travada = await travarSessao(tx, sessionId)
      if (travada.status !== 'STOP_UNCONFIRMED') return { tipo: 'NAO_ESTA_NAO_CONFIRMADA' as const }
      if (!fotoAindaVale(travada, params.fotoEsperada)) return { tipo: 'CONDICAO_MUDOU' as const }

      const dados = await tx.chargingSession.findUniqueOrThrow({ where: { id: sessionId }, select: { chargingEndedAt: true } })
      const para = dados.chargingEndedAt ? ('FINISHING' as const) : ('CHARGING' as const)
      const alteradas = await tx.chargingSession.updateMany({
        where: { id: sessionId, status: 'STOP_UNCONFIRMED' },
        data: { status: para, unconfirmedAt: null, unconfirmedReason: null, provisionalCostCents: null },
      })
      if (alteradas.count !== 1) return { tipo: 'NAO_ESTA_NAO_CONFIRMADA' as const }
      return { tipo: 'REANIMADA' as const, chargePointId: travada.chargePointId, para }
    })
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      // Outra sessão ativa no mesmo conector (índice único parcial). A transação inteira foi desfeita: a sessão segue STOP_UNCONFIRMED.
      alertarSessao('session_revived_after_unconfirmed', { sessionId, outcome: 'connector_busy' }, 'não foi possível reanimar: o conector já tem OUTRA sessão ativa — a sessão segue em confirmação até o U2')
      return 'CONECTOR_OCUPADO'
    }
    throw err
  }

  if (resultado.tipo !== 'REANIMADA') return resultado.tipo

  alertarSessao('session_revived_after_unconfirmed', { sessionId, chargePointId: resultado.chargePointId, revivedTo: resultado.para }, 'o carregador voltou a entregar energia depois de STOP_UNCONFIRMED — sessão reanimada, nada foi cobrado')
  logger.info({ sessionId }, '[sessao] sessão reanimada (U1)')
  return 'REANIMADA'
}
