import { Prisma, type PrismaClient, type WalletEntryType } from '@prisma/client'

/**
 * Débito atômico da carteira no fim de uma sessão de recarga (`StopTransaction`).
 * NÃO é núcleo puro (precisa de Prisma/transação) — mora em `services/`, não
 * em `core/` (ver eslint.config.mjs: `@prisma/client` é banido em `src/core/**`).
 *
 * Contrato LITERAL do `WalletEntry` de débito (não é detalhe — é o que faz a
 * retaguarda (`paymentsService.ts`) enxergar a sessão real, não só o
 * sintético do Cronos): `type='CHARGE_DEBIT'`, `referenceType=
 * 'CHARGING_SESSION'`, `referenceId = ChargingSession.id` (o cuid, NUNCA o
 * `ocppTransactionId`). Errar isso não dá erro nenhum — só faz a retaguarda
 * nunca enxergar o débito.
 *
 * Rede de segurança de banco: índice único parcial `ux_wallet_entry_charge_
 * debit_once` (`WalletEntry(referenceType, referenceId) WHERE type =
 * 'CHARGE_DEBIT'`, migration do Cronos 20260917140000) — se a idempotência em
 * memória abaixo escapar por alguma corrida real, o segundo INSERT falha com
 * unique_violation em vez de duplicar a cobrança silenciosamente. Mesma
 * proteção para `Debt` via `ux_debt_open_per_session`.
 */

type Tx = Prisma.TransactionClient | PrismaClient

export interface DebitarSessaoParams {
  tx: Tx
  session: { id: string; userId: string; ocppTransactionId: number; operatorId: string | null }
  siteName: string
  custoTotalCents: number
}

export interface DebitarSessaoResultado {
  /** Quanto foi de fato debitado da carteira (pode ser menor que `custoTotalCents` se o saldo não cobria tudo). */
  debitedCents: number
  /** = `custoTotalCents - debitedCents` — o que sobrou como `Debt` (0 se cobriu tudo). */
  remainingDebtCents: number
  walletEntryId: string | null
  debtId: string | null
}

const ZERO_RESULT: DebitarSessaoResultado = { debitedCents: 0, remainingDebtCents: 0, walletEntryId: null, debtId: null }

/**
 * `SELECT ... FOR UPDATE` na `Wallet` do usuário — serializa qualquer débito
 * concorrente da MESMA carteira (duas sessões do mesmo motorista terminando
 * quase ao mesmo tempo, ou o handler inline correndo junto com um retry do
 * job de liquidação). Lança se o usuário não tiver `Wallet` — não deveria
 * acontecer na prática: `avaliarInicioSessao` já bloqueia o início da sessão
 * (saldo < mínimo, e saldo de usuário sem carteira é tratado como 0) para
 * quem nunca teve uma carteira criada.
 */
