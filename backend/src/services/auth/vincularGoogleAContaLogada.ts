import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { decidirVinculoGoogle, type ContaLogada, type IdentidadeGoogleVerificada, type RecusaVinculoGoogle } from '../../core/auth/decidirVinculoGoogle'

/**
 * `POST /api/auth/google/link` (I-7): orquestração do vínculo do Google à conta LOGADA. Verificador e repositório entram por injeção (testável sem rede).
 *
 * O que ESTE vínculo NÃO faz (diferente do vínculo do login público, `prismaGoogleUserRepository.linkGoogleSub`): não zera a senha e não levanta `sessionsValidAfter`.
 * Lá o Google PROVA a posse do e-mail de uma conta cadastrada por senha por OUTRA pessoa (pré-sequestro, Órion A3), então a senha antiga é descartada. Aqui quem pede já
 * está autenticado como dono da conta E o e-mail do Google tem de ser o MESMO da conta — não há conta de terceiro a tomar, e derrubar a senha/a sessão do próprio motorista
 * só o trancaria para fora (achado da Lyra, 04/10/2026).
 *
 * Corrida: o UPDATE é condicional (`googleSub IS NULL`) e a coluna `googleSub` é UNIQUE — dois vínculos simultâneos (mesma conta com dois Googles, ou dois usuários com o mesmo
 * Google) resultam em UM vencedor e o outro recebe `ALREADY_LINKED`, nunca 500 nem sobrescrita.
 */

export interface VinculoGoogleRepository {
  findAccount(userId: string): Promise<ContaLogada | null>
  /** `true` se gravou; `false` se a conta já tinha Google ou o Google já estava em outra conta (unique). Nunca sobrescreve. */
  linkSubIfFree(userId: string, sub: string): Promise<boolean>
}

export interface VinculoGoogleDeps {
  verifyIdToken(credential: string): Promise<IdentidadeGoogleVerificada & { name?: string | null }>
  repo: VinculoGoogleRepository
}

export type ResultadoVinculoGoogle = { status: 'OK' } | { status: 'INVALID_TOKEN' } | { status: RecusaVinculoGoogle }

export async function vincularGoogleAContaLogada(userId: string, credential: string, deps: VinculoGoogleDeps): Promise<ResultadoVinculoGoogle> {
  let identidade: IdentidadeGoogleVerificada
  try {
    identidade = await deps.verifyIdToken(credential)
  } catch {
    // Sem `err`: a mensagem da lib do Google embute o próprio JWT (mesmo cuidado de `autenticarComGoogle`).
    return { status: 'INVALID_TOKEN' }
  }

  const conta = await deps.repo.findAccount(userId)
  const decisao = decidirVinculoGoogle(conta, identidade)
  if (decisao.action === 'REJECT') return { status: decisao.reason }

  const gravou = await deps.repo.linkSubIfFree(userId, identidade.sub)
  return gravou ? { status: 'OK' } : { status: 'ALREADY_LINKED' }
}

export const prismaVinculoGoogleRepository: VinculoGoogleRepository = {
  async findAccount(userId) {
    const row = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true, active: true, email: true, googleSub: true } })
    return row
  },

  async linkSubIfFree(userId, sub) {
    try {
      const { count } = await prisma.user.updateMany({ where: { id: userId, googleSub: null }, data: { googleSub: sub } })
      return count === 1
    } catch (err) {
      // Este Google já pertence a OUTRA conta (unique em `googleSub`) — inclusive quando duas contas disputam o mesmo Google ao mesmo tempo.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return false
      throw err
    }
  },
}
