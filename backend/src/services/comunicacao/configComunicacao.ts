import type { NotificationChannelConfig } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { decryptPaymentSecret, isPaymentSecretsKeyConfigured } from '../../lib/crypto/paymentSecrets'
import { resolverConfigAlertas, type LinhaComunicacao, type ResolucaoDeComunicacao } from '../../lib/alertas/configDb'
import { AppError } from '../../api/middleware/errorHandler'

/**
 * Configuração EFETIVA de comunicação (e-mail SMTP + WhatsApp/Evolution + dedupe dos avisos): o PAINEL (tabela `NotificationChannelConfig`) manda, as envs
 * `ALERT_*` são a reserva — mesmo princípio do gateway de pagamento (`services/pagamentos/gatewayConfig.ts`). Regras de resolução em `lib/alertas/configDb.ts`.
 *
 * CONSISTÊNCIA entre processos: a linha é cacheada em memória por processo com TTL de `CACHE_TTL_MS` (30 s). O processo que GRAVA (a API) invalida o próprio cache
 * na hora; o `worker` e o gateway OCPP enxergam a mudança no máximo `CACHE_TTL_MS` depois (mais os poucos segundos de snapshot do notificador). Sem Redis pub/sub de propósito:
 * não criar dependência de tempo real num caminho que precisa continuar funcionando com o Redis degradado.
 *
 * FALHA: o consumo pelo notificador (`getConfigComunicacao`) NUNCA lança — banco fora => cai na env (reserva) por `CACHE_FALHA_MS` e avisa (log sem `alert`, para não gerar
 * laço no notificador). A leitura da TELA (`getConfigComunicacaoEstrita`) lança 503, como o GET do gateway.
 */

export const CACHE_TTL_MS = 30_000
const CACHE_FALHA_MS = 5_000

export interface ConfigComunicacaoEfetiva extends ResolucaoDeComunicacao {
  /** Linha crua do banco (segredos AINDA cifrados) ou `null` se nada foi salvo (ou se a leitura falhou). */
  linha: LinhaComunicacao | null
  /** A leitura do banco falhou e o que vale agora é só a env (reserva). */
  leituraFalhou: boolean
}

interface EntradaCache {
  valor: ConfigComunicacaoEfetiva
  validoAte: number
}

let cache: EntradaCache | null = null
let carregando: Promise<ConfigComunicacaoEfetiva> | null = null
/** Incrementa a cada invalidação; uma leitura iniciada ANTES de uma gravação não pode repovoar o cache com dado velho. */
let geracao = 0
let ultimoAvisoDeFalha = 0

export class ComunicacaoIndisponivelError extends AppError {
  constructor() {
    super('Não foi possível ler as configurações de comunicação agora.', 503, 'COMMUNICATION_SETTINGS_UNAVAILABLE')
    this.name = 'ComunicacaoIndisponivelError'
  }
}

export function linhaDeRow(row: NotificationChannelConfig): LinhaComunicacao {
  return {
    emailEnabled: row.emailEnabled,
    smtpHost: row.smtpHost,
    smtpPort: row.smtpPort,
    smtpSecure: row.smtpSecure,
    smtpUser: row.smtpUser,
    smtpPasswordCiphertext: row.smtpPasswordCiphertext,
    emailFromName: row.emailFromName,
    emailFromAddress: row.emailFromAddress,
    alertEmailRecipients: row.alertEmailRecipients,
    emailMinSeverity: row.emailMinSeverity,
    whatsappEnabled: row.whatsappEnabled,
    evolutionBaseUrl: row.evolutionBaseUrl,
    evolutionInstance: row.evolutionInstance,
    evolutionApiKeyCiphertext: row.evolutionApiKeyCiphertext,
    evolutionApiVersion: row.evolutionApiVersion,
    alertWhatsappRecipients: row.alertWhatsappRecipients,
    whatsappMinSeverity: row.whatsappMinSeverity,
    alertDedupeMinutes: row.alertDedupeMinutes,
    updatedAt: row.updatedAt,
  }
}

