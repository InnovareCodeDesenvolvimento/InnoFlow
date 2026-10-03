import { prisma } from '../../lib/prisma'
import { env } from '../../lib/env'
import { logger } from '../../lib/logger'
import { decryptPaymentSecret, isPaymentSecretsKeyConfigured } from '../../lib/crypto/paymentSecrets'
import { AppError } from '../../api/middleware/errorHandler'
import { ConfiguracaoGatewayIndisponivelError } from '../../core/pagamentos/erros'
import {
  calcularReadiness,
  identidadeEhTestador,
  meioHabilitadoParaNovosPagamentos,
  paraPaymentEnvironment,
  parseListaDeTestadores,
  resolverEstadoEfetivo,
  sandboxRestrito,
  type AmbienteGateway,
  type EnvGateway,
  type EstadoEfetivo,
  type LinhaConfigGateway,
  type MeioPagamento,
} from '../../core/pagamentos/configGateway'

/**
 * Configuração EFETIVA do gateway de pagamento (F5.5): banco manda, env é reserva (regras em
 * `core/pagamentos/configGateway.ts`). Este módulo só LÊ (Prisma + `env`) e CACHEIA a linha — os
 * segredos continuam cifrados aqui; quem precisa do valor decifra no ponto de uso.
 *
 * CONSISTÊNCIA: a linha é cacheada em memória por processo com TTL curto (`CACHE_TTL_MS`). O processo que
 * GRAVA (a API, via `PUT /api/admin/payment-gateway`) invalida o próprio cache na hora; o `worker` é OUTRO
 * processo e só enxerga a mudança na próxima leitura após o TTL — consistência eventual de, no máximo,
 * `CACHE_TTL_MS` (10 s). Isso é aceitável porque (a) as flags (`cardEnabled`/`pixEnabled`) só são consultadas
 * na API, em COMEÇOS novos, e (b) trocar de credencial/ambiente é um ato raro do admin; o worker usa a
 * credencial antiga por até 10 s e depois a nova. Optou-se por TTL em vez de Redis pub/sub para não criar uma
 * dependência de tempo real num caminho que precisa continuar funcionando com o Redis degradado.
 *
 * Falha ao LER o banco => `ConfiguracaoGatewayIndisponivelError` (fail-closed, nada de cair no Fake).
 * Falhas NÃO são cacheadas — a próxima chamada tenta de novo.
 */

export const CACHE_TTL_MS = 10_000

interface EntradaCache {
  linha: LinhaConfigGateway | null
  carregadoEm: number
}

let cache: EntradaCache | null = null
let carregando: Promise<LinhaConfigGateway | null> | null = null
/** Incrementa a cada invalidação; uma leitura iniciada ANTES de uma gravação não pode repovoar o cache com dado velho. */
let geracao = 0

async function lerLinhaDoBanco(): Promise<LinhaConfigGateway | null> {
  const row = await prisma.paymentGatewayConfig.findUnique({ where: { id: 1 } })
  if (!row) return null
  if (row.environment !== 'sandbox' && row.environment !== 'production') {
    throw new ConfiguracaoGatewayIndisponivelError(`PaymentGatewayConfig.environment inválido ("${row.environment}")`)
  }
  return {
    environment: row.environment,
    merchantId: row.merchantId,
    merchantKeyCiphertext: row.merchantKeyCiphertext,
    sopClientId: row.sopClientId,
    sopClientSecretCiphertext: row.sopClientSecretCiphertext,
    webhookHeaderSecretCiphertext: row.webhookHeaderSecretCiphertext,
    cardEnabled: row.cardEnabled,
    pixEnabled: row.pixEnabled,
    updatedAt: row.updatedAt,
  }
}

async function carregarLinha(): Promise<LinhaConfigGateway | null> {
  if (cache && Date.now() - cache.carregadoEm < CACHE_TTL_MS) return cache.linha
  if (carregando) return carregando

  const geracaoNoInicio = geracao
  const promessa = lerLinhaDoBanco()
    .then((linha) => {
      if (geracao === geracaoNoInicio) cache = { linha, carregadoEm: Date.now() }
      return linha
    })
    .catch((err: unknown) => {
      if (err instanceof ConfiguracaoGatewayIndisponivelError) throw err
      logger.error({ err: err instanceof Error ? err.message : String(err), alert: 'payment_gateway_config_load_failed' }, '[pagamentos] falha ao ler PaymentGatewayConfig — gateway indisponível (fail-closed, sem fallback para o simulador)')
      throw new ConfiguracaoGatewayIndisponivelError('falha ao ler a configuração no banco', { cause: err })
    })
    .finally(() => {
      if (carregando === promessa) carregando = null
    })
  carregando = promessa
  return promessa
}

