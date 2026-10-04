import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { logger } from '../../src/lib/logger'
import { getCieloWebhookPathToken } from '../../src/services/pagamentos/webhookCieloSecrets'

/**
 * I-5 (auditoria): JSON malformado e corpo grande davam 500 + log de erro com o `err` completo, por requisição, para qualquer anônimo — e o ping da Cielo (que exige 200 ao salvar a URL)
 * falhava se o POST de teste viesse com JSON quebrado. Agora: `entity.parse.failed` -> 400, `entity.too.large` -> 413 (sem log de erro); no webhook, parser próprio de 4 KB ANTES do global,
 * e JSON inválido é tratado como ping (200) DEPOIS do token do caminho.
 */
describe('body-parser: 400/413 sem log de erro; webhook com parser próprio e tolerante', () => {
  const app = createApp()
  afterEach(() => vi.restoreAllMocks())
  afterAll(async () => {
    await prisma.$disconnect()
    redis.disconnect()
  })

  const urlWebhook = () => `/api/webhooks/cielo/${getCieloWebhookPathToken()}`
  const postBruto = (url: string, corpo: string) => request(app).post(url).set('Content-Type', 'application/json').send(corpo)

  describe('rotas comuns (parser global)', () => {
    it('JSON malformado -> 400 INVALID_JSON (não 500), sem log de erro e sem stack/corpo na resposta', async () => {
      const erro = vi.spyOn(logger, 'error')
      const res = await postBruto('/api/auth/login', '{"email": "a@b.c", "password": ')
      expect(res.status).toBe(400)
      expect(res.body).toEqual({ error: expect.any(String), code: 'INVALID_JSON' })
      expect(JSON.stringify(res.body)).not.toMatch(/SyntaxError|at |stack|Unexpected/)
      expect(erro).not.toHaveBeenCalled()
    })

    it('corpo acima do limite global (100 KB) -> 413 PAYLOAD_TOO_LARGE, sem log de erro', async () => {
      const erro = vi.spyOn(logger, 'error')
      const res = await postBruto('/api/auth/login', JSON.stringify({ email: 'a@b.c', password: 'x'.repeat(150_000) }))
      expect(res.status).toBe(413)
      expect(res.body.code).toBe('PAYLOAD_TOO_LARGE')
      expect(erro).not.toHaveBeenCalled()
    })

    it('JSON válido continua passando pelo parser global (login com credencial errada = 401, não 400)', async () => {
      const res = await postBruto('/api/auth/login', JSON.stringify({ email: 'nao-existe@example.com', password: 'qualquer-senha-12' }))
      expect(res.status).toBe(401)
    })
  })

  describe('webhook da Cielo', () => {
    it('JSON INVÁLIDO com o token do caminho certo = ping: 200 {received:true}, nada gravado, sem log de erro', async () => {
      const erro = vi.spyOn(logger, 'error')
      const antes = await prisma.webhookEvent.count()
      const res = await postBruto(urlWebhook(), '{"PaymentId": "abc", ')
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ received: true })
      expect(await prisma.webhookEvent.count()).toBe(antes)
      expect(erro).not.toHaveBeenCalled()
    })

    it('JSON inválido com o token ERRADO continua 404 (o ping tolerante não vira oráculo do token nem de nada)', async () => {
      expect((await postBruto('/api/webhooks/cielo/token-errado-do-ping-json', '{"PaymentId": ')).status).toBe(404)
    })

    it('corpo acima de 4 KB no webhook -> 413 sem log de erro (o limite próprio vale ANTES do global de 100 KB), com ou sem token certo', async () => {
      const erro = vi.spyOn(logger, 'error')
      const grande = JSON.stringify({ PaymentId: 'x', ChangeType: 1, lixo: 'a'.repeat(6_000) })
      expect((await postBruto(urlWebhook(), grande)).status).toBe(413)
      expect((await postBruto('/api/webhooks/cielo/token-errado', grande)).status).toBe(413)
      expect(erro).not.toHaveBeenCalled()
    })

    it('o mesmo corpo de ~6 KB passa em uma rota comum (prova de que o limite de 4 KB é do webhook, não do app)', async () => {
      const res = await postBruto('/api/auth/login', JSON.stringify({ email: 'nao-existe@example.com', password: 'x'.repeat(6_000) }))
      expect(res.status).not.toBe(413)
    })

    it('notificação real (JSON válido, pequeno) segue o fluxo normal: sem o header do segredo = 401', async () => {
      const res = await postBruto(urlWebhook(), JSON.stringify({ PaymentId: 'p-1', ChangeType: 1 }))
      expect(res.status).toBe(401)
    })
  })
})
