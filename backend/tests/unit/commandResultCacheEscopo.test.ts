import { describe, expect, it } from 'vitest'
import { decodeCommandRecord, decodeCommandResult, decodeCommandStatusForStaff, encodeCommandResult } from '../../src/ocpp/commandResultCache'
import { PAPEIS_QUE_PODEM_INICIAR_RECARGA_REMOTA, podeIniciarRecargaRemota } from '../../src/core/sessao/politicaRecargaRemota'

const dono = { userId: 'user-a', chargePointId: 'cp-1', operatorId: 'op-1' }

describe('registro de resultado de comando com escopo (L1.5)', () => {
  it('ida e volta: dono + status + charge point + operador', () => {
    expect(decodeCommandRecord(encodeCommandResult(dono, 'ACCEPTED'))).toEqual({ userId: 'user-a', status: 'ACCEPTED', chargePointId: 'cp-1', operatorId: 'op-1' })
    expect(encodeCommandResult(dono, 'PENDING')).toBe('user-a|PENDING|cp-1|op-1')
  })

  it('PENDING nunca vira "resultado" para o motorista (a rota dele trata null como PENDING), mas o staff enxerga PENDING', () => {
    const raw = encodeCommandResult(dono, 'PENDING')
    expect(decodeCommandResult(raw, 'user-a')).toBeNull()
    expect(decodeCommandStatusForStaff(raw, {})).toBe('PENDING')
  })

  it('staff ADMIN (escopo {}) vê o comando de qualquer operador', () => {
    expect(decodeCommandStatusForStaff(encodeCommandResult(dono, 'REJECTED'), {})).toBe('REJECTED')
  })

  it('staff OPERATOR só vê o do PRÓPRIO operador; de outro operador = null (indistinguível de inexistente)', () => {
    const raw = encodeCommandResult(dono, 'ACCEPTED')
    expect(decodeCommandStatusForStaff(raw, { operatorId: 'op-1' })).toBe('ACCEPTED')
    expect(decodeCommandStatusForStaff(raw, { operatorId: 'op-2' })).toBeNull()
    expect(decodeCommandStatusForStaff(null, { operatorId: 'op-1' })).toBeNull()
  })

  it('escopo com operatorId undefined (bug do chamador) falha FECHADO — não vira "ADMIN vê tudo"', () => {
    expect(decodeCommandStatusForStaff(encodeCommandResult(dono, 'ACCEPTED'), { operatorId: undefined })).toBeNull()
  })

  it('registro do formato ANTIGO (userId|status): o motorista dono ainda lê; OPERATOR nunca; ADMIN lê', () => {
    expect(decodeCommandResult('user-a|ACCEPTED', 'user-a')).toBe('ACCEPTED')
    expect(decodeCommandStatusForStaff('user-a|ACCEPTED', { operatorId: 'op-1' })).toBeNull()
    expect(decodeCommandStatusForStaff('user-a|ACCEPTED', {})).toBe('ACCEPTED')
  })

  it('malformado (partes demais/faltando, status desconhecido, campo vazio) -> null', () => {
    for (const raw of ['', 'lixo', 'user-a|ACCEPTED|cp-1', 'user-a|ACCEPTED|cp-1|op-1|extra', 'user-a|NADA|cp-1|op-1', 'user-a|ACCEPTED||op-1', 'user-a|ACCEPTED|cp-1|', '|ACCEPTED|cp-1|op-1']) {
      expect(decodeCommandRecord(raw), raw).toBeNull()
    }
  })
})

describe('política de recarga remota (DL4)', () => {
  it('no lote 1 só ADMIN inicia recarga remota; OPERATOR, DRIVER e papel ausente não', () => {
    expect(PAPEIS_QUE_PODEM_INICIAR_RECARGA_REMOTA).toEqual(['ADMIN'])
    expect(podeIniciarRecargaRemota('ADMIN')).toBe(true)
    expect(podeIniciarRecargaRemota('OPERATOR')).toBe(false)
    expect(podeIniciarRecargaRemota('DRIVER')).toBe(false)
    expect(podeIniciarRecargaRemota(undefined)).toBe(false)
    expect(podeIniciarRecargaRemota(null)).toBe(false)
    expect(podeIniciarRecargaRemota('admin')).toBe(false) // caixa exata: nunca "quase ADMIN"
  })
})
