import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

/**
 * O mascote existe em DUAS cópias de propósito (landing x `components/brand`) para a landing não compartilhar chunk com 404/auth/QR — ver o
 * cabeçalho de `components/landing/Mascot.tsx`. Este teste impede que elas divirjam (alt, dimensões, pálpebras, assets) e que a cópia da landing
 * passe a importar `components/ui` ou `components/brand` (o que recriaria o chunk compartilhado e poria um 7º item no modulepreload).
 */
const dir = path.resolve(import.meta.dirname, "..")
const read = (rel: string) => readFileSync(path.join(dir, rel), "utf8").replace(/\r\n/g, "\n")
const landing = read("landing/Mascot.tsx")
const brand = read("brand/Mascot.tsx")

/** Só o que é código: sem comentários de bloco/linha e sem a classe extra `brand-mascot-box` (única diferença intencional). */
function codigo(src: string) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/ brand-mascot-box/g, "")
    .replace(/[?]url/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

describe("Mascot: cópias da landing e de brand", () => {
  it("têm o mesmo código (fora comentários e a classe brand-mascot-box)", () => {
    expect(codigo(brand)).toBe(codigo(landing))
  })

  it("a cópia da landing não importa components/ui nem components/brand (nenhum chunk compartilhado)", () => {
    expect(landing).not.toMatch(/from\s+["']@\/components\/(ui|brand)/)
    expect(landing).not.toMatch(/from\s+["']\.\.?\/(ui|brand)/)
  })
})
