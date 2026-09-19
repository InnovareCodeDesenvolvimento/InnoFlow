import { describe, expect, it } from 'vitest'
import { avaliarSessao, tokenExpirado, type UsuarioParaSessao } from '../../src/core/auth/sessaoValida'
import { createSessionValidator } from '../../src/api/lib/sessionValidator'
import { changePasswordSchema } from '../../src/api/schemas/auth.schema'

const user = (over: Partial<UsuarioParaSessao> = {}): UsuarioParaSessao => ({ active: true, role: 'DRIVER', operatorId: null, sessionsValidAfter: null, ...over })
const token = (over: { iat?: number; role?: 'ADMIN' | 'OPERATOR' | 'DRIVER'; operatorId?: string | null } = {}) => ({ role: 'DRIVER' as const, operatorId: null, iat: 1_000, ...over })

describe('avaliarSessao', () => {
  it('usuário ativo, mesmo papel, sem revogação -> ok', () => {
    expect(avaliarSessao(token(), user())).toEqual({ ok: true })
  })

  it('usuário inexistente -> recusa', () => {
    expect(avaliarSessao(token(), null)).toEqual({ ok: false, reason: 'USER_NOT_FOUND' })
  })

  it('conta DESATIVADA corta o token de 12h (o buraco do Órion M1)', () => {
    expect(avaliarSessao(token(), user({ active: false }))).toEqual({ ok: false, reason: 'INACTIVE' })
  })

  it('token emitido ANTES de sessionsValidAfter (troca de senha / vínculo Google) -> revogado', () => {
    const cutoff = new Date(2_000 * 1000)
    expect(avaliarSessao(token({ iat: 1_999 }), user({ sessionsValidAfter: cutoff }))).toEqual({ ok: false, reason: 'REVOKED' })
  })

  it('token emitido DEPOIS de sessionsValidAfter -> ok', () => {
    expect(avaliarSessao(token({ iat: 2_001 }), user({ sessionsValidAfter: new Date(2_000 * 1000) }))).toEqual({ ok: true })
  })

  it('MESMO segundo do bump: o token NOVO (iat truncado em segundos) NÃO é recusado pela troca de senha que o emitiu', () => {
    // sessionsValidAfter = 2000.500s; o token novo sai no mesmo segundo -> iat = 2000 (JWT trunca).
    expect(avaliarSessao(token({ iat: 2_000 }), user({ sessionsValidAfter: new Date(2_000_500) }))).toEqual({ ok: true })
  })

  it('revogação registrada + token sem iat -> fail-closed', () => {
    expect(avaliarSessao({ role: 'DRIVER', operatorId: null }, user({ sessionsValidAfter: new Date(1_000) }))).toEqual({ ok: false, reason: 'REVOKED' })
  })

  it('sem revogação registrada, token sem iat continua valendo (não inventa revogação)', () => {
    expect(avaliarSessao({ role: 'DRIVER', operatorId: null }, user())).toEqual({ ok: true })
  })

  it('papel mudou depois da emissão (staff rebaixado) -> recusa: o token carrega privilégio velho', () => {
    expect(avaliarSessao(token({ role: 'ADMIN' }), user({ role: 'DRIVER' }))).toEqual({ ok: false, reason: 'PRIVILEGES_CHANGED' })
    expect(avaliarSessao(token({ role: 'OPERATOR', operatorId: 'op-1' }), user({ role: 'OPERATOR', operatorId: 'op-2' }))).toEqual({ ok: false, reason: 'PRIVILEGES_CHANGED' })
  })

  it('operatorId ausente no token == null no banco (não é "mudança")', () => {
    expect(avaliarSessao({ role: 'ADMIN', iat: 1 }, user({ role: 'ADMIN', operatorId: null }))).toEqual({ ok: true })
  })
})

describe('tokenExpirado', () => {
  it('exp no futuro -> não expirado; no passado/igual -> expirado; sem exp -> não expirado', () => {
    expect(tokenExpirado(2_000, 1_999_000)).toBe(false)
    expect(tokenExpirado(2_000, 2_000_000)).toBe(true)
    expect(tokenExpirado(2_000, 3_000_000)).toBe(true)
    expect(tokenExpirado(undefined, 9e15)).toBe(false)
  })
})