/** Invalida o cache DESTE processo (chamado logo depois de gravar). Outros processos expiram pelo TTL. */
export function invalidarCacheConfigGateway(): void {
  geracao += 1
  cache = null
  carregando = null
}

/** Só para teste. */
export function resetGatewayConfigCacheParaTeste(): void {
  invalidarCacheConfigGateway()
}

/** Snapshot do que o AMBIENTE DO SERVIDOR oferece (sem valores secretos). Lê `env` a cada chamada — barato e mockável. */
export function lerEnvGateway(): EnvGateway {
  return {
    sandbox: env.CIELO_SANDBOX,
    merchantId: env.CIELO_MERCHANT_ID ?? null,
    temMerchantKey: Boolean(env.CIELO_MERCHANT_KEY),
    sopClientId: env.CIELO_SOP_CLIENT_ID ?? null,
    temSopClientSecret: Boolean(env.CIELO_SOP_CLIENT_SECRET),
    temWebhookHeaderSecret: Boolean(env.CIELO_WEBHOOK_HEADER_SECRET),
    sopScriptUrl: env.CIELO_SOP_SCRIPT_URL ?? null,
    sopOauthTokenUrl: env.CIELO_SOP_OAUTH_TOKEN_URL ?? null,
    webhookPathToken: env.CIELO_WEBHOOK_PATH_TOKEN ?? null,
    paymentSecretsKeyOk: isPaymentSecretsKeyConfigured(),
  }
}

export interface ConfigEfetiva {
  /** Linha crua do banco (segredos AINDA cifrados) ou `null` se nada foi salvo. */
  linha: LinhaConfigGateway | null
  estado: EstadoEfetivo
  envGateway: EnvGateway
}

export async function getConfigEfetiva(): Promise<ConfigEfetiva> {
  const linha = await carregarLinha()
  const envGateway = lerEnvGateway()
  return { linha, estado: resolverEstadoEfetivo(linha, envGateway), envGateway }
}

export function readinessDe(config: Pick<ConfigEfetiva, 'estado' | 'envGateway'>) {
  return calcularReadiness(config.estado, config.envGateway)
}

/** Ambiente EFETIVO agora (`sandbox`/`production`) — banco manda, env é reserva. Config ilegível => `ConfiguracaoGatewayIndisponivelError`. */
export async function getAmbienteEfetivo(): Promise<AmbienteGateway> {
  return (await getConfigEfetiva()).estado.environment
}

/**
 * Ambiente efetivo no formato do enum `PaymentEnvironment` do Prisma (`SANDBOX`/`PRODUCTION`, maiúsculo) — é o que TODO `PaymentIntent`/`PaymentMethod`
 * NOVO grava em `environment` (F5.7, M4). A coluna tem DEFAULT SANDBOX: quem esquecer de passar isto nasce SANDBOX mesmo em produção.
 * (`PaymentGatewayConfig.environment` é String minúscula — o mapeamento é feito aqui, na borda.)
 */
export async function getAmbienteEfetivoParaBanco(): Promise<'SANDBOX' | 'PRODUCTION'> {
  return paraPaymentEnvironment(await getAmbienteEfetivo())
}

/** Como `getAmbienteEfetivoParaBanco`, mas config ilegível vira 503 `PAYMENT_GATEWAY_UNAVAILABLE` (fail-closed) — para as ROTAS que gravam a marca de ambiente. */
export async function getAmbienteEfetivoParaBancoOu503(): Promise<'SANDBOX' | 'PRODUCTION'> {
  try {
    return await getAmbienteEfetivoParaBanco()
  } catch (err) {
    if (err instanceof ConfiguracaoGatewayIndisponivelError) throw new AppError('O pagamento está indisponível no momento. Tente novamente em instantes.', 503, 'PAYMENT_GATEWAY_UNAVAILABLE')
    throw err
  }
}

/** `sandboxRestricted` do DTO: ambiente efetivo SANDBOX num servidor com `NODE_ENV=production`. */
export function isSandboxRestrito(estado: Pick<EstadoEfetivo, 'environment'>): boolean {
  return sandboxRestrito(estado.environment, env.NODE_ENV)
}

let avisouSegredosIlegiveis = false

