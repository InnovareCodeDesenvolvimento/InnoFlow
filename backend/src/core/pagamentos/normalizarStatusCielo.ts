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
 * Os demais valores de `Status` usados abaixo (0 NotFinished, 2
 * PaymentConfirmed, 3 Denied, 10 Voided, 12 Pending, 13 Aborted) são os
 * valores públicos e estáveis documentados da API 3.0 da Cielo, mas **não
 * foram batidos contra uma chamada real de sandbox nesta tarefa** (sem
 * credencial disponível no ambiente — ver handoff). Qualquer `Status` não
 * mapeado aqui cai em `FAILED` (fail-closed: nunca assumir sucesso por
 * default) — se o primeiro teste real (F5.2/Íris) trouxer um `Status`
 * inesperado tratado como `FAILED`, é aqui que se ajusta, não espalhando o
 * número mágico pelo resto do código.
 */

export interface RespostaPagamentoCielo {
  status: number
  returnCode: string | null
}

const RETURN_CODES_APTA_A_CAPTURAR = new Set(['00', '4'])

export type StatusCartaoNormalizado = 'PENDING' | 'AUTHORIZED' | 'CAPTURED' | 'DENIED' | 'VOIDED' | 'FAILED'

export function normalizarStatusCartaoCielo(resposta: RespostaPagamentoCielo): StatusCartaoNormalizado {
  const { status, returnCode } = resposta
  const code = returnCode?.trim() || null

  switch (status) {
    case 0: // NotFinished — ainda processando (ex.: análise antifraude assíncrona)
      return 'PENDING'
    case 1: // Authorized — só é "apto a capturar" com o ReturnCode certo
      return code && RETURN_CODES_APTA_A_CAPTURAR.has(code) ? 'AUTHORIZED' : 'DENIED'
    case 2: // PaymentConfirmed (capturado)
      return 'CAPTURED'
    case 3: // Denied
      return 'DENIED'
    case 10: // Voided
      return 'VOIDED'
    case 12: // Pending
      return 'PENDING'
    default:
      return 'FAILED'
  }
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
