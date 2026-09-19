import express, { type Express } from 'express'
import cors from 'cors'
import helmet from 'helmet'
import compression from 'compression'
import pinoHttp from 'pino-http'
import { env } from '../lib/env'
import { logger } from '../lib/logger'
import { prisma } from '../lib/prisma'
import { redis } from '../lib/redis'
import { AppError, errorHandler } from './middleware/errorHandler'
import { adminRateLimit, publicRateLimit } from './middleware/rateLimit'
import { auditTrail } from './middleware/auditTrail'
import authRoutes from './routes/auth.routes'
import publicSitesRoutes from './routes/publicSites.routes'
import publicChargePointsRoutes from './routes/publicChargePoints.routes'
import publicConfigRoutes from './routes/publicConfig.routes'
import meRoutes from './routes/me.routes'
import adminSitesRoutes from './routes/sites.routes'
import adminChargePointsRoutes from './routes/chargePoints.routes'
import adminConnectorsRoutes from './routes/connectors.routes'
import adminTariffsRoutes from './routes/tariffs.routes'
import adminTariffAssignmentsRoutes from './routes/tariffAssignments.routes'
import adminAuthTokensRoutes from './routes/authTokens.routes'
import adminDashboardRoutes from './routes/dashboard.routes'
import adminReportsRoutes from './routes/reports.routes'
import adminOperatorsRoutes from './routes/operators.routes'
import adminSessionsRoutes from './routes/sessions.routes'
import adminDriversRoutes from './routes/drivers.routes'
import adminAuditLogsRoutes from './routes/auditLogs.routes'
import adminEventsRoutes from './routes/events.routes'

/**
 * Monta o app Express da API — auth JWT, isolamento multi-tenant e os CRUDs
 * administrativos base (Fase 3b, Vega). Segurança básica (helmet/cors/
 * compression), logging estruturado e health check real (Postgres + Redis)
 * já vinham da Fase 0 (Vulcano).
 */
export function createApp(): Express {
  const app = express()

  // Achado da Nova (log de auditoria, 2026-09-17): sem isto, `req.ip` é
  // sempre o IP do proxy (nginx do frontend), nunca o do cliente real — o
  // campo `ipAddress` do audit log nasceria inútil, e o rate limit de login
  // por IP conta a internet inteira num balde só. Número de hops vem de env
  // (`TRUST_PROXY_HOPS`, default 1), nunca `true` cego.
  app.set('trust proxy', env.TRUST_PROXY_HOPS)

  app.use(helmet())
  // Allowlist explícita via `CORS_ALLOWED_ORIGINS` (env, ver env.ts) — achado
  // "importante" da auditoria do Órion: `cors()` sem args aceitava qualquer
  // origem. Requisições sem header `Origin` (curl, health check, apps
  // nativos) passam direto — não são navegador, CORS não é a defesa delas.
  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || env.CORS_ALLOWED_ORIGINS.includes(origin)) {
          callback(null, true)
          return
        }
        logger.warn({ origin }, '[cors] origem bloqueada — fora da allowlist de CORS_ALLOWED_ORIGINS')
        callback(new AppError('Origem não permitida.', 403, 'CORS_FORBIDDEN'))
      },
    }),
  )
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
  app.use('/api/public/charge-points', publicRateLimit, publicChargePointsRoutes) // público — landing do QR do PWA (F6)
  app.use('/api/public/config', publicRateLimit, publicConfigRoutes) // público — configuração da tela de login (Google client ID)
  app.use('/api/me', adminRateLimit, meRoutes) // DRIVER only — PWA do motorista (F6); rate limit específico de /sessions/start é mais apertado, aplicado na própria rota

  // Log de auditoria (Nova, 2026-09-17) — montado ANTES de todo router
  // admin: registra o listener de `res.on('finish')` cedo, mas o listener só
  // dispara depois que a resposta É enviada (por definição), então enxerga
  // `req.user`/`res.statusCode`/`res.locals` já preenchidos pelos
  // middlewares/rotas que rodam DEPOIS deste `next()`.
  app.use('/api/admin', auditTrail())

  app.use('/api/admin/sites', adminRateLimit, adminSitesRoutes)
  app.use('/api/admin/charge-points', adminRateLimit, adminChargePointsRoutes)
  app.use('/api/admin/connectors', adminRateLimit, adminConnectorsRoutes)
  app.use('/api/admin/tariffs', adminRateLimit, adminTariffsRoutes)
  app.use('/api/admin/tariff-assignments', adminRateLimit, adminTariffAssignmentsRoutes)
  app.use('/api/admin/auth-tokens', adminRateLimit, adminAuthTokensRoutes)
  app.use('/api/admin/dashboard', adminRateLimit, adminDashboardRoutes)
  app.use('/api/admin/reports', adminRateLimit, adminReportsRoutes)
  app.use('/api/admin/operators', adminRateLimit, adminOperatorsRoutes)
  app.use('/api/admin/sessions', adminRateLimit, adminSessionsRoutes)
  app.use('/api/admin/drivers', adminRateLimit, adminDriversRoutes)
  app.use('/api/admin/audit-logs', adminRateLimit, adminAuditLogsRoutes)
  app.use('/api/admin/events', adminEventsRoutes) // SSE — sem adminRateLimit (conexão longa, não uma rajada de requests)

  // 404 — nenhuma rota bateu.
  app.use((_req, res) => {
    res.status(404).json({ error: 'Rota não encontrada.', code: 'NOT_FOUND' })
  })

  // Error handler SEMPRE por último — Express só reconhece como middleware
  // de erro uma função com 4 parâmetros (err, req, res, next).
  app.use(errorHandler)

  return app
}
