import { describe, expect, it } from 'vitest'
import { PADRAO_NOME_HEADER_SITE_CIELO, WEBHOOK_SECRET_HEADER_NAME, WEBHOOK_SECRET_HEADER_NAME_LOWER } from '../../src/core/pagamentos/webhookHeader'
import { ehPingDeValidacaoDaCielo } from '../../src/core/pagamentos/pingWebhookCielo'
import { REDACT_PATHS } from '../../src/lib/logRedactPaths'
import { CAMPOS_SENSIVEIS } from '../../src/lib/logSerializers'

/**
 * C1.4. O campo "Key" do header no Site Cielo só aceita LETRAS (fato F27, provado no Parque em 02/09/2026: `X-Webhook-Secret` não pôde ser salvo e
 * o Parque usa `CieloWebhookSecret`). Um nome inválido faz a Cielo descartar TODAS as notificações sem aviso.
 */
describe('nome do header do webhook — só letras', () => {
  it('é só letras (o que o Site Cielo aceita), e o nome antigo com hífens falha na MESMA regra', () => {
    expect(WEBHOOK_SECRET_HEADER_NAME).toMatch(PADRAO_NOME_HEADER_SITE_CIELO)
    expect(PADRAO_NOME_HEADER_SITE_CIELO.test('x-innoelektron-webhook-secret')).toBe(false) // o nome antigo
    expect(PADRAO_NOME_HEADER_SITE_CIELO.test('X-Webhook-Secret')).toBe(false) // o que o dono não conseguiu salvar no Parque
    expect(PADRAO_NOME_HEADER_SITE_CIELO.test('CieloWebhookSecret')).toBe(true) // o que roda no Parque (oráculo)
  })

  it('o valor exato é InnoFlowWebhookSecret (a tela e o GO-LIVE mostram este nome)', () => {
    expect(WEBHOOK_SECRET_HEADER_NAME).toBe('InnoFlowWebhookSecret')
    expect(WEBHOOK_SECRET_HEADER_NAME_LOWER).toBe('innoflowwebhooksecret')
  })

  it('o redact do pino e a varredura em profundidade do err cobrem o header (nome em minúsculo, como o Node entrega)', () => {
    expect(REDACT_PATHS).toContain('req.headers.innoflowwebhooksecret')
    expect(CAMPOS_SENSIVEIS.has('innoflowwebhooksecret')).toBe(true)
    expect(REDACT_PATHS.some((p) => p.includes('x-innoelektron-webhook-secret'))).toBe(false)
  })
})

describe('ping de validação da URL do webhook (F26/F28)', () => {
  it('é ping: corpo ausente, vazio, não-objeto, sem PaymentId ou sem ChangeType', () => {
    for (const corpo of [undefined, null, '', 'texto', 7, [], {}, { ChangeType: 1 }, { PaymentId: '' }, { PaymentId: '   ', ChangeType: 1 }, { PaymentId: null, ChangeType: 1 }, { PaymentId: 'abc' }, { PaymentId: 'abc', ChangeType: null }]) {
      expect(ehPingDeValidacaoDaCielo(corpo), JSON.stringify(corpo)).toBe(true)
    }
  })

  it('NÃO é ping: notificação com PaymentId e ChangeType (a validação do schema decide o resto, inclusive PaymentId malformado)', () => {
    for (const corpo of [{ PaymentId: 'abc', ChangeType: 1 }, { PaymentId: 'abc', ChangeType: '1' }, { PaymentId: 'abc', ChangeType: 0 }, { PaymentId: { x: 1 }, ChangeType: 1 }, { PaymentId: 12345, ChangeType: 1 }]) {
      expect(ehPingDeValidacaoDaCielo(corpo), JSON.stringify(corpo)).toBe(false)
    }
  })
})
