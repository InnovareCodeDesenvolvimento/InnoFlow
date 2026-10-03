import { randomUUID } from 'node:crypto'
import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { env } from '../../lib/env'
import { AppError } from '../../api/middleware/errorHandler'
import { isChargePointOnline } from '../../core/estacoes/disponibilidade'
import { sendCommand, OcppCommandTimeoutError } from '../../ocpp/commands'
import { resolveActiveTariff } from '../../ocpp/tariffResolution'
import { avaliarInicioSessao } from '../../core/carteira/avaliarInicioSessao'
import { calcularTetoReserva } from '../../core/carteira/calcularTetoReserva'
import { recordCommandResult, isAcceptedCommandResult } from '../../ocpp/commandResultCache'
import { getPagamentoPort } from '../pagamentos/pagamentoPortInstance'
import { decryptPaymentSecret } from '../../lib/crypto/paymentSecrets'
import { cancelarPreAutorizacaoCartao } from '../pagamentos/cancelarPreAutorizacaoCartao'
import { assertMeioDePagamentoHabilitado, getAmbienteEfetivoParaBancoOu503 } from '../pagamentos/gatewayConfig'
import { criarPaymentIntentNoAmbienteEfetivo } from '../pagamentos/criarIntentNoAmbiente'

const COMMAND_TIMEOUT_MS = 35_000

export type SessaoPaymentInput = { mode: 'WALLET' } | { mode: 'CARD'; paymentMethodId: string }

export interface IniciarSessaoRemotaParams {
  chargePointId: string
  /**
   * Filtro adicional de operador para a query do charge point — `{}` (sem
   * restrição) para ADMIN e para o motorista (conta de rede, carrega em
   * qualquer operador); `{ operatorId }` para OPERATOR (`operatorScopeWhere(req)`
   * já resolve isso no chamador). NUNCA aplicado à query de usuário/carteira
   * — não existe isolamento por operador aí (motorista é conta única).
   */
  chargePointScope: { operatorId?: string }
  connectorId: number
  /** Já resolvido pelo chamador — admin valida que o `userId` do body existe e é DRIVER antes de chamar; a rota do motorista usa sempre `req.user!.userId`. */
  userId: string
  /** Ausente = WALLET (retrocompatível — o remote-start do admin nunca manda isto, F5.4). */
  payment?: SessaoPaymentInput
}

export interface IniciarSessaoRemotaResultado {
  correlationId: string
  idTag: string
  paymentMode: 'WALLET' | 'CARD'
  walletBalanceCents: number
  estimatedMaxCostCents: number
  minChargeCents: number | null
  /** Valor pré-autorizado na Cielo — só preenchido em CARD. */
  authorizedCents: number | null
}

/**
 * Núcleo de "iniciar uma sessão de recarga remotamente" — extraído do
 * handler `POST /api/admin/charge-points/:id/commands/remote-start` (F4)
 * para ser reaproveitado por `POST /api/me/sessions/start` (PWA do
 * motorista, F6) SEM duplicar a decisão de negócio (saldo/dívida/teto). Ver
 * `.claude/agent-memory/nova/decisoes-pwa-motorista.md` §3: se as duas rotas
 * calculassem teto de reserva de formas levemente diferentes, admin e
 * motorista divergiriam e ninguém perceberia até o financeiro não fechar.
 *
 * Reaproveita as MESMAS funções que o `Authorize`/`StartTransaction` OCPP
 * usam (`avaliarInicioSessao`, `resolveActiveTariff`, `calcularTetoReserva`)
 * — o carregador não tem chance de recusar por saldo/dívida sozinho, porque
 * o idTag que mandamos é um `AuthToken` VIRTUAL recém-criado, sempre
 * ACCEPTED.
 *
 * 202 fire-and-forget: dispara `RemoteStartTransaction` e retorna antes do
 * carregador responder (pode levar até 35s) — o resultado real fica
 * disponível via `GET /api/me/commands/:correlationId`
 * (`ocpp/commandResultCache.ts`).
 *
 * F5.4 (2026-09-30, decisão §2 da Nova): `payment.mode === 'CARD'` faz a
 * PRÉ-AUTORIZAÇÃO acontecer AQUI, antes do `RemoteStartTransaction` — nunca
 * no `Authorize`/`StartTransaction` OCPP (o carregador não pode segurar o
 * motorista esperando a Cielo). A dívida em aberto AINDA bloqueia os DOIS
 * modos (não é isenção de dívida); o SALDO da carteira só importa para
 * WALLET — CARD não olha `walletBalanceCents` pra decidir se pode começar.
 */
