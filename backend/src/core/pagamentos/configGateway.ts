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
 *  - PIX: credencial (`criarPix`/`consultarPix`). O webhook é OPCIONAL (conta compartilhada: crédito por polling).
 *    `PAYMENT_SECRETS_KEY` só entra quando algum segredo que o Pix usa está CIFRADO no banco: Pix não cifra
 *    nada de cartão, mas sem a chave não dá para decifrar `merchantKey`/segredo do webhook que vieram do banco.
 *  - CARD: credencial + par SOP (`sessaoTokenizacao`; as URLs do SOP vêm por ambiente, ver `URLS_SOP`) + `PAYMENT_SECRETS_KEY`
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

  // Conta Cielo COMPARTILHADA com o Parque (decisão do dono, 04/10/2026): a URL de notificação do Site Cielo é UMA por estabelecimento e é do Parque, então o InnoFlow NÃO usa webhook — o
  // Pix é creditado por POLLING (`services/pagamentos/pollTopupsPix.ts`). O webhook (token do caminho + segredo do header) deixou de ser pré-requisito do Pix; se estiver configurado, continua
  // funcionando como DICA que adianta a reconsulta. Os códigos WEBHOOK_PATH_TOKEN / WEBHOOK_HEADER_SECRET seguem na união do contrato do frontend, mas esta função não os emite mais.
  if ((estado.origem.merchant === 'database' || estado.origem.webhookHeaderSecret === 'database') && !env.paymentSecretsKeyOk) faltandoPix.add('PAYMENT_SECRETS_KEY')

  if (!estado.sopClientId) faltandoCard.add('SOP_CLIENT_ID')
  if (!estado.temSopClientSecret) faltandoCard.add('SOP_CLIENT_SECRET')
  // C1.1: as URLs do script e do OAuth do SOP têm DEFAULT por ambiente (`URLS_SOP`); as envs são só override opcional, então não são mais pré-requisito.
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
// Sandbox restrito a testadores (F5.7, ALTO-2)
// ----------------------------------------------------------------------------------------------

/**
 * `true` = ambiente efetivo SANDBOX num servidor de PRODUÇÃO (`NODE_ENV=production`). Os cartões de teste da Cielo são públicos e o cadastro
 * do app é aberto — sandbox numa instância pública seria cobrança grátis para qualquer um —, então Pix e cartão só funcionam para os
 * testadores (`PAYMENT_SANDBOX_TESTER_EMAILS`). Em desenvolvimento/CI (`NODE_ENV` ≠ production) nada é restrito. Ambiente PRODUCTION (dinheiro real)
 * nunca é restrito por isto.
 */
export function sandboxRestrito(ambiente: AmbienteGateway, nodeEnv: string): boolean {
  return ambiente === 'sandbox' && nodeEnv === 'production'
}

/** Lista de testadores: separada por vírgula, aparada, minúscula; vazia/ausente => conjunto VAZIO (ninguém passa — falha segura). */
export function parseListaDeTestadores(bruto: string | null | undefined): ReadonlySet<string> {
  if (!bruto) return new Set()
  return new Set(
    bruto
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.length > 0),
  )
}

/** E-mail do motorista está na lista? Comparação exata (sem curinga, sem domínio inteiro) e sem distinguir maiúsculas/espaços nas bordas. */
export function emailEhTestador(email: string | null | undefined, testadores: ReadonlySet<string>): boolean {
  if (!email) return false
  return testadores.has(email.trim().toLowerCase())
}

/** O que a guarda de testador precisa saber do usuário (nada além disto — sem hash, sem token). */
export interface IdentidadeParaTestador {
  email: string | null | undefined
  /** `User.googleSub`: preenchido só por login/vínculo com o Google, que entrega `email_verified`. */
  googleSub: string | null | undefined
  role: string
}

/**
 * Testador = e-mail na lista E identidade VERIFICADA (F5.8, ALTO-2). Estar na lista é decidido por um TEXTO; só vale quando alguém PROVOU ser dono dele:
 *  - `googleSub != null`: o Google entregou o e-mail verificado (ver `autenticarComGoogle`);
 *  - role diferente de DRIVER: staff é criado pelo admin/seed, nunca se auto-registra.
 * Um DRIVER cadastrado só com e-mail/senha (`POST /api/auth/register` NÃO confirma o endereço) nunca é testador, mesmo com o e-mail na lista —
 * senão qualquer um que soubesse o e-mail de um testador (ou o registrasse antes dele) usaria o sandbox de graça. Lista vazia = ninguém.
 */
export function identidadeEhTestador(usuario: IdentidadeParaTestador | null | undefined, testadores: ReadonlySet<string>): boolean {
  if (!usuario) return false
  if (!emailEhTestador(usuario.email, testadores)) return false
  return identidadeVerificada(usuario)
}

