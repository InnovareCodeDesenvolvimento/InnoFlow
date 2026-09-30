import type { AuthToken } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { env } from '../lib/env'
import { avaliarInicioSessao, type AvaliarInicioSessaoResultado, type FundingSource } from '../core/carteira/avaliarInicioSessao'

/**
 * Checagem de autorização compartilhada entre `Authorize` e `StartTransaction`
 * (o Authorize é opcional no protocolo, o carregador pode ir direto pro
 * Start, então o Start repete a MESMA checagem, não confia que o Authorize
 * já rodou). Também reaproveitada por `POST .../commands/remote-start` (o
 * admin dispara a sessão em nome do motorista — mesma decisão de negócio).
 *
 * Só leitura local indexada (idTag único, Debt por `userId+status`, saldo
 * pela última `WalletEntry` da wallet do usuário, `PaymentIntent` via
 * `AuthToken.paymentIntent` @unique) — milissegundos, sem I/O externo,
 * respeita a regra da Nova de nunca bloquear no timeout curto do carregador.
 * NENHUMA chamada à Cielo aqui (decisão §2 da Nova) — só lê o que
 * `POST /api/me/sessions/start` já deixou gravado (F5.4, ver
 * `services/sessao/iniciarSessaoRemota.ts`).
 */
export interface AuthorizationCheckResult {
  resultado: AvaliarInicioSessaoResultado
  token: AuthToken | null
  walletBalanceCents: number
  /**
   * Pré-autorização de cartão AUTORIZADA vinculada a este idTag (via
   * `AuthToken.paymentIntent`), se houver — `StartTransaction` usa isto para
   * ligar `PaymentIntent.chargingSessionId` e gravar
   * `ChargingSession.paymentMode = 'CARD'` na mesma escrita. `null` em
   * qualquer sessão WALLET (a grande maioria dos idTags).
   */
  cardPaymentIntent: { id: string; amountAuthorizedCents: number } | null
}

export async function checkAuthorization(idTag: string, now: Date = new Date()): Promise<AuthorizationCheckResult> {
  const token = await prisma.authToken.findUnique({ where: { idTag }, include: { paymentIntent: true } })

  let walletBalanceCents = 0
  let openDebt = false
  let cardPaymentIntent: { id: string; amountAuthorizedCents: number } | null = null
  let funding: FundingSource = { kind: 'WALLET', balanceCents: 0, minStartBalanceCents: env.WALLET_MIN_START_BALANCE_CENTS }

  if (token?.userId) {
    const [debt, wallet] = await Promise.all([
      prisma.debt.findFirst({ where: { userId: token.userId, status: 'OPEN' }, select: { id: true } }),
      prisma.wallet.findUnique({ where: { userId: token.userId }, select: { id: true } }),
    ])
    openDebt = !!debt
    if (wallet) {
      const lastEntry = await prisma.walletEntry.findFirst({
        where: { walletId: wallet.id },
        orderBy: { createdAt: 'desc' },
        select: { balanceAfterCents: true },
      })
      walletBalanceCents = lastEntry?.balanceAfterCents ?? 0
    }

    const intent = token.paymentIntent
    if (intent && intent.purpose === 'SESSION_CARD_CAPTURE' && intent.status === 'AUTHORIZED') {
      cardPaymentIntent = { id: intent.id, amountAuthorizedCents: intent.amountAuthorizedCents ?? 0 }
      funding = { kind: 'CARD_PREAUTH', authorizedCents: cardPaymentIntent.amountAuthorizedCents }
    } else {
      funding = { kind: 'WALLET', balanceCents: walletBalanceCents, minStartBalanceCents: env.WALLET_MIN_START_BALANCE_CENTS }
    }
  }

  const resultado = avaliarInicioSessao({
    token: token ? { status: token.status, expiresAt: token.expiresAt, userId: token.userId } : null,
    now,
    openDebt,
    funding,
  })

  return { resultado, token, walletBalanceCents, cardPaymentIntent }
}
