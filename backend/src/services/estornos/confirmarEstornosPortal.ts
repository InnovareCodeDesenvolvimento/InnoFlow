import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { env } from '../../lib/env'
import type { PagamentoPort } from '../../core/pagamentos/porta'
import { SYSTEM_ACTOR } from '../../core/auditoria/systemActor'
import { foraDaJanelaDeConsulta, interpretarReconsultaEstorno } from '../../core/estornos/interpretarReconsultaEstorno'
import { writeAuditLog } from '../auditoria/writeAuditLog'
import { ambienteDoIntentConfere } from '../pagamentos/ambienteDoIntent'
import { getPagamentoPort, isPagamentoDisponivel, isUsandoFakeAdapter } from '../pagamentos/pagamentoPortInstance'

/**
 * Confirma as devoluções pelo PORTAL DA CIELO (L1.8, DL8) — roda no worker, de tempos em tempos (`REFUND_PORTAL_SCAN_INTERVAL_MS`, 30 min). O ADMIN já fez o estorno no portal e REGISTROU aqui
 * (`PENDING_CONFIRMATION`); este job RECONSULTA a venda na Cielo (`consultar(PaymentId)`, só leitura) e, quando a consulta PROVA o estorno, marca `CONFIRMED` (o trigger do banco atualiza
 * `PaymentIntent.amountRefundedCents`). NUNCA chama void/estorno: nenhuma API nossa devolve dinheiro neste lote.
 *
 * REGRA (ver `core/estornos/interpretarReconsultaEstorno.ts`): só `Status 11` (Refunded) com o registro cobrindo o capturado INTEIRO confirma. Estorno PARCIAL e qualquer resposta que não
 * sabemos ler ficam como "não confirmado" — a forma da consulta num estorno parcial NUNCA foi vista (sem sandbox). Nunca confirma por falta de informação.
 *
 * INERTE E SEGURO: sem credencial Cielo (produção bloqueada), com o adaptador FAKE, ou com a configuração ilegível, a rodada é PULADA (nada é lido nem escrito). Um intent de OUTRO
 * ambiente que o gateway efetivo não é consultado (host errado => "não encontrado" enganoso). Falha de rede/Cielo numa venda só pula AQUELA venda. Conta Cielo COMPARTILHADA com o
 * Parque: é UMA consulta por venda pendente por rodada, nada mais.
 *
 * ALERTAS (deduplicados pelo N-7 por venda + motivo): devolução pendente há mais de `REFUND_PORTAL_PENDING_ALERT_HOURS`; passada a janela de consulta (~3 meses) o job PARA de consultar e alerta
 * (confirmação humana); `Status 11` mas o registro é parcial (divergência para um humano resolver).
 */

const MAX_PENDENTES_POR_RODADA = 500

export interface ConfirmarEstornosPortalResultado {
  /** `true` = a rodada nem começou (gateway indisponível/Fake). */
  pulada: boolean
  vendasConsultadas: number
  estornosConfirmados: number
  naoConfirmados: number
  foraDaJanela: number
  falhasDeConsulta: number
}

const VAZIO: ConfirmarEstornosPortalResultado = { pulada: false, vendasConsultadas: 0, estornosConfirmados: 0, naoConfirmados: 0, foraDaJanela: 0, falhasDeConsulta: 0 }

