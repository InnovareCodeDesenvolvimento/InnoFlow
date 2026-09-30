import { describe, expect, it } from 'vitest'
import { normalizarStatusCartaoCielo, normalizarStatusPixCielo } from '../../src/core/pagamentos/normalizarStatusCielo'

describe('normalizarStatusCartaoCielo', () => {
  it('Status=1 (Authorized) + ReturnCode=00 -> AUTHORIZED (apta a capturar)', () => {
    expect(normalizarStatusCartaoCielo({ status: 1, returnCode: '00' })).toBe('AUTHORIZED')
  })

  it('Status=1 (Authorized) + ReturnCode=4 -> AUTHORIZED (apta a capturar)', () => {
    expect(normalizarStatusCartaoCielo({ status: 1, returnCode: '4' })).toBe('AUTHORIZED')
  })

  it('Status=1 (Authorized) sem ReturnCode capturável -> DENIED (Status sozinho NÃO prova aprovação)', () => {
    expect(normalizarStatusCartaoCielo({ status: 1, returnCode: '99' })).toBe('DENIED')
  })

  it('Status=1 (Authorized) com ReturnCode nulo -> DENIED (fail-closed)', () => {
    expect(normalizarStatusCartaoCielo({ status: 1, returnCode: null })).toBe('DENIED')
  })

  it('Status=2 (PaymentConfirmed) -> CAPTURED', () => {
    expect(normalizarStatusCartaoCielo({ status: 2, returnCode: '6' })).toBe('CAPTURED')
  })

  it('Status=3 (Denied) -> DENIED', () => {
    expect(normalizarStatusCartaoCielo({ status: 3, returnCode: '05' })).toBe('DENIED')
  })

  it('Status=10 (Voided) -> VOIDED', () => {
    expect(normalizarStatusCartaoCielo({ status: 10, returnCode: null })).toBe('VOIDED')
  })

  it('Status=0 (NotFinished) -> PENDING', () => {
    expect(normalizarStatusCartaoCielo({ status: 0, returnCode: null })).toBe('PENDING')
  })

  it('Status=12 (Pending) -> PENDING', () => {
    expect(normalizarStatusCartaoCielo({ status: 12, returnCode: null })).toBe('PENDING')
  })

  it('Status desconhecido -> FAILED (fail-closed, nunca assume sucesso por default)', () => {
    expect(normalizarStatusCartaoCielo({ status: 999, returnCode: '00' })).toBe('FAILED')
  })
})

describe('normalizarStatusPixCielo', () => {
  it('Status=0 (NotFinished) -> PENDING', () => {
    expect(normalizarStatusPixCielo({ status: 0, returnCode: null })).toBe('PENDING')
  })

  it('Status=12 (Pending) -> PENDING', () => {
    expect(normalizarStatusPixCielo({ status: 12, returnCode: null })).toBe('PENDING')
  })

  it('Status=2 (PaymentConfirmed) -> PAID', () => {
    expect(normalizarStatusPixCielo({ status: 2, returnCode: '6' })).toBe('PAID')
  })

  it('Status=13 (Aborted) -> ABORTED', () => {
    expect(normalizarStatusPixCielo({ status: 13, returnCode: null })).toBe('ABORTED')
  })

  it('Status desconhecido -> FAILED (fail-closed)', () => {
    expect(normalizarStatusPixCielo({ status: 999, returnCode: null })).toBe('FAILED')
  })
})
