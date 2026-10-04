import { Writable } from 'node:stream'
import express from 'express'
import pino from 'pino'
import pinoHttp from 'pino-http'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { LOG_SERIALIZERS, mascararHeadersSensiveis, nomeDeHeaderEhSensivel, serializarReq } from '../../src/lib/logSerializers'

/**
 * Achado da Íris (rodada 2): o `redact` do pino só casa NOMES EXATOS, e a heurística por NOME em inglês (secret|token|key|...) deixava passar o segredo do webhook enviado
 * sob um nome em português ou arbitrário (ex.: `x-innoelektron-segredo`, `x-chave-da-cielo`, `x-codigo-de-notificacao`). Agora o `serializarReq` usa uma ALLOWLIST: só aparece em
 * claro no log um conjunto pequeno de headers conhecidos e inofensivos; TUDO o mais sai `[redacted]`, qualquer que seja o nome.
 */
describe('headers no log do pino-http: ALLOWLIST (o que não está na lista é mascarado, qualquer que seja o nome)', () => {
  it('nomeDeHeaderEhSensivel: nomes em PORTUGUÊS e arbitrários são mascarados; só a lista conhecida passa (sem caixa)', () => {
    for (const nome of [
      'x-innoelektron-webhook-secret', 'InnoFlowWebhookSecret', 'x-api-key', 'merchantkey', 'Authorization', 'proxy-authorization', 'Cookie', 'x-csrf-token', 'x-signature',
      // nomes em português / sem nenhuma palavra "óbvia" — a heurística antiga deixava passar
      'x-innoelektron-segredo', 'X-Chave-Da-Cielo', 'x-codigo-de-notificacao', 'x-notificacao', 'x-webhook', 'x-cielo-merchant', 'x-minha-coisa', 'x-xyz',
    ]) {
      expect(nomeDeHeaderEhSensivel(nome), nome).toBe(true)
    }
    for (const nome of ['host', 'Host', 'user-agent', 'content-type', 'content-length', 'accept', 'accept-encoding', 'x-forwarded-for', 'X-Request-Id', 'origin', 'referer', 'connection']) {
      expect(nomeDeHeaderEhSensivel(nome), nome).toBe(false)
    }
  })

  it('mascararHeadersSensiveis e serializarReq: mascaram os sensíveis, preservam os demais e a URL do webhook segue mascarada', () => {
    const req = serializarReq({
      method: 'POST',
      url: '/api/webhooks/cielo/TOKEN-DO-CAMINHO?x=1',
      headers: { host: 'api.exemplo.com.br', 'x-innoelektron-webhook-secret': 'SEGREDO-NOME-ANTIGO', 'X-Outro-Token': 'SEGREDO-OUTRO', 'x-innoelektron-segredo': 'SEGREDO-PT', 'user-agent': 'Cielo' },
    }) as { url: string; headers: Record<string, string> }
    expect(req.headers).toEqual({ host: 'api.exemplo.com.br', 'x-innoelektron-webhook-secret': '[redacted]', 'X-Outro-Token': '[redacted]', 'x-innoelektron-segredo': '[redacted]', 'user-agent': 'Cielo' })
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
      .set('X-Chave-Da-Cielo', 'SEGREDO-PT-6')
      .set('X-Codigo-De-Notificacao', 'SEGREDO-PT-7')
      .set('User-Agent', 'agente-visivel')
      .send({ PaymentId: 'p' })

    const log = linhas.join('\n')
    for (const segredo of ['SEGREDO-HEADER-ARBITRARIO-1', 'SEGREDO-HEADER-NOME-ANTIGO-2', 'JWT-SECRETO-3', 'COOKIE-SECRETO-4', 'CHAVE-5', 'SEGREDO-PT-6', 'SEGREDO-PT-7', 'TOKEN-DO-CAMINHO-SECRETO']) {
      expect(log, `vazou ${segredo}`).not.toContain(segredo)
    }
    expect(log).toContain('agente-visivel') // controle positivo: o log existe e headers comuns continuam úteis
    expect(log).toContain('[redacted]')
  })
})
