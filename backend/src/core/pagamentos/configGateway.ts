/**
 * Núcleo PURO da configuração do gateway de pagamento (F5.5) — sem Prisma, sem env, sem logger,
 * sem rede: testável em todas as combinações. A camada de serviço (`services/pagamentos/
 * gatewayConfig.ts`) só lê banco/ambiente e chama estas funções.
 *
 * Regras (decisões do dono/Atlas, 02/10/2026):
 *  - BANCO MANDA; sem linha no banco vale o ambiente do servidor (`source: 'env'`).
 *  - Credenciais vêm em GRUPOS que nunca se misturam: se a linha do banco tem `merchantId` OU
 *    `merchantKeyCiphertext`, o par inteiro vem do banco (um merchantId novo com a chave velha do
 *    env é uma conta que não existe — falha silenciosa na Cielo). Mesmo raciocínio para o par SOP
 *    (`sopClientId`/`sopClientSecret`). O segredo do header do webhook é independente.
 *  - Ambiente decide sandbox x produção, INCLUSIVE as URLs: o erro que não pode acontecer é "o banco
 *    diz production e as URLs seguem sandbox em silêncio" (ou o inverso, que cobraria de verdade
 *    achando que é teste).
 */

export type AmbienteGateway = 'sandbox' | 'production'
export type MeioPagamento = 'CARD' | 'PIX'

/** Mesmos códigos de `PaymentGatewayRequirement` em `frontend/src/types/api.ts` (contrato literal). */
export type RequisitoGateway =
  | 'MERCHANT_ID'
  | 'MERCHANT_KEY'
  | 'SOP_CLIENT_ID'
  | 'SOP_CLIENT_SECRET'
  | 'SOP_SCRIPT_URL'
  | 'SOP_OAUTH_TOKEN_URL'
  | 'WEBHOOK_PATH_TOKEN'
  | 'WEBHOOK_HEADER_SECRET'
  | 'PAYMENT_SECRETS_KEY'

const ORDEM_REQUISITOS: readonly RequisitoGateway[] = [
  'MERCHANT_ID',
  'MERCHANT_KEY',
  'SOP_CLIENT_ID',
  'SOP_CLIENT_SECRET',
  'SOP_SCRIPT_URL',
  'SOP_OAUTH_TOKEN_URL',
  'WEBHOOK_PATH_TOKEN',
  'WEBHOOK_HEADER_SECRET',
  'PAYMENT_SECRETS_KEY',
]

/** Linha singleton do banco, SEM decifrar nada (os `*Ciphertext` só são decifrados na hora de usar). */
export interface LinhaConfigGateway {
  environment: AmbienteGateway
  merchantId: string | null
  merchantKeyCiphertext: string | null
  sopClientId: string | null
  sopClientSecretCiphertext: string | null
  webhookHeaderSecretCiphertext: string | null
  cardEnabled: boolean
  pixEnabled: boolean
  updatedAt: Date
}

/** O que o ambiente do servidor oferece — nenhum valor secreto, só "existe ou não". */
export interface EnvGateway {
  /** `CIELO_SANDBOX`. */
  sandbox: boolean
  merchantId: string | null
  temMerchantKey: boolean
  sopClientId: string | null
  temSopClientSecret: boolean
  temWebhookHeaderSecret: boolean
  sopScriptUrl: string | null
  sopOauthTokenUrl: string | null
  webhookPathToken: string | null
  /** `PAYMENT_SECRETS_KEY` presente E decodificável para 32 bytes. */
  paymentSecretsKeyOk: boolean
}

export type OrigemCampo = 'database' | 'env' | 'none'

export interface EstadoEfetivo {
  source: 'database' | 'env'
  environment: AmbienteGateway
  merchantId: string | null
  temMerchantKey: boolean
  sopClientId: string | null
  temSopClientSecret: boolean
  temWebhookHeaderSecret: boolean
  /** Flags para EXIBIÇÃO: com linha, o que o admin salvou; sem linha, "há credenciais". */
  cardEnabled: boolean
  pixEnabled: boolean
  origem: { merchant: OrigemCampo; sop: OrigemCampo; webhookHeaderSecret: OrigemCampo }
  updatedAt: Date | null
}

