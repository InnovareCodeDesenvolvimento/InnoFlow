import type { PagamentoPort } from '../../core/pagamentos/porta'
import { decidirAdaptadorPagamento, type DecisaoAdaptadorPagamento } from '../../core/pagamentos/decidirAdaptador'
import { GatewayPagamentoNaoConfiguradoError } from '../../core/pagamentos/erros'
import { criarCieloAdapterFromEnv } from './cieloAdapter'
import { FakeAdapter } from './fakeAdapter'
import { env } from '../../lib/env'
import { logger } from '../../lib/logger'

/**
 * Composição do adaptador de pagamento — decisão de PROCESSO, não da porta. A
 * regra (qual adaptador, em qual ambiente) vive em `core/pagamentos/
 * decidirAdaptador.ts`, pura e testada: sem credencial Cielo, DEV/CI usam o
 * `FakeAdapter`, mas PRODUÇÃO fica BLOQUEADA (lança
 * `GatewayPagamentoNaoConfiguradoError`, que as rotas viram em 503) — o Fake
 * aprova qualquer cartão, então em produção ele só entra com opt-in explícito
 * (`PAYMENT_ALLOW_FAKE_ADAPTER=true`) e log de ERRO.
 *
 * LAZY de propósito: só resolve no primeiro uso real (rota de topup/webhook/
 * varredor), NUNCA no boot dos 3 entrypoints — mesma lição de
 * `bug-env-eager-todos-entrypoints.md`.
 */
let cached: PagamentoPort | null = null
let usandoFake = false
let avisouBloqueio = false

function decisaoAtual(): DecisaoAdaptadorPagamento {
  return decidirAdaptadorPagamento({
    nodeEnv: env.NODE_ENV,
    temCredenciaisCielo: Boolean(env.CIELO_MERCHANT_ID && env.CIELO_MERCHANT_KEY),
    permitirFakeEmProducao: env.PAYMENT_ALLOW_FAKE_ADAPTER,
  })
}

export function getPagamentoPort(): PagamentoPort {
  if (cached) return cached
  const decisao = decisaoAtual()
  switch (decisao) {
    case 'CIELO':
      // Credencial presente: erro do adaptador PROPAGA (nunca cai para o Fake escondendo configuração errada).
      cached = criarCieloAdapterFromEnv(env)
      usandoFake = false
      logger.info('[pagamentos] usando CieloAdapter (credenciais CIELO_MERCHANT_ID/CIELO_MERCHANT_KEY configuradas)')
      return cached
    case 'FAKE_DEV':
      cached = new FakeAdapter()
      usandoFake = true
      logger.warn('[pagamentos] sem credenciais da Cielo — usando FakeAdapter (ambiente não-produtivo; NENHUM pagamento real)')
      return cached
    case 'FAKE_PERMITIDO_EM_PRODUCAO':
      cached = new FakeAdapter()
      usandoFake = true
      logger.error({ alert: 'payment_fake_adapter_in_production' }, '[pagamentos] ALERTA: FakeAdapter ATIVO EM PRODUÇÃO por PAYMENT_ALLOW_FAKE_ADAPTER=true — aprova QUALQUER cartão e NÃO cobra nada. Só para demonstração.')
      return cached
    case 'BLOQUEADO':
      if (!avisouBloqueio) {
        avisouBloqueio = true
        logger.error({ alert: 'payment_gateway_not_configured' }, '[pagamentos] produção sem CIELO_MERCHANT_ID/CIELO_MERCHANT_KEY — Pix e cartão ficam indisponíveis (503) até configurar')
      }
      throw new GatewayPagamentoNaoConfiguradoError()
  }
}

/** `false` só quando produção está BLOQUEADA por falta de credencial — os varredores periódicos pulam a rodada em vez de gerar erro a cada minuto. */
export function isPagamentoDisponivel(): boolean {
  return decisaoAtual() !== 'BLOQUEADO'
}

export function isUsandoFakeAdapter(): boolean {
  return usandoFake
}

/** Só para teste — força reavaliar a escolha do adaptador (env pode mudar entre suítes). */
export function resetPagamentoPortCacheParaTeste(): void {
  cached = null
  usandoFake = false
  avisouBloqueio = false
}
