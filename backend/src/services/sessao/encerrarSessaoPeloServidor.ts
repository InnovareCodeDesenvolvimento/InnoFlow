import { env } from '../../lib/env'
import { logger } from '../../lib/logger'
import type { PoliticaSemLeitura, ProvaDeLeitura } from '../../core/sessao/avaliarSessaoAberta'
import { deveZerarCusto } from '../../core/sessao/leituraFinal'
import { finalizarSessao } from '../carteira/finalizarSessao'
import { alertarSessao } from './alertasSessao'
import { resolverLeituraFinal } from './resolverLeituraFinal'
import type { FotoDaSessao } from './travarSessao'

/**
 * Encerra pelo SERVIDOR uma sessão `STOP_UNCONFIRMED` cuja janela de confirmação venceu (F5.9). Substitui `reconciliarSessaoOrfa`
 * (que fechava com dinheiro NA HORA, sobre um palpite do servidor — causa raiz de M5/M6/D-A).
 *
 * Fecha pelo MESMO núcleo do StopTransaction (`finalizarSessao`: WALLET -> `liquidarSessao`; CARD -> `prepararFechamentoCartao`, captura
 * `min(total, autorizado)` ou cancelamento se o total for 0). A leitura final é resolvida SOB O LOCK, na ordem de prova do desenho
 * (log bruto do StopTransaction > última amostra > nenhuma leitura), e a foto do watchdog é reconferida ali: um StopTransaction do
 * carregador que fechou a sessão antes => `JA_ENCERRADA`, nenhuma cobrança dupla, nenhum segundo fechamento.
 *
 * D2 (decisão do dono, chave `SESSION_NO_READING_POLICY`): sem NENHUMA leitura e política `NO_CHARGE`, custo ZERO — carteira sem
 * débito, pré-autorização do cartão cancelada — e alerta `session_closed_without_meter_reading`. NUNCA se estima energia.
 * Grava `closureSource=SERVER` e `meterStopSource` (a prova realmente usada).
 */
export interface EncerrarSessaoPeloServidorParams {
  sessionId: string
  /** Foto do watchdog (compare-and-swap sob o lock). Omitida em uso manual/teste. */
  fotoEsperada?: FotoDaSessao
  /** Default: a chave `SESSION_NO_READING_POLICY` do env. */
  politicaSemLeitura?: PoliticaSemLeitura
  /** U2 decidiu pelo prazo do hold do cartão (e não pela janela): acrescenta `card_session_hold_deadline`. */
  forcadoPeloPrazoDoCartao?: boolean
}

export type EncerrarSessaoPeloServidorResultado =
  | { encerrada: true; prova: ProvaDeLeitura; custoZerado: boolean }
  | { encerrada: false; motivo: 'JA_ENCERRADA' | 'STATUS_NAO_PERMITIDO' | 'FOTO_MUDOU' | 'ABORTADA' }

export async function encerrarSessaoPeloServidor(params: EncerrarSessaoPeloServidorParams): Promise<EncerrarSessaoPeloServidorResultado> {
  const { sessionId } = params
  const politica = params.politicaSemLeitura ?? env.SESSION_NO_READING_POLICY
  const usado: { prova: ProvaDeLeitura; custoZerado: boolean; chargePointId: string } = { prova: 'NO_READING', custoZerado: false, chargePointId: '' }

  const resultado = await finalizarSessao(
    sessionId,
    async (tx, sessao) => {
      const dados = await tx.chargingSession.findUniqueOrThrow({ where: { id: sessionId }, select: { meterStartWh: true, startedAt: true } })
      const leitura = await resolverLeituraFinal(tx, { id: sessionId, chargePointId: sessao.chargePointId, ocppTransactionId: sessao.ocppTransactionId, meterStartWh: dados.meterStartWh, startedAt: dados.startedAt })
      const zerarCusto = deveZerarCusto(leitura.prova, politica)
      usado.prova = leitura.prova
      usado.custoZerado = zerarCusto
      usado.chargePointId = sessao.chargePointId
      return {
        meterStopWh: leitura.meterStopWh,
        timestamp: leitura.timestamp,
        stopReason: leitura.stopReason ?? 'OTHER',
        closureSource: 'SERVER' as const,
        meterStopSource: leitura.prova,
        zerarCusto,
      }
    },
    { statusPermitidos: ['STOP_UNCONFIRMED'], fotoEsperada: params.fotoEsperada },
  )

  if (!resultado.finalizada) {
    logger.info({ sessionId, outcome: resultado.motivo }, '[sessao] encerramento pelo servidor não aplicado (a condição mudou sob o lock)')
    return { encerrada: false, motivo: resultado.motivo }
  }

  const campos = { sessionId, chargePointId: usado.chargePointId, meterProof: usado.prova, chargeZeroed: usado.custoZerado }
  alertarSessao('session_closed_by_server', campos, 'sessão encerrada pelo servidor depois da janela de confirmação')
  if (usado.prova === 'NO_READING') {
    alertarSessao(
      'session_closed_without_meter_reading',
      { ...campos, policy: politica },
      usado.custoZerado ? 'sessão encerrada SEM nenhuma leitura do medidor — NÃO cobrada (política NO_CHARGE); revisão manual' : 'sessão encerrada SEM nenhuma leitura do medidor — cobrada pela política MIN_FEE (taxa fixa/mínimo); revisão manual',
    )
  }
  if (params.forcadoPeloPrazoDoCartao) {
    alertarSessao('card_session_hold_deadline', campos, 'encerramento forçado pelo prazo do hold da pré-autorização do cartão')
  }
  return { encerrada: true, prova: usado.prova, custoZerado: usado.custoZerado }
}
