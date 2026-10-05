import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { AppError } from '../../api/middleware/errorHandler'
import { sessionValidator } from '../../api/lib/sessionValidatorInstance'
import { isPaymentSecretsKeyConfigured, encryptPaymentSecret } from '../../lib/crypto/paymentSecrets'
import { listarEstadosSessaoVigiada } from '../../core/sessao/estadosSessao'
import { normalizarChavePix } from '../../core/lgpd/chavePix'
import { decidirExclusao, emailAnonimo, JANELA_INTENT_CREATED_MS, MARCADOR_TOKEN_CARTAO_DESTRUIDO, MENSAGEM_DA_RECUSA, NOME_CONTA_EXCLUIDA, statusDaResposta } from '../../core/lgpd/exclusaoDeConta'
import { writeAuditLog } from '../auditoria/writeAuditLog'

/**
 * Exclusão de conta do motorista (L1.4, LGPD art. 18 VI) = ANONIMIZAÇÃO, nunca DELETE: a PESSOA some, o FATO contábil (sessões, extrato, pagamentos, dívidas) fica ligado a um id
 * pseudônimo — obrigação legal/fiscal (art. 16). O banco impõe o estado final (CHECK `user_deleted_is_anonymized`, docs/MODELO-DADOS-LOTE1.md §3.1): qualquer desvio do UPDATE abaixo é recusado.
 *
 * UMA transação, nesta ordem (a ordem dos LOCKS importa):
 *  1. `Wallet FOR UPDATE` e depois `User FOR UPDATE` — mesma ordem de `finalizarSessao`/`walletLedger` (carteira primeiro), para não criar um ciclo de espera com a liquidação de uma sessão;
 *     congela o saldo e serializa duas exclusões simultâneas (a 2ª, ao enxergar `deletedAt`, devolve o MESMO resultado — idempotente);
 *  2. confere as pré-condições (sessão/pagamento em andamento, dívida aberta, saldo -> chave Pix) com a decisão pura de `core/lgpd/exclusaoDeConta.ts`;
 *  3. `AccountDeletionRequest` (chave Pix CIFRADA com o núcleo AES-GCM dos pagamentos — nunca em claro, nunca em log);
 *  4. o UPDATE do usuário; cartões -> marcador `DESTROYED` (o token da Cielo deixa de existir para nós); tokens de autorização -> `BLOCKED`;
 *  5. IP do aceite dos termos e IP/User-Agent de início das sessões -> NULL (dado pessoal que sobrevive à anonimização; as sessões em si ficam);
 *  6. auditoria `ACCOUNT_DELETION` FAIL-CLOSED (mesma transação): o snapshot do ator já nasce ANONIMIZADO (e-mail/nome do tombstone, sem IP/UA) — o AuditLog é append-only e a linha
 *     do próprio evento não pode criar dado pessoal novo (recomendação P1 do Cronos).
 * Depois do commit: o cache de sessão deste processo solta o usuário (o token atual deixa de valer na hora; em outras réplicas, em até 30 s — mesma regra da troca de senha).
 *
 * Residual conhecido (documentado): uma sessão iniciada NO MESMO INSTANTE por outro caminho que não consulta `User.active` (ex.: o StartTransaction de um carregador que recebeu o
 * comando antes do commit) só é barrada pelo `active=false` no handler OCPP; este serviço enxerga as sessões já commitadas.
 */

export interface ResultadoDaExclusao {
  status: 'DELETED' | 'DELETED_PENDING_REFUND'
  requestId: string
  /** `true` = a conta já estava excluída (2ª chamada/corrida): nada foi feito agora — quem chama NÃO deve notificar de novo. */
  jaExcluida: boolean
  /**
   * Dados para o aviso `ACCOUNT_DELETED` (L1.6). O e-mail só existe aqui, EM MEMÓRIA, durante esta chamada (depois do UPDATE ele deixou de existir no banco): quem enfileirar o
   * aviso deve levá-lo no payload do job e REMOVER o payload ao concluir. `null` quando `jaExcluida`.
   */
  notificar: { email: string; nome: string } | null
}

export interface ExcluirContaParams {
  userId: string
  /** Chave Pix para a devolução do saldo — só é lida se houver saldo positivo. */
  refundPixKey?: string | undefined
  agora?: Date
}

type Tx = Prisma.TransactionClient

