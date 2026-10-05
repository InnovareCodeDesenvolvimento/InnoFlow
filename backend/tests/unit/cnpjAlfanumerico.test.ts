import { describe, expect, it } from 'vitest'
import { cnpjNormalizadoValido, formatarCnpjNormalizado, normalizarCnpj, validarENormalizarCnpj } from '../../src/core/legal/cnpj'

describe('CNPJ numérico e alfanumérico (core/legal/cnpj)', () => {
  it('numérico válido, com ou sem pontuação, sai normalizado só com os 14 dígitos', () => {
    expect(validarENormalizarCnpj('11.222.333/0001-81')).toBe('11222333000181')
    expect(validarENormalizarCnpj(' 11222333000181 ')).toBe('11222333000181')
  })

  it('alfanumérico (exemplo OFICIAL da Receita: 12.ABC.345/01DE-35) vale; minúsculas são normalizadas', () => {
    expect(validarENormalizarCnpj('12.ABC.345/01DE-35')).toBe('12ABC34501DE35')
    expect(validarENormalizarCnpj('12.abc.345/01de-35')).toBe('12ABC34501DE35')
    expect(formatarCnpjNormalizado('12ABC34501DE35')).toBe('12.ABC.345/01DE-35')
  })

  it('dígito verificador errado é recusado (numérico e alfanumérico)', () => {
    expect(validarENormalizarCnpj('11.222.333/0001-82')).toBeNull()
    expect(validarENormalizarCnpj('11.222.333/0001-91')).toBeNull()
    expect(validarENormalizarCnpj('12.ABC.345/01DE-36')).toBeNull()
    expect(validarENormalizarCnpj('12.ABC.345/01DE-45')).toBeNull()
  })

  it('recusa sequência repetida, tamanho errado, letra nos 2 últimos (DV é numérico) e caracteres estranhos', () => {
    for (const ruim of ['00000000000000', '11111111111111', 'AAAAAAAAAAAAAA', '1122233300018', '112223330001811', '12ABC34501DEAB', '', '11.222.333/0001-8!', "11222333000181'; DROP"]) {
      expect(validarENormalizarCnpj(ruim), ruim).toBeNull()
    }
  })

  it('normalizarCnpj só tira a pontuação usual e põe em maiúsculas', () => {
    expect(normalizarCnpj('12.abc.345/01de-35')).toBe('12ABC34501DE35')
    expect(cnpjNormalizadoValido('12.ABC.345/01DE-35')).toBe(false) // exige a forma NORMALIZADA
  })
})
