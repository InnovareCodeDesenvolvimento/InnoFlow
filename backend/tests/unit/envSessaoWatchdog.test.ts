import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONFIG_WATCHDOG_PADRAO } from '../../src/core/sessao/avaliarSessaoAberta'

/**
 * F5.9b0 — as variáveis do watchdog de sessão em `lib/env.ts`. O módulo valida `process.env` UMA vez no import (e dá `process.exit(1)`
 * em configuração inválida), então cada caso prepara o ambiente, zera o cache de módulos e importa de novo; `process.exit` vira exceção.
 */

const VARS_SESSAO = [
  'SESSION_WATCHDOG_ENABLED',
  'SESSION_WATCHDOG_INTERVAL_MS',
  'SESSION_WATCHDOG_BATCH_SIZE',
  'SESSION_CHARGER_OFFLINE_MINUTES',
  'SESSION_INACTIVITY_MINUTES',
  'SESSION_CONNECTOR_IDLE_MINUTES',
  'SESSION_STOP_CONFIRM_MINUTES',
  'SESSION_STOP_MAX_ATTEMPTS',
  'SESSION_METER_TRIGGER_COOLDOWN_MINUTES',
  'SESSION_MAX_OPEN_HOURS',
  'SESSION_UNCONFIRMED_GRACE_ONLINE_MINUTES',
  'SESSION_UNCONFIRMED_GRACE_OFFLINE_MINUTES',
  'CARD_SESSION_MAX_HOLD_HOURS',
  'SESSION_NO_READING_POLICY',
  'SESSION_ALLOW_START_WHILE_UNCONFIRMED',
] as const

const original = { ...process.env }

