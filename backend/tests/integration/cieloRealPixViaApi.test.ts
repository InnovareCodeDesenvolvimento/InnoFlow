import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { env } from '../../src/lib/env'
import { resetGatewayConfigCacheParaTeste } from '../../src/services/pagamentos/gatewayConfig'
import { resetPagamentoPortCacheParaTeste } from '../../src/services/pagamentos/pagamentoPortInstance'
import { createUser, uniqueSuffix } from './helpers/fixtures'
import { CieloFalsaHttp } from './helpers/cieloFalsaHttp'
import { apontarAdaptadorParaCieloFalsa } from './helpers/cenarioCartaoHttp'

/**
 * Íris (C1.5/C2.5, 04/10/2026) — Pix `Cielo2` de ponta a ponta: `POST /api/me/wallet/topups` -> adaptador REAL -> "Cielo" por TCP -> Postgres. Banco próprio (a recarga Pix
 * cria `PaymentIntent` e outras suítes varrem os intents Pix vencidos com o FakeAdapter).
 */

const banco = await vi.hoisted(async () => {
  const { criarBancoProprio } = await import('./helpers/bancoProprio')
  return criarBancoProprio('cielo_real_pix')
})

// MUDANÇA DELIBERADA (rodada 3): a conta Cielo é COMPARTILHADA com o Parque das Feiras e o pedido vai à Cielo como `IF-<id do intent>` (I-7, 89f36dd). A Cielo falsa guarda e casa o
// `MerchantOrderId` EXATAMENTE como recebeu (como a real), então toda leitura do "mundo da Cielo" por pedido passa por `mo()`.
const mo = (intentId: string) => `IF-${intentId}`

