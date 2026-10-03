import type { MeterStopSource, SessionClosureSource, StopUnconfirmedReason, ChargingSessionStatus } from '@prisma/client'
import { calcularConfirmDeadline } from '../../core/sessao/avaliarSessaoAberta'
import { isSessaoNaoConfirmada } from '../../core/sessao/estadosSessao'
import type { PresencaCarregador } from '../../core/estacoes/disponibilidade'
import { configWatchdogDoEnv } from './configWatchdog'

/**
 * Bloco `closure` do detalhe da sessão (F5.9, 9b2) — ESPELHA `SessionClosureInfo` de `frontend/src/types/api.ts`. Mesmo bloco no detalhe do
 * motorista (`GET /api/me/sessions/:id`) e no do admin (`GET /api/admin/reports/sessions/:id`).
 *
 * Regras do contrato:
 *  - sessão aberta e sessão ANTERIOR à F5.9 (colunas nulas): tudo `null` — nunca inventa valor;
 *  - `unconfirmedSince`/`unconfirmedReason`/`confirmDeadline`: SÓ em `STOP_UNCONFIRMED`; o `confirmDeadline` é calculado NA LEITURA pela
 *    mesma função pura do watchdog (`calcularConfirmDeadline`, G1 online / G2 offline, limitado pelo hold do cartão) — o instante exato em
 *    que o watchdog vai agir;
 *  - `billedUntil` = `stoppedAt` quando `source = SERVER` ("cobramos só o que foi medido até este horário").
 * Datas saem como `Date` (o Express serializa em ISO, como todo o resto da API).
 */
export interface SessionClosureDto {
  source: SessionClosureSource | null
  meterStopSource: MeterStopSource | null
  unconfirmedSince: Date | null
  unconfirmedReason: StopUnconfirmedReason | null
  confirmDeadline: Date | null
  billedUntil: Date | null
}

export interface EntradaClosureDto {
  status: ChargingSessionStatus
  paymentMode: 'WALLET' | 'CARD'
  closureSource: SessionClosureSource | null
  meterStopSource: MeterStopSource | null
  unconfirmedAt: Date | null
  unconfirmedReason: StopUnconfirmedReason | null
  stoppedAt: Date | null
  /** `PaymentIntent.authorizedAt` do hold do cartão (só importa para o prazo em STOP_UNCONFIRMED). */
  cardAuthorizedAt: Date | null
  carregador: PresencaCarregador
  /** M5: intervalo de amostragem observado (ver `estimarIntervaloAmostragemMs`) — a MESMA conta do watchdog. Só importa em STOP_UNCONFIRMED. */
  intervaloAmostragemMs?: number | null
}

export function montarClosure(entrada: EntradaClosureDto, agora: Date = new Date()): SessionClosureDto {
  const emConfirmacao = isSessaoNaoConfirmada(entrada.status) && entrada.unconfirmedAt !== null
  return {
    source: entrada.closureSource,
    meterStopSource: entrada.meterStopSource,
    unconfirmedSince: emConfirmacao ? entrada.unconfirmedAt : null,
    unconfirmedReason: emConfirmacao ? entrada.unconfirmedReason : null,
    confirmDeadline: emConfirmacao
      ? calcularConfirmDeadline({
          agora,
          sessao: { paymentMode: entrada.paymentMode, cardAuthorizedAt: entrada.cardAuthorizedAt, unconfirmedAt: entrada.unconfirmedAt },
          carregador: entrada.carregador,
          config: configWatchdogDoEnv(),
          intervaloAmostragemMs: entrada.intervaloAmostragemMs ?? null,
        })
      : null,
    billedUntil: entrada.closureSource === 'SERVER' ? entrada.stoppedAt : null,
  }
}

/** `SessionLateStop` (SÓ no detalhe ADMIN): o Stop que chegou depois do fechamento pelo servidor. `null` se não houve. O motorista nunca vê. */
export interface SessionLateStopDto {
  meterStopWh: number
  stoppedAt: Date
  receivedAt: Date
  unbilledCostCents: number
}

export function montarLateStop(s: { lateStopMeterWh: number | null; lateStopAt: Date | null; lateStopReceivedAt: Date | null; unbilledCostCents: number | null }): SessionLateStopDto | null {
  if (s.lateStopMeterWh === null || !s.lateStopAt || !s.lateStopReceivedAt) return null
  return { meterStopWh: s.lateStopMeterWh, stoppedAt: s.lateStopAt, receivedAt: s.lateStopReceivedAt, unbilledCostCents: s.unbilledCostCents ?? 0 }
}