export function resolverEstadoEfetivo(linha: LinhaConfigGateway | null, env: EnvGateway): EstadoEfetivo {
  const merchantDoBanco = Boolean(linha && (linha.merchantId || linha.merchantKeyCiphertext))
  const sopDoBanco = Boolean(linha && (linha.sopClientId || linha.sopClientSecretCiphertext))

  const merchantId = merchantDoBanco ? (linha!.merchantId ?? null) : env.merchantId
  const temMerchantKey = merchantDoBanco ? Boolean(linha!.merchantKeyCiphertext) : env.temMerchantKey
  const sopClientId = sopDoBanco ? (linha!.sopClientId ?? null) : env.sopClientId
  const temSopClientSecret = sopDoBanco ? Boolean(linha!.sopClientSecretCiphertext) : env.temSopClientSecret

  const origemWebhook: OrigemCampo = linha?.webhookHeaderSecretCiphertext ? 'database' : env.temWebhookHeaderSecret ? 'env' : 'none'

  const temCredenciais = Boolean(merchantId && temMerchantKey)

  return {
    source: linha ? 'database' : 'env',
    environment: linha ? linha.environment : env.sandbox ? 'sandbox' : 'production',
    merchantId,
    temMerchantKey,
    sopClientId,
    temSopClientSecret,
    temWebhookHeaderSecret: origemWebhook !== 'none',
    cardEnabled: linha ? linha.cardEnabled : temCredenciais,
    pixEnabled: linha ? linha.pixEnabled : temCredenciais,
    origem: {
      merchant: merchantDoBanco ? 'database' : env.merchantId || env.temMerchantKey ? 'env' : 'none',
      sop: sopDoBanco ? 'database' : env.sopClientId || env.temSopClientSecret ? 'env' : 'none',
      webhookHeaderSecret: origemWebhook,
    },
    updatedAt: linha ? linha.updatedAt : null,
  }
}

/** Há credencial Cielo utilizável (banco OU env)? Entrada de `decidirAdaptadorPagamento` — sem decifrar nada. */
export function temCredenciaisCielo(estado: EstadoEfetivo): boolean {
  return Boolean(estado.merchantId && estado.temMerchantKey)
}

/**
 * Guarda de COMEÇOS NOVOS (cartão novo, pré-auth, Pix novo). Sem linha no banco ninguém desligou nada —
 * vale o comportamento anterior à F5.5 (sem credencial, quem decide é o resolvedor do adaptador: Fake em
 * dev/CI, 503 em produção). Captura, cancelamento, webhook, varredores e crédito de Pix de intents que já
 * existem NUNCA consultam isto — dinheiro em trânsito precisa liquidar.
 */
export function meioHabilitadoParaNovosPagamentos(linha: LinhaConfigGateway | null, meio: MeioPagamento): boolean {
  if (!linha) return true
  return meio === 'CARD' ? linha.cardEnabled : linha.pixEnabled
}

export interface ReadinessMeio {
  ready: boolean
  missing: RequisitoGateway[]
}

/**
 * Pré-requisitos por meio, conferidos contra o código (F5.5):
 *  - PIX: credencial (`criarPix`/`consultarPix`), caminho do webhook (`/api/webhooks/cielo/:token`) e segredo do
 *    header (sem o segredo configurado o webhook fica inalcançável — o aleatório por processo não conta).
 *    `PAYMENT_SECRETS_KEY` só entra quando algum segredo que o Pix usa está CIFRADO no banco: Pix não cifra
 *    nada de cartão, mas sem a chave não dá para decifrar `merchantKey`/segredo do webhook que vieram do banco.
 *  - CARD: credencial + par SOP + script SOP + URL OAuth do SOP (`sessaoTokenizacao`) + `PAYMENT_SECRETS_KEY`
 *    SEMPRE (o `CardToken` do motorista é cifrado em repouso, F5.3).
 */
