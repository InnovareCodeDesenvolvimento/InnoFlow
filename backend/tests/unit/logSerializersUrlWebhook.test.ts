import { describe, expect, it } from 'vitest'
import { mascararUrlComSegredo, serializarReq } from '../../src/lib/logSerializers'

describe('mascararUrlComSegredo (pathToken do webhook da Cielo nunca vai ao log)', () => {
  it('mascara o token e a query', () => {
    expect(mascararUrlComSegredo('/api/webhooks/cielo/abc123SEGREDO')).toBe('/api/webhooks/cielo/***')
    expect(mascararUrlComSegredo('/api/webhooks/cielo/abc123SEGREDO?x=1')).toBe('/api/webhooks/cielo/***')
  })
  it('mascara com caixa diferente e com prefixo antes (proxy)', () => {
    expect(mascararUrlComSegredo('/API/Webhooks/Cielo/segredo')).toBe('/API/Webhooks/Cielo/***')
    expect(mascararUrlComSegredo('/x/api/webhooks/cielo/segredo')).toBe('/x/api/webhooks/cielo/***')
  })
  it('nao mexe nas outras rotas', () => {
    expect(mascararUrlComSegredo('/api/me/wallet?limit=5')).toBe('/api/me/wallet?limit=5')
  })
})

describe('serializarReq', () => {
  it('mascara url e preserva o resto do req serializado', () => {
    const out = serializarReq({ id: 1, method: 'POST', url: '/api/webhooks/cielo/segredo', headers: { host: 'api.exemplo.com.br', a: 'b' } }) as Record<string, unknown>
    expect(out.url).toBe('/api/webhooks/cielo/***')
    expect(out.method).toBe('POST')
    expect(out.headers).toEqual({ host: 'api.exemplo.com.br', a: '[redacted]' }) // allowlist de headers: `host` aparece, o resto sai mascarado
    expect(JSON.stringify(out)).not.toContain('segredo')
  })
  it('e defensivo com entradas estranhas', () => {
    expect(serializarReq(undefined)).toBeUndefined()
    expect(serializarReq({ method: 'GET' })).toEqual({ method: 'GET' })
  })
})
