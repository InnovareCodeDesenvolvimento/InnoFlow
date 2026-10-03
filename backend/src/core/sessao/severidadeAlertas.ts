/**
 * Severidade dos alertas de sessão travada (F5.9), em um lugar só. Pura. Desenho da Nova, §4: aviso, erro e a exceção do stop
 * tardio (`session_late_stop_transaction` é erro se a diferença não cobrada > 0, info se 0).
 */
import type { TipoAlertaSessao } from './avaliarSessaoAberta'

export type SeveridadeAlerta = 'info' | 'warn' | 'error'

const SEVERIDADE: Record<Exclude<TipoAlertaSessao, 'session_late_stop_transaction'>, SeveridadeAlerta> = {
  session_stop_unconfirmed: 'warn',
  session_closed_by_server: 'warn',
  session_max_duration_reached: 'warn',
  // R4 só cutuca o carregador (nunca fecha): aviso para o plantão olhar o intervalo de amostragem.
  session_no_meter_values: 'warn',
  session_closed_without_meter_reading: 'error',
  session_revived_after_unconfirmed: 'error',
  session_stop_not_obeyed: 'error',
  session_metering_after_close: 'error',
  card_session_hold_deadline: 'error',
}

export function severidadeDoAlerta(tipo: TipoAlertaSessao, contexto: { diferencaCents?: number } = {}): SeveridadeAlerta {
  if (tipo === 'session_late_stop_transaction') return (contexto.diferencaCents ?? 0) > 0 ? 'error' : 'info'
  return SEVERIDADE[tipo]
}
