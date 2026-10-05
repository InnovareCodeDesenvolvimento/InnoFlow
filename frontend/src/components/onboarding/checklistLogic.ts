import { CHECKLIST_ITEMS, type ChecklistItemScript, type ChecklistKey } from "./checklistScript"

/**
 * `done`: o dado prova que o passo foi feito · `todo`: o dado prova que falta · `unknown`: a consulta ainda não respondeu ou falhou — o item NÃO conta e NÃO aparece
 * (afirmar "falta configurar" sem ter lido o dado seria mentir ao dono).
 */
export type ChecklistState = "done" | "todo" | "unknown"

export interface ChecklistItem extends ChecklistItemScript {
  state: ChecklistState
}

export interface ChecklistView {
  /** Itens verificáveis, na ordem do roteiro. */
  items: ChecklistItem[]
  doneCount: number
  total: number
  /** Nada a mostrar: tudo feito (ou nada verificável). O card some, sem "parabéns" nem ruído. */
  complete: boolean
}

/** `facts[key]`: `true` = feito, `false` = falta, `undefined` = não sei. Pura: o teste cobre as combinações sem rede. */
export function deriveChecklist(facts: Partial<Record<ChecklistKey, boolean | undefined>>): ChecklistView {
  const all: ChecklistItem[] = CHECKLIST_ITEMS.map((item) => ({ ...item, state: facts[item.key] === undefined ? "unknown" : facts[item.key] ? "done" : "todo" }))
  const items = all.filter((i) => i.state !== "unknown")
  const doneCount = items.filter((i) => i.state === "done").length
  return { items, doneCount, total: items.length, complete: items.length === 0 || doneCount === items.length }
}

/** Há ao menos um vínculo de tarifa em vigor? `validTo` nulo ou no futuro. `total` > itens lidos = há mais vínculos do que a página trouxe (então existe pelo menos um). */
export function hasActiveAssignment(items: readonly { validTo: string | null }[], total: number, now = Date.now()): boolean {
  if (items.some((a) => a.validTo === null || Date.parse(a.validTo) > now)) return true
  return total > items.length
}

/** O gateway está pronto para cobrar? Algum meio (cartão ou Pix) LIGADO pelo admin e com todos os pré-requisitos presentes. */
export function isGatewayReady(config: { cardEnabled: boolean; pixEnabled: boolean; readiness: { card: { ready: boolean }; pix: { ready: boolean } } }): boolean {
  return (config.cardEnabled && config.readiness.card.ready) || (config.pixEnabled && config.readiness.pix.ready)
}

/** Algum canal de aviso funcionando agora (`active` = config completa e válida)? */
export function isCommunicationActive(config: { email: { active: boolean }; whatsapp: { active: boolean } }): boolean {
  return config.email.active || config.whatsapp.active
}