describe('Pix Cielo2 via API (adaptador real + Cielo falsa por TCP)', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  const cielo = new CieloFalsaHttp()
  const baseline = { ...env } as Record<string, unknown>
  const processEnvBaseline = { api: process.env.CIELO_API_BASE_URL, query: process.env.CIELO_API_QUERY_BASE_URL }
  let contador = 0

  beforeAll(async () => {
    await cielo.iniciar()
    apontarAdaptadorParaCieloFalsa(cielo.url, { timeoutMs: 400 })
    ;(env as Record<string, unknown>).TOPUP_PIX_MAX_PENDING_PER_USER = 50
  })
  afterAll(async () => {
    await cielo.parar()
    Object.assign(env, baseline)
    if (processEnvBaseline.api === undefined) delete process.env.CIELO_API_BASE_URL
    else process.env.CIELO_API_BASE_URL = processEnvBaseline.api
    if (processEnvBaseline.query === undefined) delete process.env.CIELO_API_QUERY_BASE_URL
    else process.env.CIELO_API_QUERY_BASE_URL = processEnvBaseline.query
    resetGatewayConfigCacheParaTeste()
    resetPagamentoPortCacheParaTeste()
    await prisma.$disconnect()
    redis.disconnect()
    await banco.descartar()
  })
  beforeEach(() => {
    cielo.zerarRegistro()
    ;(env as Record<string, unknown>).PIX_TOPUP_EXPIRES_MINUTES = 30
  })

  async function recarregar(amountCents = 1000) {
    contador += 1
    const driver = await createUser({ role: 'DRIVER', label: `pix-${contador}`, suffix })
    const res = await request(app).post('/api/me/wallet/topups').set('Authorization', `Bearer ${driver.token}`).send({ amountCents })
    const intent = await prisma.paymentIntent.findFirst({ where: { userId: driver.id, purpose: 'WALLET_TOPUP_PIX' }, orderBy: { createdAt: 'desc' } })
    return { res, intent, driver }
  }

  it('caminho feliz: 201, 1 POST /1/sales/ com o payload exato da doc (expiração em SEGUNDOS = minutos*60), QR guardado, Tid/AuthorizationCode/ProofOfSale NULL mesmo que a Cielo os mande', async () => {
    const { res, intent } = await recarregar(1500)
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(cielo.chamadas).toHaveLength(1)
    const c = cielo.chamadas[0]
    expect(c).toMatchObject({ metodo: 'POST', url: '/1/sales/' })
    expect(c.corpo).toMatchObject({ MerchantOrderId: mo(intent!.id), Payment: { Type: 'Pix', Amount: 1500, Provider: 'Cielo2', QrCode: { Expiration: 1800 } } })
    expect(c.corpoBruto).not.toContain('QrCodeExpiration')
    const venda = cielo.vendaPorPedido(mo(intent!.id))!
    expect(venda.tid).toBeTruthy() // a Cielo falsa DEVOLVEU Tid/AuthorizationCode/ProofOfSale
    expect(intent).toMatchObject({ status: 'PENDING', cieloPaymentId: venda.paymentId, pixQrCode: '00020101021226830014br.gov.bcb.pix2561exemplo', cieloTid: null, cieloAuthorizationCode: null, cieloProofOfSale: null })
    const expira = intent!.pixExpiresAt!.getTime() - Date.now()
    expect(expira).toBeGreaterThan(1790_000)
    expect(expira).toBeLessThanOrEqual(1800_000)
  })

  it('expiração configurada ACIMA de 24 h (2000 min): o corpo manda 86400 e o expiresAt mostrado ao motorista é o MESMO teto', async () => {
    ;(env as Record<string, unknown>).PIX_TOPUP_EXPIRES_MINUTES = 2000
    const { res, intent } = await recarregar()
    expect(res.status).toBe(201)
    expect((cielo.chamadas[0].corpo as { Payment: { QrCode: { Expiration: number } } }).Payment.QrCode.Expiration).toBe(86_400)
    const expira = intent!.pixExpiresAt!.getTime() - Date.now()
    expect(expira).toBeLessThanOrEqual(86_400_000)
    expect(expira).toBeGreaterThan(86_400_000 - 10_000)
  })

  it('Cielo PROCESSA o Pix e não responde (timeout): 503, intent FAILED, 1 POST — nunca um 2º POST para o mesmo pedido, nem pelo varredor', async () => {
    cielo.agendar('POST_SALE', { processar: true, resposta: 'travar' })
    const { res, intent } = await recarregar()
    expect(res.status).toBe(503)
    expect(intent!.status).toBe('FAILED')
    expect(cielo.contar('POST_SALE', { merchantOrderId: mo(intent!.id) })).toBe(1)
    expect(cielo.efeitos.vendasCriadas.get(mo(intent!.id))).toBe(1) // a Cielo criou a cobrança, mas o QR nunca foi mostrado a ninguém
  })

  it('Cielo responde 400 de payload: 503 e intent FAILED, sem eco do erro da Cielo na resposta ao motorista', async () => {
    cielo.agendar('POST_SALE', { processar: false, resposta: { http: 400, corpo: [{ Code: 126, Message: 'ECO-NA-RESPOSTA-AO-MOTORISTA' }] } })
    const { res, intent } = await recarregar()
    expect(res.status).toBe(503)
    expect(JSON.stringify(res.body)).not.toContain('ECO-NA-RESPOSTA-AO-MOTORISTA')
    expect(intent!.status).toBe('FAILED')
  })

  /**
   * ACHADO (Íris, BAIXO): `POST /wallet/topups` grava `status: 'PENDING'` e devolve 201 SEM olhar o `status`/QR que o adaptador devolveu. Se a Cielo responder 2xx mas
   * com `Status` 13/3 (abortada/negada) ou sem `QrCodeString` (campo renomeado, Pix não habilitado na conta), o motorista recebe um "Pix" sem QR pagável (ou de uma cobrança que
   * a Cielo abortou) e a recarga fica PENDING até expirar. Desejado: tratar como falha (503 + FAILED) e logar. Os Pix `Cielo2` não têm sandbox: a forma real da resposta só se vê em produção.
   */
  it('(I-6, CORRIGIDO na rodada 2) Pix com Status 13 (abortado) ou sem QR pagável NÃO vira recarga PENDING com 201', async () => {
    cielo.agendar('POST_SALE', { corpoRespostaCru: { MerchantOrderId: 'x', Payment: { PaymentId: 'pay-pix-abortado', Status: 13, ReturnCode: '0', Type: 'Pix' } } })
    const { res, intent } = await recarregar()
    expect(res.status).not.toBe(201)
    expect(intent!.status).not.toBe('PENDING')
  })
})
