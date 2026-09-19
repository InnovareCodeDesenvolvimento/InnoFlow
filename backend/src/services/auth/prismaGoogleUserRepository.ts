import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { UniqueViolationError, type GoogleUserRepository, type UsuarioGoogle } from './autenticarComGoogle'

/**
 * Adaptador Prisma do repositório usado por `autenticarComGoogle`. Só o
 * mapeamento de `P2002` (unique violada) -> `UniqueViolationError` tem lógica
 * própria — é o que permite ao fluxo tratar a corrida de dois requests
 * simultâneos como "releia e entre", nunca como 500.
 */

const USER_SELECT = { id: true, name: true, email: true, role: true, operatorId: true, active: true, googleSub: true } as const

function mapUniqueViolation(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    throw new UniqueViolationError('unique violada (googleSub/email)')
  }
  throw err
}

export const prismaGoogleUserRepository: GoogleUserRepository = {
  findBySub(sub: string): Promise<UsuarioGoogle | null> {
    return prisma.user.findUnique({ where: { googleSub: sub }, select: USER_SELECT })
  },

  findManyByEmail(email: string): Promise<UsuarioGoogle[]> {
    return prisma.user.findMany({ where: { email: { equals: email, mode: 'insensitive' } }, select: USER_SELECT, take: 5 })
  },

  async linkGoogleSub(userId: string, sub: string): Promise<UsuarioGoogle> {
    try {
      return await prisma.user.update({ where: { id: userId }, data: { googleSub: sub }, select: USER_SELECT })
    } catch (err) {
      return mapUniqueViolation(err)
    }
  },

  async createDriverWithWallet(input: { name: string; email: string; googleSub: string }): Promise<UsuarioGoogle> {
    try {
      // Create ANINHADO = atômico (User + Wallet na mesma transação implícita)
      // — o `/register` faz 2 creates soltos e pode deixar motorista sem
      // carteira se o 2º falhar; aqui não.
      return await prisma.user.create({
        data: { role: 'DRIVER', name: input.name, email: input.email, googleSub: input.googleSub, passwordHash: null, wallet: { create: {} } },
        select: USER_SELECT,
      })
    } catch (err) {
      return mapUniqueViolation(err)
    }
  },
}
