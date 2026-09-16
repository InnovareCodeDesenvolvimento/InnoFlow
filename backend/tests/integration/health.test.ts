import { describe, expect, it, afterAll } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'

/**
 * Integração de verdade: sobe o app e bate no /health contra Postgres e
 * Redis reais (CI usa o serviço postgres do workflow + um Redis local — ver
 * .github/workflows/ci.yml). Este é o teste que prova o portão de saída da
 * Fase 0: "o backend consegue conectar em Postgres e Redis".
 */
describe('GET /health', () => {
  afterAll(async () => {
    await prisma.$disconnect()
    redis.disconnect()
  })

  it('responde 200 com os dois checks ok quando Postgres e Redis estão de pé', async () => {
    const app = createApp()
    const res = await request(app).get('/health')

    expect(res.body).toEqual({
      status: 'ok',
      checks: { postgres: true, redis: true },
    })
    expect(res.status).toBe(200)
  })
})