async function lerSaldoEBloquearCarteira(tx: Tx, userId: string): Promise<number> {
  const carteira = (await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT id FROM "Wallet" WHERE "userId" = ${userId} FOR UPDATE`))[0]
  if (!carteira) return 0
  const ultimo = await tx.walletEntry.findFirst({ where: { walletId: carteira.id }, orderBy: { createdAt: 'desc' }, select: { balanceAfterCents: true } })
  return ultimo?.balanceAfterCents ?? 0
}

export async function excluirContaDoMotorista(params: ExcluirContaParams): Promise<ResultadoDaExclusao> {
  const { userId } = params
  const agora = params.agora ?? new Date()

  // A chave Pix é normalizada/validada e cifrada ANTES da transação (CPU, sem tocar o banco). Só é USADA se houver saldo — a decisão é tomada sob lock, com o saldo real.
  const chaveBruta = params.refundPixKey?.trim() ? params.refundPixKey : undefined
  const chaveNormalizada = chaveBruta !== undefined ? normalizarChavePix(chaveBruta) : null
  let chaveCifrada: string | null = null
  if (chaveNormalizada !== null) {
    if (!isPaymentSecretsKeyConfigured()) {
      // Sem a chave de cifragem não há como guardar a chave Pix com segurança — recusa em vez de guardar em claro ou perder o pedido.
      throw new AppError('Não foi possível processar a devolução do saldo agora. Tente novamente mais tarde.', 503, 'PAYMENT_SECRETS_KEY_MISSING')
    }
    chaveCifrada = encryptPaymentSecret(chaveNormalizada)
  }

  const resultado = await prisma.$transaction(async (tx): Promise<ResultadoDaExclusao> => {
    const saldoCents = await lerSaldoEBloquearCarteira(tx, userId)

    const usuario = (await tx.$queryRaw<{ role: string; deletedAt: Date | null; email: string; name: string }[]>(Prisma.sql`SELECT role, "deletedAt", email, name FROM "User" WHERE id = ${userId} FOR UPDATE`))[0]
    if (!usuario) throw new AppError('Conta não encontrada.', 404, 'NOT_FOUND')
    if (usuario.role !== 'DRIVER') throw new AppError('Esta conta não pode ser excluída por aqui.', 403, 'FORBIDDEN')

    if (usuario.deletedAt !== null) {
      const pedido = await tx.accountDeletionRequest.findUnique({ where: { userId }, select: { id: true, refundStatus: true } })
      if (!pedido) throw new AppError('Conta não encontrada.', 404, 'NOT_FOUND') // inalcançável: o CHECK/trigger do banco só deixa `deletedAt` com o pedido criado na mesma transação
      return { status: statusDaResposta(pedido.refundStatus), requestId: pedido.id, jaExcluida: true, notificar: null }
    }

    const [sessoesEmAndamento, pagamentosEmAndamento, dividasAbertas] = await Promise.all([
      tx.chargingSession.count({ where: { userId, status: { in: listarEstadosSessaoVigiada() } } }),
      tx.paymentIntent.count({
        where: { userId, OR: [{ status: { in: ['AUTHORIZED', 'CAPTURE_PENDING', 'PENDING'] } }, { status: 'CREATED', createdAt: { gt: new Date(agora.getTime() - JANELA_INTENT_CREATED_MS) } }] },
      }),
      tx.debt.count({ where: { userId, status: 'OPEN' } }),
    ])

    const decisao = decidirExclusao({
      sessoesEmAndamento,
      pagamentosEmAndamento,
      dividasAbertas,
      saldoCents,
      chavePix: chaveBruta === undefined ? 'AUSENTE' : chaveNormalizada === null ? 'INVALIDA' : 'VALIDA',
    })
    if (!decisao.permitida) {
      const { status, mensagem } = MENSAGEM_DA_RECUSA[decisao.recusa]
      // O contrato não tem código próprio para chave Pix malformada: sai como validação do campo.
      if (decisao.recusa === 'REFUND_PIX_KEY_INVALID') throw new AppError(mensagem, status, 'VALIDATION_ERROR', [{ path: 'refundPixKey', message: 'chave Pix inválida' }])
      throw new AppError(mensagem, status, decisao.recusa)
    }

    const pedido = await tx.accountDeletionRequest.create({
      data: {
        userId,
        balanceCentsAtRequest: decisao.saldoCents,
        refundStatus: decisao.refundStatus,
        // `NOT_REQUIRED` PROÍBE chave (CHECK): sem saldo, a chave informada é descartada sem nunca ter sido gravada.
        refundPixKeyCiphertext: decisao.refundStatus === 'PENDING_REFUND' ? chaveCifrada : null,
      },
      select: { id: true },
    })

    // O UPDATE EXATO que o CHECK `user_deleted_is_anonymized` exige (docs/MODELO-DADOS-LOTE1.md §3.1). Nada além disto.
    await tx.user.update({
      where: { id: userId },
      data: {
        name: NOME_CONTA_EXCLUIDA,
        email: emailAnonimo(userId),
        phone: null,
        cpf: null,
        googleSub: null,
        passwordHash: null,
        active: false,
        sessionsValidAfter: agora,
        deletedAt: agora,
      },
    })

    await tx.paymentMethod.updateMany({ where: { userId }, data: { active: false, isDefault: false, holderName: null, cieloCardTokenCiphertext: MARCADOR_TOKEN_CARTAO_DESTRUIDO } })
    await tx.authToken.updateMany({ where: { userId }, data: { status: 'BLOCKED' } })
    await tx.consentRecord.updateMany({ where: { userId, ip: { not: null } }, data: { ip: null } })
    await tx.chargingSession.updateMany({ where: { userId, OR: [{ startIp: { not: null } }, { startUserAgent: { not: null } }] }, data: { startIp: null, startUserAgent: null } })

    await writeAuditLog(
      {
        actorUserId: userId,
        actorRole: 'DRIVER',
        // Snapshot do ator JÁ ANONIMIZADO: a tabela é append-only e esta linha não pode nascer com o e-mail/nome reais do titular.
        actorEmail: emailAnonimo(userId),
        actorName: NOME_CONTA_EXCLUIDA,
        action: 'ACCOUNT_DELETION',
        actionDetail: `account_deleted:${decisao.refundStatus}`,
        outcome: 'SUCCESS',
        httpStatus: 200,
        entityType: 'User',
        entityId: userId,
        method: 'POST',
        path: '/api/me/account/deletion',
        // Sem IP/User-Agent de propósito (dado pessoal na tabela imutável).
        ipAddress: null,
        userAgent: null,
      },
      tx,
    )

    return { status: statusDaResposta(decisao.refundStatus), requestId: pedido.id, jaExcluida: false, notificar: { email: usuario.email, nome: usuario.name } }
  })

  sessionValidator.invalidate(userId)
  if (!resultado.jaExcluida) logger.info({ userId, status: resultado.status }, '[lgpd] conta excluída (anonimizada)')
  return resultado
}
