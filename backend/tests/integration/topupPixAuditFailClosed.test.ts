import { afterAll, describe, expect, it, vi } from 'vitest'

/**
 * Falha de auditoria não pode creditar dinheiro (Órion — mesma regra do
 * ajuste manual de saldo em `walletLedger.ts`, ver `creditarTopupPix.ts`).
 * Mocka `writeAuditLog` para SEMPRE lançar — arquivo SEPARADO de propósito
 * (`vi.mock` é hoisted e vale para o arquivo inteiro; misturar com o resto
 * dos testes de Pix quebraria os que precisam da auditoria de verdade).
 */
vi.mock('../../src/services/auditoria/writeAuditLog', () => ({
  writeAuditLog: vi.fn(async () => {
    throw new Error('falha simulada de auditoria (teste fail-closed)')
  }),
}))

import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { creditarTopupPix } from '../../src/services/pagamentos/creditarTopupPix'
import { FakeAdapter } from '../../src/services/pagamentos/fakeAdapter'
import { uniqueSuffix } from './helpers/fixtures'

describe('creditarTopupPix — auditoria FAIL-CLOSED (Órion)', () => {
  const suffix = uniqueSuffix()

  afterAll(async () => {
    await prisma.$disconnect()
    redis.disconnect()
  })

  it('se writeAuditLog falhar, a transação INTEIRA desfaz: nada é creditado, nenhuma dívida é quitada, o intent continua PENDING', async () => {
    const user = await prisma.user.create({ data: { role: 'DRIVER', name: `Driver audit-fail ${suffix}`, email: `driver-audit-fail-${suffix}@example.com` } })
    const wallet = await prisma.wallet.create({ data: { userId: user.id } })
    const debt = await prisma.debt.create({ data: { userId: user.id, amountCents: 500, status: 'OPEN', reason: 'INSUFFICIENT_WALLET_BALANCE' } })

    const adapter = new FakeAdapter()
    const pix = await adapter.criarPix({ merchantOrderId: 'placeholder', amountRequestedCents: 3_000, cliente: { name: user.name } })
    adapter.marcarPixComoPago(pix.providerPaymentId)

    const intent = await prisma.paymentIntent.create({
      data: {
        purpose: 'WALLET_TOPUP_PIX',
        provider: 'CIELO_PIX',
        userId: user.id,
        walletId: wallet.id,
        amountRequestedCents: 3_000,
        status: 'PENDING',
        cieloPaymentId: pix.providerPaymentId,
        pixQrCode: pix.qrCodeString,
        pixExpiresAt: pix.expiresAt,
      },
    })

    await expect(creditarTopupPix(intent.id, adapter)).rejects.toThrow(/falha simulada de auditoria/)

    // Nada foi creditado — nem o TOPUP_PIX nem a quitação da dívida.
    expect(await prisma.walletEntry.count({ where: { walletId: wallet.id } })).toBe(0)
    expect((await prisma.debt.findUniqueOrThrow({ where: { id: debt.id } })).status).toBe('OPEN')
    expect((await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe('PENDING')
  })
})
