import { env } from '../env'
import { logger } from '../logger'
import { analisarCiphertext, decodeAesGcmKey, decryptAesGcmComChaves, derivarChaveDoSegredo, encryptAesGcmV1, keyId } from './aesGcm'

/**
 * CHAVE-MESTRA dos segredos em repouso do InnoFlow — cifra/decifra todos os campos `*Ciphertext`: `PaymentMethod.cieloCardTokenCiphertext` (F5.3),
 * `PaymentGatewayConfig.*Ciphertext` (F5.5), `NotificationChannelConfig` (SMTP/Evolution), `BackupConfig` (S3/Google/cópia da chave do backup) e a chave Pix de devolução (L1.4).
 * A chave NUNCA vive no banco.
 *
 * MUDANÇA DELIBERADA (05/10/2026, decisão do dono: "não foi assim que fizemos no InnoChat, quero da mesma forma"): a chave-mestra é DERIVADA do `JWT_SECRET`
 * (`scryptSync(JWT_SECRET, SALT_DA_CHAVE_DERIVADA, 32)`, ver `aesGcm.ts`) — o deploy só precisa das variáveis essenciais (DATABASE_URL, REDIS_URL, JWT_SECRET). Não existe mais
 * "variável de chave de segredos" obrigatória. Duas fontes, nesta ordem:
 *
 *  1. OVERRIDE (opcional): `PAYMENT_SECRETS_KEY` definida => ela é a chave ATUAL, exatamente como antes (base64 de 32 bytes; compatibilidade e rotação avançada com
 *     `PAYMENT_SECRETS_KEY_PREVIOUS`). Definida mas INVÁLIDA => FAIL-CLOSED: a chave-mestra fica indisponível (não cai para a derivada em silêncio — isso gravaria segredos numa chave que o
 *     dono não escolheu e a "correção" da variável os deixaria ilegíveis depois). Erro logado uma vez.
 *  2. DERIVADA (padrão): sem override, a chave é derivada do `JWT_SECRET` (>= 16 caracteres; produção exige >= 32 no `env.ts`).
 *
 * Quando o override está ativo, a chave derivada do `JWT_SECRET` entra como chave de SÓ-DECIFRAR automática: o que foi cifrado ANTES de definir o `PAYMENT_SECRETS_KEY` continua legível
 * (e o script `payments:recifrar-segredos` o migra para a chave nova). Escolhida pelo `kid` — não há ambiguidade. A recíproca também funciona (remover o override mantendo-o em
 * `PAYMENT_SECRETS_KEY_PREVIOUS` até recifrar).
 *
 * FAIL-CLOSED (como o InnoChat): ciphertext que a chave não decifra (JWT_SECRET trocado, dado adulterado, formato inválido) NUNCA vira texto parcial nem exceção que derrube o processo:
 * `decifrarSegredoOuNull` devolve `null` e o chamador trata como "não configurado"/ausente. `decryptPaymentSecret` (que lança um erro TIPADO sem o conteúdo) continua existindo porque
 * os consumidores antigos já capturam o erro e o tratam como ausente — o efeito é o mesmo. Nunca logue o valor em claro nem o ciphertext.
 *
 * ROTAÇÃO (F5.7): o formato é `v1:<kid>:<base64>` (ver `aesGcm.ts`; `kid` = 8 hex do SHA-256 da chave — vale também para a derivada, é isso que distingue "JWT_SECRET trocado" de "dado
 * corrompido"). `encryptPaymentSecret` SEMPRE grava `v1` com a chave ATUAL; `decryptPaymentSecret` aceita `v1` (chave escolhida pelo `kid`) e o LEGADO sem prefixo (tenta todas).
 * Runbook em `docs/DEPLOY-EASYPANEL.md`.
 */

export type ModoDaChaveMestra = 'override' | 'derivada' | 'indisponivel'

let avisouPreviousInvalida = false
let avisouOverrideInvalido = false

interface ChavesMestras {
  modo: ModoDaChaveMestra
  atual: Buffer | null
  /** Só decifram: `PAYMENT_SECRETS_KEY_PREVIOUS` (se válida) e, no modo override, a derivada do `JWT_SECRET`. */
  somenteDecifram: Buffer[]
}

/** Resolve as chaves a partir do `env` A CADA CHAMADA (barato: base64 e o scrypt é cacheado por valor) — assim mudar o ambiente num teste não exige reset. */
function resolverChaves(): ChavesMestras {
  const derivada = derivarChaveDoSegredo(env.JWT_SECRET)
  const previous = lerChaveAnterior()
  const somenteDecifram: Buffer[] = []
  if (previous) somenteDecifram.push(previous)

  if (env.PAYMENT_SECRETS_KEY) {
    let override: Buffer | null = null
    try {
      override = decodeAesGcmKey(env.PAYMENT_SECRETS_KEY)
    } catch {
      if (!avisouOverrideInvalido) {
        avisouOverrideInvalido = true
        logger.error({ alert: 'payment_secrets_key_invalid' }, '[crypto] PAYMENT_SECRETS_KEY está definida mas não decodifica para 32 bytes — chave-mestra INDISPONÍVEL (fail-closed). Corrija o valor (openssl rand -base64 32) ou remova a variável para usar a chave derivada do JWT_SECRET.')
      }
    }
    if (!override) return { modo: 'indisponivel', atual: null, somenteDecifram }
    if (derivada) somenteDecifram.push(derivada)
    return { modo: 'override', atual: override, somenteDecifram }
  }

  if (!derivada) return { modo: 'indisponivel', atual: null, somenteDecifram }
  return { modo: 'derivada', atual: derivada, somenteDecifram }
}

