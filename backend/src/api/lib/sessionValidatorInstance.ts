import { prisma } from '../../lib/prisma'
import { createSessionValidator } from './sessionValidator'

/**
 * Instância única do processo, ligada ao Prisma. Separada da fábrica (`sessionValidator.ts`)
 * para o teste unitário da fábrica não precisar de env/banco (importar `lib/prisma` valida o
 * ambiente inteiro).
 */
export const sessionValidator = createSessionValidator({
  load: (userId) => prisma.user.findUnique({ where: { id: userId }, select: { active: true, role: true, operatorId: true, sessionsValidAfter: true } }),
})
