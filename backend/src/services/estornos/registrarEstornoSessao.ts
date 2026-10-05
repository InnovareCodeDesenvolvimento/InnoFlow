import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { diffEntity } from '../../core/auditoria/diffEntity'
import { avaliarPedidoDeEstorno, avaliarTetoDoCartao, descricaoDoEstornoNoExtrato, formatarDiaMes } from '../../core/estornos/avaliarEstorno'
import { AppError } from '../../api/middleware/errorHandler'
import { writeAuditLog } from '../auditoria/writeAuditLog'
import { emitWalletUpdated } from '../../realtime/emit'
import { carregarFotoCobrancaSessao } from './fotoCobranca'
import { traduzirErroDoBancoDeEstorno, type AtorEstorno, type RequisicaoEstorno } from './tipos'

/**
 * Estorno de uma sessão paga (L1.8, DL8) — ADMIN-only. Duas saídas:
 *  - `WALLET`: crédito IMEDIATO na carteira do motorista (`WalletEntry REFUND`, `referenceType='CHARGING_SESSION'`) + `PaymentReversal` CONFIRMED, na MESMA transação
 *    (e na mesma transação da linha de auditoria, FAIL-CLOSED: sem rastro, sem dinheiro). Vale para sessão paga com carteira OU com cartão (é o padrão recomendado).
 *  - `CARD_VIA_PORTAL`: o dono já devolveu (ou vai devolver) NO PORTAL DA CIELO; aqui só se REGISTRA -> `PENDING_CONFIRMATION`, e o job `confirmarEstornosPortal`
 *    reconsulta a venda e confirma. NENHUMA chamada à Cielo acontece nesta rota (DL8: nenhuma API nossa devolve dinheiro neste lote).
 *
 * CONCORRÊNCIA: a sessão é travada `FOR NO KEY UPDATE` ANTES de qualquer leitura de soma — o MESMO lock que o trigger do banco toma no INSERT, então duas requisições
 * da mesma sessão se enfileiram aqui e a 2ª já enxerga a 1ª (ordem de lock acordada com o Cronos: SESSÃO primeiro, depois carteira/venda; `finalizarSessao` segue a mesma).
 * O trigger continua sendo a rede de segurança por baixo: se algo passar, o RAISE dele vira o mesmo 409 (`traduzirErroDoBancoDeEstorno`).
 *
 * A CONCILIAÇÃO NÃO MUDA: o estorno é informativo (`amountRefundedCents`/`WalletEntry REFUND`); o status do intent continua CAPTURED.
 */

export interface RegistrarEstornoParams {
  sessionId: string
  amountCents: number
  reason: string
  destination: 'WALLET' | 'CARD_VIA_PORTAL'
  portalReference?: string
  ator: AtorEstorno
  requisicao: RequisicaoEstorno
}

export interface RegistrarEstornoResultado {
  refundId: string
  status: 'CONFIRMED' | 'PENDING_CONFIRMATION'
}

interface SessaoTravada {
  id: string
  userId: string
  status: string
  totalCostCents: number | null
  startedAt: Date
  siteId: string
}

