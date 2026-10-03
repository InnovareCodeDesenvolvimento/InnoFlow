import { Prisma } from '@prisma/client'
import { listarEstadosSessaoAberta } from '../../core/sessao/estadosSessao'

/**
 * Lista de "sessão aberta" para SQL cru (F5.9, 9b2): a constante ÚNICA de `core/sessao/estadosSessao.ts` (inclui FAULTED), em vez de
 * `IN ('STARTED', 'CHARGING', 'FINISHING')` escrito à mão. Cada valor leva o cast para o enum — o Prisma envia parâmetros como texto e o
 * Postgres recusa `"ChargingSessionStatus" = text`. Uso: ``Prisma.sql`cs.status IN (${sqlEstadosSessaoAberta()})` ``.
 */
export function sqlEstadosSessaoAberta(): Prisma.Sql {
  return Prisma.join(listarEstadosSessaoAberta().map((estado) => Prisma.sql`${estado}::"ChargingSessionStatus"`))
}
