import { describe, expect, it } from 'vitest'
import { decidirAdaptadorPagamento, type EntradaDecisaoAdaptador } from '../../src/core/pagamentos/decidirAdaptador'

const base: EntradaDecisaoAdaptador = { nodeEnv: 'production', temCredenciaisCielo: false, permitirFakeEmProducao: false }

describe('decidirAdaptadorPagamento — o simulador nunca entra em produção por acidente', () => {
  it('PRODUÇÃO sem credencial e sem opt-in => BLOQUEADO (era FakeAdapter: cobrança grátis com cartão falso)', () => {
    expect(decidirAdaptadorPagamento(base)).toBe('BLOQUEADO')
  })

  it('PRODUÇÃO sem credencial COM opt-in explícito => Fake permitido (demonstração)', () => {
    expect(decidirAdaptadorPagamento({ ...base, permitirFakeEmProducao: true })).toBe('FAKE_PERMITIDO_EM_PRODUCAO')
  })

  it.each(['development', 'test'] as const)('%s sem credencial => FakeAdapter (demo, CI e testes seguem funcionando)', (nodeEnv) => {
    expect(decidirAdaptadorPagamento({ ...base, nodeEnv })).toBe('FAKE_DEV')
  })

  it.each(['development', 'test', 'production'] as const)('credencial presente em %s => CIELO, e o opt-in do Fake não a sobrepõe', (nodeEnv) => {
    expect(decidirAdaptadorPagamento({ nodeEnv, temCredenciaisCielo: true, permitirFakeEmProducao: false })).toBe('CIELO')
    expect(decidirAdaptadorPagamento({ nodeEnv, temCredenciaisCielo: true, permitirFakeEmProducao: true })).toBe('CIELO')
  })
})
