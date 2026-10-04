/**
 * Normalizador `Status` + `ReturnCode` (Cielo) -> vocabulário de domínio.
 * Existe para o resto do sistema NUNCA precisar saber o que é
 * `Status=2`/`ReturnCode='6'` — só o cliente HTTP da Cielo
 * (`services/pagamentos/cieloHttpClient.ts`) e este arquivo conhecem esse
 * vocabulário.
 *
 * Fatos CONFIRMADOS na doc oficial (30/09/2026, ver
 * `.claude/agent-memory/nova/cielo-fatos-verificados.md`):
 *   - `Status` sozinho NÃO prova aprovação — `Status=1` (Authorized) não é
 *     pago, é só "apto a autorizar a captura depois".
 *   - `ReturnCode` `'00'` ou `'4'` = apta a capturar; `'6'` = capturada.
 *
 * Os demais valores de `Status` (0 NotFinished, 2 PaymentConfirmed, 3 Denied, 10 Voided, 11 Refunded, 12 Pending, 13 Aborted) são os públicos da API 3.0
 * e batem com `traducao.ts` do Parque das Feiras (produção). Qualquer `Status` NÃO mapeado (inclusive ausente) vira `UNKNOWN` (C2.3): nunca aprovação,
 * mas também nunca uma falha definitiva inventada — quem chama trata como "ainda não sei" e reconsulta (ver `capturarSessaoCartao`, M1).
 */

export interface RespostaPagamentoCielo {
  status: number
  returnCode: string | null
}

/**
 * `ReturnCode` que significam "o autorizador disse sim" para CARTÃO, por degrau (F16, C2.3 — conferido contra `traducao.ts` do Parque das Feiras,
 * que roda em produção). O HTTP 2xx NUNCA decide sozinho ("o sucesso na comunicação HTTP não garante o sucesso da transação" — doc da Cielo): a
 * aprovação é a combinação `ReturnCode` + `Status`.
 *
 *   - Status 1 (Authorized, pré-autorização): `00` ou `4`. NÃO aceitamos `0` nem `6` aqui: `0` é o código do Pix e do cancelamento (o Parque o
 *     aceita porque o mesmo conjunto serve aos dois), e `6` é "capturada" — num Status 1 seria incoerente. Rejeitar um código válido só nos faz
 *     recusar; aceitar um código errado nos faz iniciar uma recarga sem autorização real. Fail-closed.
 *   - Status 2 (PaymentConfirmed, capturada): `00`, `4` ou `6`. A doc diz `6` na captura; `00`/`4` aparecem quando a venda nasce capturada.
 */
const RETURN_CODES_APROVAM_STATUS_1 = new Set(['00', '4'])
const RETURN_CODES_APROVAM_STATUS_2 = new Set(['00', '4', '6'])

export type StatusCartaoNormalizado = 'PENDING' | 'AUTHORIZED' | 'CAPTURED' | 'DENIED' | 'VOIDED' | 'REFUNDED' | 'FAILED' | 'UNKNOWN'

/**
 * Normaliza o `ReturnCode` para comparação: string, sem espaço, maiúscula (`"00" != 0` em qualquer linguagem — comparar como string normalizada).
 * Número vira string; qualquer outra coisa vira `null`.
 */
export function normalizarReturnCodeCielo(bruto: unknown): string | null {
  if (bruto === null || bruto === undefined) return null
  if (typeof bruto === 'number') return Number.isFinite(bruto) ? String(bruto) : null
  if (typeof bruto !== 'string') return null
  const limpo = bruto.trim().toUpperCase()
  return limpo === '' ? null : limpo
}

/**
 * Status + ReturnCode -> estado do CARTÃO. Regras:
 *  - 0 (NotFinished) e 12 (Pending): PENDING, qualquer `ReturnCode` (ainda processando);
 *  - 1 (Authorized): AUTHORIZED só com `ReturnCode` 00/4; senão DENIED (o caso documentado Status 1 + ReturnCode 51 é negada dentro de um HTTP 2xx);
 *  - 2 (PaymentConfirmed): CAPTURED só com `ReturnCode` 00/4/6. Status 2 com outro código (ou sem código) é INCOERENTE: não vira CAPTURED (não
 *    afirmamos cobrança sem o autorizador) NEM FAILED (a venda pode estar de fato capturada — marcar falha criaria dívida em dobro): vira UNKNOWN,
 *    não definitivo, e quem chama reconsulta;
 *  - 3 (Denied): DENIED; 10 (Voided): VOIDED; 11 (Refunded): REFUNDED; 13 (Aborted): FAILED;
 *  - qualquer outro valor (inclusive ausente/-1 e 20 Scheduled): UNKNOWN — NUNCA aprovação, e NUNCA uma falha definitiva inventada.
 */
