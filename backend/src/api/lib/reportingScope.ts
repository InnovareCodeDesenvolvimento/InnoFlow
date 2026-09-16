import type { Request } from 'express'
import { prisma } from '../../lib/prisma'
import { AppError } from '../middleware/errorHandler'

/**
 * Escopo multi-tenant para as rotas de agregação (`$queryRaw`).
 *
 * `operatorScopeWhere`/`resolveOperatorIdForWrite` (tenantScope.ts) são para
 * o QUERY BUILDER do Prisma — não protegem SQL cru. Toda função de serviço
 * de agregação recebe `operatorId: string | null` como parâmetro OBRIGATÓRIO
 * (null = ADMIN sem filtro) e este helper é o único lugar que resolve esse
 * valor a partir do usuário autenticado + query params, sempre como bind
 * param (`$1`, nunca concatenado).
 */
export interface ReportingScope {
  /** null = ADMIN sem filtro (vê tudo). Nunca null para OPERATOR. */
  operatorId: string | null
  siteId?: string
  chargePointId?: string
}

export interface ReportingScopeQuery {
  siteId?: string
  chargePointId?: string
  operatorId?: string
}

export async function resolveReportingScope(req: Request, query: ReportingScopeQuery): Promise<ReportingScope> {
  const role = req.user!.role
  let operatorId: string | null

  if (role === 'OPERATOR') {
    if (!req.user!.operatorId) throw new AppError('Usuário operador sem operatorId associado.', 403, 'FORBIDDEN')
    // OPERATOR que mandar operatorId diferente do seu -> 403 (nunca confiar
    // no cliente para a fronteira de tenant, mesma regra do resto da API).
    if (query.operatorId && query.operatorId !== req.user!.operatorId) {
      throw new AppError('Você não tem acesso aos dados deste operador.', 403, 'FORBIDDEN')
    }
    operatorId = req.user!.operatorId
  } else {
    // ADMIN: operatorId da query é OPCIONAL — presente filtra a um operador,
    // ausente (null) atravessa todos.
    operatorId = query.operatorId ?? null
  }

  let siteId: string | undefined
  if (query.siteId) {
    const site = await prisma.site.findFirst({ where: { id: query.siteId, ...(operatorId ? { operatorId } : {}) } })
    // siteId de outro operador -> 404, NUNCA 403 (403 confirmaria que o
    // recurso existe = enumeração de dados de outro tenant).
    if (!site) throw new AppError('Site não encontrado.', 404, 'NOT_FOUND')
    siteId = site.id
  }

  let chargePointId: string | undefined
  if (query.chargePointId) {
    const chargePoint = await prisma.chargePoint.findFirst({
      where: { id: query.chargePointId, ...(operatorId ? { operatorId } : {}), ...(siteId ? { siteId } : {}) },
    })
    if (!chargePoint) throw new AppError('Charge point não encontrado.', 404, 'NOT_FOUND')
    chargePointId = chargePoint.id
  }

  return { operatorId, siteId, chargePointId }
}

/**
 * Resolve o fuso do relatório: `?tz=` explícito > fuso do site (quando a
 * consulta já está escopada a UM site) > `REPORTING_TIMEZONE` (env, default
 * global). "Relatório por eletroposto usa o Site.timezone de cada site" —
 * aqui só cobre o caso de um site único já resolvido; agregação
 * multi-site com fusos diferentes por dia é limitação conhecida (ver
 * handoff) e usa o fuso resolvido aqui para TODOS os buckets.
 */
export async function resolveReportingTimezone(explicitTz: string | undefined, scope: ReportingScope, envDefaultTz: string): Promise<string> {
  if (explicitTz) return explicitTz
  if (scope.siteId) {
    const site = await prisma.site.findUnique({ where: { id: scope.siteId }, select: { timezone: true } })
    if (site) return site.timezone
  }
  return envDefaultTz
}