/**
 * Chave ANTERIOR (rotação) — só decifra. Ausente => `null`. Inválida (não decodifica para 32 bytes) => `null` + erro logado UMA vez: uma chave anterior
 * quebrada NÃO pode derrubar o que a chave atual ainda decifra (só os ciphertexts da chave antiga ficarão ilegíveis, e `secretsDecryptable`/o script avisam).
 */
function lerChaveAnterior(): Buffer | null {
  const bruto = env.PAYMENT_SECRETS_KEY_PREVIOUS
  if (!bruto) return null
  try {
    return decodeAesGcmKey(bruto)
  } catch {
    if (!avisouPreviousInvalida) {
      avisouPreviousInvalida = true
      logger.error({ alert: 'payment_secrets_key_previous_invalid' }, '[crypto] PAYMENT_SECRETS_KEY_PREVIOUS não decodifica para 32 bytes — ignorada (só a chave atual decifra)')
    }
    return null
  }
}

function getChaveAtual(): Buffer {
  const { atual, modo } = resolverChaves()
  if (!atual) {
    // Mensagem SEM valor de segredo. Só chega aqui se o JWT_SECRET sumiu/é curto demais (o `env.ts` já barra no boot) ou se o override é inválido.
    throw new Error(
      modo === 'indisponivel' && env.PAYMENT_SECRETS_KEY
        ? 'PAYMENT_SECRETS_KEY (override) está definida mas é inválida — a chave-mestra dos segredos está indisponível. Corrija (openssl rand -base64 32) ou remova a variável.'
        : 'Chave-mestra dos segredos indisponível: JWT_SECRET ausente ou com menos de 16 caracteres (a chave é derivada dele).',
    )
  }
  return atual
}

/** Como a chave-mestra está sendo obtida agora: `override` (PAYMENT_SECRETS_KEY válida), `derivada` (do JWT_SECRET) ou `indisponivel`. Não lança. */
export function modoDaChaveMestra(): ModoDaChaveMestra {
  return resolverChaves().modo
}

/**
 * A chave-mestra está UTILIZÁVEL agora? Não lança. No modo padrão (derivada) é `true` sempre que há `JWT_SECRET` válido — o que o `env.ts` garante no boot; só é `false` se
 * `PAYMENT_SECRETS_KEY` foi definida com valor inválido (ou, em teste, sem JWT_SECRET). Usado pela configuração do gateway (F5.5), pela de comunicação e pela de backup para
 * calcular `readiness`/`secretsKeyConfigured` e decidir 503 `*_SECRETS_KEY_MISSING` ANTES de tentar cifrar.
 */
export function isPaymentSecretsKeyConfigured(): boolean {
  return resolverChaves().atual !== null
}

/** Cifra no formato `v1:<kid>:<base64>` com a chave ATUAL. Lança (sem o valor) se a chave-mestra está indisponível: gravar segredo sem conseguir cifrar seria pior que falhar. */
export function encryptPaymentSecret(plaintext: string): string {
  return encryptAesGcmV1(plaintext, getChaveAtual())
}

/** Decifra `v1` (chave escolhida pelo `kid`) ou legado (todas, em ordem). Lança um erro TIPADO (sem conteúdo) se nenhuma chave disponível decifra. */
export function decryptPaymentSecret(ciphertext: string): string {
  const { atual, somenteDecifram } = resolverChaves()
  if (!atual) getChaveAtual() // lança o erro com a explicação certa
  return decryptAesGcmComChaves(ciphertext, { atual: atual!, outras: somenteDecifram })
}

/**
 * FAIL-CLOSED, no estilo do `decryptSecret` do InnoChat: NUNCA lança. Devolve o texto em claro, ou `null` quando não há como decifrar (valor ausente/vazio, chave-mestra trocada,
 * dado adulterado/truncado, formato inválido). `null` = "não configurado/ausente" para quem chama. Não loga nada (o chamador decide o alerta; nunca o valor).
 */
export function decifrarSegredoOuNull(ciphertext: string | null | undefined): string | null {
  if (!ciphertext) return null
  try {
    return decryptPaymentSecret(ciphertext)
  } catch {
    return null
  }
}

/**
 * Este ciphertext JÁ está no formato novo E cifrado com a chave ATUAL? É o que o script de rotação usa para decidir "nada a fazer" (idempotência).
 * Não decifra nada. Legado (sem prefixo) e `v1` de outra chave => `false`.
 */
export function ciphertextEstaNaChaveAtual(ciphertext: string): boolean {
  const analisado = analisarCiphertext(ciphertext)
  return analisado.formato === 'v1' && analisado.kid === keyId(getChaveAtual())
}

/** Só para teste — zera os avisos "uma vez por processo" (a chave em si é resolvida do `env` a cada chamada, sem cache a limpar). */
export function resetPaymentSecretsKeyCacheParaTeste(): void {
  avisouPreviousInvalida = false
  avisouOverrideInvalido = false
}
