import { describe, expect, it } from 'vitest'
import { verificarSegredoWebhookConstante } from '../../src/core/pagamentos/verificarSegredoWebhook'

describe('verificarSegredoWebhookConstante', () => {
  it('aceita quando os valores batem', () => {
    expect(verificarSegredoWebhookConstante('segredo-123', 'segredo-123')).toBe(true)
  })

  it('rejeita quando os valores diferem (mesmo tamanho)', () => {
    expect(verificarSegredoWebhookConstante('segredo-abc', 'segredo-xyz')).toBe(false)
  })

  it('rejeita quando os tamanhos diferem (sem lançar RangeError do timingSafeEqual)', () => {
    expect(verificarSegredoWebhookConstante('curto', 'um-segredo-bem-mais-longo')).toBe(false)
  })

  it('rejeita undefined/null (header ausente)', () => {
    expect(verificarSegredoWebhookConstante(undefined, 'segredo-123')).toBe(false)
    expect(verificarSegredoWebhookConstante(null, 'segredo-123')).toBe(false)
  })

  it('rejeita string vazia', () => {
    expect(verificarSegredoWebhookConstante('', 'segredo-123')).toBe(false)
  })
})
