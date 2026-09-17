import { Router } from 'express'
import { z } from 'zod'
import type { Tariff } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { AppError } from '../middleware/errorHandler'
import { asyncHandler } from '../middleware/asyncHandler'
import { validateParams } from '../middleware/validate'
import { resolveActiveTariff } from '../../ocpp/tariffResolution'
import { CHARGE_POINT_ONLINE_THRESHOLD_MS } from '../services/dashboardService'

/**
 * `GET /api/public/charge-points/:ocppIdentity` — SEM autenticação, mesmo
 * padrão de rate limit de `GET /api/sites` (`publicRateLimit`). É a tela que
 * o motorista vê ao escanear o QR do carregador (F6 — ver
 * decisoes-pwa-motorista.md §2: o QR codifica `ocppIdentity`, não o cuid).
 *
 * Resolve a tarifa de cada conector com a MESMA `resolveActiveTariff` que o
 * `StartTransaction` real usa — se divergisse, a tela mentiria sobre o
 * preço antes mesmo de iniciar a recarga.
 *
 * NUNCA devolve `operatorId`, `basicAuthSecretHash` ou qualquer outro dado
 * interno — por isso a query usa `select` explícito (não `include`), para
 * nem carregar o hash na memória do processo.
 */

const paramsSchema = z.object({ ocppIdentity: z.string().trim().min(1) })
type Params = z.infer<typeof paramsSchema>

const router = Router()

function toTariffSummary(tariff: Tariff) {
  return {
    name: tariff.name,
    model: tariff.model,
    pricePerKwh: tariff.pricePerKwh?.toString() ?? null,
    pricePerMinute: tariff.pricePerMinute?.toString() ?? null,
    sessionFeeCents: tariff.sessionFeeCents,
    minChargeCents: tariff.minChargeCents,
    idleFeePerMinute: tariff.idleFeePerMinute,
    currency: tariff.currency,
  }
}

router.get(
  '/:ocppIdentity',
  validateParams(paramsSchema),
  asyncHandler(async (req, res) => {
    const { ocppIdentity } = req.params as unknown as Params

    const chargePoint = await prisma.chargePoint.findFirst({
      where: { ocppIdentity, active: true },
      select: {
        id: true,
        ocppIdentity: true,
        vendor: true,
        model: true,
        lastSeenAt: true,
        siteId: true,
        operatorId: true,
        site: { select: { id: true, name: true, addressLine: true, city: true, state: true } },
        connectors: {
          orderBy: { connectorId: 'asc' },
          select: { id: true, connectorId: true, type: true, maxPowerKw: true, status: true },
        },
      },
    })
    if (!chargePoint) throw new AppError('Carregador não encontrado.', 404, 'CHARGE_POINT_NOT_FOUND')

    const online = chargePoint.lastSeenAt !== null && Date.now() - chargePoint.lastSeenAt.getTime() < CHARGE_POINT_ONLINE_THRESHOLD_MS

    const connectors = await Promise.all(
      chargePoint.connectors.map(async (connector) => {
        let tariff: ReturnType<typeof toTariffSummary> | null = null
        try {
          const resolved = await resolveActiveTariff(connector, chargePoint)
          tariff = toTariffSummary(resolved)
        } catch {
          // Conector sem TariffAssignment cadastrada — não bloqueia a
          // listagem pública (só o início de recarga, checado de novo em
          // POST /api/me/sessions/start via resolveActiveTariff dentro de
          // iniciarSessaoRemota).
          tariff = null
        }
        return {
          connectorId: connector.connectorId,
          type: connector.type,
          maxPowerKw: connector.maxPowerKw?.toString() ?? null,
          status: connector.status,
          tariff,
        }
      }),
    )

    res.json({
      ocppIdentity: chargePoint.ocppIdentity,
      vendor: chargePoint.vendor,
      model: chargePoint.model,
      online,
      site: {
        id: chargePoint.site.id,
        name: chargePoint.site.name,
        addressLine: chargePoint.site.addressLine,
        city: chargePoint.site.city,
        state: chargePoint.site.state,
      },
      connectors,
      generatedAt: new Date().toISOString(),
    })
  }),
)

export default router
