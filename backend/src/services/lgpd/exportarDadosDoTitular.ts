import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { LIMITE_LINHAS_POR_COLECAO, formatarValidade, mascararIdTag } from '../../core/lgpd/exportacao'
import { AppError } from '../../api/middleware/errorHandler'

/**
 * Exportação dos dados do TITULAR (L1.4, LGPD art. 18 II e V: acesso e portabilidade). Tudo escopado pelo `userId` que o chamador passa (sempre `req.user.userId`, nunca de corpo/query).
 *
 * LISTA BRANCA: cada coleção é montada campo a campo — nunca `...linha`. Fica de fora, por desenho: `passwordHash`, `googleSub`, token/ciphertext de cartão, `idTag` inteiro (sai
 * mascarado), identificadores da Cielo (`cieloPaymentId`, Tid, NSU), QR/"copia e cola" do Pix, chave Pix de devolução, ids de ADMIN que fizeram ajustes. O CPF sai INTEIRO só aqui
 * (é o dado do próprio titular).
 *
 * Tamanho: cada coleção é limitada a `LIMITE_LINHAS_POR_COLECAO` (mais recentes primeiro) e `limits.truncated` diz o que foi cortado — nunca uma resposta ilimitada.
 * Síncrono (um motorista tem no máximo centenas de sessões); o plano manda virar job assíncrono se passar de 5 MB ou p95 > 3 s (o tamanho vira alerta no log).
 */

export interface DadosDoTitular {
  exportedAt: string
  profile: { id: string; name: string; email: string; phone: string | null; cpf: string | null; createdAt: string }
  consents: Array<{ kind: string; version: string; acceptedAt: string; source: string }>
  sessions: unknown[]
  walletEntries: unknown[]
  topups: unknown[]
  cardPayments: unknown[]
  debts: unknown[]
  paymentMethods: Array<{ brand: string; last4: string; expiry: string; holderName: string | null; active: boolean; createdAt: string }>
  authTokens: Array<{ idTagMasked: string; type: string; status: string }>
  notifications: unknown[]
  notificationPreferences: { sessionReceiptEmail: boolean; lowBalanceEnabled: boolean; lowBalanceThresholdCents: number }
  limits: { maxRowsPerCollection: number; truncated: string[] }
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null)

