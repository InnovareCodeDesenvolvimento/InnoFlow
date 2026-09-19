import { describe, expect, it } from 'vitest'
import { AUDIT_FIELD_LIMITS, deveGravarAuditoria, limitarCamposDeAuditoria } from '../../src/core/auditoria/limitesDeCampos'

describe('limitarCamposDeAuditoria (Órion A4)', () => {
  it('trunca path/userAgent/entityId nos tetos do CHECK do banco (255/512/128)', () => {
    const r = limitarCamposDeAuditoria({ path: 'p'.repeat(5_000), userAgent: 'u'.repeat(16_000), entityId: 'e'.repeat(1_000) })
    expect(r.path).toHaveLength(AUDIT_FIELD_LIMITS.path)
    expect(r.userAgent).toHaveLength(AUDIT_FIELD_LIMITS.userAgent)
    expect(r.entityId).toHaveLength(AUDIT_FIELD_LIMITS.entityId)
    expect([AUDIT_FIELD_LIMITS.path, AUDIT_FIELD_LIMITS.userAgent, AUDIT_FIELD_LIMITS.entityId]).toEqual([255, 512, 128])
  })

  it('no limite exato NÃO mexe; abaixo, idem', () => {
    const exato = { path: 'p'.repeat(255), userAgent: 'u'.repeat(512), entityId: 'e'.repeat(128) }
    expect(limitarCamposDeAuditoria(exato)).toEqual(exato)
    expect(limitarCamposDeAuditoria({ path: '/api/admin/sites', userAgent: 'Mozilla', entityId: 'abc' })).toEqual({ path: '/api/admin/sites', userAgent: 'Mozilla', entityId: 'abc' })
  })

  it('null/undefined passam intactos (campos opcionais)', () => {
    expect(limitarCamposDeAuditoria({ path: '/x', userAgent: null, entityId: undefined })).toEqual({ path: '/x', userAgent: null, entityId: undefined })
  })

  it('preserva os OUTROS campos do input (só toca nos três)', () => {
    const r = limitarCamposDeAuditoria({ path: '/x', action: 'CREATE', httpStatus: 201 })
    expect(r.action).toBe('CREATE')
    expect(r.httpStatus).toBe(201)
  })

  it('não muta o objeto original', () => {
    const original = { path: 'p'.repeat(300) }
    limitarCamposDeAuditoria(original)
    expect(original.path).toHaveLength(300)
  })
})

describe('deveGravarAuditoria (DENIED só para quem usa o painel)', () => {
  it('DRIVER + DENIED (403 em /api/admin/*) NÃO grava — qualquer conta cadastrada inflava a tabela imutável', () => {
    expect(deveGravarAuditoria('DRIVER', 'DENIED')).toBe(false)
  })

  it('ADMIN e OPERATOR + DENIED continuam gravando (o sinal de segurança mais valioso: OPERATOR tentando o recurso de outro tenant)', () => {
    expect(deveGravarAuditoria('ADMIN', 'DENIED')).toBe(true)
    expect(deveGravarAuditoria('OPERATOR', 'DENIED')).toBe(true)
  })

  it('SUCCESS e FAILED não mudam para nenhum papel', () => {
    for (const role of ['ADMIN', 'OPERATOR', 'DRIVER'] as const) {
      expect(deveGravarAuditoria(role, 'SUCCESS')).toBe(true)
      expect(deveGravarAuditoria(role, 'FAILED')).toBe(true)
    }
  })
})
