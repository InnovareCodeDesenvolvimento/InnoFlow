import type { TariffScope } from '@prisma/client'
import { prisma } from '../lib/prisma'

/**
 * Resolve a tarifa ativa para um conector no momento do StartTransaction.
 *
 * F4 (2026-09-17): agora inclui `TariffWindow[]` (gap deixado de propósito
 * pela F3a, documentado em PROGRESSO.md — sem isso, tarifa `HYBRID` nunca
 * cobrava o preço de ponta) e endurece o desempate de `TariffAssignment` com
 * a MESMA `priority`: antes disso a ordem ficava a cargo do Postgres (não
 * determinística). Critério de desempate, nesta ordem:
 *   1. `priority` (maior ganha) — já era assim.
 *   2. Especificidade do `scope` (CONNECTOR > CHARGE_POINT > SITE >
 *      OPERATOR) — NÃO confiar na ordem alfabética do enum do Postgres.
 *   3. `createdAt` mais recente — desempate final, determinístico.
 * Só considera tarifas ATIVAS (`Tariff.active`): um vínculo cuja tarifa foi desativada é ignorado, e o próximo vínculo ativo de maior prioridade vale; sem nenhum, o erro
 * "Nenhuma tarifa ativa" existente. Resolvido em MEMÓRIA (não no SQL) porque especificidade de escopo não é
 * uma coluna, é uma regra de negócio sobre o enum `TariffScope`.
 */

const SCOPE_SPECIFICITY: Record<TariffScope, number> = {
  CONNECTOR: 4,
  CHARGE_POINT: 3,
  SITE: 2,
  OPERATOR: 1,
}

/** Nenhuma tarifa ATIVA e vigente para o conector. Subclasse de `Error` com a mesma mensagem de antes (quem só captura `Error` segue funcionando). */
export class NenhumaTarifaAtivaError extends Error {
  constructor(connectorId: string, operatorId: string) {
    super(`Nenhuma tarifa ativa encontrada para o conector ${connectorId} (operador ${operatorId})`)
    this.name = 'NenhumaTarifaAtivaError'
  }
}

export async function resolveActiveTariff(
  connector: { id: string },
  chargePoint: { id: string; siteId: string; operatorId: string },
) {
  const now = new Date()

  const assignments = await prisma.tariffAssignment.findMany({
    where: {
      operatorId: chargePoint.operatorId,
      // Tarifa DESATIVADA no admin (`Tariff.active = false`, soft delete) não pode mais ser resolvida: antes o filtro não existia e desativar não tirava a tarifa de uso.
      // Sessão JÁ em andamento não é afetada — ela cobra pelo `tariffSnapshot` gravado no StartTransaction, não por esta resolução.
      tariff: { active: true },
      validFrom: { lte: now },
      OR: [{ validTo: null }, { validTo: { gte: now } }],
      AND: [
        {
          OR: [
            { scope: 'CONNECTOR', connectorId: connector.id },
            { scope: 'CHARGE_POINT', chargePointId: chargePoint.id },
            { scope: 'SITE', siteId: chargePoint.siteId },
            { scope: 'OPERATOR' },
          ],
        },
      ],
    },
    include: { tariff: { include: { windows: true } } },
  })

  if (assignments.length === 0) {
    throw new NenhumaTarifaAtivaError(connector.id, chargePoint.operatorId)
  }

  const best = [...assignments].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority
    const specDiff = SCOPE_SPECIFICITY[b.scope] - SCOPE_SPECIFICITY[a.scope]
    if (specDiff !== 0) return specDiff
    return b.createdAt.getTime() - a.createdAt.getTime()
  })[0]

  return best.tariff
}
