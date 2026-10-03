/**
 * Fonte ÚNICA de "o que é uma sessão de recarga aberta" (F5.9, defeito D-B do desenho da Nova).
 *
 * Antes desta constante havia 5 listas literais espalhadas (BootNotification, MeterValues, StatusNotification,
 * `me.routes`, `sessions.routes`) e NENHUMA incluía `FAULTED`: uma sessão que falhava no meio da recarga nunca voltava
 * a `CHARGING`, não era reconciliada, não podia ser parada (409) e sumia do PWA — com a pré-autorização do cartão presa.
 * Qualquer lugar que pergunte "esta sessão ainda está em andamento?" importa DAQUI; reescrever a lista é o bug voltando.
 *
 * O módulo é de propósito autossuficiente (tipos literais próprios, sem `@prisma/client`): os valores abaixo espelham o
 * enum `ChargingSessionStatus` do schema, e o teste unitário trava essa correspondência.
 */

/** Estados em que o carregador ainda trata a transação como viva. Ordem = ciclo de vida típico. */
export const ESTADOS_SESSAO_ABERTA = ['STARTED', 'CHARGING', 'FINISHING', 'FAULTED'] as const
export type EstadoSessaoAberta = (typeof ESTADOS_SESSAO_ABERTA)[number]

/**
 * `STOP_UNCONFIRMED`: o SERVIDOR acha que a sessão acabou, mas o carregador não confirmou. NÃO é terminal e NÃO é "aberta":
 * o motorista não a vê como ativa, nada foi debitado/capturado, e só o watchdog (ou o StopTransaction do carregador) a fecha.
 */
export const STATUS_SESSAO_NAO_CONFIRMADA = 'STOP_UNCONFIRMED' as const
export type StatusSessaoNaoConfirmada = typeof STATUS_SESSAO_NAO_CONFIRMADA

/** Terminal. Um StopTransaction que chega depois só é REGISTRADO (`lateStop*`), nunca reabre nem cobra. */
export const STATUS_SESSAO_ENCERRADA = 'STOPPED' as const
export type StatusSessaoEncerrada = typeof STATUS_SESSAO_ENCERRADA

/** Todos os valores de `ChargingSessionStatus` (espelha o enum do Prisma). */
export type StatusSessao = EstadoSessaoAberta | StatusSessaoNaoConfirmada | StatusSessaoEncerrada

/**
 * Sessões que o WATCHDOG precisa vigiar = abertas + em confirmação. É a mesma lista do índice parcial
 * `ix_charging_session_watchdog` (migration 20261003120100).
 */
export const ESTADOS_SESSAO_VIGIADA = [...ESTADOS_SESSAO_ABERTA, STATUS_SESSAO_NAO_CONFIRMADA] as const
export type EstadoSessaoVigiada = (typeof ESTADOS_SESSAO_VIGIADA)[number]

export function isSessaoAberta(status: string): status is EstadoSessaoAberta {
  return (ESTADOS_SESSAO_ABERTA as readonly string[]).includes(status)
}

export function isSessaoNaoConfirmada(status: string): status is StatusSessaoNaoConfirmada {
  return status === STATUS_SESSAO_NAO_CONFIRMADA
}

/** Aberta OU em confirmação: ainda ocupa o conector do ponto de vista do servidor e ainda não tem dinheiro movido. */
export function isSessaoVigiada(status: string): status is EstadoSessaoVigiada {
  return isSessaoAberta(status) || isSessaoNaoConfirmada(status)
}

/**
 * Cópia MUTÁVEL para filtros do Prisma (`where: { status: { in: ... } }` não aceita `readonly` tuple). Devolve uma cópia nova
 * a cada chamada, então quem a recebe pode ordenar/alterar sem corromper a constante.
 */
export function listarEstadosSessaoAberta(): EstadoSessaoAberta[] {
  return [...ESTADOS_SESSAO_ABERTA]
}

/** Idem para o conjunto vigiado pelo watchdog (abertas + `STOP_UNCONFIRMED`). */
export function listarEstadosSessaoVigiada(): EstadoSessaoVigiada[] {
  return [...ESTADOS_SESSAO_VIGIADA]
}
