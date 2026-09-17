import { randomUUID } from 'node:crypto'
import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { env } from '../../lib/env'
import { AppError } from '../../api/middleware/errorHandler'
import { CHARGE_POINT_ONLINE_THRESHOLD_MS } from '../../api/services/dashboardService'
import { sendCommand, OcppCommandTimeoutError } from '../../ocpp/commands'
import { resolveActiveTariff } from '../../ocpp/tariffResolution'
import { avaliarInicioSessao } from '../../core/carteira/avaliarInicioSessao'
import { calcularTetoReserva } from '../../core/carteira/calcularTetoReserva'
import { recordCommandResult, isAcceptedCommandResult } from '../../ocpp/commandResultCache'

const COMMAND_TIMEOUT_MS = 35_000

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
}

export interface IniciarSessaoRemotaResultado {
  correlationId: string
  idTag: string
  walletBalanceCents: number
  estimatedMaxCostCents: number
  minChargeCents: number | null
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
 */
export async function iniciarSessaoRemota(params: IniciarSessaoRemotaParams): Promise<IniciarSessaoRemotaResultado> {
  const { chargePointId, chargePointScope, connectorId, userId } = params

  const chargePoint = await prisma.chargePoint.findFirst({ where: { id: chargePointId, ...chargePointScope } })
  if (!chargePoint) throw new AppError('Charge point não encontrado.', 404, 'CHARGE_POINT_NOT_FOUND')

  const connector = await prisma.connector.findUnique({
    where: { chargePointId_connectorId: { chargePointId: chargePoint.id, connectorId } },
  })
  if (!connector) throw new AppError('Conector não encontrado.', 404, 'CONNECTOR_NOT_FOUND')

  const online = chargePoint.lastSeenAt !== null && Date.now() - chargePoint.lastSeenAt.getTime() < CHARGE_POINT_ONLINE_THRESHOLD_MS
  if (!online) throw new AppError('Charge point está offline.', 409, 'CHARGE_POINT_OFFLINE')

  if (connector.status !== 'AVAILABLE') {
    throw new AppError('Conector ocupado.', 409, 'CONNECTOR_BUSY', [{ connectorStatus: connector.status }])
  }

  const [openDebt, wallet] = await Promise.all([
    prisma.debt.findFirst({ where: { userId, status: 'OPEN' }, select: { id: true } }),
    prisma.wallet.findUnique({ where: { userId }, select: { id: true } }),
  ])

  let walletBalanceCents = 0
  if (wallet) {
    const lastEntry = await prisma.walletEntry.findFirst({
      where: { walletId: wallet.id },
      orderBy: { createdAt: 'desc' },
      select: { balanceAfterCents: true },
    })
    walletBalanceCents = lastEntry?.balanceAfterCents ?? 0
  }

  const resultado = avaliarInicioSessao({
    token: { status: 'ACCEPTED', expiresAt: null, userId },
    now: new Date(),
    openDebt: !!openDebt,
    walletBalanceCents,
    minStartBalanceCents: env.WALLET_MIN_START_BALANCE_CENTS,
  })

  if (resultado.decision !== 'Accepted') {
    if (resultado.reason === 'OPEN_DEBT') throw new AppError('Motorista tem dívida em aberto.', 409, 'DRIVER_HAS_OPEN_DEBT')
    throw new AppError('Saldo insuficiente para iniciar a recarga.', 409, 'INSUFFICIENT_BALANCE', [
      { walletBalanceCents, minStartBalanceCents: env.WALLET_MIN_START_BALANCE_CENTS },
    ])
  }

  const tariff = await resolveActiveTariff(connector, chargePoint)
  const estimatedMaxCostCents = calcularTetoReserva(
    { pricePerKwh: tariff.pricePerKwh?.toString() ?? null, pricePerMinute: tariff.pricePerMinute?.toString() ?? null, sessionFeeCents: tariff.sessionFeeCents },
    { maxPowerKw: connector.maxPowerKw?.toString() ?? null },
    { pisoCents: env.RESERVA_PISO_CENTS, tetoCents: env.RESERVA_TETO_CENTS },
  )

  // idTag VIRTUAL fresco por disparo — evita janela de reuso entre
  // remote-starts concorrentes do mesmo motorista. Limite de 20 chars do
  // protocolo (CiString20Type) — ver `ocpp/schemas/common.ts`.
  const idTag = `V${randomUUID().replace(/-/g, '')}`.slice(0, 20)
  await prisma.authToken.create({ data: { idTag, type: 'VIRTUAL', userId, status: 'ACCEPTED' } })

  const correlationId = randomUUID()
  logger.info({ chargePointId: chargePoint.id, connectorId, userId, idTag, correlationId }, '[sessao] remote-start disparado')

  sendCommand(chargePoint.id, 'RemoteStartTransaction', { connectorId, idTag }, { timeoutMs: COMMAND_TIMEOUT_MS })
    .then((result) => {
      logger.info({ chargePointId: chargePoint.id, correlationId, result }, '[sessao] remote-start concluído')
      return recordCommandResult(correlationId, isAcceptedCommandResult(result) ? 'ACCEPTED' : 'REJECTED')
    })
    .catch((err) => {
      logger.error({ err, chargePointId: chargePoint.id, correlationId }, '[sessao] remote-start falhou')
      return recordCommandResult(correlationId, err instanceof OcppCommandTimeoutError ? 'TIMEOUT' : 'REJECTED')
    })
    .catch((err) => logger.error({ err, correlationId }, '[sessao] falha ao gravar resultado do comando em Redis (não bloqueante)'))

  return { correlationId, idTag, walletBalanceCents, estimatedMaxCostCents, minChargeCents: tariff.minChargeCents }
}
