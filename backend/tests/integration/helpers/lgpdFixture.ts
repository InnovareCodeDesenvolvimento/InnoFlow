import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import type { ChargingSessionStatus, Prisma } from '@prisma/client'
import { prisma } from '../../../src/lib/prisma'
import { issueToken } from '../../../src/lib/jwt'
import type { TestTenant } from './fixtures'

/**
 * Fixtures do lote LGPD/termos (L1.4/L1.9): motorista COM senha (hash bcrypt de custo baixo — a senha é só para o teste), carteira com saldo, sessão em qualquer estado, dívida
 * e intent. Tudo com sufixo único (as suítes rodam em paralelo no mesmo banco) e SEM apagar nada depois: `WalletEntry`/`ConsentRecord`/`AuditLog` são append-only.
 */

export const SENHA_DO_MOTORISTA = 'Senha-Forte-123'

/** CPF válido gerado a cada execução (índice único global de CPF; o banco de teste persiste entre rodadas). */
export function gerarCpf(): string {
  const base = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10))
  if (base.every((d) => d === base[0])) base[8] = (base[8]! + 1) % 10
  const dv = (digs: number[]) => {
    const soma = digs.reduce((acc, d, i) => acc + d * (digs.length + 1 - i), 0)
    const r = (soma * 10) % 11
    return r === 10 ? 0 : r
  }
  const d1 = dv(base)
  const d2 = dv([...base, d1])
  return [...base, d1, d2].join('')
}

export interface Motorista {
  id: string
  email: string
  name: string
  cpf: string
  token: string
  auth: { Authorization: string }
  walletId: string
}

export async function criarMotoristaComSenha(suffix: string, label: string, opcoes: { saldoCents?: number; googleSub?: string; semSenha?: boolean } = {}): Promise<Motorista> {
  const email = `${label}-${suffix}@example.com`
  const name = `Motorista ${label} ${suffix}`
  const cpf = gerarCpf()
  const user = await prisma.user.create({
    data: {
      role: 'DRIVER',
      name,
      email,
      phone: '(11) 91234-5678',
      cpf,
      passwordHash: opcoes.semSenha ? null : await bcrypt.hash(SENHA_DO_MOTORISTA, 4),
      googleSub: opcoes.googleSub ?? null,
    },
  })
  const wallet = await prisma.wallet.create({ data: { userId: user.id } })
  if (opcoes.saldoCents && opcoes.saldoCents > 0) {
    await prisma.walletEntry.create({
      data: { walletId: wallet.id, type: 'ADJUSTMENT_CREDIT', amountCents: opcoes.saldoCents, balanceAfterCents: opcoes.saldoCents, referenceType: 'MANUAL', description: `crédito de teste ${suffix}` },
    })
  }
  const token = issueToken({ id: user.id, role: 'DRIVER', operatorId: null })
  return { id: user.id, email, name, cpf, token, auth: { Authorization: `Bearer ${token}` }, walletId: wallet.id }
}

const tariffSnapshot = {
  id: 'placeholder',
  model: 'PER_KWH',
  pricePerKwh: '1.00',
  pricePerMinute: null,
  sessionFeeCents: null,
  minChargeCents: null,
  idleFeePerMinute: 0,
  idleGracePeriodSeconds: 0,
  windows: [],
} as unknown as Prisma.InputJsonValue

export async function criarSessao(
  tenant: TestTenant,
  userId: string,
  status: ChargingSessionStatus,
  extra: { startIp?: string; startUserAgent?: string; totalCostCents?: number; idTag?: string } = {},
): Promise<{ id: string; authTokenId: string }> {
  const idTag = extra.idTag ?? `T${randomUUID().replace(/-/g, '')}`.slice(0, 20)
  const authToken = await prisma.authToken.create({ data: { idTag, type: 'VIRTUAL', userId, status: 'ACCEPTED' } })
  // Só UMA sessão aberta por conector (índice único parcial): sessão aberta ganha um conector PRÓPRIO; as encerradas dividem o do tenant.
  const conector = status === 'STOPPED' ? { id: tenant.connectorId } : await prisma.connector.create({ data: { operatorId: tenant.operatorId, chargePointId: tenant.chargePointId, connectorId: 100 + Math.floor(Math.random() * 1_000_000), type: 'AC_TYPE2' } })
  const sessao = await prisma.chargingSession.create({
    data: {
      operatorId: tenant.operatorId,
      siteId: tenant.siteId,
      chargePointId: tenant.chargePointId,
      connectorId: conector.id,
      authTokenId: authToken.id,
      userId,
      status,
      meterStartWh: 0,
      startedAt: new Date(Date.now() - 3_600_000),
      tariffId: tenant.tariffId,
      tariffSnapshot,
      ...(status === 'STOPPED' ? { meterStopWh: 10_000, energyDeliveredWh: 10_000, stoppedAt: new Date(), totalCostCents: extra.totalCostCents ?? 1000, energyCostCents: extra.totalCostCents ?? 1000 } : {}),
      ...(status === 'STOP_UNCONFIRMED' ? { unconfirmedAt: new Date(), unconfirmedReason: 'STOP_NOT_CONFIRMED' as const } : {}),
      ...(extra.startIp ? { startIp: extra.startIp } : {}),
      ...(extra.startUserAgent ? { startUserAgent: extra.startUserAgent } : {}),
    },
  })
  return { id: sessao.id, authTokenId: authToken.id }
}
