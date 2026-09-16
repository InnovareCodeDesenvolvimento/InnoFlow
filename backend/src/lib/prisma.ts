import { PrismaClient } from '@prisma/client'
import { env } from './env'

/**
 * Cliente Prisma único, compartilhado pelos 3 entrypoints (cada processo —
 * api/ocpp/worker — mantém o seu próprio, não é compartilhado entre
 * processos). Guarda em `globalThis` em desenvolvimento para sobreviver ao
 * hot-reload do `tsx watch` sem abrir uma conexão nova a cada salvamento.
 */
declare global {
  var __prisma: PrismaClient | undefined
}

export const prisma =
  global.__prisma ??
  new PrismaClient({
    log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  })

if (env.NODE_ENV === 'development') {
  global.__prisma = prisma
}
