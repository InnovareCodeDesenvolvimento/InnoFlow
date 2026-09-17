import type { AuthToken } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { env } from '../lib/env'
import { avaliarInicioSessao, type AvaliarInicioSessaoResultado } from '../core/carteira/avaliarInicioSessao'

/**
 * Checagem de autorização compartilhada entre `Authorize` e `StartTransaction`
 * (o Authorize é opcional no protocolo — o carregador pode ir direto pro
 * Start, então o Start repete a MESMA checagem, não confia que o Authorize
 * já rodou). Também reaproveitada por `POST .../commands/remote-start` (o
 * admin dispara a sessão em nome do motorista — mesma decisão de negócio).
 *
 * Só leitura local indexada (idTag único, Debt por `userId+status`, saldo
 * pela última `WalletEntry` da wallet do usuário) — milissegundos, sem I/O
 * externo, respeita a regra da Nova de nunca bloquear no timeout curto do
 * carregador.
 */
export interface AuthorizationCheckResult {
  resultado: AvaliarInicioSessaoResultado
  token: AuthToken | null
  walletBalanceCents: number
}

export async function checkAuthorization(idTag: string, now: Date = new Date()): Promise<AuthorizationCheckResult> {
  const token = await prisma.authToken.findUnique({ where: { idTag } })

  let walletBalanceCents = 0
  let openDebt = false

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
  }

  const resultado = avaliarInicioSessao({
    token: token ? { status: token.status, expiresAt: token.expiresAt, userId: token.userId } : null,
    now,
    openDebt,
    walletBalanceCents,
    minStartBalanceCents: env.WALLET_MIN_START_BALANCE_CENTS,
  })

  return { resultado, token, walletBalanceCents }
}
