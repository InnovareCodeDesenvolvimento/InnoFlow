import { describe, expect, it } from 'vitest'
import { transicionarCartao, transicionarPix } from '../../src/core/pagamentos/maquinaEstados'
import { isTerminalCardStatus, isTerminalPixStatus } from '../../src/core/pagamentos/tipos'

describe('transicionarCartao', () => {
  it('CREATED -(AUTHORIZED)-> AUTHORIZED', () => {
    expect(transicionarCartao('CREATED', 'AUTHORIZED')).toEqual({ ok: true, estado: 'AUTHORIZED' })
  })

  it('CREATED -(AUTHORIZATION_DENIED)-> FAILED', () => {
    expect(transicionarCartao('CREATED', 'AUTHORIZATION_DENIED')).toEqual({ ok: true, estado: 'FAILED' })
  })

  it('CREATED -(AUTHORIZATION_FAILED)-> FAILED', () => {
    expect(transicionarCartao('CREATED', 'AUTHORIZATION_FAILED')).toEqual({ ok: true, estado: 'FAILED' })
  })

  it('AUTHORIZED -(CAPTURE_REQUESTED)-> CAPTURE_PENDING', () => {
    expect(transicionarCartao('AUTHORIZED', 'CAPTURE_REQUESTED')).toEqual({ ok: true, estado: 'CAPTURE_PENDING' })
  })

  it('AUTHORIZED -(VOIDED)-> VOIDED', () => {
    expect(transicionarCartao('AUTHORIZED', 'VOIDED')).toEqual({ ok: true, estado: 'VOIDED' })
  })

  it('CAPTURE_PENDING -(CAPTURED)-> CAPTURED', () => {
    expect(transicionarCartao('CAPTURE_PENDING', 'CAPTURED')).toEqual({ ok: true, estado: 'CAPTURED' })
  })

  it('CAPTURE_PENDING -(CAPTURE_FAILED)-> FAILED', () => {
    expect(transicionarCartao('CAPTURE_PENDING', 'CAPTURE_FAILED')).toEqual({ ok: true, estado: 'FAILED' })
  })

  it('estados terminais rejeitam qualquer evento', () => {
    for (const estado of ['CAPTURED', 'FAILED', 'VOIDED'] as const) {
      const resultado = transicionarCartao(estado, 'CAPTURED')
      expect(resultado.ok).toBe(false)
      expect(resultado.estado).toBe(estado)
      expect(resultado.motivo).toContain(estado)
    }
  })

  it('CREATED não aceita CAPTURE_REQUESTED (não pode pular direto para captura sem autorizar)', () => {
    const resultado = transicionarCartao('CREATED', 'CAPTURE_REQUESTED')
    expect(resultado).toEqual({ ok: false, estado: 'CREATED', motivo: expect.stringContaining('CREATED') })
  })

  it('CAPTURED não aceita VOIDED (não existe "estornar" via void, ver decisão #4 da Nova)', () => {
    const resultado = transicionarCartao('CAPTURED', 'VOIDED')
    expect(resultado.ok).toBe(false)
  })

  it('isTerminalCardStatus', () => {
    expect(isTerminalCardStatus('CAPTURED')).toBe(true)
    expect(isTerminalCardStatus('FAILED')).toBe(true)
    expect(isTerminalCardStatus('VOIDED')).toBe(true)
    expect(isTerminalCardStatus('CREATED')).toBe(false)
    expect(isTerminalCardStatus('AUTHORIZED')).toBe(false)
    expect(isTerminalCardStatus('CAPTURE_PENDING')).toBe(false)
  })
})

describe('transicionarPix', () => {
  it('CREATED -(QR_GENERATED)-> PENDING', () => {
    expect(transicionarPix('CREATED', 'QR_GENERATED')).toEqual({ ok: true, estado: 'PENDING' })
  })

  it('CREATED -(GENERATION_FAILED)-> FAILED', () => {
    expect(transicionarPix('CREATED', 'GENERATION_FAILED')).toEqual({ ok: true, estado: 'FAILED' })
  })

  it('PENDING -(PAID)-> PAID', () => {
    expect(transicionarPix('PENDING', 'PAID')).toEqual({ ok: true, estado: 'PAID' })
  })

  it('PENDING -(EXPIRED)-> EXPIRED', () => {
    expect(transicionarPix('PENDING', 'EXPIRED')).toEqual({ ok: true, estado: 'EXPIRED' })
  })

  it('PENDING -(FAILED)-> FAILED', () => {
    expect(transicionarPix('PENDING', 'FAILED')).toEqual({ ok: true, estado: 'FAILED' })
  })

  it('CREATED não aceita PAID direto (tem que passar por PENDING)', () => {
    const resultado = transicionarPix('CREATED', 'PAID')
    expect(resultado.ok).toBe(false)
  })

  it('estados terminais rejeitam qualquer evento', () => {
    for (const estado of ['PAID', 'EXPIRED', 'FAILED'] as const) {
      const resultado = transicionarPix(estado, 'PAID')
      expect(resultado.ok).toBe(false)
      expect(resultado.estado).toBe(estado)
    }
  })

  it('isTerminalPixStatus', () => {
    expect(isTerminalPixStatus('PAID')).toBe(true)
    expect(isTerminalPixStatus('EXPIRED')).toBe(true)
    expect(isTerminalPixStatus('FAILED')).toBe(true)
    expect(isTerminalPixStatus('CREATED')).toBe(false)
    expect(isTerminalPixStatus('PENDING')).toBe(false)
  })
})
