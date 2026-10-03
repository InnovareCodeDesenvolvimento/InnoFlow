import { env } from '../../lib/env'
import type { ConfigWatchdogSessao } from '../../core/sessao/avaliarSessaoAberta'

/** Monta a config do núcleo a partir do env (o `core/` não importa `env.ts`). Função, não constante: o env é lido UMA vez no import, mas isto deixa o teste trocar a política. */
export function configWatchdogDoEnv(): ConfigWatchdogSessao {
  return {
    watchdogIntervalMs: env.SESSION_WATCHDOG_INTERVAL_MS,
    chargerOfflineMinutes: env.SESSION_CHARGER_OFFLINE_MINUTES,
    inactivityMinutes: env.SESSION_INACTIVITY_MINUTES,
    connectorIdleMinutes: env.SESSION_CONNECTOR_IDLE_MINUTES,
    stopConfirmMinutes: env.SESSION_STOP_CONFIRM_MINUTES,
    stopMaxAttempts: env.SESSION_STOP_MAX_ATTEMPTS,
    maxOpenHours: env.SESSION_MAX_OPEN_HOURS,
    unconfirmedGraceOnlineMinutes: env.SESSION_UNCONFIRMED_GRACE_ONLINE_MINUTES,
    unconfirmedGraceOfflineMinutes: env.SESSION_UNCONFIRMED_GRACE_OFFLINE_MINUTES,
    cardMaxHoldHours: env.CARD_SESSION_MAX_HOLD_HOURS,
    meterTriggerCooldownMinutes: env.SESSION_METER_TRIGGER_COOLDOWN_MINUTES,
    noReadingPolicy: env.SESSION_NO_READING_POLICY,
  }
}