describe('createSessionValidator (cache de ~30s)', () => {
  function setup() {
    let nowMs = 1_000_000
    let row: UsuarioParaSessao | null = user()
    let loads = 0
    const validator = createSessionValidator({
      load: async () => {
        loads++
        return row
      },
      now: () => nowMs,
      ttlMs: 30_000,
    })
    return {
      validator,
      loads: () => loads,
      advance: (ms: number) => {
        nowMs += ms
      },
      setRow: (r: UsuarioParaSessao | null) => {
        row = r
      },
    }
  }

  it('requests dentro do TTL NÃO voltam ao banco', async () => {
    const t = setup()
    await t.validator.validate('u1', token())
    await t.validator.validate('u1', token())
    await t.validator.validate('u1', token())
    expect(t.loads()).toBe(1)
  })

  it('TRADE-OFF: desativar a conta só vale depois do TTL (até 30s) — mas VALE', async () => {
    const t = setup()
    expect((await t.validator.validate('u1', token())).ok).toBe(true)

    t.setRow(user({ active: false }))
    t.advance(10_000)
    expect((await t.validator.validate('u1', token())).ok).toBe(true) // ainda no cache

    t.advance(21_000) // passou de 30s
    expect(await t.validator.validate('u1', token())).toEqual({ ok: false, reason: 'INACTIVE' })
  })

  it('invalidate() derruba o cache NA HORA (troca de senha / vínculo Google no mesmo processo)', async () => {
    const t = setup()
    await t.validator.validate('u1', token())
    t.setRow(user({ sessionsValidAfter: new Date(9_999_999_000) }))
    t.validator.invalidate('u1')
    expect(await t.validator.validate('u1', token({ iat: 5 }))).toEqual({ ok: false, reason: 'REVOKED' })
    expect(t.loads()).toBe(2)
  })

  it('usuários diferentes têm entradas independentes', async () => {
    const t = setup()
    await t.validator.validate('u1', token())
    await t.validator.validate('u2', token())
    expect(t.loads()).toBe(2)
  })

  it('rajada simultânea no vencimento = UMA consulta (sem thundering herd)', async () => {
    const t = setup()
    await Promise.all(Array.from({ length: 20 }, () => t.validator.validate('u1', token())))
    expect(t.loads()).toBe(1)
  })

  it('falha do banco propaga (fail-closed) e NÃO fica cacheada', async () => {
    let fail = true
    const validator = createSessionValidator({
      load: async () => {
        if (fail) throw new Error('db fora')
        return user()
      },
    })
    await expect(validator.validate('u1', token())).rejects.toThrow('db fora')
    fail = false
    expect((await validator.validate('u1', token())).ok).toBe(true)
  })

  it('teto de entradas: passou do limite, limpa em vez de crescer sem fim', async () => {
    let loads = 0
    const validator = createSessionValidator({
      load: async () => {
        loads++
        return user()
      },
      maxEntries: 3,
    })
    for (const id of ['a', 'b', 'c', 'd']) await validator.validate(id, token())
    await validator.validate('a', token()) // 'a' foi limpo quando 'd' entrou
    expect(loads).toBe(5)
  })
})

describe('changePasswordSchema', () => {
  it('aceita senha de 10+ caracteres; currentPassword é opcional (conta só-Google)', () => {
    expect(changePasswordSchema.safeParse({ newPassword: 'abcdefghij' }).success).toBe(true)
    expect(changePasswordSchema.safeParse({ currentPassword: 'x', newPassword: 'abcdefghij' }).success).toBe(true)
  })

  it('recusa menos de 10 caracteres', () => {
    expect(changePasswordSchema.safeParse({ newPassword: 'curta123' }).success).toBe(false)
  })

  it('recusa mais de 72 BYTES (o bcrypt trunca em silêncio) — inclusive multibyte', () => {
    expect(changePasswordSchema.safeParse({ newPassword: 'a'.repeat(72) }).success).toBe(true)
    expect(changePasswordSchema.safeParse({ newPassword: 'a'.repeat(73) }).success).toBe(false)
    expect(changePasswordSchema.safeParse({ newPassword: 'ç'.repeat(40) }).success).toBe(false) // 40 chars = 80 bytes
  })

  it('newPassword é obrigatória', () => {
    expect(changePasswordSchema.safeParse({}).success).toBe(false)
  })
})
