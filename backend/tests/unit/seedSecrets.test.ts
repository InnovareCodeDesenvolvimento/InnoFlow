import { describe, expect, it } from 'vitest'
import { resolveSeedSecret } from '../../prisma/seedSecrets'

const ADMIN = { envName: 'SEED_ADMIN_PASSWORD', devDefault: 'admin123456', minLength: 12 }
const CP = { envName: 'SEED_CHARGEPOINT_SECRET', devDefault: 'changeme-basic-auth-secret', minLength: 16, maxLength: 40 }

describe('resolveSeedSecret (Órion C1: seed sem senha fixa)', () => {
  it('PRODUÇÃO sem env: PULA — nunca cai no default admin123456', () => {
    const r = resolveSeedSecret(ADMIN, {}, true)
    expect(r.status).toBe('skipped')
    expect(JSON.stringify(r)).not.toContain('admin123456')
  })

  it('PRODUÇÃO com env vazia ("") também pula (é como o EasyPanel guarda env em branco)', () => {
    expect(resolveSeedSecret(ADMIN, { SEED_ADMIN_PASSWORD: '' }, true).status).toBe('skipped')
  })

  it('PRODUÇÃO com env válida: usa a env', () => {
    expect(resolveSeedSecret(ADMIN, { SEED_ADMIN_PASSWORD: 'AdminForte#2026xx' }, true)).toEqual({ status: 'ok', value: 'AdminForte#2026xx', source: 'env' })
  })

  it('env curta demais -> pula (produção E dev: uma credencial fraca por env não vira default silencioso)', () => {
    expect(resolveSeedSecret(ADMIN, { SEED_ADMIN_PASSWORD: 'curta' }, true).status).toBe('skipped')
    expect(resolveSeedSecret(ADMIN, { SEED_ADMIN_PASSWORD: 'curta' }, false).status).toBe('skipped')
  })

  it('env com um valor CONHECIDO do seed antigo é recusada (não adianta "definir" admin123456)', () => {
    expect(resolveSeedSecret(ADMIN, { SEED_ADMIN_PASSWORD: 'admin123456' }, true).status).toBe('skipped')
    expect(resolveSeedSecret(CP, { SEED_CHARGEPOINT_SECRET: 'changeme-basic-auth-secret' }, true).status).toBe('skipped')
  })

  it('segredo do carregador: 16..40 caracteres', () => {
    expect(resolveSeedSecret(CP, { SEED_CHARGEPOINT_SECRET: 'a'.repeat(15) }, true).status).toBe('skipped')
    expect(resolveSeedSecret(CP, { SEED_CHARGEPOINT_SECRET: 'a'.repeat(16) }, true).status).toBe('ok')
    expect(resolveSeedSecret(CP, { SEED_CHARGEPOINT_SECRET: 'a'.repeat(40) }, true).status).toBe('ok')
    expect(resolveSeedSecret(CP, { SEED_CHARGEPOINT_SECRET: 'a'.repeat(41) }, true).status).toBe('skipped')
  })

  it('DEV sem env: usa o default de dev (conveniência local), marcando a origem', () => {
    expect(resolveSeedSecret(ADMIN, {}, false)).toEqual({ status: 'ok', value: 'admin123456', source: 'dev-default' })
  })

  it('DEV com env válida: a env vence o default', () => {
    expect(resolveSeedSecret(ADMIN, { SEED_ADMIN_PASSWORD: 'OutraSenhaForte99' }, false)).toEqual({ status: 'ok', value: 'OutraSenhaForte99', source: 'env' })
  })

  it('a mensagem de "pulado" nunca inclui o valor recebido', () => {
    const r = resolveSeedSecret(ADMIN, { SEED_ADMIN_PASSWORD: 'curta-seg' }, true)
    expect(r.status).toBe('skipped')
    expect(JSON.stringify(r)).not.toContain('curta-seg')
  })
})
