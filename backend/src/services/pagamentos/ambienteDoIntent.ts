import type { PaymentEnvironment } from '@prisma/client'
import { logger } from '../../lib/logger'
import { getAmbienteEfetivoParaBanco } from './gatewayConfig'

/**
 * Defesa em profundidade da marca de ambiente (F5.7, M4d): um `PaymentIntent` nasce com o ambiente EFETIVO do gateway (`SANDBOX`/`PRODUCTION`) e só
 * pode ser reconsultado/capturado/cancelado/creditado NESSE host. Se o ambiente efetivo mudou desde então (o ADMIN trocou o gateway — a troca é
 * bloqueada com intent vivo, mas há a corrida de um intent criado logo depois da checagem, e o legado sem marca real), chamar a Cielo agora iria ao HOST ERRADO:
 * um id de sandbox consultado em produção (ou o inverso) devolve "não encontrado" e o fluxo trataria isso como falha — marcando FAILED/dívida
 * por um erro NOSSO. Então, antes de qualquer chamada à Cielo sobre um intent existente: se `intent.environment` ≠ ambiente efetivo, NÃO chama,
 * loga `alert: payment_intent_environment_mismatch` e quem chamou trata como falha retentável/pulada (nunca decide cobrança por isso).
 * Um intent divergente fica como está até o ambiente voltar (ou até alguém resolver à mão) — por isso o alerta, que o dono precisa ver.
 */

export class AmbienteDoIntentDivergenteError extends Error {
  constructor(
    readonly paymentIntentId: string,
    readonly ambienteDoIntent: PaymentEnvironment,
    readonly ambienteEfetivo: PaymentEnvironment,
  ) {
    super(`PaymentIntent ${paymentIntentId} é do ambiente ${ambienteDoIntent} mas o gateway está em ${ambienteEfetivo} — a Cielo NÃO foi chamada`)
    this.name = 'AmbienteDoIntentDivergenteError'
  }
}

const INTERVALO_LOG_MS = 10 * 60_000
const ultimoLog = new Map<string, number>()

async function verificar(intent: { id: string; environment: PaymentEnvironment }, contexto: string): Promise<{ confere: boolean; efetivo: PaymentEnvironment }> {
  const efetivo = await getAmbienteEfetivoParaBanco()
  if (intent.environment === efetivo) return { confere: true, efetivo }

  // Os varredores rodam a cada minuto: um alerta por intent a cada 10 min basta (não vira centenas de linhas iguais).
  const agora = Date.now()
  if (agora - (ultimoLog.get(intent.id) ?? 0) >= INTERVALO_LOG_MS) {
    ultimoLog.set(intent.id, agora)
    logger.error(
      { alert: 'payment_intent_environment_mismatch', paymentIntentId: intent.id, intentEnvironment: intent.environment, effectiveEnvironment: efetivo, contexto },
      '[pagamentos] PaymentIntent de OUTRO ambiente que o gateway efetivo — a Cielo NÃO foi chamada (nada marcado como falha/dívida por isso)',
    )
  }
  return { confere: false, efetivo }
}

/** `true` = o intent é do ambiente efetivo e pode falar com a Cielo. `false` = divergente: NÃO chamar (já logou) — quem chamou PULA este intent. Config ilegível propaga (`ConfiguracaoGatewayIndisponivelError`). */
export async function ambienteDoIntentConfere(intent: { id: string; environment: PaymentEnvironment }, contexto: string): Promise<boolean> {
  return (await verificar(intent, contexto)).confere
}

/** Como `ambienteDoIntentConfere`, mas LANÇA `AmbienteDoIntentDivergenteError` (para jobs com retentativa: a falha é retentável e nunca decide cobrança). */
export async function exigirAmbienteDoIntent(intent: { id: string; environment: PaymentEnvironment }, contexto: string): Promise<void> {
  const { confere, efetivo } = await verificar(intent, contexto)
  if (!confere) throw new AmbienteDoIntentDivergenteError(intent.id, intent.environment, efetivo)
}

/** Só para teste. */
export function resetLogsDeAmbienteDivergenteParaTeste(): void {
  ultimoLog.clear()
}
