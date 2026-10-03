/**
 * Decide se uma sessão de recarga pode COMEÇAR — usado tanto pelo
 * `Authorize` quanto pelo `StartTransaction` (o Authorize é opcional no
 * protocolo, o carregador pode ir direto pro Start; por isso os dois
 * handlers OCPP chamam esta mesma função via `ocpp/authorizationCheck.ts`)
 * e também pela rota `POST .../commands/remote-start` (o admin dispara a
 * sessão em nome do motorista) e por `POST /api/me/sessions/start` (F5.4,
 * caminho WALLET — ver `services/sessao/iniciarSessaoRemota.ts`).
 *
 * Função pura (sem I/O, sem Prisma/express/ws — respeita a fronteira de
 * `src/core/**` da Nova) — todo dado já vem RESOLVIDO pelo chamador (leituras
 * indexadas e rápidas, nunca I/O externo — regra da Nova: nunca bloquear no
 * timeout curto do carregador).
 *
 * Ordem de checagem (literal do desenho da F4, Nova + decisão do dono
 * 2026-09-17):
 *   1. token inexistente -> `Invalid`
 *   2. token.status BLOCKED/EXPIRED (ou vencido por `expiresAt`) -> `Blocked`/`Expired`
 *   3. token sem `userId` amarrado -> `Invalid` (não tem quem pagar)
 *   4. `Debt` OPEN do usuário -> `Blocked`
 *   5. `funding.kind === 'WALLET'` e saldo < `minStartBalanceCents` -> `Blocked`
 *   6. senão -> `Accepted`
 *
 * NUNCA devolve `Invalid` para saldo insuficiente — OCPP 1.6 não tem status
 * para isso, e `Invalid` confundiria o operador achando que o token não
 * existe (decisão explícita da Nova).
 *
 * F5.4 (2026-09-30): `walletBalanceCents`/`minStartBalanceCents` viraram a
 * união `funding` — uma sessão CARD (cartão pré-autorizado na Cielo ANTES do
 * RemoteStart, ver `checkAuthorization.ts`) não tem saldo de carteira
 * nenhum para checar aqui: a pré-autorização já É a prova de que o dinheiro
 * está garantido, então `funding.kind === 'CARD_PREAUTH'` NUNCA aciona
 * `INSUFFICIENT_BALANCE` (o valor de `authorizedCents` existe só para
 * documentação/uso futuro do chamador — esta função não o compara com nada,
 * a checagem de esgotamento em tempo real é responsabilidade da guarda do
 * `MeterValues`, que lê `PaymentIntent.amountAuthorizedCents` diretamente).
 * `Debt` OPEN continua bloqueando os DOIS modos (dívida não é isenção de
 * dívida — decisão da Nova, reconfirmada na F5.4).
 */

export type AuthTokenStatusInput = 'ACCEPTED' | 'BLOCKED' | 'EXPIRED' | 'INVALID'

export interface AvaliarInicioSessaoTokenInput {
  status: AuthTokenStatusInput
  expiresAt: Date | null
  userId: string | null
}

/** Fonte de fundos que sustenta o início da sessão — ver nota F5.4 acima. */
export type FundingSource = { kind: 'WALLET'; balanceCents: number; minStartBalanceCents: number } | { kind: 'CARD_PREAUTH'; authorizedCents: number }

export interface AvaliarInicioSessaoInput {
  /** `null` = idTag desconhecido (não existe `AuthToken` com esse idTag). */
  token: AvaliarInicioSessaoTokenInput | null
  now: Date
  /** Já resolvido pelo chamador: existe `Debt` com `status='OPEN'` para este usuário? */
  openDebt: boolean
  funding: FundingSource
  /**
   * F5.9 (D7): o motorista tem sessão em `STOP_UNCONFIRMED` (o servidor acha que acabou, o carregador não confirmou)? `permitirInicio` é a chave
   * `SESSION_ALLOW_START_WHILE_UNCONFIRMED` do dono. Existe e NÃO permitido => `Blocked`. Quando permitido, o chamador já desconta o saldo
   * comprometido (`provisionalCostCents` das sessões WALLET em confirmação) de `funding.balanceCents` — esta função continua pura e só compara.
   */
  sessaoNaoConfirmada?: { existe: boolean; permitirInicio: boolean }
}

export type AvaliarInicioSessaoReason =
  | 'UNKNOWN_TOKEN'
  | 'TOKEN_NOT_LINKED_TO_USER'
  | 'TOKEN_BLOCKED'
  | 'TOKEN_INVALID'
  | 'TOKEN_EXPIRED'
  | 'OPEN_DEBT'
  | 'SESSION_PENDING_CONFIRMATION'
  | 'INSUFFICIENT_BALANCE'

export type AvaliarInicioSessaoResultado =
  | { decision: 'Accepted' }
  | { decision: 'Invalid'; reason: 'UNKNOWN_TOKEN' | 'TOKEN_NOT_LINKED_TO_USER' | 'TOKEN_INVALID' }
  | { decision: 'Blocked'; reason: 'TOKEN_BLOCKED' | 'OPEN_DEBT' | 'SESSION_PENDING_CONFIRMATION' | 'INSUFFICIENT_BALANCE' }
  | { decision: 'Expired'; reason: 'TOKEN_EXPIRED' }

export function avaliarInicioSessao(input: AvaliarInicioSessaoInput): AvaliarInicioSessaoResultado {
  const { token, now, openDebt, funding, sessaoNaoConfirmada } = input

  if (!token) {
    return { decision: 'Invalid', reason: 'UNKNOWN_TOKEN' }
  }

  if (token.status === 'INVALID') {
    return { decision: 'Invalid', reason: 'TOKEN_INVALID' }
  }
  if (token.status === 'BLOCKED') {
    return { decision: 'Blocked', reason: 'TOKEN_BLOCKED' }
  }
  const expiredByStatus = token.status === 'EXPIRED'
  const expiredByDate = token.expiresAt !== null && token.expiresAt.getTime() < now.getTime()
  if (expiredByStatus || expiredByDate) {
    return { decision: 'Expired', reason: 'TOKEN_EXPIRED' }
  }

  if (!token.userId) {
    return { decision: 'Invalid', reason: 'TOKEN_NOT_LINKED_TO_USER' }
  }

  if (openDebt) {
    return { decision: 'Blocked', reason: 'OPEN_DEBT' }
  }

  if (sessaoNaoConfirmada?.existe && !sessaoNaoConfirmada.permitirInicio) {
    return { decision: 'Blocked', reason: 'SESSION_PENDING_CONFIRMATION' }
  }

  if (funding.kind === 'WALLET' && funding.balanceCents < funding.minStartBalanceCents) {
    return { decision: 'Blocked', reason: 'INSUFFICIENT_BALANCE' }
  }

  return { decision: 'Accepted' }
}
