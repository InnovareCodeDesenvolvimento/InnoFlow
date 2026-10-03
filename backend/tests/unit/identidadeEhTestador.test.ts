import { describe, expect, it } from 'vitest'
import { identidadeEhTestador, parseListaDeTestadores } from '../../src/core/pagamentos/configGateway'

/**
 * F5.8 (ALTO-2, achado da Íris) — a guarda do sandbox restrito só vale para identidade VERIFICADA: e-mail na lista E (googleSub OU role de staff).
 * Um DRIVER que se cadastrou só com e-mail/senha (o register não confirma o endereço) nunca é testador.
 */
const lista = parseListaDeTestadores('dono@empresa.com.br, Tester2@Example.com')

describe('identidadeEhTestador', () => {
  it('DRIVER com googleSub e e-mail na lista => testador (o Google entregou email_verified)', () => {
    expect(identidadeEhTestador({ email: 'dono@empresa.com.br', googleSub: 'g-123', role: 'DRIVER' }, lista)).toBe(true)
  })

  it('DRIVER SÓ COM SENHA (googleSub null/undefined/vazio) com o e-mail na lista => NÃO é testador', () => {
    expect(identidadeEhTestador({ email: 'dono@empresa.com.br', googleSub: null, role: 'DRIVER' }, lista)).toBe(false)
    expect(identidadeEhTestador({ email: 'dono@empresa.com.br', googleSub: undefined, role: 'DRIVER' }, lista)).toBe(false)
    expect(identidadeEhTestador({ email: 'dono@empresa.com.br', googleSub: '', role: 'DRIVER' }, lista)).toBe(false)
  })

  it('staff (qualquer role diferente de DRIVER) com e-mail na lista passa mesmo sem googleSub', () => {
    for (const role of ['ADMIN', 'OPERATOR', 'SUPPORT', 'QUALQUER_OUTRA']) {
      expect(identidadeEhTestador({ email: 'dono@empresa.com.br', googleSub: null, role }, lista), role).toBe(true)
    }
  })

  it('e-mail em caixa diferente continua casando (a lista não distingue caixa) — quem impede o duplicado é o register', () => {
    expect(identidadeEhTestador({ email: 'DONO@EMPRESA.COM.BR', googleSub: 'g-1', role: 'DRIVER' }, lista)).toBe(true)
    expect(identidadeEhTestador({ email: ' tester2@example.com ', googleSub: 'g-2', role: 'DRIVER' }, lista)).toBe(true)
  })

  it('e-mail fora da lista nunca é testador, mesmo com googleSub ou staff', () => {
    expect(identidadeEhTestador({ email: 'outro@empresa.com.br', googleSub: 'g-9', role: 'DRIVER' }, lista)).toBe(false)
    expect(identidadeEhTestador({ email: 'outro@empresa.com.br', googleSub: null, role: 'ADMIN' }, lista)).toBe(false)
  })

  it('lista vazia = ninguém, nem com googleSub nem staff (falha segura)', () => {
    const vazia = parseListaDeTestadores(undefined)
    expect(identidadeEhTestador({ email: 'dono@empresa.com.br', googleSub: 'g-1', role: 'DRIVER' }, vazia)).toBe(false)
    expect(identidadeEhTestador({ email: 'dono@empresa.com.br', googleSub: null, role: 'ADMIN' }, vazia)).toBe(false)
  })

  it('usuário inexistente ou sem e-mail => false', () => {
    expect(identidadeEhTestador(null, lista)).toBe(false)
    expect(identidadeEhTestador(undefined, lista)).toBe(false)
    expect(identidadeEhTestador({ email: null, googleSub: 'g-1', role: 'DRIVER' }, lista)).toBe(false)
    expect(identidadeEhTestador({ email: '', googleSub: 'g-1', role: 'ADMIN' }, lista)).toBe(false)
  })
})
