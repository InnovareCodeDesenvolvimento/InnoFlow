import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'

/**
 * Vigia do PRAZO DE RESPOSTA do chargeback (L1.8). O dono cadastra o chargeback com `responseDeadline` (o prazo que a Cielo deu para contestar), mas o InnoFlow não descobre nada
 * sozinho: sem este aviso, o prazo vence calado e a disputa se perde por omissão. Roda no worker 1x por DIA (job repeatable de 24 h — a janela diária É o dedupe: o aviso não se repete
 * a cada hora; o notificador ainda deduplica por 30 min por cima disso).
 *
 *  - `chargeback_response_deadline_near`: chargeback OPEN com prazo nos próximos `DIAS_DE_ANTECEDENCIA` (3) dias. `diasRestantes` = dias INTEIROS até o prazo, arredondado PARA CIMA
 *    (prazo daqui a 2 h = 1; até 3 dias = 3).
 *  - `chargeback_response_deadline_overdue`: OPEN com o prazo JÁ vencido. `diasDeAtraso` = dias inteiros desde o vencimento (0 = venceu há menos de 24 h). Continua avisando todo dia
 *    enquanto estiver OPEN — o desfecho (WON/LOST/ACCEPTED) é o que silencia.
 *
 * Um aviso POR chargeback (id do chargeback + id da venda + dias): o dono precisa saber QUAL. Sem PII: só ids opacos e contagem de dias (o contexto que sai para e-mail/WhatsApp ainda passa
 * pela allowlist de `core/alertas/contexto.ts`). Só LÊ; nunca altera o chargeback. Chargeback sem prazo cadastrado não é vigiado (nada a comparar).
 */

export const DIAS_DE_ANTECEDENCIA = 3
/** Teto de avisos por rodada (anti-tempestade; a fila real é de poucas unidades). Passou disso: 1 log de resumo com o total — os mais urgentes (prazo mais antigo) saem primeiro. */
export const MAX_AVISOS_POR_RODADA = 50
const DIA_MS = 24 * 60 * 60 * 1000

export interface VigiarPrazoChargebacksResultado {
  proximos: number
  vencidos: number
  /** Quantos avisos de fato saíram nesta rodada (≤ MAX_AVISOS_POR_RODADA). */
  avisosEmitidos: number
}

/** `maxAvisos` só existe para o teste provar o corte (em produção vale o teto fixo). */
export async function vigiarPrazoChargebacks(agora: Date = new Date(), opcoes: { maxAvisos?: number } = {}): Promise<VigiarPrazoChargebacksResultado> {
  const maxAvisos = opcoes.maxAvisos ?? MAX_AVISOS_POR_RODADA
  const limite = new Date(agora.getTime() + DIAS_DE_ANTECEDENCIA * DIA_MS)
  const abertos = await prisma.paymentReversal.findMany({
    where: { kind: 'CHARGEBACK', status: 'OPEN', responseDeadline: { not: null, lte: limite } },
    orderBy: [{ responseDeadline: 'asc' }, { id: 'asc' }],
    take: maxAvisos + 1,
    select: { id: true, paymentIntentId: true, responseDeadline: true },
  })

  const resultado: VigiarPrazoChargebacksResultado = { proximos: 0, vencidos: 0, avisosEmitidos: 0 }
  for (const cb of abertos.slice(0, maxAvisos)) {
    const prazo = cb.responseDeadline!.getTime()
    if (prazo < agora.getTime()) {
      resultado.vencidos += 1
      logger.warn(
        { alert: 'chargeback_response_deadline_overdue', chargebackId: cb.id, paymentIntentId: cb.paymentIntentId, diasDeAtraso: Math.floor((agora.getTime() - prazo) / DIA_MS) },
        '[chargeback] o prazo de resposta ao chargeback JÁ VENCEU e ele segue em aberto',
      )
    } else {
      resultado.proximos += 1
      logger.warn(
        { alert: 'chargeback_response_deadline_near', chargebackId: cb.id, paymentIntentId: cb.paymentIntentId, diasRestantes: Math.ceil((prazo - agora.getTime()) / DIA_MS) },
        '[chargeback] o prazo de resposta ao chargeback está chegando',
      )
    }
    resultado.avisosEmitidos += 1
  }
  if (abertos.length > maxAvisos) {
    logger.warn({ avisosEmitidos: resultado.avisosEmitidos, limite: maxAvisos }, '[chargeback] há mais chargebacks com prazo próximo/vencido do que o teto de avisos da rodada — mostrando só os mais urgentes')
  }
  return resultado
}
