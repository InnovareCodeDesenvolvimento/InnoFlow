/**
 * Contexto SEGURO de um alerta (o que vai para e-mail/WhatsApp, canais FORA do nosso controle). Puro.
 *
 * Duas camadas, ambas obrigatórias:
 *  1. ALLOWLIST de campos (por NOME): só ids técnicos, códigos, contagens e valores em centavos/Wh. Nome fora da lista é DESCARTADO, mesmo que
 *     o valor pareça inofensivo — é a defesa contra o dia em que alguém passar `{ alert, req }` ou `{ alert, err }` por engano. Objetos aninhados
 *     nunca passam (só escalar e lista curta de escalares).
 *  2. FILTRO DE VALOR: mesmo num campo permitido, string longa, com cara de token/JWT/Bearer, e-mail, URL ou sequência de 13+ dígitos (PAN) é
 *     descartada. É a rede de segurança para um campo "motivo" que um dia carregue texto livre.
 *
 * Reaproveita `REDACT_PATHS` (logRedactPaths.ts) como TRAVA: nenhum nome da lista de redação pode estar na allowlist (o teste confere), então uma
 * chave sensível nova adicionada ao redact do logger não pode ser "esquecida" aqui.
 */

/** Campos que podem aparecer no corpo do alerta. Só nomes — o valor ainda passa pelo filtro de valor. */
export const CAMPOS_PERMITIDOS: ReadonlySet<string> = new Set([
  // identificadores técnicos (opacos)
  'paymentIntentId', 'intentId', 'paymentId', 'merchantOrderId', 'sessionId', 'chargePointId', 'ocppIdentity', 'connectorId',
  'operatorId', 'userId', 'actorUserId', 'chargebackId',
  // códigos e estados
  'httpStatus', 'codigos', 'returnCode', 'status', 'statusBruto', 'statusPix', 'motivo', 'reason', 'escopo', 'scope', 'operacao', 'desfecho',
  'environment', 'intentEnvironment', 'effectiveEnvironment', 'severity', 'identityKnown', 'envVar', 'changedFields', 'campos',
  // origem (IP já mascarado, ou o IP de quem está atacando o gateway OCPP)
  'ipMascarado', 'clientIp',
  // contagens, tempos e limites
  'failures', 'falhas', 'tentativas', 'sweepAttempts', 'ageMinutes', 'quantidade', 'scanned', 'actionable', 'evaluated', 'batchSize', 'maxPages',
  'skippedBalanceGuard', 'maxMessages', 'windowSeconds', 'lockSeconds', 'limite', 'length', 'minRecommended', 'ocppTrustProxyHops',
  'proximaTentativaEmSegundos', 'diasRestantes', 'diasDeAtraso',
  // valores monetários (centavos) — nunca dado de cartão
  'captureAmountCents', 'requestedCents', 'authorizedCents', 'esperadoCents', 'pagoCents', 'diferencaCents',
  // flags
  'temPaymentId', 'temQrCode',
])

const MAX_STRING = 120
const MAX_ITENS_LISTA = 10
const MAX_CAMPOS = 30

const CARACTERES_SEGUROS = /^[\p{L}\p{N}_.:\- ,()]+$/u
const EMAIL = /[^\s@]+@[^\s@]+/
const URL_OU_CAMINHO = /(https?:\/\/|\/\/|\?[\w%]+=)/i
const CARTAO_LIKE = /\d{13,}/
const PREFIXO_DE_CREDENCIAL = /(eyJ[\w-]{6,}|bearer\s|basic\s|sk_|pk_|api[-_ ]?key)/i
/** 32+ caracteres seguidos sem espaço/hífen/ponto: com cara de segredo/hash (um cuid tem 25; um uuid tem hífens). */
/** Palavras em minúsculas separadas por `_` (códigos como `payment_gateway_environment_url_mismatch`): longas, mas não são segredo. Cada palavra curta: um token não passa por aqui. */
const PALAVRAS_SNAKE_CASE = /^[a-z]{1,15}(?:_[a-z]{1,15})+$/
const TOKEN_LIKE = /[A-Za-z0-9_+=]{32,}/

/** `true` se a string pode viajar para um canal externo. */
export function stringEhSegura(valor: string): boolean {
  if (valor.length === 0 || valor.length > MAX_STRING) return false
  if (!CARACTERES_SEGUROS.test(valor)) return false
  if (EMAIL.test(valor) || URL_OU_CAMINHO.test(valor) || PREFIXO_DE_CREDENCIAL.test(valor)) return false
  if (!PALAVRAS_SNAKE_CASE.test(valor) && TOKEN_LIKE.test(valor)) return false
  // 13+ dígitos seguidos, ou "disfarçados" com espaço/hífen entre os grupos quando o texto é só isso (número de cartão). Um uuid tem hífens e letras: não cai aqui.
  if (CARTAO_LIKE.test(valor)) return false
  if (/^[\d\s-]+$/.test(valor) && CARTAO_LIKE.test(valor.replace(/[\s-]/g, ''))) return false
  return true
}

export type ValorDeContexto = string | number | boolean

function valorEscalarSeguro(v: unknown): ValorDeContexto | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') return stringEhSegura(v) ? v : undefined
  return undefined
}

/** Reduz o objeto logado ao contexto seguro. Nunca lança. Listas viram "a, b, c". */
export function sanitizarContexto(bruto: unknown): Record<string, ValorDeContexto> {
  const saida: Record<string, ValorDeContexto> = {}
  if (typeof bruto !== 'object' || bruto === null || Array.isArray(bruto)) return saida
  let n = 0
  for (const nome of Object.keys(bruto)) {
    if (n >= MAX_CAMPOS) break
    if (!CAMPOS_PERMITIDOS.has(nome)) continue
    let valor: unknown
    try {
      valor = (bruto as Record<string, unknown>)[nome]
    } catch {
      continue // getter que lança
    }
    if (Array.isArray(valor)) {
      const itens = valor.slice(0, MAX_ITENS_LISTA).map(valorEscalarSeguro).filter((x): x is ValorDeContexto => x !== undefined)
      if (itens.length > 0) {
        saida[nome] = itens.join(', ')
        n++
      }
      continue
    }
    const seguro = valorEscalarSeguro(valor)
    if (seguro !== undefined) {
      saida[nome] = seguro
      n++
    }
  }
  return saida
}

/**
 * Mensagem do log (texto escrito por nós) reduzida: sem e-mail, sem sequência de 13+ dígitos, sem trecho com cara de token, uma linha, até 300
 * caracteres. A mensagem é a explicação humana do alerta, por isso vai junto — mas, por ser texto livre (pode ter valor interpolado), passa por limpeza.
 */
export function sanitizarMensagem(mensagem: unknown): string {
  if (typeof mensagem !== 'string') return ''
  return mensagem
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[^\s@]+@[^\s@]+/g, '[omitido]')
    .replace(/(eyJ[\w-]{6,}[\w.-]*|bearer\s+\S+|basic\s+\S+)/gi, '[omitido]')
    .replace(/https?:\/\/\S+/gi, '[url omitida]')
    .replace(/\d(?:[\s-]?\d){12,}/g, '[omitido]')
    .replace(/[A-Za-z0-9_+=]{32,}/g, '[omitido]')
    .trim()
    .slice(0, 300)
}
