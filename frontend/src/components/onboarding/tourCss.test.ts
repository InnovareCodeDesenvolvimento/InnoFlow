import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

/**
 * `prefers-reduced-motion`: o movimento do mascote e do tour é CSS (`tour.css`), sem JavaScript por quadro. A garantia de que a versão estática existe é estrutural: toda declaração
 * de `animation`/`transition` fica DENTRO de `@media (prefers-reduced-motion: no-preference)`. Com `reduce` (ou sem suporte), nada se move.
 */
const css = readFileSync(path.resolve(import.meta.dirname, "tour.css"), "utf8")

/** Remove os blocos `@media (prefers-reduced-motion: no-preference) { ... }` (chaves casadas) e devolve o que sobra: o CSS que vale SEMPRE. */
function withoutNoPreferenceBlocks(source: string): string {
  let out = ""
  let i = 0
  const marker = "@media (prefers-reduced-motion: no-preference)"
  while (i < source.length) {
    const at = source.indexOf(marker, i)
    if (at === -1) {
      out += source.slice(i)
      break
    }
    out += source.slice(i, at)
    let depth = 0
    let j = source.indexOf("{", at)
    for (; j < source.length; j++) {
      if (source[j] === "{") depth++
      else if (source[j] === "}" && --depth === 0) break
    }
    i = j + 1
  }
  return out
}

/** Também sem os `@keyframes` (declarar keyframe não anima nada sozinho). */
function withoutKeyframes(source: string): string {
  return source.replace(/@keyframes[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "")
}

describe("tour.css e prefers-reduced-motion", () => {
  const always = withoutKeyframes(withoutNoPreferenceBlocks(css))

  it("nenhuma animation/transition vale fora do bloco no-preference", () => {
    expect(always).not.toMatch(/\banimation(-[a-z]+)?\s*:/)
    expect(always).not.toMatch(/\btransition(-[a-z]+)?\s*:/)
  })

  it("e há, de fato, movimento dentro do bloco (o teste não está provando o vazio)", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: no-preference\)/)
    expect(css).toMatch(/animation: tm-breathe/)
    expect(css).toMatch(/animation: tm-led/)
    expect(css).toMatch(/animation: tm-wave/)
    expect(css).toMatch(/animation: tm-blink/)
    expect(css).toMatch(/animation: tour-in/)
  })

  it("a versão estática mostra o balão e os LEDs sem depender de animação", () => {
    // `.tour-balloon[data-ready]` fica visível por `visibility`, não por uma animação de opacidade que o reduce desligaria.
    expect(always).toMatch(/\.tour-balloon\[data-ready\]\s*\{\s*visibility:\s*visible/)
    expect(always).toMatch(/\.tm-led\s*\{[^}]*opacity:\s*0\.35/)
  })
})
