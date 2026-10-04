import { afterAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { getCieloWebhookHeaderSecret, getCieloWebhookPathToken } from '../../src/services/pagamentos/webhookCieloSecrets'
import { PADRAO_NOME_HEADER_SITE_CIELO, WEBHOOK_SECRET_HEADER_NAME } from '../../src/core/pagamentos/webhookHeader'
import { uniqueSuffix } from './helpers/fixtures'

/**
 * Íris (C1.4, 04/10/2026) — webhook da Cielo: a ORDEM EXATA dos portões e o nome do header, medidos contra a rota de verdade.
 *   token do caminho (404) -> ping sem PaymentId/ChangeType (200, SEM ler nem gravar nada) -> segredo do header (401) -> schema do corpo (400).
 * Valores de referência do Parque (`CieloWebhookSecret`; segredo errado = 403 lá, 401 aqui por decisão do InnoFlow): o nome só pode ter LETRAS (o campo "Key" do
 * Site Cielo recusa hífen/número/espaço — `X-Webhook-Secret` não pôde ser salvo em 02/09/2026) e o ping automático da Cielo ao salvar a URL precisa de 200.
 */

describe('webhook da Cielo — ordem dos portões e nome do header', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  afterAll(async () => {
    await prisma.$disconnect()
    redis.disconnect()
  })

  const url = (token = getCieloWebhookPathToken()) => `/api/webhooks/cielo/${token}`
  const validBody = (id = `iris-${suffix}-${Math.random().toString(36).slice(2, 8)}`) => ({ PaymentId: id, ChangeType: 1 })
  // só os eventos DESTE arquivo (o Postgres é compartilhado com outras suítes em paralelo, que também gravam WebhookEvent)
  const eventos = () => prisma.webhookEvent.count({ where: { provider: 'CIELO', externalId: { startsWith: `iris-${suffix}` } } })

  it('o nome do header é só letras (regex do Site Cielo) e é exatamente InnoFlowWebhookSecret', () => {
    expect(WEBHOOK_SECRET_HEADER_NAME).toBe('InnoFlowWebhookSecret')
    expect(PADRAO_NOME_HEADER_SITE_CIELO.test(WEBHOOK_SECRET_HEADER_NAME)).toBe(true)
    expect(PADRAO_NOME_HEADER_SITE_CIELO.test('X-Webhook-Secret')).toBe(false)
    expect(PADRAO_NOME_HEADER_SITE_CIELO.test('InnoFlow-Webhook-Secret')).toBe(false)
    expect(PADRAO_NOME_HEADER_SITE_CIELO.test('InnoFlowWebhookSecret2')).toBe(false)
    expect(PADRAO_NOME_HEADER_SITE_CIELO.test('')).toBe(false)
  })

  it('PORTÃO 1 — token do caminho errado: 404 para tudo (válido, inválido E ping), antes de qualquer outra coisa', async () => {
    const segredo = await getCieloWebhookHeaderSecret()
    const antes = await eventos()
    for (const corpo of [validBody(), {}, { PaymentId: `iris-${suffix}-x` }]) {
      const r = await request(app).post(url('token-que-nao-existe')).set(WEBHOOK_SECRET_HEADER_NAME, segredo).send(corpo)
      expect(r.status, JSON.stringify(corpo)).toBe(404)
    }
    expect((await request(app).post(url('token-que-nao-existe')).send({})).status).toBe(404) // ping sem segredo, token errado: ainda 404
    expect(await eventos()).toBe(antes)
  })

  it('PORTÃO 2 — PING (sem PaymentId e/ou sem ChangeType) com o token certo: 200 SEM segredo, e NADA é gravado', async () => {
    const antes = await eventos()
    const pings: Array<[string, () => request.Test]> = [
      ['corpo vazio {}', () => request(app).post(url()).send({})],
      ['sem corpo', () => request(app).post(url())],
      ['texto puro', () => request(app).post(url()).set('content-type', 'text/plain').send('ping')],
      ['array', () => request(app).post(url()).send([])],
      ['só PaymentId', () => request(app).post(url()).send({ PaymentId: `iris-${suffix}-so-id` })],
      ['só ChangeType', () => request(app).post(url()).send({ ChangeType: 1 })],
      ['PaymentId em branco', () => request(app).post(url()).send({ PaymentId: '   ', ChangeType: 1 })],
      ['ChangeType null', () => request(app).post(url()).send({ PaymentId: `iris-${suffix}-ct-null`, ChangeType: null })],
      ['form-urlencoded', () => request(app).post(url()).type('form').send('a=1')],
    ]
    for (const [nome, enviar] of pings) {
      const r = await enviar()
      expect(r.status, nome).toBe(200)
      expect(r.body, nome).toEqual({ received: true })
    }
    expect(await eventos()).toBe(antes)
  })

  it('o ping vem ANTES do segredo: com segredo ERRADO continua 200 (como o Parque: o ping não tem o que proteger)', async () => {
    expect((await request(app).post(url()).set(WEBHOOK_SECRET_HEADER_NAME, 'segredo-errado').send({})).status).toBe(200)
  })

  /**
   * ACHADO (Íris, confirma o I-5 do Órion): o `express.json()` global roda ANTES da rota e o `errorHandler` não mapeia o erro do body-parser — corpo com JSON quebrado vira 500
   * (e um log de erro por requisição). Para o webhook isso quebra o PING (a Cielo exige 200 ao salvar a URL; um ping com corpo estranho não pode ser 5xx) e dá a qualquer anônimo, mesmo
   * com o token do caminho errado, um 5xx em vez de 404. Vira `it` quando o webhook tolerar corpo malformado (como ping) e o erro de parse virar 400.
   */
  it.fails('(achado I-5) ping com JSON MALFORMADO deveria ser 200, e token errado + JSON malformado deveria ser 404 — hoje é 500', async () => {
    const ping = await request(app).post(url()).set('content-type', 'application/json').send('{"PaymentId":')
    expect(ping.status).toBe(200)
    const tokenErrado = await request(app).post(url('token-errado')).set('content-type', 'application/json').send('{"PaymentId":')
    expect(tokenErrado.status).toBe(404)
  })

  it('PORTÃO 3 — notificação de verdade sem segredo, com segredo errado ou com o nome ANTIGO do header: 401 (mesmo com o valor CERTO sob o nome antigo)', async () => {
    const segredo = await getCieloWebhookHeaderSecret()
    const antes = await eventos()
    expect((await request(app).post(url()).send(validBody())).status).toBe(401)
    expect((await request(app).post(url()).set(WEBHOOK_SECRET_HEADER_NAME, `${segredo}x`).send(validBody())).status).toBe(401)
    expect((await request(app).post(url()).set(WEBHOOK_SECRET_HEADER_NAME, segredo.slice(0, -1)).send(validBody())).status).toBe(401)
    expect((await request(app).post(url()).set(WEBHOOK_SECRET_HEADER_NAME, '').send(validBody())).status).toBe(401)
    // MESMO TAMANHO, conteúdo diferente (o mutante que só confere o tamanho sobrevivia a tamanhos diferentes): troca só o último caractere
    const mesmoTamanho = segredo.slice(0, -1) + (segredo.endsWith('a') ? 'b' : 'a')
    expect(mesmoTamanho).toHaveLength(segredo.length)
    expect(mesmoTamanho).not.toBe(segredo)
    expect((await request(app).post(url()).set(WEBHOOK_SECRET_HEADER_NAME, mesmoTamanho).send(validBody())).status).toBe(401)
    expect((await request(app).post(url()).set(WEBHOOK_SECRET_HEADER_NAME, 'Z'.repeat(segredo.length)).send(validBody())).status).toBe(401)
    expect((await request(app).post(url()).set('x-innoelektron-webhook-secret', segredo).send(validBody())).status).toBe(401) // nome ANTIGO com o segredo CERTO
    expect((await request(app).post(url()).set('X-Webhook-Secret', segredo).send(validBody())).status).toBe(401)
    expect((await request(app).post(url()).set('Inno-Flow-Webhook-Secret', segredo).send(validBody())).status).toBe(401) // com hífens
    expect(await eventos()).toBe(antes)
  })

  it('o segredo vem ANTES do schema: corpo malformado SEM segredo é 401 (não 400), COM segredo é 400', async () => {
    const segredo = await getCieloWebhookHeaderSecret()
    const malformados = [{ PaymentId: 'p'.repeat(65), ChangeType: 1 }, { PaymentId: 12345, ChangeType: 1 }, { PaymentId: { x: 1 }, ChangeType: 1 }, { PaymentId: 'abc', ChangeType: 'não-é-número' }, { PaymentId: 'abc', ChangeType: 1.5 }]
    for (const corpo of malformados) {
      expect((await request(app).post(url()).send(corpo)).status, `sem segredo ${JSON.stringify(corpo)}`).toBe(401)
      expect((await request(app).post(url()).set(WEBHOOK_SECRET_HEADER_NAME, segredo).send(corpo)).status, `com segredo ${JSON.stringify(corpo)}`).toBe(400)
    }
  })

  it('segredo certo em QUALQUER caixa do nome do header (HTTP não distingue maiúsculas) aceita e grava; o corpo real da Cielo (com RecurrentPaymentId null) passa', async () => {
    const segredo = await getCieloWebhookHeaderSecret()
    for (const nome of ['InnoFlowWebhookSecret', 'innoflowwebhooksecret', 'INNOFLOWWEBHOOKSECRET', 'Innoflowwebhooksecret']) {
      const corpo = { RecurrentPaymentId: null, ...validBody(), ChangeType: 1 }
      const r = await request(app).post(url()).set(nome, segredo).send(corpo)
      expect(r.status, nome).toBe(200)
      const gravado = await prisma.webhookEvent.findFirst({ where: { provider: 'CIELO', externalId: corpo.PaymentId } })
      expect(gravado, nome).not.toBeNull()
      expect(gravado!.changeType).toBe(1)
    }
  })

  it('PaymentId desconhecido ainda recebe 200 (nunca devolve erro à Cielo: ela reenvia em rajada) e o evento fica gravado sem intent', async () => {
    const segredo = await getCieloWebhookHeaderSecret()
    const corpo = validBody()
    const r = await request(app).post(url()).set(WEBHOOK_SECRET_HEADER_NAME, segredo).send(corpo)
    expect(r.status).toBe(200)
    expect(await prisma.webhookEvent.findFirstOrThrow({ where: { externalId: corpo.PaymentId } })).toMatchObject({ paymentIntentId: null, provider: 'CIELO' })
  })
})