beforeEach(() => {
  vi.resetModules()
  for (const k of VARS_SESSAO) delete process.env[k]
  // Obrigatórias do schema (sem default de propósito).
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
  const sairam: unknown[] = []
  vi.spyOn(process, 'exit').mockImplementation(((codigo?: number) => {
    sairam.push(codigo)
    throw new Error(`process.exit(${codigo})`)
  }) as never)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const aviso = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const { env } = await import('../../src/lib/env')
  return { env, aviso, sairam }
}

async function recusa(vars: Record<string, string>): Promise<void> {
  await expect(carregar(vars)).rejects.toThrow(/process\.exit\(1\)/)
}

describe('defaults — nenhum campo novo é obrigatório (campo novo sem default derrubaria os 3 entrypoints no boot)', () => {
  it('sem nenhuma variável SESSION_* o boot passa e traz os defaults recomendados', async () => {
    const { env } = await carregar()
    expect({
      SESSION_WATCHDOG_INTERVAL_MS: env.SESSION_WATCHDOG_INTERVAL_MS,
      SESSION_WATCHDOG_BATCH_SIZE: env.SESSION_WATCHDOG_BATCH_SIZE,
      SESSION_CHARGER_OFFLINE_MINUTES: env.SESSION_CHARGER_OFFLINE_MINUTES,
      SESSION_INACTIVITY_MINUTES: env.SESSION_INACTIVITY_MINUTES,
      SESSION_CONNECTOR_IDLE_MINUTES: env.SESSION_CONNECTOR_IDLE_MINUTES,
      SESSION_STOP_CONFIRM_MINUTES: env.SESSION_STOP_CONFIRM_MINUTES,
      SESSION_STOP_MAX_ATTEMPTS: env.SESSION_STOP_MAX_ATTEMPTS,
      SESSION_METER_TRIGGER_COOLDOWN_MINUTES: env.SESSION_METER_TRIGGER_COOLDOWN_MINUTES,
      SESSION_MAX_OPEN_HOURS: env.SESSION_MAX_OPEN_HOURS,
      SESSION_UNCONFIRMED_GRACE_ONLINE_MINUTES: env.SESSION_UNCONFIRMED_GRACE_ONLINE_MINUTES,
      SESSION_UNCONFIRMED_GRACE_OFFLINE_MINUTES: env.SESSION_UNCONFIRMED_GRACE_OFFLINE_MINUTES,
      CARD_SESSION_MAX_HOLD_HOURS: env.CARD_SESSION_MAX_HOLD_HOURS,
      SESSION_NO_READING_POLICY: env.SESSION_NO_READING_POLICY,
      SESSION_ALLOW_START_WHILE_UNCONFIRMED: env.SESSION_ALLOW_START_WHILE_UNCONFIRMED,
    }).toEqual({
      SESSION_WATCHDOG_INTERVAL_MS: 60_000,
      SESSION_WATCHDOG_BATCH_SIZE: 100,
      SESSION_CHARGER_OFFLINE_MINUTES: 10,
      SESSION_INACTIVITY_MINUTES: 15,
      SESSION_CONNECTOR_IDLE_MINUTES: 5,
      SESSION_STOP_CONFIRM_MINUTES: 5,
      SESSION_STOP_MAX_ATTEMPTS: 3,
      SESSION_METER_TRIGGER_COOLDOWN_MINUTES: 15,
      SESSION_MAX_OPEN_HOURS: 24,
      SESSION_UNCONFIRMED_GRACE_ONLINE_MINUTES: 10,
      SESSION_UNCONFIRMED_GRACE_OFFLINE_MINUTES: 120,
      CARD_SESSION_MAX_HOLD_HOURS: 48,
      SESSION_NO_READING_POLICY: 'NO_CHARGE', // D2a (recomendação da Nova)
      SESSION_ALLOW_START_WHILE_UNCONFIRMED: true, // D7a (recomendação da Nova)
    })
  })

  it('os defaults do env BATEM com CONFIG_WATCHDOG_PADRAO do core (duas fontes da verdade não podem divergir)', async () => {
    const { env } = await carregar()
    expect({
      watchdogIntervalMs: env.SESSION_WATCHDOG_INTERVAL_MS,
      chargerOfflineMinutes: env.SESSION_CHARGER_OFFLINE_MINUTES,
      inactivityMinutes: env.SESSION_INACTIVITY_MINUTES,
      connectorIdleMinutes: env.SESSION_CONNECTOR_IDLE_MINUTES,
      stopConfirmMinutes: env.SESSION_STOP_CONFIRM_MINUTES,
      stopMaxAttempts: env.SESSION_STOP_MAX_ATTEMPTS,
      maxOpenHours: env.SESSION_MAX_OPEN_HOURS,
      unconfirmedGraceOnlineMinutes: env.SESSION_UNCONFIRMED_GRACE_ONLINE_MINUTES,
      unconfirmedGraceOfflineMinutes: env.SESSION_UNCONFIRMED_GRACE_OFFLINE_MINUTES,
      cardMaxHoldHours: env.CARD_SESSION_MAX_HOLD_HOURS,
      meterTriggerCooldownMinutes: env.SESSION_METER_TRIGGER_COOLDOWN_MINUTES,
      noReadingPolicy: env.SESSION_NO_READING_POLICY,
    }).toEqual(CONFIG_WATCHDOG_PADRAO)
  })

  it('strings vazias (variável declarada sem valor, como no .env.example descomentado) usam o default nas duas chaves de decisão do dono', async () => {
    const { env } = await carregar({ SESSION_NO_READING_POLICY: '', SESSION_ALLOW_START_WHILE_UNCONFIRMED: '' })
    expect(env.SESSION_NO_READING_POLICY).toBe('NO_CHARGE')
    expect(env.SESSION_ALLOW_START_WHILE_UNCONFIRMED).toBe(true)
  })
})

describe('kill-switch do watchdog (M4 do Órion)', () => {
  it('SESSION_WATCHDOG_ENABLED nasce FALSE (default seguro do 1º deploy) e aceita true/1/yes/on e false/0/no/off', async () => {
    expect((await carregar()).env.SESSION_WATCHDOG_ENABLED).toBe(false)
    for (const v of ['true', '1', 'yes', 'on', 'TRUE']) {
      vi.resetModules()
      expect((await carregar({ SESSION_WATCHDOG_ENABLED: v })).env.SESSION_WATCHDOG_ENABLED, v).toBe(true)
    }
    for (const v of ['false', '0', 'no', 'off', '']) {
      vi.resetModules()
      expect((await carregar({ SESSION_WATCHDOG_ENABLED: v })).env.SESSION_WATCHDOG_ENABLED, v).toBe(false)
    }
  })

  it('valor que não é booleano derruba o boot (não adivinhamos se o watchdog está ligado)', async () => {
    await recusa({ SESSION_WATCHDOG_ENABLED: 'talvez' })
  })
})

describe('valores informados', () => {
  it('numéricos viram number', async () => {
    const { env } = await carregar({
      SESSION_WATCHDOG_INTERVAL_MS: '30000',
      SESSION_UNCONFIRMED_GRACE_OFFLINE_MINUTES: '240',
      CARD_SESSION_MAX_HOLD_HOURS: '72',
      SESSION_STOP_MAX_ATTEMPTS: '5',
    })
    expect(env.SESSION_WATCHDOG_INTERVAL_MS).toBe(30_000)
    expect(env.SESSION_UNCONFIRMED_GRACE_OFFLINE_MINUTES).toBe(240)
    expect(env.CARD_SESSION_MAX_HOLD_HOURS).toBe(72)
    expect(env.SESSION_STOP_MAX_ATTEMPTS).toBe(5)
  })

  it.each([
    ['MIN_FEE', 'MIN_FEE'],
    ['min_fee', 'MIN_FEE'],
    ['  Min_Fee  ', 'MIN_FEE'],
    ['NO_CHARGE', 'NO_CHARGE'],
    ['no_charge', 'NO_CHARGE'],
  ])('SESSION_NO_READING_POLICY=%j => %s (aceita caixa e espaços)', async (entradaTexto, esperado) => {
    const { env } = await carregar({ SESSION_NO_READING_POLICY: entradaTexto })
    expect(env.SESSION_NO_READING_POLICY).toBe(esperado)
  })

  it.each([
    ['false', false],
    ['0', false],
    ['off', false],
    ['no', false],
    ['FALSE', false],
    ['true', true],
    ['1', true],
    ['on', true],
  ])('SESSION_ALLOW_START_WHILE_UNCONFIRMED=%j => %s (envBoolean: "false" NÃO vira true)', async (texto, esperado) => {
    const { env } = await carregar({ SESSION_ALLOW_START_WHILE_UNCONFIRMED: texto })
    expect(env.SESSION_ALLOW_START_WHILE_UNCONFIRMED).toBe(esperado)
  })
})

describe('valores inválidos derrubam o boot (não adivinhamos política de cobrança nem janela)', () => {
  it.each(['TALVEZ', 'NONE', 'cobrar', 'NO-CHARGE'])('SESSION_NO_READING_POLICY=%j', async (v) => recusa({ SESSION_NO_READING_POLICY: v }))
  it.each(['talvez', 'sim', '2'])('SESSION_ALLOW_START_WHILE_UNCONFIRMED=%j', async (v) => recusa({ SESSION_ALLOW_START_WHILE_UNCONFIRMED: v }))

  it.each(VARS_SESSAO.filter((k) => k !== 'SESSION_NO_READING_POLICY' && k !== 'SESSION_ALLOW_START_WHILE_UNCONFIRMED' && k !== 'SESSION_WATCHDOG_ENABLED'))(
    '%s recusa 0, negativo, decimal e texto',
    async (nome) => {
      for (const ruim of ['0', '-1', '1.5', 'abc']) {
        vi.resetModules()
        await recusa({ [nome]: ruim })
      }
    },
  )
})

describe('coerência entre campos', () => {
  it('hold do cartão MENOR que a duração máxima: o boot passa, mas AVISA (o prazo do cartão passaria a mandar)', async () => {
    const { aviso } = await carregar({ CARD_SESSION_MAX_HOLD_HOURS: '12', SESSION_MAX_OPEN_HOURS: '24' })
    expect(aviso.mock.calls.some(([m]) => String(m).includes('CARD_SESSION_MAX_HOLD_HOURS'))).toBe(true)
  })

  it('hold igual ou maior (inclusive o default 48 > 24): sem aviso', async () => {
    const padrao = await carregar()
    expect(padrao.aviso.mock.calls.some(([m]) => String(m).includes('CARD_SESSION_MAX_HOLD_HOURS'))).toBe(false)
    vi.resetModules()
    const igual = await carregar({ CARD_SESSION_MAX_HOLD_HOURS: '24', SESSION_MAX_OPEN_HOURS: '24' })
    expect(igual.aviso.mock.calls.some(([m]) => String(m).includes('CARD_SESSION_MAX_HOLD_HOURS'))).toBe(false)
  })
})