export function calcularReadiness(estado: EstadoEfetivo, env: EnvGateway): { card: ReadinessMeio; pix: ReadinessMeio } {
  const faltandoPix = new Set<RequisitoGateway>()
  const faltandoCard = new Set<RequisitoGateway>()

  if (!estado.merchantId) {
    faltandoPix.add('MERCHANT_ID')
    faltandoCard.add('MERCHANT_ID')
  }
  if (!estado.temMerchantKey) {
    faltandoPix.add('MERCHANT_KEY')
    faltandoCard.add('MERCHANT_KEY')
  }

  if (!env.webhookPathToken) faltandoPix.add('WEBHOOK_PATH_TOKEN')
  if (!estado.temWebhookHeaderSecret) faltandoPix.add('WEBHOOK_HEADER_SECRET')
  if ((estado.origem.merchant === 'database' || estado.origem.webhookHeaderSecret === 'database') && !env.paymentSecretsKeyOk) faltandoPix.add('PAYMENT_SECRETS_KEY')

  if (!estado.sopClientId) faltandoCard.add('SOP_CLIENT_ID')
  if (!estado.temSopClientSecret) faltandoCard.add('SOP_CLIENT_SECRET')
  if (!env.sopScriptUrl) faltandoCard.add('SOP_SCRIPT_URL')
  if (!env.sopOauthTokenUrl) faltandoCard.add('SOP_OAUTH_TOKEN_URL')
  if (!env.paymentSecretsKeyOk) faltandoCard.add('PAYMENT_SECRETS_KEY')

  const ordenar = (s: Set<RequisitoGateway>): RequisitoGateway[] => ORDEM_REQUISITOS.filter((r) => s.has(r))
  const card = ordenar(faltandoCard)
  const pix = ordenar(faltandoPix)
  return { card: { ready: card.length === 0, missing: card }, pix: { ready: pix.length === 0, missing: pix } }
}

export type ErroMudancaConfig =
  | { kind: 'PRODUCTION_CONFIRMATION_REQUIRED' }
  | { kind: 'GATEWAY_NOT_READY'; missing: RequisitoGateway[] }

/**
 * Decide se uma mudança de configuração pode ser GRAVADA. `antes`/`depois` são os estados EFETIVOS (já com
 * env como reserva). Regras:
 *  1. sandbox -> production exige `confirmProduction`;
 *  2. par de credencial do banco NUNCA fica pela metade (merchantId sem chave, ou o inverso) — gravar isso
 *     derrubaria Pix/cartão em produção (credencial presente porém inválida) e ainda impediria liquidar
 *     intents em trânsito;
 *  3. ao virar production, TODO meio habilitado no estado resultante precisa estar pronto;
 *  4. fora disso, um meio HABILITADO no estado resultante precisa estar pronto, exceto se já estava
 *     habilitado e já estava incompleto antes (não bloqueia editar um campo alheio de uma conta que já
 *     estava quebrada — o que se bloqueia é PIORAR ou LIGAR).
 */
export function avaliarMudancaDeConfig(input: {
  antes: EstadoEfetivo
  depois: EstadoEfetivo
  readinessAntes: { card: ReadinessMeio; pix: ReadinessMeio }
  readinessDepois: { card: ReadinessMeio; pix: ReadinessMeio }
  confirmProduction: boolean
}): ErroMudancaConfig | null {
  const { antes, depois, readinessAntes, readinessDepois, confirmProduction } = input

  const virouProducao = antes.environment === 'sandbox' && depois.environment === 'production'
  if (virouProducao && !confirmProduction) return { kind: 'PRODUCTION_CONFIRMATION_REQUIRED' }

  const faltando = new Set<RequisitoGateway>()

  if (depois.origem.merchant === 'database') {
    if (!depois.merchantId) faltando.add('MERCHANT_ID')
    if (!depois.temMerchantKey) faltando.add('MERCHANT_KEY')
  }

  const meios: Array<{ habilitadoDepois: boolean; habilitadoAntes: boolean; antes: ReadinessMeio; depois: ReadinessMeio }> = [
    { habilitadoDepois: depois.cardEnabled, habilitadoAntes: antes.cardEnabled, antes: readinessAntes.card, depois: readinessDepois.card },
    { habilitadoDepois: depois.pixEnabled, habilitadoAntes: antes.pixEnabled, antes: readinessAntes.pix, depois: readinessDepois.pix },
  ]
  for (const m of meios) {
    if (!m.habilitadoDepois || m.depois.ready) continue
    const jaEstavaQuebrado = m.habilitadoAntes && !m.antes.ready
    if (virouProducao || !jaEstavaQuebrado) m.depois.missing.forEach((r) => faltando.add(r))
  }

  if (faltando.size === 0) return null
  return { kind: 'GATEWAY_NOT_READY', missing: ORDEM_REQUISITOS.filter((r) => faltando.has(r)) }
}

