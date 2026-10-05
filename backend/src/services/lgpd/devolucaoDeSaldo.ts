import { Prisma, type AccountDeletionRefundStatus } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { AppError } from '../../api/middleware/errorHandler'
import { decryptPaymentSecret } from '../../lib/crypto/paymentSecrets'
import { diffEntity } from '../../core/auditoria/diffEntity'
import { devolucaoAtrasada, idadeEmDias, PRAZO_MAXIMO_DEVOLUCAO_DIAS } from '../../core/lgpd/exclusaoDeConta'
import { writeAuditLog } from '../auditoria/writeAuditLog'

/**
 * Devolução MANUAL do saldo de conta excluída (L1.4, DL2) — a parte do ADMIN. O titular excluiu a conta com saldo, informou uma chave Pix (guardada CIFRADA) e o ADMIN faz o Pix
 * por fora; aqui ele REGISTRA que fez: lança o `WalletEntry TOPUP_REFUND` (valor negativo, ligado 1:1 ao pedido) e APAGA a chave Pix.
 *
 * Regras (as de estado/forma são do BANCO — CHECKs e triggers de `AccountDeletionRequest`, docs/MODELO-DADOS-LOTE1.md §2.2; o código só devolve o erro certo antes de chegar nelas):
 *  - só `PENDING_REFUND` pode ser devolvido; `REFUNDED` é terminal (409 `ALREADY_REFUNDED`); `NOT_REQUIRED` não tem nada a devolver (409 `REFUND_NOT_REQUIRED`);
 *  - valor = saldo do pedido, INTEGRAL (recomendação P4 do Cronos: sem devolução parcial — o resto ficaria na carteira de uma conta excluída, sem dono). Maior: 409
 *    `AMOUNT_EXCEEDS_BALANCE` (contrato); menor: 409 `PARTIAL_REFUND_NOT_ALLOWED`;
 *  - o saldo ATUAL da carteira também precisa cobrir o valor (carteira primeiro, `FOR UPDATE`, mesma ordem das demais movimentações);
 *  - a gravação da auditoria é FAIL-CLOSED na mesma transação (dinheiro por decisão de um humano — mesmo critério do ajuste manual de saldo).
 * A chave Pix decifrada só aparece na listagem do ADMIN; nunca em log, auditoria ou erro.
 */

export interface PedidoDeDevolucaoDto {
  id: string
  userId: string
  requestedAt: string
  balanceCentsAtRequest: number
  refundStatus: AccountDeletionRefundStatus
  refundPixKey: string | null
  refundedAt: string | null
  refundedByUserId: string | null
  /** Extras além do contrato (aditivos): idade do pedido em dias e se passou do prazo recomendado de 30 dias (só faz sentido enquanto `PENDING_REFUND`). */
  ageDays: number
  overdue: boolean
  /** Só presente (`true`) quando a chave guardada NÃO pôde ser decifrada (chave de cifragem trocada/perdida) — o ADMIN precisa falar com o titular por outro canal. */
  refundPixKeyUnreadable?: true
}

type LinhaDoPedido = Prisma.AccountDeletionRequestGetPayload<{
  select: { id: true; userId: true; requestedAt: true; balanceCentsAtRequest: true; refundStatus: true; refundPixKeyCiphertext: true; refundedAt: true; refundedByUserId: true }
}>

