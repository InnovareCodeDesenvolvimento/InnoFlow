import { Writable } from 'node:stream'
import express from 'express'
import pino from 'pino'
import pinoHttp from 'pino-http'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { LOG_SERIALIZERS, mascararHeadersSensiveis, nomeDeHeaderEhSensivel, serializarReq } from '../../src/lib/logSerializers'

/**
 * Achado da Íris: o `redact` do pino só casa NOMES EXATOS de header. O segredo do webhook da Cielo enviado sob um nome FORA da lista (ex.: o nome antigo
 * `x-innoelektron-webhook-secret`, ou outro que o dono cadastre no Site Cielo) saía em claro no log do pino-http. O `serializarReq` agora mascara por PADRÃO DE NOME
 * (secret|token|key|auth|cookie|passw|senha|signature|credential) — a redação não depende mais do nome exato.
 */
describe('headers sensíveis mascarados por padrão de nome (não pela lista exata do redact)', () => {
  it('nomeDeHeaderEhSensivel: pega variações de nome; deixa passar os headers comuns', () => {
    for (const nome of ['x-innoelektron-webhook-secret', 'InnoFlowWebhookSecret', 'X-Qualquer-Coisa-Secret', 'x-api-key', 'merchantkey', 'x-auth-token', 'Authorization', 'proxy-authorization', 'Cookie', 'x-csrf-token', 'x-signature', 'x-user-password', 'x-credential-id']) {
      expect(nomeDeHeaderEhSensivel(nome), nome).toBe(true)
    }
    for (const nome of ['host', 'user-agent', 'content-type', 'content-length', 'accept', 'accept-encoding', 'x-forwarded-for', 'x-request-id', 'origin', 'referer', 'connection']) {
      expect(nomeDeHeaderEhSensivel(nome), nome).toBe(false)
    }
  })

  it('mascararHeadersSensiveis e serializarReq: mascaram os sensíveis, preservam os demais e a URL do webhook segue mascarada', () => {
    const req = serializarReq({
      method: 'POST',
      url: '/api/webhooks/cielo/TOKEN-DO-CAMINHO?x=1',
      headers: { host: 'api.exemplo.com.br', 'x-innoelektron-webhook-secret': 'SEGREDO-NOME-ANTIGO', 'X-Outro-Token': 'SEGREDO-OUTRO', 'user-agent': 'Cielo' },
    }) as { url: string; headers: Record<string, string> }
    expect(req.headers).toEqual({ host: 'api.exemplo.com.br', 'x-innoelektron-webhook-secret': '[redacted]', 'X-Outro-Token': '[redacted]', 'user-agent': 'Cielo' })
    expect(req.url).toBe('/api/webhooks/cielo/***')
    expect(mascararHeadersSensiveis(undefined)).toBeUndefined()
    expect(mascararHeadersSensiveis(['x'])).toEqual(['x'])
  })

  it('pino-http REAL (sem NENHUM path de redact): o segredo enviado sob nome arbitrário NÃO aparece no log; host e user-agent aparecem', async () => {
    const linhas: string[] = []
    const saida = new Writable({
      write(chunk, _enc, cb) {
        linhas.push(chunk.toString())
        cb()
      },
    })
    const logger = pino({ serializers: LOG_SERIALIZERS }, saida) // propositalmente SEM `redact`: a prova é do serializer
    const app = express()
    app.use(pinoHttp({ logger, serializers: LOG_SERIALIZERS }))
    app.post('/api/webhooks/cielo/:t', (_req, res) => {
      res.json({ ok: true })
    })

    await request(app)
      .post('/api/webhooks/cielo/TOKEN-DO-CAMINHO-SECRETO')
      .set('X-Nome-Que-Ninguem-Previu-Secret', 'SEGREDO-HEADER-ARBITRARIO-1')
      .set('x-innoelektron-webhook-secret', 'SEGREDO-HEADER-NOME-ANTIGO-2')
      .set('Authorization', 'Bearer JWT-SECRETO-3')
      .set('Cookie', 'sessao=COOKIE-SECRETO-4')
      .set('X-Api-Key', 'CHAVE-5')
      .set('User-Agent', 'agente-visivel')
      .send({ PaymentId: 'p' })

    const log = linhas.join('\n')
    for (const segredo of ['SEGREDO-HEADER-ARBITRARIO-1', 'SEGREDO-HEADER-NOME-ANTIGO-2', 'JWT-SECRETO-3', 'COOKIE-SECRETO-4', 'CHAVE-5', 'TOKEN-DO-CAMINHO-SECRETO']) {
      expect(log, `vazou ${segredo}`).not.toContain(segredo)
    }
    expect(log).toContain('agente-visivel') // controle positivo: o log existe e headers comuns continuam úteis
    expect(log).toContain('[redacted]')
  })
})
