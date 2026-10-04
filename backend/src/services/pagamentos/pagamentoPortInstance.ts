import { createHash } from 'node:crypto'
import type { PagamentoPort } from '../../core/pagamentos/porta'
import { decidirAdaptadorPagamento, type DecisaoAdaptadorPagamento } from '../../core/pagamentos/decidirAdaptador'
import { ConfiguracaoGatewayIncoerenteError, ConfiguracaoGatewayIndisponivelError, GatewayPagamentoNaoConfiguradoError } from '../../core/pagamentos/erros'
import { resolverUrlsCielo, temCredenciaisCielo, verificarCoerenciaUrls, type EstadoEfetivo, type LinhaConfigGateway } from '../../core/pagamentos/configGateway'
import { decryptPaymentSecret } from '../../lib/crypto/paymentSecrets'
import { criarCieloAdapterFromEnv } from './cieloAdapter'
import { FakeAdapter } from './fakeAdapter'
import { getConfigEfetiva, type ConfigEfetiva } from './gatewayConfig'
import { env } from '../../lib/env'
import { logger } from '../../lib/logger'

/**
 * Composição do adaptador de pagamento — decisão de PROCESSO, não da porta. A regra (qual adaptador, em qual
 * ambiente) vive em `core/pagamentos/decidirAdaptador.ts`, pura e testada: sem credencial Cielo, DEV/CI usam o
 * `FakeAdapter`, mas PRODUÇÃO fica BLOQUEADA (lança `GatewayPagamentoNaoConfiguradoError`, que as rotas viram
 * em 503) — o Fake aprova qualquer cartão, então em produção ele só entra com opt-in explícito
 * (`PAYMENT_ALLOW_FAKE_ADAPTER=true`) e log de ERRO.
 *
 * F5.5 (02/10/2026): a credencial agora pode vir do BANCO (tela do admin) OU do env — "tem credencial" é
 * qualquer um dos dois (`getConfigEfetiva`, precedência banco > env). Garantias que a refatoração NÃO pode
 * reabrir:
 *  - falha ao LER/DECIFRAR a config => lança `ConfiguracaoGatewayIndisponivelError` (503), NUNCA cai no Fake;
 *  - credencial presente porém inválida propaga o erro do adaptador (nunca Fake);
 *  - ambiente x URLs incoerentes (production com URL de sandbox ou o inverso) => recusa construir o adaptador.
 *
 * ASSÍNCRONO (era síncrono): ler a config é I/O (Prisma, com cache de 10 s em `gatewayConfig.ts`). Todos os
 * chamadores já eram `async`; os que usavam `getPagamentoPort()` como valor-padrão de parâmetro passaram a
 * resolvê-lo dentro do corpo (`pagamentoPort ?? (await getPagamentoPort())`) — mudança mecânica, mantém a
 * injeção do Fake nos testes.
 *
 * O adaptador (e o `FakeAdapter`, que guarda estado em memória e é singleton por processo) é reaproveitado
 * enquanto a config não muda; trocou credencial/ambiente => reconstrói.
 */
let fakeCache: FakeAdapter | null = null
let cieloCache: { chave: string; adapter: PagamentoPort } | null = null
let usandoFake = false
let avisouBloqueio = false

function decisaoPara(config: ConfigEfetiva): DecisaoAdaptadorPagamento {
  return decidirAdaptadorPagamento({
    nodeEnv: env.NODE_ENV,
    temCredenciaisCielo: temCredenciaisCielo(config.estado),
    permitirFakeEmProducao: env.PAYMENT_ALLOW_FAKE_ADAPTER,
  })
}

/** Identifica a versão da config só para decidir "reconstruir o adaptador?" — hash, nunca guarda texto de segredo. */
function chaveDaConfig(linha: LinhaConfigGateway | null, estado: EstadoEfetivo, urls: { api: string; query: string }): string {
  const partes = [estado.source, estado.environment, linha?.updatedAt.getTime() ?? 0, linha?.merchantKeyCiphertext ?? '', linha?.sopClientSecretCiphertext ?? '', urls.api, urls.query]
  return createHash('sha256').update(partes.join('|')).digest('hex')
}