function paraDto(linha: LinhaDoPedido, agora: Date): PedidoDeDevolucaoDto {
  let refundPixKey: string | null = null
  let ilegivel = false
  if (linha.refundStatus === 'PENDING_REFUND' && linha.refundPixKeyCiphertext) {
    try {
      refundPixKey = decryptPaymentSecret(linha.refundPixKeyCiphertext)
    } catch {
      // Sem `err`: a mensagem pode nomear o formato do ciphertext. Só o id do pedido (pseudônimo) vai para o log.
      ilegivel = true
      logger.error({ requestId: linha.id }, '[lgpd] chave Pix de devolução não pôde ser decifrada (JWT_SECRET trocado? a chave dos segredos é derivada dele)')
    }
  }
  return {
    id: linha.id,
    userId: linha.userId,
    requestedAt: linha.requestedAt.toISOString(),
    balanceCentsAtRequest: linha.balanceCentsAtRequest,
    refundStatus: linha.refundStatus,
    refundPixKey,
    refundedAt: linha.refundedAt ? linha.refundedAt.toISOString() : null,
    refundedByUserId: linha.refundedByUserId,
    ageDays: idadeEmDias(linha.requestedAt, agora),
    overdue: linha.refundStatus === 'PENDING_REFUND' && devolucaoAtrasada(linha.requestedAt, agora),
    ...(ilegivel ? { refundPixKeyUnreadable: true as const } : {}),
  }
}

const SELECT_PEDIDO = { id: true, userId: true, requestedAt: true, balanceCentsAtRequest: true, refundStatus: true, refundPixKeyCiphertext: true, refundedAt: true, refundedByUserId: true } as const

export async function listarPedidosDeDevolucao(params: { status?: AccountDeletionRefundStatus | undefined; page: number; pageSize: number }, agora: Date = new Date()) {
  const where: Prisma.AccountDeletionRequestWhereInput = params.status ? { refundStatus: params.status } : {}
  const [linhas, total] = await Promise.all([
    prisma.accountDeletionRequest.findMany({
      where,
      // A fila de trabalho (PENDING_REFUND) mostra o mais ANTIGO primeiro (é o que vence); o histórico, o mais recente.
      orderBy: { requestedAt: params.status === 'PENDING_REFUND' ? 'asc' : 'desc' },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
      select: SELECT_PEDIDO,
    }),
    prisma.accountDeletionRequest.count({ where }),
  ])
  return { items: linhas.map((l) => paraDto(l, agora)), total }
}

export interface RegistrarDevolucaoParams {
  requestId: string
  amountCents: number
  proofReference: string
  actor: { userId: string; email: string; name: string; operatorId: string | null }
  request: { method: string; path: string; ipAddress: string | null; userAgent: string | null; requestId: string | null }
  agora?: Date
}

