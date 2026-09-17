import { describe, expect, it } from 'vitest'
import { avaliarInicioSessao, type AvaliarInicioSessaoInput } from '../../src/core/carteira/avaliarInicioSessao'

const NOW = new Date('2026-09-17T12:00:00Z')

function baseInput(overrides: Partial<AvaliarInicioSessaoInput> = {}): AvaliarInicioSessaoInput {
  return {
    token: { status: 'ACCEPTED', expiresAt: null, userId: 'user-1' },
    now: NOW,
    openDebt: false,
    walletBalanceCents: 5000,
    minStartBalanceCents: 2000,
    ...overrides,
  }
}

describe('avaliarInicioSessao', () => {
  it('token inexistente -> Invalid (UNKNOWN_TOKEN)', () => {
    const result = avaliarInicioSessao(baseInput({ token: null }))
    expect(result).toEqual({ decision: 'Invalid', reason: 'UNKNOWN_TOKEN' })
  })

  it('token.status INVALID -> Invalid (TOKEN_INVALID)', () => {
    const result = avaliarInicioSessao(baseInput({ token: { status: 'INVALID', expiresAt: null, userId: 'user-1' } }))
    expect(result).toEqual({ decision: 'Invalid', reason: 'TOKEN_INVALID' })
  })

  it('token.status BLOCKED -> Blocked (TOKEN_BLOCKED), verificado ANTES do saldo', () => {
    const result = avaliarInicioSessao(baseInput({ token: { status: 'BLOCKED', expiresAt: null, userId: 'user-1' }, walletBalanceCents: 999_999 }))
    expect(result).toEqual({ decision: 'Blocked', reason: 'TOKEN_BLOCKED' })
  })

  it('token.status EXPIRED -> Expired (TOKEN_EXPIRED)', () => {
    const result = avaliarInicioSessao(baseInput({ token: { status: 'EXPIRED', expiresAt: null, userId: 'user-1' } }))
    expect(result).toEqual({ decision: 'Expired', reason: 'TOKEN_EXPIRED' })
  })

  it('token com expiresAt no passado -> Expired (TOKEN_EXPIRED), mesmo com status ACCEPTED', () => {
    const result = avaliarInicioSessao(
      baseInput({ token: { status: 'ACCEPTED', expiresAt: new Date('2026-01-01T00:00:00Z'), userId: 'user-1' } }),
    )
    expect(result).toEqual({ decision: 'Expired', reason: 'TOKEN_EXPIRED' })
  })

  it('token com expiresAt no futuro -> não expira por causa da data', () => {
    const result = avaliarInicioSessao(
      baseInput({ token: { status: 'ACCEPTED', expiresAt: new Date('2027-01-01T00:00:00Z'), userId: 'user-1' } }),
    )
    expect(result).toEqual({ decision: 'Accepted' })
  })

  it('token sem userId amarrado -> Invalid (TOKEN_NOT_LINKED_TO_USER)', () => {
    const result = avaliarInicioSessao(baseInput({ token: { status: 'ACCEPTED', expiresAt: null, userId: null } }))
    expect(result).toEqual({ decision: 'Invalid', reason: 'TOKEN_NOT_LINKED_TO_USER' })
  })

  it('Debt OPEN do usuário -> Blocked (OPEN_DEBT), verificado ANTES do saldo', () => {
    const result = avaliarInicioSessao(baseInput({ openDebt: true, walletBalanceCents: 999_999 }))
    expect(result).toEqual({ decision: 'Blocked', reason: 'OPEN_DEBT' })
  })

  it('saldo abaixo do mínimo -> Blocked (INSUFFICIENT_BALANCE) — NUNCA Invalid', () => {
    const result = avaliarInicioSessao(baseInput({ walletBalanceCents: 1999, minStartBalanceCents: 2000 }))
    expect(result).toEqual({ decision: 'Blocked', reason: 'INSUFFICIENT_BALANCE' })
  })

  it('saldo exatamente no mínimo -> Accepted (limite inclusivo)', () => {
    const result = avaliarInicioSessao(baseInput({ walletBalanceCents: 2000, minStartBalanceCents: 2000 }))
    expect(result).toEqual({ decision: 'Accepted' })
  })

  it('tudo certo -> Accepted', () => {
    const result = avaliarInicioSessao(baseInput())
    expect(result).toEqual({ decision: 'Accepted' })
  })
})
