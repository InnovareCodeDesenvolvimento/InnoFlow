import { randomUUID } from 'node:crypto'
import { env } from '../../lib/env'
import { logger } from '../../lib/logger'
import { decryptPaymentSecret } from '../../lib/crypto/paymentSecrets'
import { resolverUrlsCielo, resolverUrlsSop, verificarCoerenciaUrls } from '../../core/pagamentos/configGateway'
import { mensagemDeFalhaCielo } from '../../core/pagamentos/classificarFalhaCielo'
import { CieloHttpClient, CieloHttpError } from './cieloHttpClient'
import { CieloSopOAuthError, emitirAccessTokenDoNavegadorSop, obterTokenOAuthSop, type CieloSopConfig } from './cieloSopOAuth'
import { getConfigEfetiva, type ConfigEfetiva } from './gatewayConfig'

/**
 * Teste de conexão do gateway (C2.1) — `POST /api/admin/payment-gateway/test-connection`. Executa os passos REAIS com a credencial EFETIVA (banco > env) e
 * diz, POR PASSO, o que está certo e o que consertar — sem cobrar nada, sem gravar nada e sem devolver segredo. Nasceu no Parque das Feiras de "um dia
 * inteiro de cartão morto" por credencial/ambiente errados que só apareciam quando o motorista tentava pagar.
 *
 * Passos:
 *  - MERCHANT_CREDENTIALS: `GET {apiquery}/1/sales?merchantOrderId=<uuid inexistente>` — leitura pura (nenhum efeito, nenhuma cobrança), no host de CONSULTA. A
 *    Cielo valida `MerchantId`/`MerchantKey` ANTES de procurar a venda: credencial errada volta HTTP 400 com código 132 (e 101/131/138–140, ver
 *    `classificarFalhaCielo`), 403 é IP fora da lista, e credencial boa volta 2xx ou 404 (venda inexistente) — os dois contam como credencial aceita.
 *    ⚠️ NÃO PROVADO contra a Cielo real: que um GET de venda inexistente discrimina assim é a hipótese da Nova (C2.1 do plano); se a Cielo responder outra coisa a
 *    credencial boa, o passo aparecerá como REQUEST_REFUSED (nunca como OK falso).
 *  - SOP_OAUTH e SOP_ACCESS_TOKEN: os dois passos do Silent Order Post (`cieloSopOAuth.ts`), só se o par ClientId/ClientSecret está configurado. Os tokens
 *    emitidos são DESCARTADOS na hora.
 *
 * Os dois ramos rodam em paralelo (cada chamada tem o timeout `CIELO_TIMEOUT_MS`). Nunca lança por falha da Cielo: toda falha vira `status` do passo.
 */

export type PassoTesteConexao = 'MERCHANT_CREDENTIALS' | 'SOP_OAUTH' | 'SOP_ACCESS_TOKEN'

export type StatusPassoTesteConexao =
  | 'OK'
  | 'CREDENTIAL_REJECTED' // credencial recusada (inclui "credencial de OUTRO ambiente")
  | 'IP_NOT_ALLOWED' // 403: IP de saída fora da lista de IPs confiáveis do Site Cielo — a credencial pode estar certa
  | 'UNAVAILABLE' // 5xx, timeout, rede
  | 'RATE_LIMITED'
  | 'REQUEST_REFUSED' // a Cielo/Braspag recusou a NOSSA requisição por motivo que não parece credencial
  | 'MISCONFIGURED' // ambiente x URLs incoerentes, ou segredo salvo que não decifra
  | 'NOT_CONFIGURED' // falta credencial para este passo
  | 'SKIPPED' // um passo anterior falhou

export interface ResultadoPassoTesteConexao {
  step: PassoTesteConexao
  status: StatusPassoTesteConexao
  /** Só o HOST contatado (público), sem caminho nem query. */
  host: string | null
  httpStatus: number | null
  durationMs: number
  /** PT-BR, para o admin. NUNCA contém segredo, token nem corpo cru da Cielo. */
  message: string
}

export interface ResultadoTesteConexaoGateway {
  environment: 'sandbox' | 'production'
  testedAt: string
  /** `true` só se ao menos um passo deu `OK` e NENHUM falhou (`NOT_CONFIGURED`/`SKIPPED` não são falha, mas sozinhos não bastam). */
  ok: boolean
  steps: ResultadoPassoTesteConexao[]
}

const STATUS_QUE_NAO_SAO_FALHA: ReadonlySet<StatusPassoTesteConexao> = new Set(['OK', 'NOT_CONFIGURED', 'SKIPPED'])

function hostDe(url: string): string | null {
  try {
    return new URL(url).host
  } catch {
    return null
  }
}

async function medir<T>(fn: () => Promise<T>): Promise<{ resultado: T; durationMs: number }> {
  const inicio = performance.now()
  const resultado = await fn()
  return { resultado, durationMs: Math.round(performance.now() - inicio) }
}

