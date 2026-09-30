import type { PagamentoPort } from '../../core/pagamentos/porta'
import { criarCieloAdapterFromEnv } from './cieloAdapter'
import { FakeAdapter } from './fakeAdapter'
import { env } from '../../lib/env'
import { logger } from '../../lib/logger'

/**
 * Composição do adaptador real de pagamento — decisão de PROCESSO, não da
 * porta (ver gap da F5.1: "Escolha do adaptador... é decisão de composição
 * do entrypoint"). LAZY de propósito: só resolve no primeiro uso real (rota
 * de topup/webhook/varredor de expiração), NUNCA no boot dos 3 entrypoints
 * — mesma lição de `bug-env-eager-todos-entrypoints.md`.
 *
 * Sem `CIELO_MERCHANT_ID`/`CIELO_MERCHANT_KEY` configuradas (ainda não temos
 * credencial de sandbox — ver handoff), cai para `FakeAdapter` com um AVISO
 * no log — nunca silencioso, porque "produção processando Pix de mentira"
 * tem que aparecer em algum lugar.
 */
let cached: PagamentoPort | null = null
let usandoFake = false

export function getPagamentoPort(): PagamentoPort {
  if (cached) return cached
  try {
    cached = criarCieloAdapterFromEnv(env)
    usandoFake = false
    logger.info('[pagamentos] usando CieloAdapter (credenciais CIELO_MERCHANT_ID/CIELO_MERCHANT_KEY configuradas)')
  } catch (err) {
    cached = new FakeAdapter()
    usandoFake = true
    logger.warn(
      { reason: err instanceof Error ? err.message : String(err) },
      '[pagamentos] CIELO_MERCHANT_ID/CIELO_MERCHANT_KEY ausentes — usando FakeAdapter (NENHUM pagamento real está sendo processado)',
    )
  }
  return cached
}

export function isUsandoFakeAdapter(): boolean {
  return usandoFake
}

/** Só para teste — força reavaliar a escolha do adaptador (env pode mudar entre suítes). */
export function resetPagamentoPortCacheParaTeste(): void {
  cached = null
  usandoFake = false
}
