import 'dotenv/config'
import { createApp } from '../api/app'
import { env } from '../lib/env'
import { logger } from '../lib/logger'

const app = createApp()

app.listen(env.PORT, () => {
  logger.info(`api ok — porta ${env.PORT}`)
})
