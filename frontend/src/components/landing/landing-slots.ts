/**
 * Chaves das seis seções abaixo da dobra, na ordem em que aparecem na página. Cada uma tem um "espaço" (`.lnd-slot-<chave>`)
 * com a altura reservada em `landing-reserve.css` (GERADO por `scripts/gerar-reservas-landing.mjs`). Fica num módulo
 * SEM imports de componentes para a casca da landing (que carrega no primeiro paint) saber quantos espaços reservar
 * sem puxar o chunk das seções.
 */
export const SLOT_KEYS = ["tour", "op", "feat", "trust", "faq", "cta"] as const
export type SlotKey = (typeof SLOT_KEYS)[number]

/** Os espaços vazios: reservam a altura final do conteúdo que ainda não foi montado (a página já nasce do tamanho certo). */
export function slotClass(key: SlotKey): string {
  return `lnd-slot lnd-slot-${key}`
}
