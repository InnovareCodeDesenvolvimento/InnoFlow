/** N-7 — allowlist de campos + filtro de valor do contexto dos alertas, e a trava contra `REDACT_PATHS`. */
import { describe, expect, it } from 'vitest'
import { CAMPOS_PERMITIDOS, sanitizarContexto, sanitizarMensagem, stringEhSegura } from '../../src/core/alertas/contexto'
import { REDACT_PATHS } from '../../src/lib/logRedactPaths'

describe('sanitizarContexto', () => {
  it('nenhum nome da lista de redação do logger (REDACT_PATHS) está na allowlist', () => {
    const nomesRedigidos = REDACT_PATHS.flatMap((p) => p.replace(/^\*\./, '').split('.').slice(-1))
    const colisao = [...CAMPOS_PERMITIDOS].filter((c) => nomesRedigidos.some((n) => n.toLowerCase() === c.toLowerCase()))
    expect(colisao).toEqual([])
  })

  it('só passa campo permitido; objeto aninhado, erro e função nunca passam', () => {
    const r = sanitizarContexto({
      alert: 'x',
      paymentIntentId: 'pi_1',
      failures: 5,
      req: { headers: { authorization: 'x' } },
      err: new Error('segredo'),
      cb: () => 1,
      identityKnown: true,
      desconhecido: 'valor',
    })
    expect(r).toEqual({ paymentIntentId: 'pi_1', failures: 5, identityKnown: true })
  })

  it('valor perigoso em campo permitido é descartado', () => {
    const perigosos = [
      'a@b.com',
      '4111111111111111',
      '4111 1111 1111 1111',
      '4111-1111-1111-1111',
      'eyJhbGciOiJIUzI1NiJ9.eyJ4IjoxfQ.sig',
      'Bearer abc',
      'Basic dXNlcjpwYXNz',
      'https://api.cielo.com.br/x?token=1',
      'a'.repeat(33),
      'x'.repeat(121),
      'linha1\nlinha2',
      '',
      '<script>',
    ]
    for (const v of perigosos) expect(stringEhSegura(v), JSON.stringify(v)).toBe(false)
    for (const v of ['pi_abc123', 'cmuv8eu580b0801lfmmppmx09', 'a1b2c3d4-0000-4000-8000-000000000001', 'merchant_order', 'IF-123', '127.0.0.1', 'sem leitura de medidor']) {
      expect(stringEhSegura(v), v).toBe(true)
    }
  })

  it('listas viram texto (até 10 itens, só escalares seguros); números não finitos caem', () => {
    expect(sanitizarContexto({ codigos: ['A', 'B', 'c@d.com', { x: 1 }] })).toEqual({ codigos: 'A, B' })
    expect(sanitizarContexto({ failures: Number.NaN, tentativas: Infinity, quantidade: 3 })).toEqual({ quantidade: 3 })
    expect(sanitizarContexto({ codigos: Array.from({ length: 50 }, (_, i) => `c${i}`) }).codigos).toBe('c0, c1, c2, c3, c4, c5, c6, c7, c8, c9')
  })

  it('entrada que não é objeto, getter que lança e referência circular não derrubam', () => {
    expect(sanitizarContexto(null)).toEqual({})
    expect(sanitizarContexto('texto')).toEqual({})
    expect(sanitizarContexto([1, 2])).toEqual({})
    const o: Record<string, unknown> = { quantidade: 2 }
    o.self = o
    Object.defineProperty(o, 'sessionId', { enumerable: true, get() { throw new Error('boom') } })
    expect(sanitizarContexto(o)).toEqual({ quantidade: 2 })
  })
})

describe('sanitizarMensagem', () => {
  it('remove e-mail, cartão, Bearer/JWT, URL e blocos longos; uma linha só; até 300 caracteres', () => {
    const m = sanitizarMensagem('x\ny a@b.com 4111111111111111 Bearer abc.def eyJhbGciOi.eyJ4.sig https://x.com/?t=1 ' + 'z'.repeat(40) + ' fim')
    expect(m).not.toMatch(/a@b\.com|4111|Bearer|eyJ|https|zzzz|\n/)
    expect(m).toContain('fim')
    expect(sanitizarMensagem('y'.repeat(1000)).length).toBeLessThanOrEqual(300)
    expect(sanitizarMensagem(undefined)).toBe('')
    expect(sanitizarMensagem(42)).toBe('')
  })
})
