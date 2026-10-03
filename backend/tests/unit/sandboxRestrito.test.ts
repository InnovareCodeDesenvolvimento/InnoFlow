import { describe, expect, it } from 'vitest'
import { emailEhTestador, paraPaymentEnvironment, parseListaDeTestadores, sandboxRestrito } from '../../src/core/pagamentos/configGateway'

/** F5.7 (ALTO-2) — sandbox em servidor de produção: regra pura (a prova de ponta a ponta contra o banco está em `paymentGatewaySandboxRestrito.test.ts`). */
describe('sandboxRestrito (ambiente efetivo x NODE_ENV)', () => {
  it('só restringe SANDBOX em servidor de PRODUÇÃO', () => {
    expect(sandboxRestrito('sandbox', 'production')).toBe(true)
    expect(sandboxRestrito('production', 'production')).toBe(false) // dinheiro real: não é esta trava
    expect(sandboxRestrito('sandbox', 'development')).toBe(false)
    expect(sandboxRestrito('sandbox', 'test')).toBe(false)
    expect(sandboxRestrito('production', 'development')).toBe(false)
  })
})

describe('parseListaDeTestadores / emailEhTestador', () => {
  it('lista vazia, ausente ou só vírgulas/espaços => NINGUÉM (falha segura)', () => {
    for (const bruto of [undefined, null, '', '   ', ',', ' , , ']) {
      const lista = parseListaDeTestadores(bruto)
      expect(lista.size, String(bruto)).toBe(0)
      expect(emailEhTestador('qualquer@example.com', lista)).toBe(false)
    }
  })

  it('separa por vírgula, apara espaços e ignora maiúsculas (no e-mail da lista E no do motorista)', () => {
    const lista = parseListaDeTestadores('  Dono@Empresa.com.br ,tester2@example.com,,  ')
    expect([...lista].sort()).toEqual(['dono@empresa.com.br', 'tester2@example.com'])
    expect(emailEhTestador('dono@empresa.com.br', lista)).toBe(true)
    expect(emailEhTestador('  DONO@EMPRESA.COM.BR ', lista)).toBe(true)
    expect(emailEhTestador('tester2@example.com', lista)).toBe(true)
  })

  it('comparação EXATA: sem curinga, sem domínio inteiro, sem sufixo/prefixo', () => {
    const lista = parseListaDeTestadores('dono@empresa.com.br,*@empresa.com.br,@empresa.com.br')
    expect(emailEhTestador('outro@empresa.com.br', lista)).toBe(false)
    expect(emailEhTestador('xdono@empresa.com.br', lista)).toBe(false)
    expect(emailEhTestador('dono@empresa.com.br.evil.com', lista)).toBe(false)
    expect(emailEhTestador('dono+tag@empresa.com.br', lista)).toBe(false)
  })

  it('e-mail ausente/vazio nunca é testador', () => {
    const lista = parseListaDeTestadores('a@b.com')
    expect(emailEhTestador(undefined, lista)).toBe(false)
    expect(emailEhTestador(null, lista)).toBe(false)
    expect(emailEhTestador('', lista)).toBe(false)
  })
})

describe('paraPaymentEnvironment (borda String minúscula -> enum maiúsculo)', () => {
  it('sandbox -> SANDBOX, production -> PRODUCTION', () => {
    expect(paraPaymentEnvironment('sandbox')).toBe('SANDBOX')
    expect(paraPaymentEnvironment('production')).toBe('PRODUCTION')
  })
})
