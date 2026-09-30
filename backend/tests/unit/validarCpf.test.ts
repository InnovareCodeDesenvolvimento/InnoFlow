import { describe, expect, it } from 'vitest'
import { apenasDigitos, isValidCpf } from '../../src/core/pagamentos/validarCpf'

describe('apenasDigitos', () => {
  it('remove tudo que não for dígito', () => {
    expect(apenasDigitos('123.456.789-09')).toBe('12345678909')
  })
})

describe('isValidCpf', () => {
  it('aceita um CPF válido (dígito verificador correto)', () => {
    expect(isValidCpf('11144477735')).toBe(true)
  })

  it('rejeita dígito verificador errado', () => {
    expect(isValidCpf('11144477736')).toBe(false)
  })

  it('rejeita sequência de dígito único (passa no cálculo, mas nunca é CPF real)', () => {
    expect(isValidCpf('00000000000')).toBe(false)
    expect(isValidCpf('11111111111')).toBe(false)
  })

  it('rejeita tamanho diferente de 11 dígitos', () => {
    expect(isValidCpf('123456789')).toBe(false)
    expect(isValidCpf('123456789012')).toBe(false)
  })

  it('rejeita string vazia (chamador decide se CPF é obrigatório, isto só valida FORMATO)', () => {
    expect(isValidCpf('')).toBe(false)
  })
})