/** Sem a chave de cifragem os segredos salvos não decifram: devolve um decifrador que lança (o canal vira "ilegível", não derruba). */
const decifrar = (c: string): string => decryptPaymentSecret(c)

export function resolverAgora(linha: LinhaComunicacao | null, leituraFalhou = false): ConfigComunicacaoEfetiva {
  return { ...resolverConfigAlertas(linha, process.env, decifrar), linha, leituraFalhou }
}

async function lerDoBanco(estrito: boolean): Promise<ConfigComunicacaoEfetiva> {
  try {
    const row = await prisma.notificationChannelConfig.findUnique({ where: { id: 1 } })
    return resolverAgora(row ? linhaDeRow(row) : null)
  } catch (err) {
    if (estrito) throw new ComunicacaoIndisponivelError()
    const t = Date.now()
    if (t - ultimoAvisoDeFalha > 60_000) {
      ultimoAvisoDeFalha = t
      // SEM o campo `alert`: este log vem do caminho do próprio notificador.
      logger.warn({ notifier: 'config_banco', erro: err instanceof Error ? err.name : 'erro' }, '[comunicacao] falha ao ler NotificationChannelConfig — usando só as envs (reserva) até o banco voltar')
    }
    return resolverAgora(null, true)
  }
}

async function carregar(estrito: boolean): Promise<ConfigComunicacaoEfetiva> {
  const agora = Date.now()
  if (cache && cache.validoAte > agora && !(estrito && cache.valor.leituraFalhou)) return cache.valor
  if (carregando && !estrito) return carregando

  const geracaoNoInicio = geracao
  const promessa = lerDoBanco(estrito)
    .then((valor) => {
      if (geracao === geracaoNoInicio) cache = { valor, validoAte: Date.now() + (valor.leituraFalhou ? CACHE_FALHA_MS : CACHE_TTL_MS) }
      return valor
    })
    .finally(() => {
      if (carregando === promessa) carregando = null
    })
  if (!estrito) carregando = promessa
  return promessa
}

/** Para o notificador e os envios: NUNCA lança (banco fora => env). */
export function getConfigComunicacao(): Promise<ConfigComunicacaoEfetiva> {
  return carregar(false)
}

/** Para a TELA: banco fora => `ComunicacaoIndisponivelError` (503). */
export function getConfigComunicacaoEstrita(): Promise<ConfigComunicacaoEfetiva> {
  return carregar(true)
}

/** Invalida o cache DESTE processo (logo depois de gravar). Outros processos expiram pelo TTL. */
export function invalidarCacheComunicacao(): void {
  geracao += 1
  cache = null
  carregando = null
}

/** Só para teste. */
export function resetCacheComunicacaoParaTeste(): void {
  invalidarCacheComunicacao()
  ultimoAvisoDeFalha = 0
}

/**
 * `secretsDecryptable` do DTO: tenta decifrar os segredos SALVOS NO BANCO agora (nunca lança, nunca devolve nem loga o texto). `null` = não há segredo salvo;
 * `false` = ao menos um não decifra (chave trocada/perdida); `true` = todos decifram.
 */
export function verificarSegredosDecifraveis(linha: LinhaComunicacao | null): boolean | null {
  if (!linha) return null
  const salvos = [linha.smtpPasswordCiphertext, linha.evolutionApiKeyCiphertext].filter((c): c is string => Boolean(c))
  if (salvos.length === 0) return null
  try {
    for (const c of salvos) decifrar(c)
    return true
  } catch {
    return false
  }
}

export const chaveDeCifragemConfigurada = isPaymentSecretsKeyConfigured

/** Só para teste: o que está em cache AGORA (sem ler o banco). */
export function configEmCacheParaTeste(): ConfigComunicacaoEfetiva | null {
  return cache?.valor ?? null
}