async function lockWalletForUpdate(tx: Tx, userId: string): Promise<{ id: string }> {
  const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT id FROM "Wallet" WHERE "userId" = ${userId} FOR UPDATE`)
  const wallet = rows[0]
  if (!wallet) {
    throw new Error(`walletLedger: usuário ${userId} não tem Wallet cadastrada — não é possível debitar/creditar.`)
  }
  return wallet
}

/** Saldo atual = `balanceAfterCents` da última `WalletEntry` (append-only, nunca soma o histórico inteiro). `0` se a carteira ainda não tem nenhuma entrada. */
async function getCurrentBalanceCents(tx: Tx, walletId: string): Promise<number> {
  const lastEntry = await tx.walletEntry.findFirst({ where: { walletId }, orderBy: { createdAt: 'desc' }, select: { balanceAfterCents: true } })
  return lastEntry?.balanceAfterCents ?? 0
}

export async function debitarSessao(params: DebitarSessaoParams): Promise<DebitarSessaoResultado> {
  const { tx, session, siteName, custoTotalCents } = params

  const wallet = await lockWalletForUpdate(tx, session.userId)

  // Idempotência: sessão já liquidada antes (reconexão do carregador gerando
  // StopTransaction com novo ocppMessageId para o mesmo evento lógico, OU
  // reprocessamento pelo job de retry) — não duplica nem o débito nem a
  // dívida. Checado DEPOIS do FOR UPDATE de propósito: serializa qualquer
  // tentativa concorrente de liquidar a MESMA sessão via a mesma carteira,
  // garantindo que só a primeira realmente escreve.
  const [existingEntry, existingDebt] = await Promise.all([
    tx.walletEntry.findFirst({ where: { type: 'CHARGE_DEBIT', referenceType: 'CHARGING_SESSION', referenceId: session.id } }),
    tx.debt.findFirst({ where: { chargingSessionId: session.id, reason: 'INSUFFICIENT_WALLET_BALANCE' } }),
  ])
  if (existingEntry || existingDebt) {
    return {
      debitedCents: existingEntry ? -existingEntry.amountCents : 0,
      remainingDebtCents: existingDebt?.amountCents ?? 0,
      walletEntryId: existingEntry?.id ?? null,
      debtId: existingDebt?.id ?? null,
    }
  }

  if (custoTotalCents <= 0) {
    // Sessão gratuita (ex.: energyDeliveredWh=0, falha instantânea) — nada a
    // debitar, nada a registrar. Idempotente por construção (nunca escreve).
    return ZERO_RESULT
  }

  const saldoAtual = await getCurrentBalanceCents(tx, wallet.id)
  const debitar = Math.min(Math.max(saldoAtual, 0), custoTotalCents)
  const faltou = custoTotalCents - debitar

  // Só cria WalletEntry se de fato debitou algo — um débito de R$0,00 não é
  // "pagamento via carteira" para a leitura de `paymentMethod` derivado
  // (`reportsService.ts`: `EXISTS WalletEntry type=CHARGE_DEBIT`), então uma
  // entrada de valor zero marcaria erroneamente uma sessão 100% inadimplente
  // como "paga pela carteira".
  let walletEntryId: string | null = null
  if (debitar > 0) {
    const entry = await tx.walletEntry.create({
      data: {
        walletId: wallet.id,
        type: 'CHARGE_DEBIT',
        amountCents: -debitar,
        balanceAfterCents: saldoAtual - debitar,
        referenceType: 'CHARGING_SESSION',
        referenceId: session.id,
        description: `Recarga ${session.ocppTransactionId} — ${siteName}`,
      },
    })
    walletEntryId = entry.id
  }

  let debtId: string | null = null
  if (faltou > 0) {
    const debt = await tx.debt.create({
      data: {
        userId: session.userId,
        operatorId: session.operatorId,
        chargingSessionId: session.id,
        amountCents: faltou,
        status: 'OPEN',
        reason: 'INSUFFICIENT_WALLET_BALANCE',
      },
    })
    debtId = debt.id
  }

  return { debitedCents: debitar, remainingDebtCents: faltou, walletEntryId, debtId }
}

// ------------------------------------------------------------
// Crédito/débito manual do ADMIN (`POST /api/admin/drivers/:id/wallet/entries`)
// — mesmo padrão de FOR UPDATE + saldo derivado da última entrada, mas tipo
// ADJUSTMENT_CREDIT/ADJUSTMENT_DEBIT e sem idempotência por referenceId
// (é uma ação discricionária do admin, não um evento de sessão que possa
// ser reenviado pelo protocolo OCPP).
// ------------------------------------------------------------

export interface AjustarCarteiraParams {
  tx: Tx
  userId: string
  /** != 0. > 0 credita, < 0 debita — validado pelo schema Zod da rota antes de chegar aqui. */
  amountCents: number
  description: string
  createdByUserId: string
}

export class SaldoInsuficienteError extends Error {}

export interface AjustarCarteiraResultado {
  entry: {
    id: string
    type: WalletEntryType
    amountCents: number
    balanceAfterCents: number
    referenceType: string | null
    referenceId: string | null
    description: string | null
    createdAt: Date
  }
}

export async function ajustarCarteira(params: AjustarCarteiraParams): Promise<AjustarCarteiraResultado> {
  const { tx, userId, amountCents, description, createdByUserId } = params

  // Wallet pode não existir ainda (motorista nunca recarregou nem foi
  // creditado) — o ADMIN pode ser o primeiro a criar saldo para ele.
  const existingWallet = await tx.wallet.findUnique({ where: { userId }, select: { id: true } })
  const wallet = existingWallet ?? (await tx.wallet.create({ data: { userId } }))
  await tx.$queryRaw(Prisma.sql`SELECT id FROM "Wallet" WHERE id = ${wallet.id} FOR UPDATE`)

  const saldoAtual = await getCurrentBalanceCents(tx, wallet.id)

  if (amountCents < 0 && Math.abs(amountCents) > saldoAtual) {
    throw new SaldoInsuficienteError(`Saldo insuficiente para debitar ${Math.abs(amountCents)} centavos (saldo atual: ${saldoAtual}).`)
  }

  const entry = await tx.walletEntry.create({
    data: {
      walletId: wallet.id,
      type: amountCents > 0 ? 'ADJUSTMENT_CREDIT' : 'ADJUSTMENT_DEBIT',
      amountCents,
      balanceAfterCents: saldoAtual + amountCents,
      referenceType: 'MANUAL',
      referenceId: null,
      description,
      createdBy: createdByUserId,
    },
  })

  return { entry }
}