type ParcialPasso = Omit<ResultadoPassoTesteConexao, 'step' | 'durationMs'>

function semChamada(step: PassoTesteConexao, status: StatusPassoTesteConexao, message: string, host: string | null = null): ResultadoPassoTesteConexao {
  return { step, status, host, httpStatus: null, durationMs: 0, message }
}

// --------------------------------------------------------------------------------------------------------------------
// Passo 1 — credencial do estabelecimento (MerchantId/MerchantKey) na API de vendas
// --------------------------------------------------------------------------------------------------------------------

async function testarCredencialDoEstabelecimento(config: ConfigEfetiva): Promise<ResultadoPassoTesteConexao> {
  const { linha, estado } = config
  const step: PassoTesteConexao = 'MERCHANT_CREDENTIALS'
  if (!estado.merchantId || !estado.temMerchantKey) {
    return semChamada(step, 'NOT_CONFIGURED', 'MerchantId e/ou MerchantKey não configurados: cadastre a credencial da Cielo na tela do gateway.')
  }

  const urls = resolverUrlsCielo(estado.environment, { api: process.env.CIELO_API_BASE_URL, query: process.env.CIELO_API_QUERY_BASE_URL })
  const incoerencia = verificarCoerenciaUrls(estado.environment, urls)
  if (incoerencia) return semChamada(step, 'MISCONFIGURED', `Configuração incoerente: ${incoerencia}. Corrija o ambiente ou as URLs do servidor.`, hostDe(urls.query))

  let merchantKey: string | undefined
  try {
    merchantKey = estado.origem.merchant === 'database' ? decryptPaymentSecret(linha!.merchantKeyCiphertext!) : env.CIELO_MERCHANT_KEY
  } catch {
    return semChamada(step, 'MISCONFIGURED', 'Não foi possível decifrar a MerchantKey salva (PAYMENT_SECRETS_KEY trocada/ausente ou dado corrompido). Reenvie a credencial pela tela do gateway.', hostDe(urls.query))
  }
  if (!merchantKey) return semChamada(step, 'NOT_CONFIGURED', 'MerchantKey não disponível para o teste.', hostDe(urls.query))

  const host = hostDe(urls.query)
  const client = new CieloHttpClient({ merchantId: estado.merchantId, merchantKey, apiBaseUrl: urls.api, apiQueryBaseUrl: urls.query, timeoutMs: env.CIELO_TIMEOUT_MS })
  const { resultado, durationMs } = await medir(async (): Promise<ParcialPasso> => {
    try {
      await client.getByMerchantOrderId(`innoflow-teste-conexao-${randomUUID()}`)
      return { status: 'OK', host, httpStatus: 200, message: 'Credencial aceita pela Cielo (consulta de venda respondeu).' }
    } catch (err) {
      if (err instanceof CieloHttpError) return parcialDeFalhaHttp(err, host)
      logger.warn({ passo: step }, '[pagamentos][teste-conexao] sem resposta da Cielo (timeout ou rede)')
      return { status: 'UNAVAILABLE', host, httpStatus: null, message: 'Não foi possível falar com a Cielo (timeout ou rede). Tente de novo; se persistir, confira a conectividade de saída do servidor.' }
    }
  })
  return { step, durationMs, ...resultado }
}

function parcialDeFalhaHttp(err: CieloHttpError, host: string | null): ParcialPasso {
  const base = { host, httpStatus: err.httpStatus, message: mensagemDeFalhaCielo({ tipo: err.tipo, codigos: err.codigos }, err.httpStatus) }
  switch (err.tipo) {
    case 'NAO_ENCONTRADO':
      // A Cielo aceitou a credencial e só não achou a venda inexistente que procuramos de propósito.
      return { ...base, status: 'OK', message: 'Credencial aceita pela Cielo (a venda de teste, inexistente de propósito, não foi encontrada).' }
    case 'CREDENCIAL':
      return { ...base, status: 'CREDENTIAL_REJECTED' }
    case 'IP_NAO_PERMITIDO':
      return { ...base, status: 'IP_NOT_ALLOWED' }
    case 'LIMITE_DE_CHAMADAS':
      return { ...base, status: 'RATE_LIMITED' }
    case 'INDISPONIVEL':
      return { ...base, status: 'UNAVAILABLE' }
    case 'REQUISICAO_RECUSADA':
      return { ...base, status: 'REQUEST_REFUSED' }
  }
}

// --------------------------------------------------------------------------------------------------------------------
// Passos 2 e 3 — Silent Order Post
// --------------------------------------------------------------------------------------------------------------------

function parcialDeFalhaSop(err: unknown, host: string | null): ParcialPasso {
  if (err instanceof CieloSopOAuthError) {
    const status: StatusPassoTesteConexao =
      err.kind === 'credencial_invalida' ? 'CREDENTIAL_REJECTED' : err.httpStatus !== undefined && err.httpStatus >= 400 && err.httpStatus < 500 ? 'REQUEST_REFUSED' : 'UNAVAILABLE'
    return { status, host, httpStatus: err.httpStatus ?? null, message: err.message } // a mensagem do erro só tem status HTTP e o `error` OAuth — nunca segredo
  }
  return { status: 'UNAVAILABLE', host, httpStatus: null, message: 'Falha inesperada ao falar com a Braspag.' }
}

