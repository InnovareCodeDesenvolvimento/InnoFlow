import { afterAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/api/app'
import { env } from '../../src/lib/env'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'

/**
 * CORS: `exposedHeaders: ['Retry-After']` (pedido das Lyras — o front lê o tempo de espera do 429 entre domínios). O teste prova DUAS coisas: (1) o cabeçalho passa a ser exposto,
 * inclusive num 429 REAL do rate limit de login; (2) NADA mais foi afrouxado — a allowlist de origens segue fail-closed e não há credenciais/curinga.
 */
describe('CORS expõe Retry-After sem afrouxar o resto', () => {
  const app = createApp()
  const ORIGEM_OK = env.CORS_ALLOWED_ORIGINS[0]!
  const ORIGEM_ESTRANHA = 'https://site-qualquer.example'

  afterAll(async () => {
    await prisma.$disconnect()
    redis.disconnect()
  })

  it('a allowlist de teste tem ao menos uma origem (premissa dos testes abaixo)', () => {
    expect(ORIGEM_OK).toBeTruthy()
    expect(env.CORS_ALLOWED_ORIGINS).not.toContain(ORIGEM_ESTRANHA)
  })

  it('resposta a origem PERMITIDA: Access-Control-Expose-Headers = Retry-After (e só ele), origem ecoada, sem curinga e sem credenciais', async () => {
    const res = await request(app).get('/health').set('Origin', ORIGEM_OK)
    expect(res.headers['access-control-expose-headers']).toBe('Retry-After')
    expect(res.headers['access-control-allow-origin']).toBe(ORIGEM_OK) // ecoa a origem da allowlist, nunca '*'
    expect(res.headers['access-control-allow-credentials']).toBeUndefined() // não passou a aceitar credenciais
  })

  it('origem FORA da allowlist continua bloqueada (403 CORS_FORBIDDEN), sem Allow-Origin nem Expose-Headers vazando', async () => {
    const res = await request(app).get('/health').set('Origin', ORIGEM_ESTRANHA)
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('CORS_FORBIDDEN')
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
    expect(res.headers['access-control-expose-headers']).toBeUndefined()
  })

  it('preflight: métodos e origem inalterados (padrão do `cors`), sem Allow-Credentials', async () => {
    const res = await request(app).options('/api/auth/login').set('Origin', ORIGEM_OK).set('Access-Control-Request-Method', 'POST')
    expect(res.status).toBe(204)
    expect(res.headers['access-control-allow-origin']).toBe(ORIGEM_OK)
    expect(res.headers['access-control-allow-methods']).toBe('GET,HEAD,PUT,PATCH,POST,DELETE')
    expect(res.headers['access-control-allow-credentials']).toBeUndefined()
  })

  it('429 REAL do rate limit de login: traz Retry-After no corpo da resposta E o Expose-Headers que o torna legível entre domínios', async () => {
    // Corpo inválido => 400 antes de qualquer banco; o limiter de login conta respostas >= 400 (20 por 15 min por IP) — a 21ª é 429.
    let ultima = await request(app).post('/api/auth/login').set('Origin', ORIGEM_OK).send({})
    for (let i = 0; i < 20; i++) ultima = await request(app).post('/api/auth/login').set('Origin', ORIGEM_OK).send({})
    expect(ultima.status).toBe(429)
    expect(ultima.body.code).toBe('RATE_LIMITED_AUTH')
    expect(Number(ultima.headers['retry-after'])).toBeGreaterThan(0)
    expect(ultima.headers['access-control-expose-headers']).toBe('Retry-After')
    expect(ultima.headers['access-control-allow-origin']).toBe(ORIGEM_OK)
  })
})
