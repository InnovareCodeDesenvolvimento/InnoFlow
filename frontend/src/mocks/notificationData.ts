/**
 * Mock das PREFERÊNCIAS DE NOTIFICAÇÃO (L1.6): `GET/PATCH /api/me/notification-preferences`. Mesmas regras do backend (corpo estrito só com as 3 chaves, ao menos uma, limiar inteiro de
 * 500 a 50000, booleanos de verdade). Estado em memória POR USUÁRIO, na página (`page.goto` zera). Sem linha salva, o padrão é `true`, `true`, `2000`.
 *
 * Gatilhos por `localStorage`:
 *  - `mock:notif-get`   = `network` | `500` | `403` | `slow` | `empty`  -> falha o GET (`empty` = 200 sem corpo útil; `slow` = 3 s de atraso, para medir o esqueleto);
 *  - `mock:notif-patch` = `network` | `500` | `429`                      -> falha o PATCH (o 400 sai das regras: limiar fora de 500-50000, fracionário, campo desconhecido).
 */
import {
  LOW_BALANCE_THRESHOLD_DEFAULT_CENTS,
  LOW_BALANCE_THRESHOLD_MAX_CENTS,
  LOW_BALANCE_THRESHOLD_MIN_CENTS,
  type MeNotificationPreferences,
} from "@/types/api"

const store = new Map<string, MeNotificationPreferences>()

export function getMockNotificationPreferences(userId: string): MeNotificationPreferences {
  let prefs = store.get(userId)
  if (!prefs) {
    prefs = { sessionReceiptEmail: true, lowBalanceEnabled: true, lowBalanceThresholdCents: LOW_BALANCE_THRESHOLD_DEFAULT_CENTS }
    store.set(userId, prefs)
  }
  return prefs
}

const KEYS = ["sessionReceiptEmail", "lowBalanceEnabled", "lowBalanceThresholdCents"] as const

/** `null` = válido; senão os `details` do 400. */
export function validateNotificationPatch(body: unknown): Array<{ path: string; message: string }> | null {
  const raw = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null
  if (!raw) return [{ path: "", message: "Corpo inválido." }]
  const issues: Array<{ path: string; message: string }> = []
  for (const key of Object.keys(raw)) if (!(KEYS as readonly string[]).includes(key)) issues.push({ path: key, message: "Unrecognized key" })
  if (Object.keys(raw).length === 0) issues.push({ path: "", message: "Informe ao menos um campo." })
  if (raw.sessionReceiptEmail !== undefined && typeof raw.sessionReceiptEmail !== "boolean") issues.push({ path: "sessionReceiptEmail", message: "Expected boolean" })
  if (raw.lowBalanceEnabled !== undefined && typeof raw.lowBalanceEnabled !== "boolean") issues.push({ path: "lowBalanceEnabled", message: "Expected boolean" })
  const t = raw.lowBalanceThresholdCents
  if (t !== undefined && (typeof t !== "number" || !Number.isInteger(t) || t < LOW_BALANCE_THRESHOLD_MIN_CENTS || t > LOW_BALANCE_THRESHOLD_MAX_CENTS)) {
    issues.push({ path: "lowBalanceThresholdCents", message: "Valor fora do intervalo." })
  }
  return issues.length > 0 ? issues : null
}

export function applyNotificationPatch(userId: string, patch: Partial<MeNotificationPreferences>): MeNotificationPreferences {
  const next = { ...getMockNotificationPreferences(userId), ...patch }
  store.set(userId, next)
  return next
}
