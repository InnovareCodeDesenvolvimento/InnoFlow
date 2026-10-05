import { describe, expect, it } from 'vitest'
import { calcularMudancaDePerfil, mascararCpf } from '../../src/core/perfil/perfilMotorista'
import { updateMeProfileSchema } from '../../src/api/schemas/meProfile.schema'

describe('mascararCpf (L1.2)', () => {
  it('mostra só os dígitos 4 a 9: ***.456.789-**', () => {
    expect(mascararCpf('12345678909')).toBe('***.456.789-**')
  })
  it('ausente ou fora do formato -> null (nunca devolve pedaço de lixo)', () => {
    expect(mascararCpf(null)).toBeNull()
    expect(mascararCpf(undefined)).toBeNull()
    expect(mascararCpf('')).toBeNull()
    expect(mascararCpf('123')).toBeNull()
    expect(mascararCpf('123.456.789-09')).toBeNull()
  })
})

describe('calcularMudancaDePerfil', () => {
  const atual = { name: 'Ana', phone: '11999999999', cpf: null as string | null }

  it('só entram os campos que MUDAM; ausente = não mexer; null = apagar', () => {
    expect(calcularMudancaDePerfil(atual, { name: 'Ana', phone: null })).toEqual({ dados: { phone: null }, camposAlterados: ['phone'] })
    expect(calcularMudancaDePerfil(atual, { name: 'Ana Maria' })).toEqual({ dados: { name: 'Ana Maria' }, camposAlterados: ['name'] })
  })
  it('pedido idêntico ao gravado não muda nada (nada a gravar nem auditar)', () => {
    expect(calcularMudancaDePerfil(atual, { name: 'Ana', phone: '11999999999', cpf: null })).toEqual({ dados: {}, camposAlterados: [] })
    expect(calcularMudancaDePerfil(atual, {})).toEqual({ dados: {}, camposAlterados: [] })
  })
})

describe('updateMeProfileSchema', () => {
  it('normaliza: nome aparado, CPF só com dígitos', () => {
    const r = updateMeProfileSchema.parse({ name: '  Ana  ', cpf: '529.982.247-25', phone: ' (11) 91234-5678 ' })
    expect(r).toEqual({ name: 'Ana', cpf: '52998224725', phone: '(11) 91234-5678' })
  })
  it('estrito: e-mail, userId, role e desconhecidos são recusados', () => {
    for (const extra of [{ email: 'a@b.co' }, { userId: 'x' }, { role: 'ADMIN' }, { googleSub: 'g' }]) {
      expect(updateMeProfileSchema.safeParse({ name: 'Ana', ...extra }).success).toBe(false)
    }
  })
  it('exige ao menos um campo; null só em phone/cpf (nome não apaga)', () => {
    expect(updateMeProfileSchema.safeParse({}).success).toBe(false)
    expect(updateMeProfileSchema.safeParse({ phone: null }).success).toBe(true)
    expect(updateMeProfileSchema.safeParse({ cpf: null }).success).toBe(true)
    expect(updateMeProfileSchema.safeParse({ name: null }).success).toBe(false)
  })
  it('CPF inválido e telefone com letras/curto são recusados', () => {
    expect(updateMeProfileSchema.safeParse({ cpf: '12345678900' }).success).toBe(false)
    expect(updateMeProfileSchema.safeParse({ cpf: '11111111111' }).success).toBe(false)
    expect(updateMeProfileSchema.safeParse({ phone: 'telefone' }).success).toBe(false)
    expect(updateMeProfileSchema.safeParse({ phone: '12345' }).success).toBe(false)
  })
})
