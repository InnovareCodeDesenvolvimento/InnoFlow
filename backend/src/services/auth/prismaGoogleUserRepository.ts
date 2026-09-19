import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { UniqueViolationError, type GoogleUserRepository, type UsuarioGoogle } from './autenticarComGoogle'

/**
 * Adaptador Prisma do repositório usado por `autenticarComGoogle`. Só o
 * mapeamento de `P2002` (unique violada) -> `UniqueViolationError` tem lógica
 * própria — é o que permite ao fluxo tratar a corrida de dois requests
 * simultâneos como "releia e entre", nunca como 500.
 *
 * `passwordHash` é lido só para virar o booleano `hasPassword` (o hash em si nunca sai daqui).
 */

const USER_SELECT = { id: true, name: true, email: true, role: true, operatorId: true, active: true, googleSub: true, passwordHash: true } as const

type UserRow = { id: string; name: string; email: string; role: UsuarioGoogle['role']; operatorId: string | null; active: boolean; googleSub: string | null; passwordHash: string | null }

function toUsuario({ passwordHash, ...rest }: UserRow): UsuarioGoogle {
  return { ...rest, hasPassword: passwordHash !== null }
}

function mapUniqueViolation(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    throw new UniqueViolationError('unique violada (googleSub/email)')
  }
  throw err
}

export const prismaGoogleUserRepository: GoogleUserRepository = {
  async findBySub(sub: string): Promise<UsuarioGoogle | null> {
    const row = await prisma.user.findUnique({ where: { googleSub: sub }, select: USER_SELECT })
    return row ? toUsuario(row) : null
  },

  async findManyByEmail(email: string): Promise<UsuarioGoogle[]> {
    const rows = await prisma.user.findMany({ where: { email: { equals: email, mode: 'insensitive' } }, select: USER_SELECT, take: 5 })
    return rows.map(toUsuario)
  },

  async linkGoogleSub(userId: string, sub: string): Promise<UsuarioGoogle> {
    try {
      // Órion A3 (pré-sequestro de conta): quem cadastrou o e-mail da VÍTIMA por `/register`
      // (que não verifica o e-mail) tem a senha e possivelmente sessões abertas. Ao vincular o
      // Google — que PROVA a posse do e-mail — o dono legítimo assume: a senha do atacante é
      // apagada (`passwordHash: null`; o dono passa a entrar pelo Google e pode definir uma
      // senha depois em `POST /api/auth/password`) e as sessões emitidas até agora morrem
      // (`sessionsValidAfter: now`). Decisão do dono/Atlas.
      const row = await prisma.user.update({
        where: { id: userId },
        data: { googleSub: sub, passwordHash: null, sessionsValidAfter: new Date() },
        select: USER_SELECT,
      })
      return toUsuario(row)
    } catch (err) {
      return mapUniqueViolation(err)
    }
  },

  async createDriverWithWallet(input: { name: string; email: string; googleSub: string }): Promise<UsuarioGoogle> {
    try {
      // Create ANINHADO = atômico (User + Wallet na mesma transação implícita)
      // — o `/register` faz 2 creates soltos e pode deixar motorista sem
      // carteira se o 2º falhar; aqui não.
      const row = await prisma.user.create({
        data: { role: 'DRIVER', name: input.name, email: input.email, googleSub: input.googleSub, passwordHash: null, wallet: { create: {} } },
        select: USER_SELECT,
      })
      return toUsuario(row)
    } catch (err) {
      return mapUniqueViolation(err)
    }
  },
}
