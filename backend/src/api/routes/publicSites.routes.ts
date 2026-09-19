import { Router } from 'express'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { asyncHandler } from '../middleware/asyncHandler'
import { validateQuery } from '../middleware/validate'
import { paginationMeta } from '../schemas/pagination.schema'
import { paraSitePublico } from '../lib/publicSiteDto'

/**
 * `GET /api/sites` — público (sem auth), consumido pelo app do motorista
 * para o mapa e a lista "eletropostos perto de mim". Filtro geográfico é
 * bounding box simples (min/max lat/lng) — sem PostGIS por ora, como
 * definido nesta fase; se o volume de sites crescer muito, um índice
 * espacial de verdade é candidato natural para uma fase futura de performance.
 *
 * "Eletropostos perto de mim" (Nova, decisoes-mapa-eletropostos.md): esta
 * rota foi ESTENDIDA (aditivo), não duplicada — um segundo endpoint para
 * "quantos conectores livres" seria um segundo contrato para o mesmo número.
 * Cada conector sai com `isFree` e cada carregador com `online`, ambos pela
 * regra ÚNICA do servidor (`core/estacoes/disponibilidade.ts`): livre =
 * online E status AVAILABLE. Corrige de passagem um bug real: a rota não
 * selecionava `lastSeenAt`, então mostrava "Disponível" para carregador
 * OFFLINE. `lastSeenAt`/`disconnectedAt` NUNCA saem na resposta — só o
 * booleano derivado. Sem preço aqui (resolver tarifa por conector numa página
 * de 50 sites = ~200 consultas — preço fica no detalhe). Disponibilidade muda
 * a todo instante: `Cache-Control: no-cache` (sempre revalida, ETag continua
 * barateando a resposta idêntica).
 */
const boundingBoxQuerySchema = z
  .object({
    minLat: z.coerce.number().min(-90).max(90).optional(),
    maxLat: z.coerce.number().min(-90).max(90).optional(),
    minLng: z.coerce.number().min(-180).max(180).optional(),
    maxLng: z.coerce.number().min(-180).max(180).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(50),
  })
  .refine(
    (q) => {
      const bounds = [q.minLat, q.maxLat, q.minLng, q.maxLng]
      const anyGiven = bounds.some((v) => v !== undefined)
      const allGiven = bounds.every((v) => v !== undefined)
      return !anyGiven || allGiven
    },
    { message: 'Informe minLat, maxLat, minLng e maxLng juntos, ou nenhum deles.' },
  )

type BoundingBoxQuery = z.infer<typeof boundingBoxQuerySchema>

const router = Router()

router.get(
  '/',
  validateQuery(boundingBoxQuerySchema),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as BoundingBoxQuery

    const where: Prisma.SiteWhereInput = { active: true }
    if (q.minLat !== undefined && q.maxLat !== undefined && q.minLng !== undefined && q.maxLng !== undefined) {
      where.latitude = { gte: q.minLat, lte: q.maxLat }
      where.longitude = { gte: q.minLng, lte: q.maxLng }
    }

    const [rows, total] = await Promise.all([
      prisma.site.findMany({
        where,
        // Sem ordem estável, `skip/take` pode repetir ou perder site entre
        // páginas (o Postgres não garante ordem sem ORDER BY).
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        select: {
          id: true,
          name: true,
          addressLine: true,
          city: true,
          state: true,
          latitude: true,
          longitude: true,
          chargePoints: {
            where: { active: true },
            orderBy: { ocppIdentity: 'asc' },
            select: {
              id: true,
              ocppIdentity: true,
              vendor: true,
              model: true,
              lastSeenAt: true,
              disconnectedAt: true,
              connectors: {
                orderBy: { connectorId: 'asc' },
                select: { id: true, connectorId: true, type: true, status: true, maxPowerKw: true },
              },
            },
          },
        },
      }),
      prisma.site.count({ where }),
    ])

    const now = new Date()
    const items = rows.map((site) => paraSitePublico(site, now))

    res.setHeader('Cache-Control', 'no-cache')
    res.json({ items, meta: paginationMeta(q.page, q.pageSize, total) })
  }),
)

export default router
