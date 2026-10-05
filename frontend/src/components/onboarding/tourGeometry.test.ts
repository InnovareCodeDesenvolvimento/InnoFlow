import { describe, expect, it } from "vitest"
import { clipRect, computePlacement, fitsInViewport, lookDirection, overlaps, padRect, type Rect, type Size } from "./tourGeometry"

const BALLOON: Size = { width: 368, height: 260 }
const MOBILE_BALLOON: Size = { width: 351, height: 300 }
const VIEWPORTS: Size[] = [
  { width: 375, height: 812 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
]

describe("computePlacement", () => {
  it("prefere o lado direito do alvo quando cabe (sidebar a 1440)", () => {
    const sidebarItem: Rect = { left: 10, top: 300, width: 236, height: 56 }
    const p = computePlacement({ target: sidebarItem, balloon: BALLOON, viewport: VIEWPORTS[2] })
    expect(p).toMatchObject({ mode: "anchored", side: "right" })
    if (p.mode === "anchored") expect(p.left).toBe(10 + 236 + 16)
  })

  it("alvo na barra de baixo do celular: o balão vai EM CIMA e não cobre o alvo", () => {
    const navItem: Rect = { left: 69, top: 738, width: 87, height: 81 }
    const p = computePlacement({ target: navItem, balloon: MOBILE_BALLOON, viewport: VIEWPORTS[0] })
    expect(p).toMatchObject({ mode: "anchored", side: "top" })
    if (p.mode === "anchored") expect(overlaps({ left: p.left, top: p.top, ...MOBILE_BALLOON }, navItem)).toBe(false)
  })

  it("alvo no cabeçalho do celular: o balão vai EMBAIXO", () => {
    const header: Rect = { left: 317, top: 8, width: 48, height: 48 }
    expect(computePlacement({ target: header, balloon: MOBILE_BALLOON, viewport: VIEWPORTS[0] })).toMatchObject({ mode: "anchored", side: "bottom" })
  })

  it("sem alvo, ou alvo todo fora da janela: balão centralizado (fallback)", () => {
    expect(computePlacement({ target: null, balloon: BALLOON, viewport: VIEWPORTS[2] })).toEqual({ mode: "center" })
    expect(computePlacement({ target: { left: 100, top: 2000, width: 50, height: 50 }, balloon: BALLOON, viewport: VIEWPORTS[2] })).toEqual({ mode: "center" })
    expect(computePlacement({ target: { left: -400, top: 10, width: 50, height: 50 }, balloon: BALLOON, viewport: VIEWPORTS[2] })).toEqual({ mode: "center" })
  })

  it("nenhum lado cabe (balão maior que a janela livre): centraliza em vez de sair da tela", () => {
    const tiny: Size = { width: 320, height: 480 }
    expect(computePlacement({ target: { left: 100, top: 200, width: 100, height: 80 }, balloon: { width: 300, height: 450 }, viewport: tiny })).toEqual({ mode: "center" })
  })

  it("alvo mais alto que a janela (sidebar): usa só a parte visível", () => {
    const tall: Rect = { left: -6, top: -6, width: 268, height: 912 }
    const p = computePlacement({ target: tall, balloon: BALLOON, viewport: VIEWPORTS[2] })
    expect(p.mode).toBe("anchored")
    if (p.mode === "anchored") expect(p.top).toBeGreaterThanOrEqual(12)
  })

  it("a ponta (arrow) fica dentro do balão", () => {
    const p = computePlacement({ target: { left: 1058, top: 8, width: 216, height: 48 }, balloon: BALLOON, viewport: VIEWPORTS[2] })
    expect(p.mode).toBe("anchored")
    if (p.mode === "anchored") {
      expect(p.arrow).toBeGreaterThanOrEqual(20)
      expect(p.arrow).toBeLessThanOrEqual((p.side === "top" || p.side === "bottom" ? BALLOON.width : BALLOON.height) - 20)
    }
  })

  // Varredura: para uma grade de alvos em cada largura, o balão ancorado SEMPRE cabe na janela e NUNCA cobre o alvo — a mesma propriedade que a régua do navegador confere.
  it.each(VIEWPORTS)("balão ancorado cabe na janela e não cobre o alvo ($width x $height)", (viewport) => {
    const balloon = viewport.width < 640 ? { width: Math.min(368, viewport.width - 24), height: 300 } : BALLOON
    let anchored = 0
    for (let top = 0; top < viewport.height - 40; top += 60) {
      for (let left = 0; left < viewport.width - 40; left += 70) {
        const target: Rect = { left, top, width: 80, height: 48 }
        const p = computePlacement({ target, balloon, viewport })
        if (p.mode !== "anchored") continue
        anchored++
        const box: Rect = { left: p.left, top: p.top, ...balloon }
        expect(fitsInViewport(box, viewport, 12)).toBe(true)
        expect(overlaps(box, clipRect(target, viewport))).toBe(false)
      }
    }
    expect(anchored).toBeGreaterThan(10)
  })
})

describe("auxiliares", () => {
  it("padRect aumenta nos 4 lados", () => {
    expect(padRect({ left: 10, top: 10, width: 20, height: 20 }, 6)).toEqual({ left: 4, top: 4, width: 32, height: 32 })
  })
  it("clipRect recorta pela janela", () => {
    expect(clipRect({ left: -5, top: 90, width: 20, height: 50 }, { width: 100, height: 100 })).toEqual({ left: 0, top: 90, width: 15, height: 10 })
  })
  it("lookDirection: o mascote olha para o lado do alvo", () => {
    expect(lookDirection({ mode: "center" })).toBe("none")
    expect(lookDirection({ mode: "anchored", side: "right", left: 0, top: 0, arrow: 20 })).toBe("left")
    expect(lookDirection({ mode: "anchored", side: "top", left: 0, top: 0, arrow: 20 })).toBe("down")
  })
})
