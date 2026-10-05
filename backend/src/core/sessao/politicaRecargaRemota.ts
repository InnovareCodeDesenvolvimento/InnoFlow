/**
 * POLÍTICA ÚNICA de quem pode iniciar recarga remota pela API/tela de administração (L1.5) e consultar o resultado do comando.
 *
 * DL4 (decisão do dono, 05/10/2026): no lote 1 só **ADMIN**. O motivo é real, não teórico: o motorista é conta de REDE (sem `operatorId`) e a rota de remote-start
 * debita a carteira do motorista informado — com OPERATOR liberado, um staff do operador X poderia gastar o saldo de QUALQUER motorista da plataforma (basta o e-mail).
 * OPERATOR volta quando o aviso por e-mail ao motorista ("uma recarga foi iniciada na sua conta pelo suporte", L1.6) existir ou o motorista confirmar no app.
 *
 * Para reabrir: acrescentar 'OPERATOR' aqui. NADA mais precisa mudar — o escopo por operador (`operatorScopeWhere`) já é aplicado em todos os pontos, e o teste
 * `remoteStartPoliticaEscopo.test.ts` prova o isolamento com a política aberta. Esta lista é a ÚNICA fonte da regra.
 */
export type PapelDeStaff = 'ADMIN' | 'OPERATOR'

export const PAPEIS_QUE_PODEM_INICIAR_RECARGA_REMOTA: readonly PapelDeStaff[] = ['ADMIN']

export function podeIniciarRecargaRemota(papel: string | undefined | null): boolean {
  return papel !== undefined && papel !== null && (PAPEIS_QUE_PODEM_INICIAR_RECARGA_REMOTA as readonly string[]).includes(papel)
}
