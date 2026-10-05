import type { TourContext, TourDefinition, TourStep } from "./tourScripts"

/** Breakpoint `lg` do Tailwind: a sidebar do Admin só existe a partir daqui (abaixo, o menu é um drawer fechado). */
export const WIDE_MIN_WIDTH = 1024

/** Passo já resolvido para o momento: filtros aplicados, textos dinâmicos viraram string e o alvo foi escolhido pela largura. */
export interface ResolvedStep {
  id: string
  kind: TourStep["kind"]
  /** Nome do `data-tour` a procurar (`undefined` = balão centralizado). */
  target: string | undefined
  mood: TourStep["mood"]
  title: string
  body: string
}

function text(value: string | ((ctx: TourContext) => string), ctx: TourContext): string {
  return typeof value === "function" ? value(ctx) : value
}

/**
 * Passos que valem para ESTE usuário nesta largura: some o que exige uma rota que o menu dele não tem (OPERATOR sem as telas só-ADMIN; "Backups" enquanto a tela não existe)
 * e o que só faz sentido com a sidebar visível. Pura: o teste do roteiro roda sem DOM.
 */
export function resolveSteps(definition: TourDefinition, ctx: TourContext): ResolvedStep[] {
  return definition.steps
    .filter((step) => !(step.wideOnly && !ctx.isWide))
    .filter((step) => !(step.requiresNavHref && !ctx.navHrefs.includes(step.requiresNavHref)))
    .map((step) => ({
      id: step.id,
      kind: step.kind,
      target: !ctx.isWide && step.targetNarrow ? step.targetNarrow : step.target,
      mood: step.mood,
      title: step.title,
      body: text(!ctx.isWide && step.bodyNarrow ? step.bodyNarrow : step.body, ctx),
    }))
}

export interface TourNav {
  index: number
  done: boolean
}

/** Próximo passo; no último, `done` (concluir). */
export function goNext(index: number, total: number): TourNav {
  return index >= total - 1 ? { index, done: true } : { index: index + 1, done: false }
}

export function goBack(index: number): TourNav {
  return { index: Math.max(0, index - 1), done: false }
}

export type TourKeyAction = "next" | "back" | "skip" | null

/** Teclado do tour: setas navegam, Esc pula. Com Ctrl/Cmd/Alt a tecla é do navegador (atalhos), não do tour. */
export function keyToAction(e: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }): TourKeyAction {
  if (e.ctrlKey || e.metaKey || e.altKey) return null
  if (e.key === "ArrowRight") return "next"
  if (e.key === "ArrowLeft") return "back"
  if (e.key === "Escape") return "skip"
  return null
}

/** Índice do próximo elemento focável dentro do balão (foco preso: dá a volta nas pontas). `current` -1 = foco fora do balão. */
export function nextFocusIndex(current: number, count: number, backwards: boolean): number {
  if (count <= 0) return -1
  if (current < 0) return backwards ? count - 1 : 0
  return backwards ? (current - 1 + count) % count : (current + 1) % count
}

/** Guarda o passo por `id` (e não por índice): se a janela muda de largura e a lista de passos muda, o usuário continua no mesmo passo — ou no primeiro, se ele deixou de existir. */
export function indexOfStep(steps: readonly { id: string }[], stepId: string): number {
  return Math.max(
    0,
    steps.findIndex((s) => s.id === stepId),
  )
}