export async function registrarEstornoSessao(params: RegistrarEstornoParams): Promise<RegistrarEstornoResultado> {
  const { sessionId, amountCents, reason, destination, portalReference, ator, requisicao } = params

  let saldoApos: number | null = null
  let motoristaId = ''
  let resultado: RegistrarEstornoResultado
  try {
    resultado = await prisma.$transaction(async (tx) => {
      // 1) LOCK da sessão primeiro (mesmo lock do trigger do banco).
      const linhas = await tx.$queryRaw<SessaoTravada[]>(
        Prisma.sql`SELECT id, "userId", status::text AS status, "totalCostCents", "startedAt", "siteId" FROM "ChargingSession" WHERE id = ${sessionId} FOR NO KEY UPDATE`,
      )
      const sessao = linhas[0]
      if (!sessao) throw new AppError('Sessão não encontrada.', 404, 'SESSION_NOT_FOUND')
      motoristaId = sessao.userId
      // Só sessão ENCERRADA foi cobrada (débito/captura acontecem no fechamento). Aberta/travada: não há o que estornar ainda.
      if (sessao.status !== 'STOPPED') throw new AppError('Esta sessão ainda não foi cobrada: não há o que estornar.', 409, 'SESSION_NOT_BILLED')

      // 2) O que a sessão de fato cobrou e o que já foi estornado (pendentes no portal incluídos: seguram o teto).
      const { foto, intentsCartao } = await carregarFotoCobrancaSessao(tx, sessionId, sessao.totalCostCents)
      const avaliacao = avaliarPedidoDeEstorno(foto, amountCents)
      if (!avaliacao.ok) {
        if (avaliacao.codigo === 'SESSION_NOT_BILLED') throw new AppError('Esta sessão não foi cobrada: não há o que estornar.', 409, 'SESSION_NOT_BILLED')
        throw new AppError('O valor passa do que ainda pode ser estornado nesta sessão.', 409, 'AMOUNT_EXCEEDS_REFUNDABLE', { refundableCents: avaliacao.reembolsavelCents })
      }

      let paymentIntentId: string | null = null
      if (destination === 'CARD_VIA_PORTAL') {
        // Devolução no portal só existe para venda de CARTÃO capturada desta sessão.
        const intent = intentsCartao[0]
        if (!intent || !intent.amountCapturedCents) throw new AppError('Esta sessão não foi paga com cartão: não há venda na Cielo para devolver.', 409, 'NO_CARD_PAYMENT')
        const jaNoPortal = await tx.paymentReversal.aggregate({
          _sum: { amountCents: true },
          where: { paymentIntentId: intent.id, kind: 'REFUND', destination: 'CARD_VIA_PORTAL', status: { not: 'CANCELLED' } },
        })
        const teto = avaliarTetoDoCartao({ capturadoCents: intent.amountCapturedCents, devolucoesNoPortalCents: jaNoPortal._sum.amountCents ?? 0, amountCents })
        if (!teto.ok) throw new AppError('O valor passa do que foi capturado no cartão.', 409, 'AMOUNT_EXCEEDS_REFUNDABLE', { refundableCents: teto.disponivelCents })
        paymentIntentId = intent.id
      }

      const agora = new Date()
      let reversal
      if (destination === 'WALLET') {
        const motorista = await tx.user.findUnique({ where: { id: sessao.userId }, select: { deletedAt: true } })
        if (motorista?.deletedAt) throw new AppError('A conta do motorista foi excluída: não há carteira para receber o estorno.', 409, 'DRIVER_ACCOUNT_DELETED')

        const existente = await tx.wallet.findUnique({ where: { userId: sessao.userId }, select: { id: true } })
        const carteira = existente ?? (await tx.wallet.create({ data: { userId: sessao.userId }, select: { id: true } }))
        await tx.$queryRaw(Prisma.sql`SELECT id FROM "Wallet" WHERE id = ${carteira.id} FOR UPDATE`)
        const ultima = await tx.walletEntry.findFirst({ where: { walletId: carteira.id }, orderBy: { createdAt: 'desc' }, select: { balanceAfterCents: true } })
        const saldoAntes = ultima?.balanceAfterCents ?? 0
        const site = await tx.site.findUnique({ where: { id: sessao.siteId }, select: { timezone: true } })

        const lancamento = await tx.walletEntry.create({
          data: {
            walletId: carteira.id,
            type: 'REFUND',
            amountCents,
            balanceAfterCents: saldoAntes + amountCents,
            referenceType: 'CHARGING_SESSION',
            referenceId: sessionId,
            description: descricaoDoEstornoNoExtrato(formatarDiaMes(sessao.startedAt, site?.timezone ?? 'UTC')),
            createdBy: ator.userId,
          },
        })
        saldoApos = lancamento.balanceAfterCents
        reversal = await tx.paymentReversal.create({
          data: {
            kind: 'REFUND',
            status: 'CONFIRMED',
            destination: 'WALLET',
            chargingSessionId: sessionId,
            paymentIntentId: null,
            userId: sessao.userId, // reescrito pelo trigger a partir da sessão; o tipo do Prisma exige o campo
            amountCents,
            reason,
            walletEntryId: lancamento.id,
            createdByUserId: ator.userId,
            resolvedAt: agora,
            resolvedByUserId: ator.userId,
          },
        })
      } else {
        reversal = await tx.paymentReversal.create({
          data: {
            kind: 'REFUND',
            status: 'PENDING_CONFIRMATION',
            destination: 'CARD_VIA_PORTAL',
            chargingSessionId: sessionId,
            paymentIntentId,
            userId: sessao.userId,
            amountCents,
            reason,
            portalReference: portalReference ?? null,
            createdByUserId: ator.userId,
          },
        })
      }

      // FAIL-CLOSED: se a auditoria não grava, o estorno inteiro (lançamento incluído) reverte. SEM o texto do motivo (texto livre pode ter nome) e SEM dado do motorista além do id.
      await writeAuditLog(
        {
          actorUserId: ator.userId,
          actorRole: ator.role,
          actorEmail: ator.email,
          actorName: ator.name,
          actorOperatorId: ator.operatorId,
          action: 'REFUND',
          actionDetail: destination === 'WALLET' ? 'refund:wallet' : 'refund:card_via_portal',
          outcome: 'SUCCESS',
          httpStatus: 201,
          entityType: 'PaymentReversal',
          entityId: reversal.id,
          method: requisicao.method,
          path: requisicao.path,
          ipAddress: requisicao.ipAddress,
          userAgent: requisicao.userAgent,
          requestId: requisicao.requestId,
          changes: diffEntity(
            null,
            { amountCents, destination, status: reversal.status, chargingSessionId: sessionId, paymentIntentId, targetUserId: sessao.userId, hasPortalReference: portalReference !== undefined },
            ['amountCents', 'destination', 'status', 'chargingSessionId', 'paymentIntentId', 'targetUserId', 'hasPortalReference'],
          ),
        },
        tx,
      )

      return { refundId: reversal.id, status: reversal.status as RegistrarEstornoResultado['status'] }
    })
  } catch (err) {
    const traduzido = traduzirErroDoBancoDeEstorno(err)
    if (traduzido) throw traduzido
    throw err
  }

  logger.info({ refundId: resultado.refundId, sessionId, destination, status: resultado.status, amountCents, actorUserId: ator.userId }, '[estorno] estorno de sessão registrado')

  // Depois do commit (nunca antes de a linha existir): o PWA do motorista atualiza o saldo na hora.
  if (saldoApos !== null) {
    await emitWalletUpdated(motoristaId, saldoApos).catch((err) => logger.error({ err, userId: motoristaId }, '[estorno] falha ao publicar wallet.updated após o estorno (best-effort)'))
  }
  return resultado
}