export function normalizarStatusCartaoCielo(resposta: RespostaPagamentoCielo): StatusCartaoNormalizado {
  const { status } = resposta
  const code = normalizarReturnCodeCielo(resposta.returnCode)

  switch (status) {
    case 0:
    case 12:
      return 'PENDING'
    case 1:
      return code !== null && RETURN_CODES_APROVAM_STATUS_1.has(code) ? 'AUTHORIZED' : 'DENIED'
    case 2:
      return code !== null && RETURN_CODES_APROVAM_STATUS_2.has(code) ? 'CAPTURED' : 'UNKNOWN'
    case 3:
      return 'DENIED'
    case 10:
      return 'VOIDED'
    case 11:
      return 'REFUNDED'
    case 13:
      return 'FAILED'
    default:
      return 'UNKNOWN'
  }
}

// ---------------------------------------------------------------------------
// Cancelamento / estorno (F19, C2.3) — o `ReturnCode` do `PUT .../void` NÃO é o mesmo do pagamento
// ---------------------------------------------------------------------------

/**
 * Desfecho de um `void`. Tabelas do Parque (`traducao.ts`, doc "codigos-retorno-cancelamento"):
 *  - aprovado: `ReturnCode` 0/00/9 E `Status` 10 (Voided, até 23h59 do dia da autorização) ou 11 (Refunded, depois) — a Cielo decide pelo relógio;
 *  - EM_ANDAMENTO: 10/223/476 ("já existe um cancelamento andando"): nem sucesso nem recusa. NÃO retentar e NÃO dar por feito;
 *  - RECUSADO: 40/41/53/101 (definitivo) e 103–107 (restrição cadastral — problema da CONTA, não da transação);
 *  - INDEFINIDO: tudo o mais — inclusive `ReturnCode` de aprovação com `Status` que não confirma (ex.: ainda 1), ou `Status` 10/11 sem código.
 *    Fail-closed: nunca grava "cancelado" sem os dois sinais.
 */
export type DesfechoCancelamento = 'CONFIRMADO' | 'EM_ANDAMENTO' | 'RECUSADO' | 'INDEFINIDO'

export interface InterpretacaoCancelamento {
  desfecho: DesfechoCancelamento
  /** Só com `CONFIRMADO`: 10 = VOIDED (cancelada), 11 = REFUNDED (estornada). */
  reversao: 'VOIDED' | 'REFUNDED' | null
  /** Recusa por restrição cadastral (103–107): alerta ao ADMIN, o motorista não resolve. */
  restricaoCadastral: boolean
}

const RETURN_CODES_CANCELAMENTO_APROVADO = new Set(['0', '00', '9'])
const RETURN_CODES_CANCELAMENTO_EM_ANDAMENTO = new Set(['10', '223', '476'])
const RETURN_CODES_CANCELAMENTO_RECUSA_DEFINITIVA = new Set(['40', '41', '53', '101', '103', '104', '105', '106', '107'])
const RETURN_CODES_RESTRICAO_CADASTRAL = new Set(['103', '104', '105', '106', '107'])

export function interpretarCancelamentoCielo(resposta: RespostaPagamentoCielo): InterpretacaoCancelamento {
  const code = normalizarReturnCodeCielo(resposta.returnCode)
  const restricaoCadastral = code !== null && RETURN_CODES_RESTRICAO_CADASTRAL.has(code)

  if (code !== null && RETURN_CODES_CANCELAMENTO_EM_ANDAMENTO.has(code)) return { desfecho: 'EM_ANDAMENTO', reversao: null, restricaoCadastral: false }
  if (code !== null && RETURN_CODES_CANCELAMENTO_RECUSA_DEFINITIVA.has(code)) return { desfecho: 'RECUSADO', reversao: null, restricaoCadastral }
  if (code !== null && RETURN_CODES_CANCELAMENTO_APROVADO.has(code)) {
    if (resposta.status === 10) return { desfecho: 'CONFIRMADO', reversao: 'VOIDED', restricaoCadastral: false }
    if (resposta.status === 11) return { desfecho: 'CONFIRMADO', reversao: 'REFUNDED', restricaoCadastral: false }
  }
  return { desfecho: 'INDEFINIDO', reversao: null, restricaoCadastral: false }
}

export type StatusPixNormalizado = 'PENDING' | 'PAID' | 'ABORTED' | 'FAILED'

export function normalizarStatusPixCielo(resposta: RespostaPagamentoCielo): StatusPixNormalizado {
  const { status } = resposta
  switch (status) {
    case 0:
    case 12:
      return 'PENDING'
    case 2:
      return 'PAID'
    case 13:
      return 'ABORTED'
    default:
      return 'FAILED'
  }
}