// ----------------------------------------------------------------------------------------------
// Ambiente -> URLs
// ----------------------------------------------------------------------------------------------

/**
 * Hosts oficiais da API 3.0 da Cielo. SANDBOX confirmado na doc usada pelo projeto desde a F5.1;
 * PRODUÇÃO ("api"/"apiquery" sem o sufixo "sandbox") segue o padrão público da Cielo mas está
 * ⚠️ A CONFIRMAR na doc oficial/suporte antes do go-live — não há como validar sem credencial real.
 */
export const URLS_CIELO: Record<AmbienteGateway, { api: string; query: string }> = {
  sandbox: { api: 'https://apisandbox.cieloecommerce.cielo.com.br', query: 'https://apiquerysandbox.cieloecommerce.cielo.com.br' },
  production: { api: 'https://api.cieloecommerce.cielo.com.br', query: 'https://apiquery.cieloecommerce.cielo.com.br' },
}

export interface UrlsCielo {
  api: string
  query: string
  /** `explicita` = veio de `CIELO_API_BASE_URL`/`CIELO_API_QUERY_BASE_URL` no ambiente do servidor; `ambiente` = derivada do `environment`. */
  origem: { api: 'explicita' | 'ambiente'; query: 'explicita' | 'ambiente' }
}

/** URL explícita do servidor ganha; senão deriva do ambiente. `explicitas` é o `process.env` CRU (o `env.ts` tem default sandbox e esconderia "não definida"). */
export function resolverUrlsCielo(ambiente: AmbienteGateway, explicitas: { api?: string | undefined; query?: string | undefined }): UrlsCielo {
  const api = explicitas.api?.trim()
  const query = explicitas.query?.trim()
  return {
    api: api ? api : URLS_CIELO[ambiente].api,
    query: query ? query : URLS_CIELO[ambiente].query,
    origem: { api: api ? 'explicita' : 'ambiente', query: query ? 'explicita' : 'ambiente' },
  }
}

function hostDe(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return null
  }
}

/**
 * Detecta URL incompatível com o ambiente — devolve a descrição do problema (sem URL completa, só host) ou
 * `null` se coerente. Só acusa o que é inequívoco: produção apontando para host com "sandbox", ou sandbox
 * apontando para um host OFICIAL de produção da Cielo (cobraria de verdade achando que é teste). Host
 * customizado (mock local, proxy) em sandbox passa.
 */
export function verificarCoerenciaUrls(ambiente: AmbienteGateway, urls: Pick<UrlsCielo, 'api' | 'query'>): string | null {
  const hostsProducaoOficiais = new Set([hostDe(URLS_CIELO.production.api), hostDe(URLS_CIELO.production.query)])
  for (const [nome, url] of [['CIELO_API_BASE_URL', urls.api], ['CIELO_API_QUERY_BASE_URL', urls.query]] as const) {
    const host = hostDe(url)
    if (!host) return `${nome} não é uma URL válida`
    if (ambiente === 'production' && host.includes('sandbox')) return `ambiente "production" mas ${nome} aponta para o host de sandbox (${host})`
    if (ambiente === 'sandbox' && hostsProducaoOficiais.has(host)) return `ambiente "sandbox" mas ${nome} aponta para o host de PRODUÇÃO da Cielo (${host})`
  }
  return null
}

/** `{base}/api/webhooks/cielo/{token}`; `null` sem token (a rota usa um aleatório por processo — inalcançável de fora). */
export function montarWebhookUrl(baseUrl: string | null | undefined, pathToken: string | null | undefined): string | null {
  if (!pathToken || !baseUrl) return null
  return `${baseUrl.replace(/\/+$/, '')}/api/webhooks/cielo/${pathToken}`
}