export async function registrarDevolucaoManual(params: RegistrarDevolucaoParams): Promise<PedidoDeDevolucaoDto> {
  const { requestId, amountCents, proofReference, actor, request } = params
  const agora = params.agora ?? new Date()

  const linha = await prisma.$transaction(async (tx) => {
    const pedido = (
      await tx.$queryRaw<{ id: string; userId: string; refundStatus: AccountDeletionRefundStatus; balanceCentsAtRequest: number }[]>(
        Prisma.sql`SELECT id, "userId", "refundStatus", "balanceCentsAtRequest" FROM "AccountDeletionRequest" WHERE id = ${requestId} FOR UPDATE`,
      )
    )[0]
    if (!pedido) throw new AppError('Pedido de exclusão não encontrado.', 404, 'NOT_FOUND')
    if (pedido.refundStatus === 'REFUNDED') throw new AppError('Esta devolução já foi registrada.', 409, 'ALREADY_REFUNDED')
    if (pedido.refundStatus === 'NOT_REQUIRED') throw new AppError('Este pedido não tem saldo a devolver.', 409, 'REFUND_NOT_REQUIRED')

    if (amountCents > pedido.balanceCentsAtRequest) throw new AppError('O valor é maior que o saldo do titular no pedido de exclusão.', 409, 'AMOUNT_EXCEEDS_BALANCE')
    if (amountCents < pedido.balanceCentsAtRequest) throw new AppError('A devolução precisa ser do saldo integral do titular.', 409, 'PARTIAL_REFUND_NOT_ALLOWED')

    const carteira = (await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT id FROM "Wallet" WHERE "userId" = ${pedido.userId} FOR UPDATE`))[0]
    if (!carteira) throw new AppError('O saldo atual da carteira não cobre o valor informado.', 409, 'AMOUNT_EXCEEDS_BALANCE')
    const ultimo = await tx.walletEntry.findFirst({ where: { walletId: carteira.id }, orderBy: { createdAt: 'desc' }, select: { balanceAfterCents: true } })
    const saldoAtual = ultimo?.balanceAfterCents ?? 0
    if (amountCents > saldoAtual) throw new AppError('O saldo atual da carteira não cobre o valor informado.', 409, 'AMOUNT_EXCEEDS_BALANCE')

    const lancamento = await tx.walletEntry.create({
      data: {
        walletId: carteira.id,
        type: 'TOPUP_REFUND',
        amountCents: -amountCents,
        balanceAfterCents: saldoAtual - amountCents,
        referenceType: 'ACCOUNT_DELETION',
        referenceId: pedido.id,
        description: 'Devolução de saldo por exclusão de conta',
        createdBy: actor.userId,
      },
      select: { id: true },
    })

    const atualizado = await tx.accountDeletionRequest.update({
      where: { id: pedido.id },
      data: {
        refundStatus: 'REFUNDED',
        refundPixKeyCiphertext: null, // a chave é APAGADA ao concluir (o CHECK do banco exige)
        refundedAmountCents: amountCents,
        refundProofReference: proofReference,
        refundedAt: agora,
        refundedByUserId: actor.userId,
        refundWalletEntryId: lancamento.id,
      },
      select: SELECT_PEDIDO,
    })

    await writeAuditLog(
      {
        actorUserId: actor.userId,
        actorRole: 'ADMIN',
        actorEmail: actor.email,
        actorName: actor.name,
        actorOperatorId: actor.operatorId,
        action: 'ACCOUNT_DELETION',
        actionDetail: 'refund_recorded',
        outcome: 'SUCCESS',
        httpStatus: 200,
        entityType: 'AccountDeletionRequest',
        entityId: pedido.id,
        method: request.method,
        path: request.path,
        ipAddress: request.ipAddress,
        userAgent: request.userAgent,
        requestId: request.requestId,
        // Só o valor (a chave Pix já foi apagada; o comprovante fica na linha do pedido, não duplicado aqui).
        changes: diffEntity(null, { amountCents }, ['amountCents']),
      },
      tx,
    )

    return atualizado
  })

  return paraDto(linha, agora)
}

/** Pedidos `PENDING_REFUND` há mais do prazo (30 dias) — para o alerta ao dono. Conta e o mais antigo; nunca devolve chave. */
export async function resumirDevolucoesAtrasadas(agora: Date = new Date()): Promise<{ total: number; maisAntigaDias: number | null }> {
  const limite = new Date(agora.getTime() - PRAZO_MAXIMO_DEVOLUCAO_DIAS * 86_400_000)
  const where: Prisma.AccountDeletionRequestWhereInput = { refundStatus: 'PENDING_REFUND', requestedAt: { lt: limite } }
  const [total, maisAntiga] = await Promise.all([
    prisma.accountDeletionRequest.count({ where }),
    prisma.accountDeletionRequest.findFirst({ where, orderBy: { requestedAt: 'asc' }, select: { requestedAt: true } }),
  ])
  return { total, maisAntigaDias: maisAntiga ? idadeEmDias(maisAntiga.requestedAt, agora) : null }
}

/** Emite o alerta (classificado IMPORTANTE) se há devolução atrasada. Só contagem e idade no log — nunca id de titular nem chave. */
export async function vigiarDevolucoesAtrasadas(agora: Date = new Date()): Promise<void> {
  const r = await resumirDevolucoesAtrasadas(agora)
  if (r.total === 0) return
  logger.warn(
    { alert: 'payment_refund_pending_overdue', pendentesAtrasadas: r.total, maisAntigaDias: r.maisAntigaDias, prazoDias: PRAZO_MAXIMO_DEVOLUCAO_DIAS },
    '[lgpd] há devolução de saldo de conta excluída pendente além do prazo',
  )
}
