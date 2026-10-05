/**
 * L1.6 / DL5 — regras PURAS das notificações ao motorista: quem é desligável, o cruzamento do limiar de saldo baixo, o id do job, o código seguro de motivo, e a PARIDADE com o
 * contrato do frontend (`frontend/src/types/api.ts`): se a lista de tipos ou a de "sempre ligados" divergir lá ou aqui, o teste quebra.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { NotificationType } from '@prisma/client'
import { describe, expect, it } from 'vitest'
import {
  codigoSeguroDeMotivo,
  cruzouLimiarDeSaldoBaixo,
  decidirEnvio,
  ehSempreLigado,
  jobIdDaNotificacao,
  LIMIAR_SALDO_BAIXO_MAX_CENTS,
  LIMIAR_SALDO_BAIXO_MIN_CENTS,
  LIMIAR_SALDO_BAIXO_PADRAO_CENTS,
  limiarValido,
  NOTIFICATION_TYPES,
  PREFERENCIAS_PADRAO,
  TIPOS_SEMPRE_LIGADOS,
  type PreferenciasDeNotificacao,
} from '../../src/core/notificacoes/politica'

const TUDO_DESLIGADO: PreferenciasDeNotificacao = { sessionReceiptEmail: false, lowBalanceEnabled: false, lowBalanceThresholdCents: 500 }

describe('DL5 — o que é opcional e o que é sempre', () => {
  it('padrões: recibo e saldo baixo LIGADOS, limiar R$ 20,00', () => {
    expect(PREFERENCIAS_PADRAO).toEqual({ sessionReceiptEmail: true, lowBalanceEnabled: true, lowBalanceThresholdCents: 2000 })
    expect(LIMIAR_SALDO_BAIXO_PADRAO_CENTS).toBe(2000)
    expect([LIMIAR_SALDO_BAIXO_MIN_CENTS, LIMIAR_SALDO_BAIXO_MAX_CENTS]).toEqual([500, 50_000])
  })

  it('segurança e cobrança passam MESMO com tudo desligado (não existe como desligá-los)', () => {
    for (const tipo of ['PASSWORD_CHANGED', 'SESSION_PAYMENT_FAILED', 'ACCOUNT_DELETED'] as const) {
      expect(ehSempreLigado(tipo)).toBe(true)
      expect(decidirEnvio(tipo, TUDO_DESLIGADO)).toEqual({ enviar: true })
    }
  })

  it('recibo desligado dispensa SÓ o recibo (concluída e encerrada pelo servidor); saldo baixo desligado dispensa SÓ o saldo baixo', () => {
    expect(decidirEnvio('SESSION_COMPLETED', { ...PREFERENCIAS_PADRAO, sessionReceiptEmail: false })).toEqual({ enviar: false, motivo: 'PREFERENCE_OFF' })
    expect(decidirEnvio('SESSION_CLOSED_BY_SERVER', { ...PREFERENCIAS_PADRAO, sessionReceiptEmail: false })).toEqual({ enviar: false, motivo: 'PREFERENCE_OFF' })
    expect(decidirEnvio('LOW_BALANCE', { ...PREFERENCIAS_PADRAO, lowBalanceEnabled: false })).toEqual({ enviar: false, motivo: 'PREFERENCE_OFF' })
    // o outro interruptor não interfere
    expect(decidirEnvio('LOW_BALANCE', { ...PREFERENCIAS_PADRAO, sessionReceiptEmail: false })).toEqual({ enviar: true })
    expect(decidirEnvio('SESSION_COMPLETED', { ...PREFERENCIAS_PADRAO, lowBalanceEnabled: false })).toEqual({ enviar: true })
  })

  it('Pix creditado e recarga pelo suporte não têm chave: sempre saem', () => {
    expect(decidirEnvio('TOPUP_CREDITED', TUDO_DESLIGADO)).toEqual({ enviar: true })
    expect(decidirEnvio('REMOTE_START_BY_SUPPORT', TUDO_DESLIGADO)).toEqual({ enviar: true })
  })

  it('todo tipo tem decisão definida (um tipo novo sem regra aparece aqui)', () => {
    for (const tipo of NOTIFICATION_TYPES) expect(['enviar' in decidirEnvio(tipo, PREFERENCIAS_PADRAO)]).toEqual([true])
  })
})

describe('saldo baixo só no CRUZAMENTO (acceptance do plano)', () => {
  it('R$ 25 -> R$ 15 com limiar R$ 20 => avisa; R$ 15 -> R$ 10 => NÃO avisa de novo', () => {
    expect(cruzouLimiarDeSaldoBaixo(2500, 1500, 2000)).toBe(true)
    expect(cruzouLimiarDeSaldoBaixo(1500, 1000, 2000)).toBe(false)
  })

  it('fronteiras: ANTES exatamente no limiar conta como "acima" (cruza ao cair); DEPOIS exatamente no limiar NÃO é abaixo', () => {
    expect(cruzouLimiarDeSaldoBaixo(2000, 1999, 2000)).toBe(true)
    expect(cruzouLimiarDeSaldoBaixo(2500, 2000, 2000)).toBe(false)
    expect(cruzouLimiarDeSaldoBaixo(1999, 1000, 2000)).toBe(false)
  })

  it('quem sobe e volta a cruzar é avisado de novo (cada cruzamento é um fato novo); movimento que não reduz não cruza', () => {
    expect(cruzouLimiarDeSaldoBaixo(1500, 5000, 2000)).toBe(false)
    expect(cruzouLimiarDeSaldoBaixo(5000, 1500, 2000)).toBe(true)
    expect(cruzouLimiarDeSaldoBaixo(2500, 2500, 2000)).toBe(false)
  })

  it('o limiar da PESSOA manda: o mesmo movimento cruza um limiar e não cruza outro', () => {
    expect(cruzouLimiarDeSaldoBaixo(2500, 1500, 1000)).toBe(false)
    expect(cruzouLimiarDeSaldoBaixo(2500, 1500, 5000)).toBe(false) // já estava abaixo de R$ 50 antes
    expect(cruzouLimiarDeSaldoBaixo(6000, 1500, 5000)).toBe(true)
  })

  it('limiarValido: inteiro de 500 a 50000', () => {
    for (const v of [500, 2000, 50_000]) expect(limiarValido(v)).toBe(true)
    for (const v of [499, 50_001, 0, -1, 20.5, '2000', null, undefined, NaN]) expect(limiarValido(v)).toBe(false)
  })
})

describe('job id e motivo', () => {
  it('jobId é determinístico por (tipo, fato), sem `:` (o BullMQ recusa) nem caractere estranho', () => {
    expect(jobIdDaNotificacao('SESSION_COMPLETED', 'cmabc123')).toBe('notif-SESSION_COMPLETED-cmabc123')
    expect(jobIdDaNotificacao('SESSION_COMPLETED', 'cmabc123')).toBe(jobIdDaNotificacao('SESSION_COMPLETED', 'cmabc123'))
    expect(jobIdDaNotificacao('SESSION_COMPLETED', 'a')).not.toBe(jobIdDaNotificacao('SESSION_PAYMENT_FAILED', 'a'))
    expect(jobIdDaNotificacao('LOW_BALANCE', 'a:b c@d/e')).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('o motivo gravado no banco é sempre um CÓDIGO: mensagem/endereço viram o código genérico', () => {
    expect(codigoSeguroDeMotivo('SMTP_CONNECTION_FAILED')).toBe('SMTP_CONNECTION_FAILED')
    expect(codigoSeguroDeMotivo('smtp 550')).toBe('SEND_FAILED') // espaço
    expect(codigoSeguroDeMotivo('rejeitado: maria@exemplo.com')).toBe('SEND_FAILED') // endereço
    expect(codigoSeguroDeMotivo('x'.repeat(65))).toBe('SEND_FAILED')
    expect(codigoSeguroDeMotivo(undefined)).toBe('SEND_FAILED')
    expect(codigoSeguroDeMotivo('maria@exemplo.com', 'OUTRO')).toBe('OUTRO')
  })
})

describe('paridade com o contrato do frontend (frontend/src/types/api.ts)', () => {
  const api = readFileSync(resolve(__dirname, '../../../frontend/src/types/api.ts'), 'utf8')
  const listaDe = (nome: string): string[] => {
    const m = new RegExp(`export const ${nome} = \\[([^\\]]*)\\]`).exec(api)
    expect(m, `${nome} não achado em api.ts`).not.toBeNull()
    return [...m![1].matchAll(/"([A-Z_]+)"/g)].map((x) => x[1])
  }

  it('NOTIFICATION_TYPES e o enum NotificationType do Prisma são os mesmos 8 valores', () => {
    expect(listaDe('NOTIFICATION_TYPES').sort()).toEqual([...NOTIFICATION_TYPES].sort())
    expect(Object.values(NotificationType).sort()).toEqual([...NOTIFICATION_TYPES].sort())
  })

  it('ALWAYS_ON_NOTIFICATION_TYPES é exatamente a lista de sempre ligados daqui', () => {
    expect(listaDe('ALWAYS_ON_NOTIFICATION_TYPES').sort()).toEqual([...TIPOS_SEMPRE_LIGADOS].sort())
  })

  it('limites e padrão do limiar iguais aos do contrato', () => {
    const n = (nome: string) => Number(new RegExp(`export const ${nome} = (\\d+)`).exec(api)![1])
    expect(n('LOW_BALANCE_THRESHOLD_MIN_CENTS')).toBe(LIMIAR_SALDO_BAIXO_MIN_CENTS)
    expect(n('LOW_BALANCE_THRESHOLD_MAX_CENTS')).toBe(LIMIAR_SALDO_BAIXO_MAX_CENTS)
    expect(n('LOW_BALANCE_THRESHOLD_DEFAULT_CENTS')).toBe(LIMIAR_SALDO_BAIXO_PADRAO_CENTS)
  })
})