export async function confirmarEstornosPortal(opcoes: { port?: PagamentoPort; agora?: Date } = {}): Promise<ConfirmarEstornosPortalResultado> {
  const agora = opcoes.agora ?? new Date()
  const resultado = { ...VAZIO }

  const pendentes = await prisma.paymentReversal.findMany({
    where: { kind: 'REFUND', destination: 'CARD_VIA_PORTAL', status: 'PENDING_CONFIRMATION' },
    orderBy: { createdAt: 'asc' },
    take: MAX_PENDENTES_POR_RODADA,
    select: { id: true, paymentIntentId: true, createdAt: true },
  })
  if (pendentes.length === 0) return resultado
  if (pendentes.length >= MAX_PENDENTES_POR_RODADA) logger.warn({ pendentes: pendentes.length }, '[estorno] muitas devoluções pendentes no portal — a rodada olhou só as mais antigas')

  // Gateway indisponível (produção sem credencial / config ilegível) ou FAKE (dev/CI: não conhece o portal da Cielo): nada a fazer. Inerte.
  let port = opcoes.port
  if (!port) {
    if (!(await isPagamentoDisponivel())) return { ...resultado, pulada: true }
    port = await getPagamentoPort()
    if (isUsandoFakeAdapter()) return { ...resultado, pulada: true }
  }

  const idsDeVendas = [...new Set(pendentes.map((p) => p.paymentIntentId).filter((id): id is string => id !== null))]
  for (const intentId of idsDeVendas) {
    const intent = await prisma.paymentIntent.findUnique({
      where: { id: intentId },
      select: { id: true, environment: true, cieloPaymentId: true, amountCapturedCents: true, capturedAt: true, authorizedAt: true, createdAt: true },
    })
    const doIntent = pendentes.filter((p) => p.paymentIntentId === intentId)
    const maisAntigo = doIntent[0]!.createdAt
    if (!intent || !intent.cieloPaymentId || !intent.amountCapturedCents) {
      logger.warn({ paymentIntentId: intentId }, '[estorno] venda sem PaymentId/valor capturado — não dá para reconsultar na Cielo; confirmação é humana')
      resultado.naoConfirmados += doIntent.length
      continue
    }

    const dataDaVenda = intent.capturedAt ?? intent.authorizedAt ?? intent.createdAt
    if (foraDaJanelaDeConsulta(dataDaVenda, agora, env.REFUND_PORTAL_RECONSULT_WINDOW_DAYS)) {
      resultado.foraDaJanela += doIntent.length
      resultado.naoConfirmados += doIntent.length
      logger.warn(
        { alert: 'payment_refund_portal_pending_overdue', paymentIntentId: intentId, motivo: 'JANELA_DE_CONSULTA_EXPIRADA', pendentes: doIntent.length },
        '[estorno] devolução no portal ainda pendente e a venda saiu da janela de consulta da Cielo (~3 meses) — o job parou de reconsultar; conferir o extrato da Cielo e cancelar o registro (ou aceitar a divergência)',
      )
      continue
    }

    if (!(await ambienteDoIntentConfere({ id: intent.id, environment: intent.environment }, 'confirmarEstornosPortal'))) {
      resultado.naoConfirmados += doIntent.length
      continue
    }

    let consulta
    try {
      consulta = await port.consultar(intent.cieloPaymentId)
    } catch (err) {
      resultado.falhasDeConsulta += 1
      logger.warn({ err: err instanceof Error ? err.message : String(err), paymentIntentId: intentId }, '[estorno] falha ao reconsultar a venda na Cielo — tenta na próxima rodada')
      continue
    }
    resultado.vendasConsultadas += 1

    // Soma do que o ADMIN registrou (pendentes + já confirmadas desta venda) — o veredito compara com o capturado.
    const registrado = await prisma.paymentReversal.aggregate({
      _sum: { amountCents: true },
      where: { paymentIntentId: intentId, kind: 'REFUND', destination: 'CARD_VIA_PORTAL', status: { in: ['PENDING_CONFIRMATION', 'CONFIRMED'] } },
    })
    const veredito = interpretarReconsultaEstorno({ statusBruto: consulta.statusBruto, capturadoCents: intent.amountCapturedCents, devolucoesRegistradasCents: registrado._sum.amountCents ?? 0 })

    if (!veredito.confirmado) {
      resultado.naoConfirmados += doIntent.length
      if (veredito.motivo === 'STATUS_REFUNDED_MAS_REGISTRO_PARCIAL') {
        logger.warn(
          { alert: 'payment_refund_portal_status_mismatch', paymentIntentId: intentId, motivo: veredito.motivo },
          '[estorno] a Cielo mostra a venda TOTALMENTE estornada, mas o registro no InnoFlow é parcial — NÃO confirmado; conferir o portal e ajustar o registro',
        )
      } else if (agora.getTime() - maisAntigo.getTime() > env.REFUND_PORTAL_PENDING_ALERT_HOURS * 3600_000) {
        logger.warn(
          { alert: 'payment_refund_portal_pending_overdue', paymentIntentId: intentId, motivo: 'AGUARDANDO_CONFIRMACAO', pendentes: doIntent.length },
          '[estorno] devolução no portal registrada há muito tempo e a consulta da Cielo ainda não mostra o estorno — conferir o portal (estorno parcial não é lido pela consulta: cancelar o registro e anotar à mão)',
        )
      }
      continue
    }

    // Provado: confirma todas as pendentes desta venda (a soma delas + as confirmadas já cobre o capturado).
    for (const p of doIntent) {
      const confirmou = await confirmarUma(p.id, intentId, agora)
      if (confirmou) resultado.estornosConfirmados += 1
      else resultado.naoConfirmados += 1
    }
  }

  logger.info({ ...resultado }, '[estorno] rodada de confirmação das devoluções no portal concluída')
  return resultado
}

/** CAS: só confirma se AINDA estiver pendente (o ADMIN pode ter cancelado no meio). Auditoria SYSTEM FAIL-CLOSED na mesma transação. */
async function confirmarUma(reversalId: string, paymentIntentId: string, agora: Date): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const r = await tx.paymentReversal.updateMany({ where: { id: reversalId, status: 'PENDING_CONFIRMATION' }, data: { status: 'CONFIRMED', resolvedAt: agora } })
    if (r.count !== 1) return false
    await writeAuditLog(
      {
        actorUserId: SYSTEM_ACTOR.userId,
        actorRole: 'SYSTEM',
        actorEmail: SYSTEM_ACTOR.email,
        actorName: SYSTEM_ACTOR.name,
        actorOperatorId: null,
        action: 'REFUND',
        actionDetail: 'refund:auto_confirmed',
        outcome: 'SUCCESS',
        entityType: 'PaymentReversal',
        entityId: reversalId,
        changes: { status: { from: 'PENDING_CONFIRMATION', to: 'CONFIRMED' }, paymentIntentId: { to: paymentIntentId } },
      },
      tx,
    )
    return true
  })
}
