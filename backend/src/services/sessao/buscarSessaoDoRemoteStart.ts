import { prisma } from '../../lib/prisma'
import type { CommandRecord } from '../../ocpp/commandResultCache'

/**
 * Acha a sessão que NASCEU de um remote-start (a sessão só existe depois do `StartTransaction` do carregador, que chega depois do `RemoteStartTransaction` aceito — por isso
 * "ainda não existe" é um estado normal, devolvido como `null`, nunca erro).
 *
 * Como é seguro (nada de "a sessão mais recente deste motorista"):
 * - A chave é o `idTag` VIRTUAL gerado no disparo — único por comando, gravado no registro do comando pelo servidor (`CommandOwner.idTag`). Nenhum outro comando/sessão compartilha.
 * - Além do idTag, a consulta exige MOTORISTA e CHARGE POINT do registro (também gravados pelo servidor) e o escopo de operador de quem consulta (`operatorScopeWhere(req)`):
 *   um OPERATOR nunca recebe o id de uma sessão de outro operador. O registro já passou pelo mesmo escopo em `decodeCommandRecordForStaff`; aqui é a segunda camada.
 * - Registro sem idTag (comando que não é remote-start, ou formato antigo) => `null`: não há como ligar a uma sessão sem adivinhar, e adivinhar vazaria.
 */
export async function buscarSessaoDoRemoteStart(record: CommandRecord, scope: { operatorId?: string }): Promise<string | null> {
  if (!record.idTag || !record.chargePointId) return null
  const sessao = await prisma.chargingSession.findFirst({
    where: { authToken: { idTag: record.idTag }, userId: record.userId, chargePointId: record.chargePointId, ...scope },
    select: { id: true },
  })
  return sessao?.id ?? null
}
