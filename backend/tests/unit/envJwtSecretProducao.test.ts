import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * N-12 (Órion, 05/10/2026) — em PRODUÇÃO `JWT_SECRET` < 32 caracteres derruba o boot (fail-closed); fora de produção continua só avisando.
 * `lib/env.ts` valida `process.env` UMA vez no import (e dá `process.exit(1)`), então cada caso prepara o ambiente, zera o cache de módulos
 * e importa de novo; `process.exit` vira exceção (mesma técnica de `envSessaoWatchdog.test.ts`).
 */

const original = { ...process.env }

beforeEach(() => {
  vi.resetModules()
  process.env.DATABASE_URL = 'postgresql://x:y@localhost:5432/z'
  process.env.REDIS_URL = 'redis://localhost:6379'
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const k of Object.keys(process.env)) if (!(k in original)) delete process.env[k]
  Object.assign(process.env, original)
})

async function carregar(vars: Record<string, string>) {
  Object.assign(process.env, vars)
  const sairam: unknown[] = []
  vi.spyOn(process, 'exit').mockImplementation(((codigo?: number) => {
    sairam.push(codigo)
    throw new Error(`process.exit(${codigo})`)
  }) as never)
  const erros = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const avisos = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  let env: { JWT_SECRET: string } | undefined
  let caiu = false
  try {
    env = (await import('../../src/lib/env')).env
  } catch {
    caiu = true // o process.exit mockado lançou
  }
  return { env, caiu, erros, avisos, sairam }
}

const segredo = (n: number) => 'k'.repeat(n)

describe('N-12 — JWT_SECRET em produção', () => {
  it.each([16, 20, 31])('production com %i caracteres: o boot NÃO sobe (exit 1) e a mensagem diz o mínimo, sem imprimir o segredo', async (n) => {
    const secret = segredo(n)
    const { caiu, sairam, erros } = await carregar({ NODE_ENV: 'production', JWT_SECRET: secret })
    expect(caiu).toBe(true)
    expect(sairam).toEqual([1])
    const texto = erros.mock.calls.map((c) => c.join(' ')).join(' | ')
    expect(texto).toContain('JWT_SECRET')
    expect(texto).toContain('>= 32')
    expect(texto).not.toContain(secret)
  })

  it.each([32, 48, 64])('production com %i caracteres: sobe, sem aviso de JWT_SECRET', async (n) => {
    const { env, avisos, sairam } = await carregar({ NODE_ENV: 'production', JWT_SECRET: segredo(n) })
    expect(env?.JWT_SECRET).toHaveLength(n)
    expect(sairam).toEqual([])
    expect(avisos.mock.calls.flat().join(' ')).not.toContain('JWT_SECRET')
  })

  it('production com JWT_SECRET abaixo do mínimo do schema (< 16) também não sobe', async () => {
    const { caiu, sairam } = await carregar({ NODE_ENV: 'production', JWT_SECRET: segredo(8) })
    expect(caiu).toBe(true)
    expect(sairam).toEqual([1])
  })

  it.each(['development', 'test'])('NODE_ENV=%s com 20 caracteres: continua subindo, só AVISA (não quebra dev/CI)', async (nodeEnv) => {
    const { env, avisos, sairam } = await carregar({ NODE_ENV: nodeEnv, JWT_SECRET: segredo(20) })
    expect(env?.JWT_SECRET).toHaveLength(20)
    expect(sairam).toEqual([])
    const texto = avisos.mock.calls.flat().join(' ')
    expect(texto).toContain('JWT_SECRET tem 20 caracteres')
    expect(texto).toContain('recomendado >= 32')
  })

  it('o segredo de dev do docker-compose / .env.example (que o dev local usa) tem >= 32 e sobe em qualquer ambiente', async () => {
    const dev = 'dev-only-troque-isto-por-um-segredo-forte-de-verdade'
    expect(dev.length).toBeGreaterThanOrEqual(32)
    const { sairam } = await carregar({ NODE_ENV: 'production', JWT_SECRET: dev })
    expect(sairam).toEqual([])
  })
})