export async function exportarDadosDoTitular(userId: string, agora: Date = new Date()): Promise<DadosDoTitular> {
  const take = LIMITE_LINHAS_POR_COLECAO + 1 // +1 só para saber se havia mais (truncado)

  const usuario = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, email: true, phone: true, cpf: true, createdAt: true, role: true, deletedAt: true } })
  if (!usuario || usuario.role !== 'DRIVER' || usuario.deletedAt !== null) throw new AppError('Conta não encontrada.', 404, 'NOT_FOUND')

  const carteira = await prisma.wallet.findUnique({ where: { userId }, select: { id: true } })

  const [consents, sessions, walletEntries, topups, cardPayments, debts, paymentMethods, authTokens, notifications, preferencias] = await Promise.all([
    prisma.consentRecord.findMany({ where: { userId }, orderBy: { acceptedAt: 'desc' }, take, select: { kind: true, version: true, acceptedAt: true, source: true } }),
    prisma.chargingSession.findMany({
      where: { userId },
      orderBy: { startedAt: 'desc' },
      take,
      select: {
        id: true,
        status: true,
        paymentMode: true,
        startedAt: true,
        stoppedAt: true,
        stopReason: true,
        meterStartWh: true,
        meterStopWh: true,
        energyDeliveredWh: true,
        energyCostCents: true,
        timeCostCents: true,
        idleFeeCents: true,
        sessionFeeCents: true,
        minChargeAdjustmentCents: true,
        totalCostCents: true,
        startIp: true,
        startUserAgent: true,
        site: { select: { name: true, city: true, state: true } },
        chargePoint: { select: { ocppIdentity: true } },
        connector: { select: { connectorId: true, type: true } },
      },
    }),
    carteira
      ? prisma.walletEntry.findMany({
          where: { walletId: carteira.id },
          orderBy: { createdAt: 'desc' },
          take,
          select: { id: true, type: true, amountCents: true, balanceAfterCents: true, referenceType: true, referenceId: true, description: true, createdAt: true },
        })
      : Promise.resolve([]),
    prisma.paymentIntent.findMany({
      where: { userId, purpose: 'WALLET_TOPUP_PIX' },
      orderBy: { createdAt: 'desc' },
      take,
      select: { id: true, status: true, amountRequestedCents: true, createdAt: true, capturedAt: true, pixExpiresAt: true },
    }),
    prisma.paymentIntent.findMany({
      where: { userId, purpose: 'SESSION_CARD_CAPTURE' },
      orderBy: { createdAt: 'desc' },
      take,
      select: {
        id: true,
        status: true,
        chargingSessionId: true,
        amountAuthorizedCents: true,
        amountCapturedCents: true,
        amountRefundedCents: true,
        createdAt: true,
        capturedAt: true,
        paymentMethod: { select: { brand: true, last4: true } },
      },
    }),
    prisma.debt.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take, select: { id: true, amountCents: true, status: true, reason: true, chargingSessionId: true, createdAt: true, settledAt: true } }),
    prisma.paymentMethod.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take, select: { brand: true, last4: true, expiryMonth: true, expiryYear: true, holderName: true, active: true, createdAt: true } }),
    prisma.authToken.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take, select: { idTag: true, type: true, status: true } }),
    prisma.notificationLog.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take, select: { type: true, channel: true, status: true, createdAt: true, sentAt: true } }),
    prisma.notificationPreference.findUnique({ where: { userId }, select: { sessionReceiptEmail: true, lowBalanceEnabled: true, lowBalanceThresholdCents: true } }),
  ])

  const truncated: string[] = []
  /** Corta a coleção no limite e registra o NOME dela se havia mais linhas. */
  const limitar = <T>(nome: string, linhas: T[]): T[] => {
    if (linhas.length <= LIMITE_LINHAS_POR_COLECAO) return linhas
    truncated.push(nome)
    return linhas.slice(0, LIMITE_LINHAS_POR_COLECAO)
  }

  const exportacao: DadosDoTitular = {
    exportedAt: agora.toISOString(),
    profile: { id: usuario.id, name: usuario.name, email: usuario.email, phone: usuario.phone, cpf: usuario.cpf, createdAt: usuario.createdAt.toISOString() },
    consents: limitar('consents', consents).map((c) => ({ kind: c.kind, version: c.version, acceptedAt: c.acceptedAt.toISOString(), source: c.source })),
    sessions: limitar('sessions', sessions).map((s) => ({
      id: s.id,
      status: s.status,
      paymentMode: s.paymentMode,
      startedAt: s.startedAt.toISOString(),
      stoppedAt: iso(s.stoppedAt),
      stopReason: s.stopReason,
      site: s.site.name,
      city: s.site.city,
      state: s.site.state,
      chargePoint: s.chargePoint.ocppIdentity,
      connector: { number: s.connector.connectorId, type: s.connector.type },
      meterStartWh: s.meterStartWh,
      meterStopWh: s.meterStopWh,
      energyDeliveredWh: s.energyDeliveredWh,
      cost: {
        energyCents: s.energyCostCents,
        timeCents: s.timeCostCents,
        idleFeeCents: s.idleFeeCents,
        sessionFeeCents: s.sessionFeeCents,
        minChargeAdjustmentCents: s.minChargeAdjustmentCents,
        totalCents: s.totalCostCents,
      },
      startIp: s.startIp,
      startUserAgent: s.startUserAgent,
    })),
    walletEntries: limitar('walletEntries', walletEntries).map((e) => ({
      id: e.id,
      type: e.type,
      amountCents: e.amountCents,
      balanceAfterCents: e.balanceAfterCents,
      referenceType: e.referenceType,
      referenceId: e.referenceId,
      description: e.description,
      createdAt: e.createdAt.toISOString(),
    })),
    topups: limitar('topups', topups).map((t) => ({ id: t.id, status: t.status, amountCents: t.amountRequestedCents, createdAt: t.createdAt.toISOString(), paidAt: iso(t.capturedAt), expiresAt: iso(t.pixExpiresAt) })),
    cardPayments: limitar('cardPayments', cardPayments).map((p) => ({
      id: p.id,
      status: p.status,
      sessionId: p.chargingSessionId,
      authorizedCents: p.amountAuthorizedCents,
      capturedCents: p.amountCapturedCents,
      refundedCents: p.amountRefundedCents,
      card: p.paymentMethod ? { brand: p.paymentMethod.brand, last4: p.paymentMethod.last4 } : null,
      createdAt: p.createdAt.toISOString(),
      capturedAt: iso(p.capturedAt),
    })),
    debts: limitar('debts', debts).map((d) => ({ id: d.id, amountCents: d.amountCents, status: d.status, reason: d.reason, sessionId: d.chargingSessionId, createdAt: d.createdAt.toISOString(), settledAt: iso(d.settledAt) })),
    paymentMethods: limitar('paymentMethods', paymentMethods).map((m) => ({
      brand: m.brand ?? '',
      last4: m.last4 ?? '',
      expiry: formatarValidade(m.expiryMonth, m.expiryYear),
      holderName: m.holderName,
      active: m.active,
      createdAt: m.createdAt.toISOString(),
    })),
    authTokens: limitar('authTokens', authTokens).map((t) => ({ idTagMasked: mascararIdTag(t.idTag), type: t.type, status: t.status })),
    notifications: limitar('notifications', notifications).map((n) => ({ type: n.type, channel: n.channel, status: n.status, createdAt: n.createdAt.toISOString(), sentAt: iso(n.sentAt) })),
    // Sem linha = os mesmos defaults do `GET /api/me/notification-preferences` (docs/MODELO-DADOS-LOTE1.md §2.4).
    notificationPreferences: preferencias ?? { sessionReceiptEmail: true, lowBalanceEnabled: true, lowBalanceThresholdCents: 2000 },
    limits: { maxRowsPerCollection: LIMITE_LINHAS_POR_COLECAO, truncated },
  }

  logger.info({ userId, truncated }, '[lgpd] exportação de dados do titular montada')
  return exportacao
}
