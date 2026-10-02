import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SEGREDO_WEBHOOK_TAMANHO_MINIMO } from '../../src/core/pagamentos/verificarSegredoWebhook'
import { updatePaymentGatewayConfigSchema } from '../../src/api/schemas/paymentGateway.schema'

/**
 * F5.7 (B2): segredos do webhook fracos. PUT exige >= 32; as ENVs seguem aceitando >= 8 (não derrubam o boot) mas o USO loga `warn`
 * com o TAMANHO (nunca o valor), no máximo 1x por hora.
 */
describe('B2 — PUT do gateway: segredo do webhook >= 32 caracteres', () => {
  it('31 é recusado (inclusive com espaços nas bordas, que o schema apara); 32 e 40 passam', () => {
    expect(updatePaymentGatewayConfigSchema.safeParse({ webhookHeaderSecret: 'a'.repeat(SEGREDO_WEBHOOK_TAMANHO_MINIMO - 1) }).success).toBe(false)
    expect(updatePaymentGatewayConfigSchema.safeParse({ webhookHeaderSecret: `  ${'a'.repeat(31)}  ` }).success).toBe(false)
    expect(updatePaymentGatewayConfigSchema.safeParse({ webhookHeaderSecret: 'a'.repeat(32) }).success).toBe(true)
    expect(updatePaymentGatewayConfigSchema.safeParse({ webhookHeaderSecret: 'a'.repeat(40) }).success).toBe(true)
  })

  it('a mensagem de erro diz o mínimo (a tela pode mostrá-la)', () => {
    const r = updatePaymentGatewayConfigSchema.safeParse({ webhookHeaderSecret: 'curto-demais' })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues[0].message).toContain('32')
  })
})

describe('B2 — ENV CIELO_WEBHOOK_PATH_TOKEN: aceita >= 8 no boot, mas o uso avisa quando < 32', () => {
  const original = process.env.CIELO_WEBHOOK_PATH_TOKEN
  beforeEach(() => vi.resetModules())
  afterEach(() => {
    if (original === undefined) delete process.env.CIELO_WEBHOOK_PATH_TOKEN
    else process.env.CIELO_WEBHOOK_PATH_TOKEN = original
  })

  async function carregar(token: string) {
    process.env.CIELO_WEBHOOK_PATH_TOKEN = token
    const { logger } = await import('../../src/lib/logger')
    const aviso = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    const { getCieloWebhookPathToken } = await import('../../src/services/pagamentos/webhookCieloSecrets')
    return { aviso, getCieloWebhookPathToken }
  }

  it('token de 12 caracteres: o boot NÃO cai, o uso loga warn com o tamanho (nunca o valor) e só 1x', async () => {
    const token = 'tokenfraco12'
    const { aviso, getCieloWebhookPathToken } = await carregar(token)
    expect(getCieloWebhookPathToken()).toBe(token)
    expect(getCieloWebhookPathToken()).toBe(token)
    const chamadas = aviso.mock.calls.filter(([c]) => (c as { alert?: string }).alert === 'payment_webhook_secret_weak')
    expect(chamadas).toHaveLength(1)
    expect(chamadas[0][0]).toMatchObject({ envVar: 'CIELO_WEBHOOK_PATH_TOKEN', length: 12, minRecommended: 32 })
    expect(JSON.stringify(aviso.mock.calls)).not.toContain(token)
  })

  it('token de 32+ caracteres: sem aviso', async () => {
    const { aviso, getCieloWebhookPathToken } = await carregar('t'.repeat(40))
    getCieloWebhookPathToken()
    expect(aviso.mock.calls.filter(([c]) => (c as { alert?: string }).alert === 'payment_webhook_secret_weak')).toHaveLength(0)
  })

  it('segredo do HEADER vindo do env com 10 caracteres: warn com o tamanho, nunca o valor, 1x (config sem linha no banco)', async () => {
    const segredo = 'hdrfraco10'
    const original = process.env.CIELO_WEBHOOK_HEADER_SECRET
    process.env.CIELO_WEBHOOK_HEADER_SECRET = segredo
    vi.doMock('../../src/services/pagamentos/gatewayConfig', () => ({ getConfigEfetiva: async () => ({ linha: null }) }))
    try {
      const { logger } = await import('../../src/lib/logger')
      const aviso = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
      const { getCieloWebhookHeaderSecret } = await import('../../src/services/pagamentos/webhookCieloSecrets')
      expect(await getCieloWebhookHeaderSecret()).toBe(segredo)
      expect(await getCieloWebhookHeaderSecret()).toBe(segredo)
      const chamadas = aviso.mock.calls.filter(([c]) => (c as { alert?: string }).alert === 'payment_webhook_secret_weak')
      expect(chamadas).toHaveLength(1)
      expect(chamadas[0][0]).toMatchObject({ envVar: 'CIELO_WEBHOOK_HEADER_SECRET', length: 10 })
      expect(JSON.stringify(aviso.mock.calls)).not.toContain(segredo)
    } finally {
      vi.doUnmock('../../src/services/pagamentos/gatewayConfig')
      if (original === undefined) delete process.env.CIELO_WEBHOOK_HEADER_SECRET
      else process.env.CIELO_WEBHOOK_HEADER_SECRET = original
    }
  })
})
