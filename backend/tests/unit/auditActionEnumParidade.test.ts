import { describe, expect, it } from 'vitest'
import { AuditAction } from '@prisma/client'
import { auditActionEnum } from '../../src/api/schemas/auditLog.schema'

describe('auditActionEnum (filtro da tela de Auditoria) = enum AuditAction do Prisma', () => {
  it('não faltam nem sobram valores (faltavam PAYMENT_* e os 4 do lote 1; o filtro por eles dava 400)', () => {
    expect([...auditActionEnum.options].sort()).toEqual(Object.values(AuditAction).sort())
  })
})
