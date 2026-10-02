import { PrismaClient } from '@prisma/client'
import { env } from './env'
import { logger } from './logger'
import { limparTextoSensivel } from './logSerializers'

/**
 * Cliente Prisma único, compartilhado pelos 3 entrypoints (cada processo —
 * api/ocpp/worker — mantém o seu próprio, não é compartilhado entre
 * processos). Guarda em `globalThis` em desenvolvimento para sobreviver ao
 * hot-reload do `tsx watch` sem abrir uma conexão nova a cada salvamento.
 *
 * F5.7 (B3, Íris): os logs do engine saem como EVENTO e passam pelo nosso `logger` (com a limpeza de
 * `limparTextoSensivel`) em vez de irem crus para o stderr. Antes, uma violação de constraint no
 * `PaymentGatewayConfig` despejava `Failing row contains (...)` — a linha rejeitada, com os `*Ciphertext`
 * das credenciais do gateway truncados — direto no stderr do processo, por fora do redact do pino.
 */
declare global {
  var __prisma: PrismaClient | undefined
}

function criarClient(): PrismaClient {
  const client = new PrismaClient({
    log:
      env.NODE_ENV === 'development'
        ? [
            { level: 'warn', emit: 'event' },
            { level: 'error', emit: 'event' },
          ]
        : [{ level: 'error', emit: 'event' }],
  })
  client.$on('error', (e) => logger.error({ target: e.target }, `[prisma] ${limparTextoSensivel(e.message)}`))
  if (env.NODE_ENV === 'development') client.$on('warn', (e) => logger.warn({ target: e.target }, `[prisma] ${limparTextoSensivel(e.message)}`))
  return client as unknown as PrismaClient
}

export const prisma = global.__prisma ?? criarClient()

if (env.NODE_ENV === 'development') {
  global.__prisma = prisma
}
