import { prisma } from '../lib/prisma'

/**
 * Resolve a tarifa ativa para um conector no momento do StartTransaction.
 *
 * SIMPLIFICADO DE PROPÓSITO para esta fase (F3a): pega a `TariffAssignment`
 * de maior prioridade cujo escopo (CONNECTOR > CHARGE_POINT > SITE >
 * OPERATOR, mas aqui tratado só por `priority`, não por especificidade
 * automática) bate e está dentro da janela de validade. NÃO resolve
 * `TariffWindow` (ponta/fora-ponta) nem calcula custo — isso é tarifação de
 * verdade, trabalho da F4. Aqui só precisamos de uma tarifa válida para
 * preencher `ChargingSession.tariffId`/`tariffSnapshot` (colunas NOT NULL).
 *
 * Se o operador cadastrar assignments sobrepostos no mesmo `priority`, a
 * ordem de desempate fica a cargo do Postgres (não determinística) — outro
 * ponto para a F4 endurecer se virar problema real.
 */
export async function resolveActiveTariff(
  connector: { id: string },
  chargePoint: { id: string; siteId: string; operatorId: string },
) {
  const now = new Date()

  const assignment = await prisma.tariffAssignment.findFirst({
    where: {
      operatorId: chargePoint.operatorId,
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
    include: { tariff: true },
    orderBy: { priority: 'desc' },
  })

  if (!assignment) {
    throw new Error(`Nenhuma tarifa ativa encontrada para o conector ${connector.id} (operador ${chargePoint.operatorId})`)
  }

  return assignment.tariff
}