async function testarSop(config: ConfigEfetiva): Promise<ResultadoPassoTesteConexao[]> {
  const { linha, estado } = config
  const urlsSop = resolverUrlsSop(estado.environment, { oauthToken: env.CIELO_SOP_OAUTH_TOKEN_URL, accessToken: env.CIELO_SOP_ACCESS_TOKEN_URL, script: env.CIELO_SOP_SCRIPT_URL })
  const hostOauth = hostDe(urlsSop.oauthToken)
  const hostAccess = hostDe(urlsSop.accessToken)

  if (!estado.sopClientId || !estado.temSopClientSecret) {
    const msg = 'ClientId/ClientSecret do Silent Order Post (Braspag) não configurados: o cadastro de cartão não funciona sem eles.'
    return [semChamada('SOP_OAUTH', 'NOT_CONFIGURED', msg, hostOauth), semChamada('SOP_ACCESS_TOKEN', 'NOT_CONFIGURED', msg, hostAccess)]
  }

  let clientSecret: string | undefined
  try {
    clientSecret = estado.origem.sop === 'database' ? decryptPaymentSecret(linha!.sopClientSecretCiphertext!) : env.CIELO_SOP_CLIENT_SECRET
  } catch {
    const msg = 'Não foi possível decifrar o ClientSecret do SOP salvo (PAYMENT_SECRETS_KEY trocada/ausente ou dado corrompido). Reenvie pela tela do gateway.'
    return [semChamada('SOP_OAUTH', 'MISCONFIGURED', msg, hostOauth), semChamada('SOP_ACCESS_TOKEN', 'SKIPPED', 'Depende do passo anterior.', hostAccess)]
  }
  if (!clientSecret) return [semChamada('SOP_OAUTH', 'NOT_CONFIGURED', 'ClientSecret do SOP não disponível.', hostOauth), semChamada('SOP_ACCESS_TOKEN', 'SKIPPED', 'Depende do passo anterior.', hostAccess)]

  const sopConfig: CieloSopConfig = {
    clientId: estado.sopClientId,
    clientSecret,
    merchantId: estado.merchantId ?? '',
    oauthTokenUrl: urlsSop.oauthToken,
    accessTokenUrl: urlsSop.accessToken,
    timeoutMs: env.CIELO_TIMEOUT_MS,
  }

  const oauth = await medir(async (): Promise<{ parcial: ParcialPasso; token: string | null }> => {
    try {
      const token = await obterTokenOAuthSop(sopConfig)
      return { parcial: { status: 'OK', host: hostOauth, httpStatus: 200, message: 'ClientId/ClientSecret aceitos pela Braspag.' }, token }
    } catch (err) {
      return { parcial: parcialDeFalhaSop(err, hostOauth), token: null }
    }
  })
  const passoOauth: ResultadoPassoTesteConexao = { step: 'SOP_OAUTH', durationMs: oauth.durationMs, ...oauth.resultado.parcial }

  if (oauth.resultado.token === null) return [passoOauth, semChamada('SOP_ACCESS_TOKEN', 'SKIPPED', 'O passo de autenticação falhou; este depende dele.', hostAccess)]
  if (!estado.merchantId) return [passoOauth, semChamada('SOP_ACCESS_TOKEN', 'NOT_CONFIGURED', 'MerchantId não configurado: o AccessToken do SOP é emitido para um MerchantId.', hostAccess)]

  const acesso = await medir(async (): Promise<ParcialPasso> => {
    try {
      await emitirAccessTokenDoNavegadorSop(sopConfig, oauth.resultado.token!) // o AccessToken emitido é descartado na hora
      return { status: 'OK', host: hostAccess, httpStatus: 200, message: 'AccessToken do Silent Order Post emitido (o cadastro de cartão deve funcionar).' }
    } catch (err) {
      return parcialDeFalhaSop(err, hostAccess)
    }
  })
  return [passoOauth, { step: 'SOP_ACCESS_TOKEN', durationMs: acesso.durationMs, ...acesso.resultado }]
}

// --------------------------------------------------------------------------------------------------------------------

export async function testarConexaoGateway(): Promise<ResultadoTesteConexaoGateway> {
  const config = await getConfigEfetiva() // ConfiguracaoGatewayIndisponivelError => a rota devolve 503 (como o GET)
  const [merchant, sop] = await Promise.all([testarCredencialDoEstabelecimento(config), testarSop(config)])
  const steps = [merchant, ...sop]
  const ok = steps.some((s) => s.status === 'OK') && steps.every((s) => STATUS_QUE_NAO_SAO_FALHA.has(s.status))
  return { environment: config.estado.environment, testedAt: new Date().toISOString(), ok, steps }
}
