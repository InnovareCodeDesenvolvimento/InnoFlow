/**
 * Contexto anexado a cada conexão de charge point aceita, resolvido uma vez
 * no `auth()` do RPCServer e reutilizado por todos os handlers daquela
 * conexão (via `client.session`). Evita cada handler ter que re-resolver
 * `ocppIdentity -> ChargePoint.id` a cada mensagem.
 */
export interface OcppHandlerCtx {
  /** ChargePoint.id (cuid interno) — é o que toda FK do schema usa. */
  chargePointId: string
  /** Denormalizado no accept() para os handlers não terem que buscar de novo. */
  operatorId: string
  /** ChargePoint.ocppIdentity — o identificador que veio na URL do WebSocket. */
  ocppIdentity: string
}