/**
 * `secretsDecryptable` do DTO (F5.7, M3): tenta DECIFRAR os segredos SALVOS NO BANCO agora. `null` = não há segredo salvo no banco
 * (sem linha / `source: 'env'` / só campos não secretos); `false` = ao menos um não decifra (`PAYMENT_SECRETS_KEY` trocada/perdida ou dado
 * corrompido) — o gateway está em 503 mesmo com os chips "Configurada"; `true` = todos decifram. NUNCA lança (o GET da config não pode
 * falhar por causa disto — é justamente pela tela que o admin lê o estado e REENVIA os segredos) e nunca devolve nem loga o texto decifrado.
 * Loga UMA vez por processo (`payment_gateway_secrets_undecryptable`). Barato: no máximo 3 decifragens AES-GCM.
 */
export function verificarSegredosDecifraveis(linha: LinhaConfigGateway | null): boolean | null {
  if (!linha) return null
  const salvos = [linha.merchantKeyCiphertext, linha.sopClientSecretCiphertext, linha.webhookHeaderSecretCiphertext].filter((c): c is string => Boolean(c))
  if (salvos.length === 0) return null
  try {
    for (const ciphertext of salvos) decryptPaymentSecret(ciphertext)
    return true
  } catch (err) {
    if (!avisouSegredosIlegiveis) {
      avisouSegredosIlegiveis = true
      logger.error(
        { alert: 'payment_gateway_secrets_undecryptable', reason: err instanceof Error ? err.name : 'erro' },
        '[pagamentos] os segredos do gateway salvos no banco NÃO decifram (PAYMENT_SECRETS_KEY trocada/perdida ou dado corrompido) — gateway indisponível até reenviar os 3 segredos pela tela do admin',
      )
    }
    return false
  }
}

/** Só para teste — o aviso de "segredos ilegíveis" é UMA vez por processo. */
export function resetAvisoSegredosIlegiveisParaTeste(): void {
  avisouSegredosIlegiveis = false
}

/**
 * Guarda de COMEÇOS NOVOS: `409 PAYMENT_METHOD_DISABLED` quando o meio não pode COMEÇAR algo novo para este motorista:
 *  - `reason: 'GATEWAY_DISABLED'` — o admin desligou o meio na tela do gateway (distingue de "este cartão foi removido", mesmo `code`);
 *  - `reason: 'SANDBOX_RESTRICTED'` (F5.7, ALTO-2) — ambiente efetivo SANDBOX num servidor `NODE_ENV=production` e o e-mail do motorista não está em
 *    `PAYMENT_SANDBOX_TESTER_EMAILS` (lista vazia/ausente = ninguém) OU a identidade não é verificada (DRIVER só com senha nunca é testador — ver
 *    `identidadeEhTestador`: exige `googleSub` ou role de staff). MESMA mensagem de "desativado": não revela a existência da lista de testadores.
 * Config ilegível => 503 `PAYMENT_GATEWAY_UNAVAILABLE` (fail-closed). Só COMEÇOS novos (cartão novo, pré-auth, Pix novo): captura, cancelamento,
 * webhook, varredores e Pix já pago NUNCA passam por aqui — dinheiro em trânsito precisa liquidar; a carteira também nunca é bloqueada.
 */
export async function assertMeioDePagamentoHabilitado(meio: MeioPagamento, userId: string): Promise<void> {
  let config: ConfigEfetiva
  try {
    config = await getConfigEfetiva()
  } catch (err) {
    if (err instanceof ConfiguracaoGatewayIndisponivelError) {
      throw new AppError('O pagamento está indisponível no momento. Tente novamente em instantes.', 503, 'PAYMENT_GATEWAY_UNAVAILABLE')
    }
    throw err
  }
  const mensagem = meio === 'CARD' ? 'O pagamento com cartão está desativado no momento.' : 'A recarga por Pix está desativada no momento.'
  if (!meioHabilitadoParaNovosPagamentos(config.linha, meio)) {
    throw new AppError(mensagem, 409, 'PAYMENT_METHOD_DISABLED', [{ method: meio, reason: 'GATEWAY_DISABLED' }])
  }
  if (isSandboxRestrito(config.estado)) {
    const motorista = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, googleSub: true, role: true } })
    if (!identidadeEhTestador(motorista, parseListaDeTestadores(env.PAYMENT_SANDBOX_TESTER_EMAILS))) {
      throw new AppError(mensagem, 409, 'PAYMENT_METHOD_DISABLED', [{ method: meio, reason: 'SANDBOX_RESTRICTED' }])
    }
  }
}

