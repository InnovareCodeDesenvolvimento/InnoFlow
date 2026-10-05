import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { AppError } from '../../api/middleware/errorHandler'
import { identidadeVerificada } from '../../core/pagamentos/configGateway'
import { calcularMudancaDePerfil, mascararCpf, type CampoEditavelPerfil } from '../../core/perfil/perfilMotorista'
import type { UpdateMeProfileInput } from '../../api/schemas/meProfile.schema'

/** Espelha `MeProfile` de `frontend/src/types/api.ts`. */
export interface MeProfileDTO {
  id: string
  name: string
  email: string
  phone: string | null
  cpfMasked: string | null
  hasPassword: boolean
  googleLinked: boolean
  identityVerified: boolean
  createdAt: string
}

const SELECT_PERFIL = { id: true, role: true, name: true, email: true, phone: true, cpf: true, passwordHash: true, googleSub: true, createdAt: true } satisfies Prisma.UserSelect
type UsuarioPerfil = Prisma.UserGetPayload<{ select: typeof SELECT_PERFIL }>

/** NUNCA devolve `cpf` inteiro, `passwordHash` nem `googleSub` — só os derivados (`cpfMasked`, `hasPassword`, `googleLinked`). */
function toMeProfileDTO(u: UsuarioPerfil): MeProfileDTO {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    phone: u.phone,
    cpfMasked: mascararCpf(u.cpf),
    hasPassword: u.passwordHash !== null,
    googleLinked: u.googleSub !== null,
    identityVerified: identidadeVerificada(u),
    createdAt: u.createdAt.toISOString(),
  }
}

/** O token já passou por `authenticate` (conta existe e ativa); `null` aqui só acontece numa corrida de exclusão — vira 404 em vez de 500. */
export async function obterPerfil(userId: string): Promise<MeProfileDTO> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: SELECT_PERFIL })
  if (!user) throw new AppError('Conta não encontrada.', 404, 'NOT_FOUND')
  return toMeProfileDTO(user)
}

export interface ResultadoAtualizacaoPerfil {
  perfil: MeProfileDTO
  /** Vazio = o pedido não mudou nada (mesmos valores) — nada a auditar. */
  camposAlterados: CampoEditavelPerfil[]
  /** Dados para a linha de auditoria (ator = o próprio motorista). */
  ator: { id: string; role: UsuarioPerfil['role']; email: string; name: string }
}

/**
 * Atualiza SÓ os campos pedidos que mudam, em um único UPDATE (atômico por linha). `userId` vem do chamador (sempre `req.user`).
 * CPF já usado por outra conta: o índice único parcial do banco responde P2002 — `409 CPF_IN_USE` (nunca confia em pré-checagem, que perderia a corrida).
 */
export async function atualizarPerfil(userId: string, pedido: UpdateMeProfileInput): Promise<ResultadoAtualizacaoPerfil> {
  const atual = await prisma.user.findUnique({ where: { id: userId }, select: SELECT_PERFIL })
  if (!atual) throw new AppError('Conta não encontrada.', 404, 'NOT_FOUND')

  const { dados, camposAlterados } = calcularMudancaDePerfil({ name: atual.name, phone: atual.phone, cpf: atual.cpf }, pedido)

  let depois = atual
  if (camposAlterados.length > 0) {
    try {
      depois = await prisma.user.update({ where: { id: userId }, data: dados, select: SELECT_PERFIL })
    } catch (err) {
      if (err instanceof Error && (err as { code?: string }).code === 'P2002') {
        throw new AppError('Este CPF já está cadastrado em outra conta.', 409, 'CPF_IN_USE')
      }
      throw err
    }
  }

  return { perfil: toMeProfileDTO(depois), camposAlterados, ator: { id: depois.id, role: depois.role, email: depois.email, name: depois.name } }
}