export async function iniciarSessaoRemota(params: IniciarSessaoRemotaParams): Promise<IniciarSessaoRemotaResultado> {
  const { chargePointId, chargePointScope, connectorId, userId, payment } = params
  const mode = payment?.mode ?? 'WALLET'

  // F5.5: cartão desligado na tela do gateway => 409 PAYMENT_METHOD_DISABLED ANTES de qualquer efeito (nem PaymentIntent, nem pré-auth). Só COMEÇOS novos: a carteira não passa por aqui.
  if (mode === 'CARD') await assertMeioDePagamentoHabilitado('CARD', userId)

  const chargePoint = await prisma.chargePoint.findFirst({ where: { id: chargePointId, ...chargePointScope } })
  if (!chargePoint) throw new AppError('Charge point não encontrado.', 404, 'CHARGE_POINT_NOT_FOUND')

  const connector = await prisma.connector.findUnique({
    where: { chargePointId_connectorId: { chargePointId: chargePoint.id, connectorId } },
  })
  if (!connector) throw new AppError('Conector não encontrado.', 404, 'CONNECTOR_NOT_FOUND')

  const online = isChargePointOnline(chargePoint) // `findFirst` sem select traz lastSeenAt e disconnectedAt
  if (!online) throw new AppError('Charge point está offline.', 409, 'CHARGE_POINT_OFFLINE')

  if (connector.status !== 'AVAILABLE') {
    throw new AppError('Conector ocupado.', 409, 'CONNECTOR_BUSY', [{ connectorStatus: connector.status }])
  }

  // Dados de pagamento do cartão (CARD) — validados ANTES de qualquer outra
  // checagem de negócio (ordem literal do handoff): 404 se o cartão não é do
  // motorista, 409 se está soft-deletado.
  let paymentMethod: { id: string; cieloCardTokenCiphertext: string; brand: string | null } | null = null
  // F5.7 (M4): o cartão só vale no ambiente EFETIVO em que foi tokenizado (token de sandbox não cobra em produção e vice-versa). Cartão do outro ambiente
  // => "como se não existisse" (404 PAYMENT_METHOD_NOT_FOUND). O intent novo nasce com a MESMA marca.
  const environment = mode === 'CARD' ? await getAmbienteEfetivoParaBancoOu503() : null
  if (payment && payment.mode === 'CARD') {
    const found = await prisma.paymentMethod.findFirst({
      where: { id: payment.paymentMethodId, userId, environment: environment! },
      select: { id: true, active: true, cieloCardTokenCiphertext: true, brand: true },
    })
    if (!found) throw new AppError('Cartão não encontrado.', 404, 'PAYMENT_METHOD_NOT_FOUND')
    if (!found.active) throw new AppError('Este cartão foi removido. Escolha outro ou cadastre um novo.', 409, 'PAYMENT_METHOD_DISABLED')
    paymentMethod = found
  }

  const [openDebt, wallet] = await Promise.all([
    prisma.debt.findFirst({ where: { userId, status: 'OPEN' }, select: { id: true } }),
    prisma.wallet.findUnique({ where: { userId }, select: { id: true } }),
  ])

  // walletBalanceCents é sempre calculado e sempre devolvido na resposta
  // (informativo em CARD — não decide nada ali), mesmo espírito de sempre.
  let walletBalanceCents = 0
  if (wallet) {
    const lastEntry = await prisma.walletEntry.findFirst({
      where: { walletId: wallet.id },
      orderBy: { createdAt: 'desc' },
      select: { balanceAfterCents: true },
    })
    walletBalanceCents = lastEntry?.balanceAfterCents ?? 0
  }

  if (mode === 'CARD') {
    // Dívida em aberto AINDA bloqueia — CARD não é isenção de dívida
    // (reconfirmado na decisão da Nova para a F5.4). Sem reusar
    // `avaliarInicioSessao` aqui: ela precisaria de um `authorizedCents` que
    // ainda não existe neste ponto do fluxo (a pré-auth só acontece depois),
    // e o único critério que importa neste gate é a dívida.
    if (openDebt) throw new AppError('Motorista tem dívida em aberto.', 409, 'DRIVER_HAS_OPEN_DEBT')
  } else {
    const resultado = avaliarInicioSessao({
      token: { status: 'ACCEPTED', expiresAt: null, userId },
      now: new Date(),
      openDebt: !!openDebt,
      funding: { kind: 'WALLET', balanceCents: walletBalanceCents, minStartBalanceCents: env.WALLET_MIN_START_BALANCE_CENTS },
    })

    if (resultado.decision !== 'Accepted') {
      if (resultado.reason === 'OPEN_DEBT') throw new AppError('Motorista tem dívida em aberto.', 409, 'DRIVER_HAS_OPEN_DEBT')
      throw new AppError('Saldo insuficiente para iniciar a recarga.', 409, 'INSUFFICIENT_BALANCE', [
        { walletBalanceCents, minStartBalanceCents: env.WALLET_MIN_START_BALANCE_CENTS },
      ])
    }
  }

  const tariff = await resolveActiveTariff(connector, chargePoint)
  const estimatedMaxCostCents = calcularTetoReserva(
    { pricePerKwh: tariff.pricePerKwh?.toString() ?? null, pricePerMinute: tariff.pricePerMinute?.toString() ?? null, sessionFeeCents: tariff.sessionFeeCents },
    { maxPowerKw: connector.maxPowerKw?.toString() ?? null },
    { pisoCents: env.RESERVA_PISO_CENTS, tetoCents: env.RESERVA_TETO_CENTS },
  )

  let idTag: string
  let cardPaymentIntentId: string | null = null
  let authorizedCents: number | null = null

  if (mode === 'CARD' && paymentMethod) {
    // F5.8 (M4c): a marca de ambiente vem da leitura SOB LOCK, serializada com a troca de ambiente do gateway; `ambienteEsperado` = o ambiente em que o cartão foi
    // escolhido acima — se a troca aconteceu no meio, recusa (503) em vez de rotular o intent com um ambiente que não é o do cartão.
    const intent = await criarPaymentIntentNoAmbienteEfetivo(
      {
        purpose: 'SESSION_CARD_CAPTURE',
        provider: 'CIELO_CARD',
        userId,
        paymentMethodId: paymentMethod.id,
        walletId: null,
        amountRequestedCents: estimatedMaxCostCents,
        status: 'CREATED',
      },
      { ambienteEsperado: environment! },
    )

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } })

    let autorizacao
    try {
      // Decifra só no momento da chamada — nunca persiste nem loga em claro
      // (mesma regra da F5.3: `cardToken` inteiro NUNCA em log).
      const cardToken = decryptPaymentSecret(paymentMethod.cieloCardTokenCiphertext)
      autorizacao = await (await getPagamentoPort()).autorizar({
        merchantOrderId: intent.id,
        amountRequestedCents: estimatedMaxCostCents,
        cartao: { cardToken, brand: paymentMethod.brand ?? undefined },
        cliente: { name: user?.name ?? 'Motorista InnoElektron' },
      })
    } catch (err) {
      // Timeout/erro de rede — `CieloAdapter.autorizar` JÁ reconsultou por
      // `merchantOrderId` antes de propagar (decisão §2 da Nova); se ainda
      // assim chegou aqui, é falha real do gateway. O intent fica CREATED —
      // NUNCA repetimos o POST às cegas (API 3.0 sem chave de idempotência).
      // O varredor periódico (`varrerPreAutorizacoesCartao`) reconsulta por
      // `merchantOrderId` e resolve mais tarde.
      logger.error({ err: err instanceof Error ? err.message : String(err), paymentIntentId: intent.id, userId }, '[sessao] falha ao pré-autorizar cartão na Cielo')
      throw new AppError('O pagamento com cartão está indisponível no momento. Tente novamente em instantes.', 503, 'PAYMENT_GATEWAY_UNAVAILABLE')
    }

    if (autorizacao.status !== 'AUTHORIZED') {
      await prisma.paymentIntent.update({
        where: { id: intent.id },
        data: { status: 'DENIED', returnCode: autorizacao.returnCode, cieloPaymentId: autorizacao.providerPaymentId || null, failureReason: 'Pagamento recusado pela operadora do cartão.' },
      })
      // Mensagem amigável — NUNCA o ReturnCode cru da Cielo (mesma regra da F5.2).
      throw new AppError('Pagamento recusado pela operadora do cartão.', 402, 'CARD_AUTHORIZATION_DENIED')
    }

    // idTag VIRTUAL fresco — mesmo limite/formato do caminho WALLET abaixo.
    idTag = `V${randomUUID().replace(/-/g, '')}`.slice(0, 20)
    await prisma.$transaction(async (tx) => {
      const authToken = await tx.authToken.create({ data: { idTag, type: 'VIRTUAL', userId, status: 'ACCEPTED' } })
      await tx.paymentIntent.update({
        where: { id: intent.id },
        data: {
          status: 'AUTHORIZED',
          cieloPaymentId: autorizacao.providerPaymentId || null,
          returnCode: autorizacao.returnCode,
          amountAuthorizedCents: autorizacao.amountAuthorizedCents,
          authorizedAt: new Date(),
          authTokenId: authToken.id,
        },
      })
    })

    cardPaymentIntentId = intent.id
    authorizedCents = autorizacao.amountAuthorizedCents
  } else {
    // idTag VIRTUAL fresco por disparo — evita janela de reuso entre
    // remote-starts concorrentes do mesmo motorista. Limite de 20 chars do
    // protocolo (CiString20Type) — ver `ocpp/schemas/common.ts`.
    idTag = `V${randomUUID().replace(/-/g, '')}`.slice(0, 20)
    await prisma.authToken.create({ data: { idTag, type: 'VIRTUAL', userId, status: 'ACCEPTED' } })
  }

  const correlationId = randomUUID()
  logger.info({ chargePointId: chargePoint.id, connectorId, userId, idTag, correlationId, paymentMode: mode }, '[sessao] remote-start disparado')

  sendCommand(chargePoint.id, 'RemoteStartTransaction', { connectorId, idTag }, { timeoutMs: COMMAND_TIMEOUT_MS })
    .then((result) => {
      logger.info({ chargePointId: chargePoint.id, correlationId, result }, '[sessao] remote-start concluído')
      const accepted = isAcceptedCommandResult(result)
      if (!accepted) {
        void cancelarPreAutorizacaoSeCard(mode, cardPaymentIntentId)
      }
      return recordCommandResult(correlationId, accepted ? 'ACCEPTED' : 'REJECTED', userId)
    })
    .catch((err) => {
      logger.error({ err, chargePointId: chargePoint.id, correlationId }, '[sessao] remote-start falhou')
      const timedOut = err instanceof OcppCommandTimeoutError
      // Timeout é ambíguo (carregador pode só estar lento) — não cancela a
      // pré-auth à força; o varredor (+`CARD_PREAUTH_ABANDON_MINUTES`) cobre
      // esse caso depois. Qualquer OUTRA falha de transporte é tratada como
      // "carregador inalcançável" — mesma convenção de `sessions.routes.ts`
      // (`POST /sessions/:id/stop`).
      if (!timedOut) {
        void cancelarPreAutorizacaoSeCard(mode, cardPaymentIntentId)
      }
      return recordCommandResult(correlationId, timedOut ? 'TIMEOUT' : 'REJECTED', userId)
    })
    .catch((err) => logger.error({ err, correlationId }, '[sessao] falha ao gravar resultado do comando em Redis (não bloqueante)'))

  return { correlationId, idTag, paymentMode: mode, walletBalanceCents, estimatedMaxCostCents, minChargeCents: tariff.minChargeCents, authorizedCents }
}

/** `RemoteStartTransaction` não aceito (rejeitado ou falha de transporte que não é timeout) — a pré-autorização de cartão, se houver, não vai ser usada por ninguém: cancela na hora. */
async function cancelarPreAutorizacaoSeCard(mode: 'WALLET' | 'CARD', cardPaymentIntentId: string | null): Promise<void> {
  if (mode !== 'CARD' || !cardPaymentIntentId) return
  await cancelarPreAutorizacaoCartao(cardPaymentIntentId).catch((err) =>
    logger.error({ err, paymentIntentId: cardPaymentIntentId }, '[sessao] falha ao cancelar pré-autorização após remote-start não aceito (não bloqueante — varredor resolve depois)'),
  )
}
