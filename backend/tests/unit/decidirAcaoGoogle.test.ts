import { describe, expect, it } from 'vitest'
import { decidirAcaoGoogle, type ContaCandidata, type IdentidadeGoogle } from '../../src/core/auth/decidirAcaoGoogle'

const identity: IdentidadeGoogle = { sub: 'google-sub-1', email: 'motorista@gmail.com', emailVerified: true, name: 'Motorista' }

const driver = (over: Partial<ContaCandidata> = {}): ContaCandidata => ({ id: 'u-driver', role: 'DRIVER', active: true, googleSub: null, ...over })
const staff = (role: 'ADMIN' | 'OPERATOR', over: Partial<ContaCandidata> = {}): ContaCandidata => ({ id: `u-${role}`, role, active: true, googleSub: null, ...over })

describe('decidirAcaoGoogle', () => {
  it('e-mail NÃO verificado recusa antes de qualquer outra coisa (mesmo com sub conhecido)', () => {
    const decisao = decidirAcaoGoogle({ ...identity, emailVerified: false }, driver({ googleSub: identity.sub }), [])
    expect(decisao).toEqual({ action: 'REJECT', reason: 'EMAIL_NOT_VERIFIED' })
  })

  it('e-mail não verificado nunca revela conta de staff nem cria/vincula', () => {
    expect(decidirAcaoGoogle({ ...identity, emailVerified: false }, null, [staff('ADMIN')])).toEqual({ action: 'REJECT', reason: 'EMAIL_NOT_VERIFIED' })
    expect(decidirAcaoGoogle({ ...identity, emailVerified: false }, null, [])).toEqual({ action: 'REJECT', reason: 'EMAIL_NOT_VERIFIED' })
  })

  it('sub conhecido (DRIVER ativo) -> LOGIN, sem olhar o e-mail', () => {
    expect(decidirAcaoGoogle(identity, driver({ googleSub: identity.sub }), [])).toEqual({ action: 'LOGIN', userId: 'u-driver' })
  })

  it('sub conhecido mas conta inativa -> INACTIVE', () => {
    expect(decidirAcaoGoogle(identity, driver({ googleSub: identity.sub, active: false }), [])).toEqual({ action: 'REJECT', reason: 'INACTIVE' })
  })

  it('sub conhecido em conta de staff (dado sujo) -> STAFF_NOT_ALLOWED', () => {
    expect(decidirAcaoGoogle(identity, staff('OPERATOR', { googleSub: identity.sub }), [])).toEqual({
      action: 'REJECT',
      reason: 'STAFF_NOT_ALLOWED',
      userId: 'u-OPERATOR',
    })
  })

  it('e-mail de DRIVER existente sem Google -> LINK', () => {
    expect(decidirAcaoGoogle(identity, null, [driver()])).toEqual({ action: 'LINK', userId: 'u-driver' })
  })

  it('e-mail de DRIVER inativo -> INACTIVE (e NÃO vincula)', () => {
    expect(decidirAcaoGoogle(identity, null, [driver({ active: false })])).toEqual({ action: 'REJECT', reason: 'INACTIVE' })
  })

  it('e-mail de DRIVER já vinculado a OUTRO sub -> ACCOUNT_MISMATCH (nunca sobrescreve)', () => {
    expect(decidirAcaoGoogle(identity, null, [driver({ googleSub: 'outro-sub' })])).toEqual({ action: 'REJECT', reason: 'ACCOUNT_MISMATCH' })
  })

  it('e-mail de DRIVER já vinculado ao MESMO sub (corrida) -> LOGIN, sem regravar', () => {
    expect(decidirAcaoGoogle(identity, null, [driver({ googleSub: identity.sub })])).toEqual({ action: 'LOGIN', userId: 'u-driver' })
  })

  it.each(['ADMIN', 'OPERATOR'] as const)('e-mail de %s -> STAFF_NOT_ALLOWED (nunca vincula, nunca entra)', (role) => {
    expect(decidirAcaoGoogle(identity, null, [staff(role)])).toEqual({ action: 'REJECT', reason: 'STAFF_NOT_ALLOWED', userId: `u-${role}` })
  })

  it('staff entre os candidatos do e-mail recusa mesmo com um DRIVER de grafia parecida na frente', () => {
    const decisao = decidirAcaoGoogle(identity, null, [driver(), staff('ADMIN')])
    expect(decisao).toEqual({ action: 'REJECT', reason: 'STAFF_NOT_ALLOWED', userId: 'u-ADMIN' })
  })

  it('ninguém achado -> CREATE', () => {
    expect(decidirAcaoGoogle(identity, null, [])).toEqual({ action: 'CREATE' })
  })
})
