import { gzipSync } from "node:zlib"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { Page } from "@playwright/test"

/**
 * SONDA DE GEOMETRIA (F-A, Íris): grava, para CADA elemento do documento, o retângulo, a árvore e o estilo computado — para provar que dois builds do app (baseline x novo) têm a
 * MESMA geometria e que a única diferença de estilo é cor. Ativada por `VISUAL_GEO_DIR=<pasta>` (sem a variável não faz nada e não custa nada). Compare com `scripts/comparar-geometria.mjs`.
 *
 * Por que DOM e não só pixel: dois pixels diferentes dizem "mudou", não "mudou a COR do texto e nada se mexeu". O retângulo de TODOS os elementos idêntico + só `color`/`fill`/`stroke`
 * diferentes no estilo é a prova de recolor; qualquer outra coisa (1 px de padding, quebra de linha, ícone trocado) aparece como retângulo ou propriedade diferente.
 */

/** Propriedades que definem GEOMETRIA/LAYOUT/TIPOGRAFIA (qualquer diferença aqui é "não é só cor"). */
export const PROPS_GEOMETRIA = [
  "display", "position", "top", "right", "bottom", "left", "z-index", "float", "clear",
  "width", "height", "min-width", "min-height", "max-width", "max-height", "box-sizing",
  "margin-top", "margin-right", "margin-bottom", "margin-left",
  "padding-top", "padding-right", "padding-bottom", "padding-left",
  "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
  "border-top-style", "border-right-style", "border-bottom-style", "border-left-style",
  "border-top-left-radius", "border-top-right-radius", "border-bottom-left-radius", "border-bottom-right-radius",
  "flex-direction", "flex-wrap", "flex-grow", "flex-shrink", "flex-basis", "align-items", "align-self", "justify-content", "gap", "order",
  "grid-template-columns", "grid-template-rows", "grid-column-start", "grid-column-end", "grid-row-start", "grid-row-end",
  "overflow-x", "overflow-y", "white-space", "text-overflow", "word-break", "overflow-wrap",
  "font-family", "font-size", "font-weight", "font-style", "line-height", "letter-spacing", "text-transform", "text-align", "text-indent", "text-decoration-line", "vertical-align",
  "transform", "visibility", "content", "object-fit", "aspect-ratio",
  "background-image", "background-size", "background-position", "background-repeat",
  "box-shadow", "filter", "backdrop-filter", "mix-blend-mode", "cursor",
] as const

/** Propriedades de COR. Diferença só aqui = recolor. Quais são ACEITAS é decisão do comparador (texto/ícone), não da sonda. */
export const PROPS_COR = [
  "color", "fill", "stroke", "-webkit-text-fill-color", "text-decoration-color", "caret-color",
  "background-color", "border-top-color", "border-right-color", "border-bottom-color", "border-left-color", "outline-color", "opacity",
] as const

const ATRIBUTOS = ["role", "aria-label", "aria-labelledby", "aria-describedby", "aria-hidden", "aria-expanded", "aria-current", "alt", "title", "placeholder", "type", "href", "src", "for", "name", "data-state", "disabled"]

export interface NoGeo {
  /** caminho de índices de filhos a partir de <body> */
  p: string
  t: string
  /** texto próprio (nós de texto diretos) normalizado */
  x: string
  /** atributos relevantes (sem class/style) */
  a: Record<string, string>
  /** [x, y, w, h] em coordenadas de PÁGINA, 2 casas */
  r: [number, number, number, number]
  /** valores de PROPS_GEOMETRIA, na ordem */
  g: string[]
  /** valores de PROPS_COR, na ordem */
  c: string[]
  /** classes (só informação: o comparador NÃO usa para decidir igualdade) */
  k: string
}

export interface DumpGeo {
  nome: string
  url: string
  viewport: { w: number; h: number }
  doc: { w: number; h: number }
  propsGeometria: readonly string[]
  propsCor: readonly string[]
  nos: NoGeo[]
}

export async function gravarGeometria(page: Page, nome: string, viewportNome: string): Promise<void> {
  const pasta = process.env.VISUAL_GEO_DIR
  if (!pasta) return
  const dump = await page.evaluate(
    ({ pg, pc, attrs }) => {
      const r2 = (n: number) => Math.round(n * 100) / 100
      const nos: unknown[] = []
      const visitar = (el: Element, caminho: number[]) => {
        const tag = el.tagName.toLowerCase()
        if (tag === "script" || tag === "style" || tag === "noscript" || tag === "link" || tag === "meta") return
        const cs = getComputedStyle(el)
        const rc = el.getBoundingClientRect()
        const a: Record<string, string> = {}
        for (const n of attrs) {
          const v = el.getAttribute(n)
          if (v !== null) a[n] = v
        }
        let x = ""
        for (const c of Array.from(el.childNodes)) if (c.nodeType === 3) x += c.nodeValue
        nos.push({
          p: caminho.join("."),
          t: tag,
          x: x.replace(/\s+/g, " ").trim(),
          a,
          r: [r2(rc.x + window.scrollX), r2(rc.y + window.scrollY), r2(rc.width), r2(rc.height)],
          g: pg.map((p: string) => cs.getPropertyValue(p)),
          c: pc.map((p: string) => cs.getPropertyValue(p)),
          k: typeof (el as HTMLElement).className === "string" ? (el as HTMLElement).className : (el.getAttribute("class") ?? ""),
        })
        let i = 0
        for (const filho of Array.from(el.children)) visitar(filho, [...caminho, i++])
      }
      visitar(document.body, [0])
      return {
        url: location.pathname + location.search,
        viewport: { w: window.innerWidth, h: window.innerHeight },
        doc: { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight },
        nos,
      }
    },
    { pg: [...PROPS_GEOMETRIA], pc: [...PROPS_COR], attrs: ATRIBUTOS },
  )
  const completo: DumpGeo = { nome, propsGeometria: PROPS_GEOMETRIA, propsCor: PROPS_COR, ...(dump as Omit<DumpGeo, "nome" | "propsGeometria" | "propsCor">) }
  mkdirSync(pasta, { recursive: true })
  writeFileSync(path.join(pasta, `${viewportNome}__${nome}.json.gz`), gzipSync(JSON.stringify(completo)))
}