/**
 * REGRA ÚNICA de "identidade verificada" (F5.8 ALTO-2 e I-7 da auditoria): `googleSub != null` (o Google entregou o e-mail verificado) OU role diferente de DRIVER (staff é criado pelo
 * admin/seed, nunca se auto-registra). `POST /api/auth/register` NÃO confirma o e-mail, então um DRIVER só com senha NÃO é verificado. Usada por `identidadeEhTestador` (sandbox) e por
 * `cartaoLiberadoParaUsuario` (pagar com cartão) — uma definição só, para as duas não divergirem.
 */
export function identidadeVerificada(usuario: Pick<IdentidadeParaTestador, 'googleSub' | 'role'> | null | undefined): boolean {
  if (!usuario) return false
  return usuario.role !== 'DRIVER' || Boolean(usuario.googleSub)
}

/**
 * I-7 (decisão do dono, 04/10/2026): pagar com CARTÃO exige identidade verificada — entre com Google. O cadastro por e-mail/senha não confirma o e-mail, e o cartão roubado testado em
 * contas descartáveis é o risco que a Cielo cobra (recusas, chargeback). Pix e carteira não são afetados.
 */
export function cartaoLiberadoParaUsuario(usuario: Pick<IdentidadeParaTestador, 'googleSub' | 'role'> | null | undefined): boolean {
  return identidadeVerificada(usuario)
}

/** `AmbienteGateway` (minúsculo, coluna String de `PaymentGatewayConfig`) -> enum `PaymentEnvironment` do Prisma (maiúsculo, `PaymentIntent`/`PaymentMethod`). */
export function paraPaymentEnvironment(ambiente: AmbienteGateway): 'SANDBOX' | 'PRODUCTION' {
  return ambiente === 'production' ? 'PRODUCTION' : 'SANDBOX'
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

/**
 * Silent Order Post (C1.1): URLs por ambiente — as MESMAS que rodam em produção no Parque das Feiras (F7/F8/F9 de
 * `docs/GATEWAY-CIELO-PARQUE-VS-INNOFLOW.md`). `oauthToken` é o passo 1 (Braspag), `accessToken` o passo 2 (emite o AccessToken do navegador) e
 * `script` o que a página isolada carrega. ATENÇÃO: o host do script de produção (`transaction.cieloecommerce.cielo.com.br`) é DIFERENTE do
 * host da emissão do AccessToken (`transaction.pagador.com.br`) — não unificar. A doc oficial cita uma URL única de script
 * (`www.pagador.com.br/...`); a do Parque é a que está provada em produção (P5 do documento: confirmar com a Cielo qual é a canônica).
 */
export const URLS_SOP: Record<AmbienteGateway, { oauthToken: string; accessToken: string; script: string }> = {
  sandbox: {
    oauthToken: 'https://authsandbox.braspag.com.br/oauth2/token',
    accessToken: 'https://transactionsandbox.pagador.com.br/post/api/public/v2/accesstoken',
    script: 'https://transactionsandbox.pagador.com.br/post/scripts/silentorderpost-1.0.min.js',
  },
  production: {
    oauthToken: 'https://auth.braspag.com.br/oauth2/token',
    accessToken: 'https://transaction.pagador.com.br/post/api/public/v2/accesstoken',
    script: 'https://transaction.cieloecommerce.cielo.com.br/post/scripts/silentorderpost-1.0.min.js',
  },
}

export interface UrlsSop {
  oauthToken: string
  accessToken: string
  script: string
}

/** Default do ambiente; `CIELO_SOP_OAUTH_TOKEN_URL` / `CIELO_SOP_ACCESS_TOKEN_URL` / `CIELO_SOP_SCRIPT_URL` (env do servidor) continuam como override opcional (servidor falso em teste, URL canônica nova). */
export function resolverUrlsSop(
  ambiente: AmbienteGateway,
  override: { oauthToken?: string | null | undefined; accessToken?: string | null | undefined; script?: string | null | undefined } = {},
): UrlsSop {
  const oauthToken = override.oauthToken?.trim()
  const accessToken = override.accessToken?.trim()
  const script = override.script?.trim()
  return {
    oauthToken: oauthToken ? oauthToken : URLS_SOP[ambiente].oauthToken,
    accessToken: accessToken ? accessToken : URLS_SOP[ambiente].accessToken,
    script: script ? script : URLS_SOP[ambiente].script,
  }
}

/** `{base}/api/webhooks/cielo/{token}`; `null` sem token (a rota usa um aleatório por processo — inalcançável de fora). */
export function montarWebhookUrl(baseUrl: string | null | undefined, pathToken: string | null | undefined): string | null {
  if (!pathToken || !baseUrl) return null
  return `${baseUrl.replace(/\/+$/, '')}/api/webhooks/cielo/${pathToken}`
}