function construirAdaptadorCielo(config: ConfigEfetiva): PagamentoPort {
  const { linha, estado } = config

  // URL explícita do SERVIDOR (process.env cru: o `env.ts` tem default sandbox e esconderia "não definida") ganha;
  // senão deriva do ambiente efetivo.
  const urls = resolverUrlsCielo(estado.environment, { api: process.env.CIELO_API_BASE_URL, query: process.env.CIELO_API_QUERY_BASE_URL })
  const incoerencia = verificarCoerenciaUrls(estado.environment, urls)
  if (incoerencia) {
    logger.error({ alert: 'payment_gateway_environment_url_mismatch', environment: estado.environment }, `[pagamentos] ${incoerencia} — adaptador NÃO construído (fail-closed)`)
    throw new ConfiguracaoGatewayIncoerenteError(incoerencia)
  }

  const chave = chaveDaConfig(linha, estado, urls)
  if (cieloCache && cieloCache.chave === chave) return cieloCache.adapter

  // Segredos do banco são decifrados AQUI, só na hora de construir o adaptador (nunca na leitura da config).
  let merchantKey: string | undefined
  let sopClientSecret: string | undefined
  try {
    merchantKey = estado.origem.merchant === 'database' ? decryptPaymentSecret(linha!.merchantKeyCiphertext!) : env.CIELO_MERCHANT_KEY
    sopClientSecret = estado.origem.sop === 'database' ? decryptPaymentSecret(linha!.sopClientSecretCiphertext!) : env.CIELO_SOP_CLIENT_SECRET
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err), alert: 'payment_gateway_config_decrypt_failed' }, '[pagamentos] não foi possível decifrar as credenciais salvas no banco (PAYMENT_SECRETS_KEY trocada/ausente ou dado corrompido) — gateway indisponível (fail-closed)')
    throw new ConfiguracaoGatewayIndisponivelError('falha ao decifrar as credenciais salvas', { cause: err })
  }

  // Credencial presente: erro do adaptador PROPAGA (nunca cai para o Fake escondendo configuração errada).
  const adapter = criarCieloAdapterFromEnv({
    CIELO_MERCHANT_ID: estado.merchantId ?? undefined,
    CIELO_MERCHANT_KEY: merchantKey,
    CIELO_API_BASE_URL: urls.api,
    CIELO_API_QUERY_BASE_URL: urls.query,
    CIELO_TIMEOUT_MS: env.CIELO_TIMEOUT_MS,
    CIELO_SANDBOX: estado.environment === 'sandbox',
    CIELO_SOP_SCRIPT_URL: config.envGateway.sopScriptUrl ?? undefined,
    CIELO_SOP_CLIENT_ID: estado.sopClientId ?? undefined,
    CIELO_SOP_CLIENT_SECRET: sopClientSecret,
    CIELO_SOP_OAUTH_TOKEN_URL: config.envGateway.sopOauthTokenUrl ?? undefined,
    CIELO_SOP_ACCESS_TOKEN_URL: env.CIELO_SOP_ACCESS_TOKEN_URL,
  })
  cieloCache = { chave, adapter }
  logger.info(
    { environment: estado.environment, source: estado.origem.merchant, apiHost: new URL(urls.api).host },
    '[pagamentos] usando CieloAdapter (credenciais configuradas)',
  )
  return adapter
}

export async function getPagamentoPort(): Promise<PagamentoPort> {
  const config = await getConfigEfetiva() // ConfiguracaoGatewayIndisponivelError => 503 nas rotas
  const decisao = decisaoPara(config)
  switch (decisao) {
    case 'CIELO': {
      const adapter = construirAdaptadorCielo(config)
      usandoFake = false
      return adapter
    }
    case 'FAKE_DEV':
      if (!fakeCache) {
        fakeCache = new FakeAdapter()
        logger.warn('[pagamentos] sem credenciais da Cielo — usando FakeAdapter (ambiente não-produtivo; NENHUM pagamento real)')
      }
      usandoFake = true
      return fakeCache
    case 'FAKE_PERMITIDO_EM_PRODUCAO':
      if (!fakeCache) {
        fakeCache = new FakeAdapter()
        logger.error({ alert: 'payment_fake_adapter_in_production' }, '[pagamentos] ALERTA: FakeAdapter ATIVO EM PRODUÇÃO por PAYMENT_ALLOW_FAKE_ADAPTER=true — aprova QUALQUER cartão e NÃO cobra nada. Só para demonstração.')
      }
      usandoFake = true
      return fakeCache
    case 'BLOQUEADO':
      if (!avisouBloqueio) {
        avisouBloqueio = true
        logger.error({ alert: 'payment_gateway_not_configured' }, '[pagamentos] produção sem credencial Cielo (banco nem env) — Pix e cartão ficam indisponíveis (503) até configurar')
      }
      throw new GatewayPagamentoNaoConfiguradoError()
  }
}

/**
 * `false` quando produção está BLOQUEADA por falta de credencial OU a config está ilegível — os varredores
 * periódicos pulam a rodada em vez de gerar erro a cada minuto (o motivo já foi logado em ERRO).
 */
export async function isPagamentoDisponivel(): Promise<boolean> {
  try {
    return decisaoPara(await getConfigEfetiva()) !== 'BLOQUEADO'
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, '[pagamentos] config do gateway ilegível — rodada do varredor pulada')
    return false
  }
}

export function isUsandoFakeAdapter(): boolean {
  return usandoFake
}

/** Só para teste — força reavaliar a escolha do adaptador (env pode mudar entre suítes). */
export function resetPagamentoPortCacheParaTeste(): void {
  fakeCache = null
  cieloCache = null
  usandoFake = false
  avisouBloqueio = false
}
