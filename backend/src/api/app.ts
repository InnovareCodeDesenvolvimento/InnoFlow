import express, { type Express } from 'express'
import cors from 'cors'
import helmet from 'helmet'
import compression from 'compression'
import pinoHttp from 'pino-http'
import { logger } from '../lib/logger'
import { prisma } from '../lib/prisma'
import { redis } from '../lib/redis'
import { errorHandler } from './middleware/errorHandler'
import { adminRateLimit, publicRateLimit } from './middleware/rateLimit'
import authRoutes from './routes/auth.routes'
import publicSitesRoutes from './routes/publicSites.routes'
import adminSitesRoutes from './routes/sites.routes'
import adminChargePointsRoutes from './routes/chargePoints.routes'
import adminConnectorsRoutes from './routes/connectors.routes'
import adminTariffsRoutes from './routes/tariffs.routes'
import adminAuthTokensRoutes from './routes/authTokens.routes'
import adminDashboardRoutes from './routes/dashboard.routes'
import adminReportsRoutes from './routes/reports.routes'
import adminOperatorsRoutes from './routes/operators.routes'
import adminSessionsRoutes from './routes/sessions.routes'
import adminDriversRoutes from './routes/drivers.routes'

/**
 * Monta o app Express da API — auth JWT, isolamento multi-tenant e os CRUDs
 * administrativos base (Fase 3b, Vega). Segurança básica (helmet/cors/
 * compression), logging estruturado e health check real (Postgres + Redis)
 * já vinham da Fase 0 (Vulcano).
 */
export function createApp(): Express {
  const app = express()

  app.use(helmet())
  app.use(cors())
  app.use(compression())
  app.use(express.json())
  app.use(pinoHttp({ logger }))

  // Health check "de verdade": um load balancer/orquestrador só deve marcar
  // a instância como saudável se ela consegue falar com as duas dependências
  // que toda rota de negócio vai precisar. Processo vivo != aplicação sadia.
  app.get('/health', async (_req, res) => {
    const checks = { postgres: false, redis: false }

    try {
      await prisma.$queryRaw`SELECT 1`
      checks.postgres = true
    } catch (err) {
      logger.error({ err }, 'health check: falha ao conectar no Postgres')
    }

    try {
      const pong = await redis.ping()
      checks.redis = pong === 'PONG'
    } catch (err) {
      logger.error({ err }, 'health check: falha ao conectar no Redis')
    }

    const healthy = checks.postgres && checks.redis
    res.status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'degraded', checks })
  })

  app.use('/api/auth', authRoutes) // rate limit próprio (mais apertado) já aplicado nas rotas de login/registro
  app.use('/api/sites', publicRateLimit, publicSitesRoutes) // público — app do motorista
  app.use('/api/admin/sites', adminRateLimit, adminSitesRoutes)
  app.use('/api/admin/charge-points', adminRateLimit, adminChargePointsRoutes)
  app.use('/api/admin/connectors', adminRateLimit, adminConnectorsRoutes)
  app.use('/api/admin/tariffs', adminRateLimit, adminTariffsRoutes)
  app.use('/api/admin/auth-tokens', adminRateLimit, adminAuthTokensRoutes)
  app.use('/api/admin/dashboard', adminRateLimit, adminDashboardRoutes)
  app.use('/api/admin/reports', adminRateLimit, adminReportsRoutes)
  app.use('/api/admin/operators', adminRateLimit, adminOperatorsRoutes)
  app.use('/api/admin/sessions', adminRateLimit, adminSessionsRoutes)
  app.use('/api/admin/drivers', adminRateLimit, adminDriversRoutes)

  // 404 — nenhuma rota bateu.
  app.use((_req, res) => {
    res.status(404).json({ error: 'Rota não encontrada.', code: 'NOT_FOUND' })
  })

  // Error handler SEMPRE por último — Express só reconhece como middleware
  // de erro uma função com 4 parâmetros (err, req, res, next).
  app.use(errorHandler)

  return app
}
