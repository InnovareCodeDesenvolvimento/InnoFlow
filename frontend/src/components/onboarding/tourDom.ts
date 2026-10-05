import type { Rect } from "./tourGeometry"

/**
 * Funções de DOM do tour (medir e achar o alvo). Ficam fora do componente para o comportamento "alvo ausente ou oculto → fallback centralizado" ser testável
 * e para o componente só orquestrar.
 */

/** Fração mínima da área do alvo que precisa estar à vista (não cortada por rolagem/overflow nem fora da janela) para ele valer como destaque. Abaixo disso o tour usa o balão centralizado. */
export const MIN_VISIBLE_FRACTION = 0.6

export function toRect(r: DOMRect): Rect {
  return { top: r.top, left: r.left, width: r.width, height: r.height }
}

/** O elemento existe, tem caixa e não está `display:none`/`visibility:hidden` (nem dentro de um). */
export function isRendered(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect()
  if (r.width <= 0 || r.height <= 0) return false
  if (typeof el.checkVisibility === "function") return el.checkVisibility({ checkVisibilityCSS: true })
  return true
}

/** Primeiro elemento `data-tour="nome"` renderizado (o mesmo nome pode existir na sidebar fixa e no drawer: só um está visível por vez). */
export function findTarget(name: string, root: ParentNode = document): HTMLElement | null {
  const nodes = root.querySelectorAll<HTMLElement>(`[data-tour="${name}"]`)
  for (const node of nodes) if (isRendered(node)) return node
  return null
}

function intersect(a: Rect, b: Rect): Rect {
  const left = Math.max(a.left, b.left)
  const top = Math.max(a.top, b.top)
  const right = Math.min(a.left + a.width, b.left + b.width)
  const bottom = Math.min(a.top + a.height, b.top + b.height)
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
}

/**
 * Parte do alvo que o usuário realmente VÊ: o retângulo recortado pela janela e por todo ancestral que corta (`overflow` ≠ visible — a lista rolável do menu, o grupo recolhido do accordion).
 * Devolve `null` se menos de `MIN_VISIBLE_FRACTION` dele aparece: o tour então centraliza o balão em vez de apontar para algo que ninguém vê.
 */
export function measureVisibleRect(el: HTMLElement): Rect | null {
  const full = toRect(el.getBoundingClientRect())
  if (full.width <= 0 || full.height <= 0) return null
  let clip: Rect = { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
  for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
    const s = getComputedStyle(p)
    if (s.overflowX !== "visible" || s.overflowY !== "visible") clip = intersect(clip, toRect(p.getBoundingClientRect()))
  }
  const seen = intersect(full, clip)
  if (seen.width * seen.height < full.width * full.height * MIN_VISIBLE_FRACTION) return null
  return seen
}

function isInFixedContext(el: HTMLElement): boolean {
  for (let p: HTMLElement | null = el; p && p !== document.body; p = p.parentElement) {
    const position = getComputedStyle(p).position
    if (position === "fixed" || position === "sticky") return true
  }
  return false
}

/**
 * Traz o alvo para a vista: rola, na ordem, cada ancestral rolável (a lista do menu lateral) e, só se o alvo não for `fixed`/`sticky`, a própria janela. Rolagem instantânea (sem animação),
 * para a medição seguinte já ver o resultado. Não usa `scrollIntoView`: ele rola também ancestrais `overflow:hidden` (o shell do Admin) e desloca a página inteira.
 */
export function ensureVisible(el: HTMLElement, margin = 16): void {
  for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
    const s = getComputedStyle(p)
    if (!/(auto|scroll)/.test(s.overflowY) || p.scrollHeight <= p.clientHeight) continue
    const box = p.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    if (r.top < box.top + margin) p.scrollTop -= box.top + margin - r.top
    else if (r.bottom > box.bottom - margin) p.scrollTop += r.bottom - (box.bottom - margin)
  }
  if (isInFixedContext(el)) return
  const r = el.getBoundingClientRect()
  if (r.top < 0 || r.bottom > window.innerHeight) {
    window.scrollBy({ top: r.top - Math.max(margin, (window.innerHeight - r.height) / 2), behavior: "instant" })
  }
}

export const FOCUSABLE = "button:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])"

export function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
}
