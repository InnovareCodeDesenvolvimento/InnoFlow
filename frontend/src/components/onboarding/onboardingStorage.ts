/**
 * Persistência do onboarding (tour + checklist) — por USUÁRIO, no `localStorage` do aparelho.
 *
 * LIMITAÇÃO (decisão consciente, documentada em DESIGN-SYSTEM.md "Onboarding e tour"): o registro vale POR DISPOSITIVO/NAVEGADOR. Quem entra em outro aparelho, ou limpa os dados do navegador,
 * vê o tour de novo. O backend desta fase não guarda esse estado (não há campo no usuário nem rota) e esta tarefa não toca o backend.
 * PROPOSTA (não implementada): um flag no servidor — `GET /api/me` devolveria `onboarding: { driver?: { version, status, at }, admin?: {...} }` e `PUT /api/me/onboarding/:tourId`
 * `{ version, status }` gravaria; o cliente passaria a ler daí e este `localStorage` viraria só cache otimista. Mesma ideia para o "checklist dispensado".
 *
 * Tudo com try/catch: modo privado/cota cheia/`localStorage` bloqueado NÃO pode derrubar o app. Sem armazenamento disponível o tour NÃO abre sozinho (não dá para lembrar que
 * foi visto, e incomodar a cada carregamento é pior que não mostrar); "Rever tour" continua funcionando.
 */

export type TourStatus = "completed" | "skipped"

export interface TourRecord {
  /** Versão do roteiro que o usuário viu (`TourDefinition.version`). */
  version: number
  status: TourStatus
  /** ISO 8601 de quando terminou/pulou. */
  at: string
}

export type TourRead = { kind: "none" } | { kind: "record"; record: TourRecord } | { kind: "unavailable" }

const TOUR_PREFIX = "innoflow:tour:v1:"
const CHECKLIST_PREFIX = "innoflow:checklist:v1:"
/**
 * Interruptor do APARELHO: `"1"` = não abrir tour sozinho nem mostrar o checklist de primeiros passos neste navegador (o "Rever tour" continua funcionando).
 * Serve a quiosque/demonstração e ao harness de E2E/regressão visual, que semeiam a chave para as telas existentes partirem sem sobreposição.
 */
export const ONBOARDING_OFF_KEY = "innoflow:onboarding:off"

export function tourStorageKey(userId: string, tourId: string): string {
  return `${TOUR_PREFIX}${userId}:${tourId}`
}

export function checklistStorageKey(userId: string): string {
  return `${CHECKLIST_PREFIX}${userId}`
}

function defaultStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is TourRecord {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.version === "number" && Number.isFinite(v.version) && (v.status === "completed" || v.status === "skipped") && typeof v.at === "string"
}

export function readTourRecord(userId: string, tourId: string, storage: Storage | null = defaultStorage()): TourRead {
  if (!storage) return { kind: "unavailable" }
  try {
    const raw = storage.getItem(tourStorageKey(userId, tourId))
    if (raw === null) return { kind: "none" }
    const parsed: unknown = JSON.parse(raw)
    // Registro corrompido (alguém editou, versão futura do formato): trata como ausente — o próximo "concluir" o sobrescreve com um válido.
    return isRecord(parsed) ? { kind: "record", record: parsed } : { kind: "none" }
  } catch {
    return { kind: "unavailable" }
  }
}

export function writeTourRecord(userId: string, tourId: string, record: TourRecord, storage: Storage | null = defaultStorage()): boolean {
  if (!storage) return false
  try {
    storage.setItem(tourStorageKey(userId, tourId), JSON.stringify(record))
    return true
  } catch {
    return false
  }
}

export function clearTourRecord(userId: string, tourId: string, storage: Storage | null = defaultStorage()): void {
  try {
    storage?.removeItem(tourStorageKey(userId, tourId))
  } catch {
    /* sem armazenamento: nada a limpar */
  }
}

export function isOnboardingOff(storage: Storage | null = defaultStorage()): boolean {
  try {
    return storage?.getItem(ONBOARDING_OFF_KEY) === "1"
  } catch {
    return false
  }
}

/**
 * O tour abre sozinho quando NÃO há registro do usuário (1º acesso) ou quando o registro é de uma versão ANTERIOR do roteiro. Armazenamento indisponível ou interruptor do aparelho ligado = não abre.
 * Quem pulou/concluiu a versão atual (ou uma posterior) não é incomodado.
 */
export function shouldAutoStart(read: TourRead, currentVersion: number, off = false): boolean {
  if (off) return false
  if (read.kind === "unavailable") return false
  if (read.kind === "none") return true
  return read.record.version < currentVersion
}

export function isChecklistDismissed(userId: string, storage: Storage | null = defaultStorage()): boolean {
  try {
    return storage?.getItem(checklistStorageKey(userId)) === "dismissed"
  } catch {
    return false
  }
}

export function dismissChecklist(userId: string, storage: Storage | null = defaultStorage()): boolean {
  if (!storage) return false
  try {
    storage.setItem(checklistStorageKey(userId), "dismissed")
    return true
  } catch {
    return false
  }
}
