import 'dotenv/config'
import { startOcppServer } from '../ocpp/server'
import { env } from '../lib/env'
import { logger } from '../lib/logger'

startOcppServer(env.OCPP_PORT).catch((err) => {
  logger.error({ err }, '[ocpp] falha fatal ao subir o gateway')
  process.exit(1)
})
