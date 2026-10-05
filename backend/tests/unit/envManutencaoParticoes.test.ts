import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * N-11 — variáveis de partições/retenção em `lib/env.ts`. O módulo valida `process.env` UMA vez no import (e dá `process.exit(1)`),
 * então cada caso prepara o ambiente, zera o cache de módulos e importa de novo (mesma técnica de `envSessaoWatchdog.test.ts`).
 */

const VARS = ['PARTITION_AHEAD_MONTHS', 'PARTITION_MAINTENANCE_INTERVAL_MS', 'RETENTION_ENABLED', 'RETENTION_DRY_RUN', 'RETENTION_OCPP_MESSAGE_DAYS', 'RETENTION_METER_SAMPLE_DAYS', 'RETENTION_WEBHOOK_EVENT_DAYS'] as const
const original = { ...process.env }

beforeEach(() => {
  vi.resetModules()
  for (const k of VARS) delete process.env[k]
  process.env.DATABASE_URL = 'postgresql://x:y@localhost:5432/z'
  process.env.REDIS_URL = 'redis://localhost:6379'
  process.env.JWT_SECRET = 'segredo-de-teste-com-mais-de-32-caracteres-ok'
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const k of Object.keys(process.env)) if (!(k in original)) delete process.env[k]
  Object.assign(process.env, original)
})

async function carregar(vars: Record<string, string> = {}) {
  Object.assign(process.env, vars)
  vi.spyOn(process, 'exit').mockImplementation(((codigo?: number) => {
    throw new Error(`process.exit(${codigo})`)
  }) as never)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  return (await import('../../src/lib/env')).env
}

describe('N-11 — env de partições e retenção', () => {
  it('padrões: retenção DESLIGADA, dry-run desligado, 6 meses à frente, prazos do dono (DL6: 12 meses / 12 meses / 180 dias)', async () => {
    const env = await carregar()
    expect(env.RETENTION_ENABLED).toBe(false)
    expect(env.RETENTION_DRY_RUN).toBe(false)
    expect(env.PARTITION_AHEAD_MONTHS).toBe(6)
    expect(env.PARTITION_MAINTENANCE_INTERVAL_MS).toBe(86_400_000)
    expect(env.RETENTION_OCPP_MESSAGE_DAYS).toBe(365)
    expect(env.RETENTION_METER_SAMPLE_DAYS).toBe(365)
    expect(env.RETENTION_WEBHOOK_EVENT_DAYS).toBe(180)
  })

  it('"false"/"0" não ligam a retenção (envBoolean, não coerce.boolean); "true" liga', async () => {
    expect((await carregar({ RETENTION_ENABLED: 'false' })).RETENTION_ENABLED).toBe(false)
    vi.resetModules()
    expect((await carregar({ RETENTION_ENABLED: '0' })).RETENTION_ENABLED).toBe(false)
    vi.resetModules()
    expect((await carregar({ RETENTION_ENABLED: 'true', RETENTION_DRY_RUN: 'true' })).RETENTION_DRY_RUN).toBe(true)
  })

  it.each([
    ['RETENTION_OCPP_MESSAGE_DAYS', '7'],
    ['RETENTION_METER_SAMPLE_DAYS', '0'],
    ['RETENTION_WEBHOOK_EVENT_DAYS', '-1'],
    ['PARTITION_AHEAD_MONTHS', '1'],
    ['RETENTION_ENABLED', 'talvez'],
  ])('%s=%s é recusado no boot (piso de 30 dias / mínimo de 3 meses; não adivinha booleano)', async (nome, valor) => {
    await expect(carregar({ [nome]: valor })).rejects.toThrow(/process\.exit\(1\)/)
  })
})
