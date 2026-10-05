import { Prisma, type PrismaClient } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { PREFERENCIAS_PADRAO, type PreferenciasDeNotificacao } from '../../core/notificacoes/politica'

/**
 * Preferências de notificação do motorista (L1.6, DL5): `NotificationPreference` é 1:1 com o usuário e criada SOB DEMANDA — sem linha valem os padrões (recibo ligado, saldo baixo
 * ligado, limiar R$ 20). Só existe coluna para o que é OPCIONAL: segurança e cobrança não têm como ser desligadas (nem por API, nem por banco).
 *
 * O dono é SEMPRE o `userId` que o chamador passa (a rota usa `req.user.userId`; nenhum id vem de corpo/query).
 */

type Db = Pick<PrismaClient, 'notificationPreference'>

const SELECT = { sessionReceiptEmail: true, lowBalanceEnabled: true, lowBalanceThresholdCents: true } as const

export async function lerPreferencias(userId: string, db: Db = prisma): Promise<PreferenciasDeNotificacao> {
  const linha = await db.notificationPreference.findUnique({ where: { userId }, select: SELECT })
  return linha ?? { ...PREFERENCIAS_PADRAO }
}

/**
 * Atualiza SÓ o que veio (campo ausente = "não mexer"). `upsert` cria a linha com os padrões do banco + o que veio. Duas primeiras gravações simultâneas: a perdedora toma
 * unique violation (P2002) na criação e refaz como UPDATE — ninguém recebe 500 por isso.
 */
export async function atualizarPreferencias(userId: string, patch: Partial<PreferenciasDeNotificacao>, db: Db = prisma): Promise<PreferenciasDeNotificacao> {
  const dados: Partial<PreferenciasDeNotificacao> = {}
  if (patch.sessionReceiptEmail !== undefined) dados.sessionReceiptEmail = patch.sessionReceiptEmail
  if (patch.lowBalanceEnabled !== undefined) dados.lowBalanceEnabled = patch.lowBalanceEnabled
  if (patch.lowBalanceThresholdCents !== undefined) dados.lowBalanceThresholdCents = patch.lowBalanceThresholdCents
  try {
    return await db.notificationPreference.upsert({ where: { userId }, create: { userId, ...dados }, update: dados, select: SELECT })
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return db.notificationPreference.update({ where: { userId }, data: dados, select: SELECT })
    }
    throw err
  }
}
