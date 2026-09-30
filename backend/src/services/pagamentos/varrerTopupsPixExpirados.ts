import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import type { PagamentoPort } from '../../core/pagamentos/porta'
import { creditarTopupPix } from './creditarTopupPix'
import { getPagamentoPort } from './pagamentoPortInstance'
import { emitTopupUpdated, emitWalletUpdated } from '../../realtime/emit'

/**
 * Varredor de expiração da recarga Pix — a REDE DE SEGURANÇA do fluxo
 * (mesmo espírito do varredor de `PaymentIntent` citado na decisão §4 da
 * Nova). Roda periodicamente (BullMQ repeatable, ver
 * `worker/jobs/expirarTopupsPixJob.ts`).
 *
 * Regra dura da tarefa: NUNCA expira só por `pixExpiresAt` ter passado sem
 * RECONSULTAR a Cielo primeiro — um Pix pago no segundo 1799 de uma janela
 * de 1800s pode ter a confirmação chegando um pouco depois do prazo do QR
 * (rede lenta, banco do motorista demorado); o dinheiro já entrou na nossa
 * conta Cielo e não tem como devolver só porque decidimos "expirar" do nosso
 * lado. Por isso: PENDING vencido -> reconsulta -> só marca EXPIRED se a
 * Cielo confirmar que não foi pago; se confirmar PAID, credita pelo MESMO
 * caminho do webhook.
 */

const BATCH_SIZE = 50

export async function varrerTopupsPixExpirados(pagamentoPort: PagamentoPort = getPagamentoPort()): Promise<{ creditados: number; expirados: number }> {
  const vencidos = await prisma.paymentIntent.findMany({
    where: { purpose: 'WALLET_TOPUP_PIX', status: 'PENDING', pixExpiresAt: { lt: new Date() } },
    orderBy: { pixExpiresAt: 'asc' },
    take: BATCH_SIZE,
  })

  let creditados = 0
  let expirados = 0

  for (const intent of vencidos) {
    if (!intent.cieloPaymentId) {
      // Edge case raro: `criarPix` nunca devolveu o `PaymentId` (falha entre
      // o INSERT e a resposta da Cielo) — sem `cieloPaymentId` não há o que
      // reconsultar; expira direto (não tem como ter sido pago sem QR).
      const atualizado = await prisma.paymentIntent.updateMany({
        where: { id: intent.id, status: 'PENDING' },
        data: { status: 'EXPIRED', failureReason: 'QR nunca foi gerado pela Cielo — expirado sem reconsulta possível.' },
      })
      if (atualizado.count > 0) {
        expirados++
        await emitTopupUpdated(intent.userId, intent.id, 'EXPIRED').catch((err) => logger.error({ err, intentId: intent.id }, '[varrerTopupsPixExpirados] falha ao publicar topup.updated (não bloqueante)'))
      }
      continue
    }

    try {
      const consulta = await pagamentoPort.consultarPix(intent.cieloPaymentId)

      if (consulta.status === 'PAID') {
        const resultado = await creditarTopupPix(intent.id, pagamentoPort)
        if (resultado) {
          creditados++
          await Promise.all([
            emitWalletUpdated(resultado.userId, resultado.balanceAfterCents),
            emitTopupUpdated(resultado.userId, resultado.paymentIntentId, 'PAID'),
          ]).catch((err) => logger.error({ err, intentId: intent.id }, '[varrerTopupsPixExpirados] falha ao publicar eventos de tempo real (não bloqueante)'))
        }
        continue
      }

      const atualizado = await prisma.paymentIntent.updateMany({
        where: { id: intent.id, status: 'PENDING' },
        data: { status: 'EXPIRED', failureReason: 'Pix expirado sem pagamento confirmado pela Cielo.' },
      })
      if (atualizado.count > 0) {
        expirados++
        await emitTopupUpdated(intent.userId, intent.id, 'EXPIRED').catch((err) => logger.error({ err, intentId: intent.id }, '[varrerTopupsPixExpirados] falha ao publicar topup.updated (não bloqueante)'))
      }
    } catch (err) {
      // Falha de rede/Cielo ao reconsultar ESTE intent não pode derrubar o
      // lote inteiro — os próximos continuam, e este volta a ser pego na
      // próxima rodada do varredor (continua PENDING).
      logger.error({ err, intentId: intent.id }, '[varrerTopupsPixExpirados] falha ao reconsultar/expirar — tentando de novo na próxima rodada')
    }
  }

  if (creditados > 0 || expirados > 0) {
    logger.info({ creditados, expirados, total: vencidos.length }, '[varrerTopupsPixExpirados] rodada concluída')
  }

  return { creditados, expirados }
}
