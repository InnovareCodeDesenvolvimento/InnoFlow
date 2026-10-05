import { describe, expect, it } from "vitest"
import { goBack, goNext, indexOfStep, keyToAction, nextFocusIndex } from "./tourLogic"

describe("navegação do tour", () => {
  it("avança e, no último passo, conclui", () => {
    expect(goNext(0, 5)).toEqual({ index: 1, done: false })
    expect(goNext(3, 5)).toEqual({ index: 4, done: false })
    expect(goNext(4, 5)).toEqual({ index: 4, done: true })
  })
  it("volta sem passar do primeiro", () => {
    expect(goBack(3)).toEqual({ index: 2, done: false })
    expect(goBack(0)).toEqual({ index: 0, done: false })
  })
  it("o passo é guardado por id: se a lista encolhe (janela redimensionada), vai para o primeiro", () => {
    const steps = [{ id: "a" }, { id: "b" }, { id: "c" }]
    expect(indexOfStep(steps, "c")).toBe(2)
    expect(indexOfStep(steps, "sumiu")).toBe(0)
  })
})

describe("teclado", () => {
  it("setas navegam, Esc pula", () => {
    expect(keyToAction({ key: "ArrowRight" })).toBe("next")
    expect(keyToAction({ key: "ArrowLeft" })).toBe("back")
    expect(keyToAction({ key: "Escape" })).toBe("skip")
    expect(keyToAction({ key: "a" })).toBeNull()
  })
  it("com Ctrl/Cmd/Alt a tecla é do navegador, não do tour", () => {
    expect(keyToAction({ key: "ArrowLeft", altKey: true })).toBeNull()
    expect(keyToAction({ key: "ArrowRight", ctrlKey: true })).toBeNull()
    expect(keyToAction({ key: "Escape", metaKey: true })).toBeNull()
  })
})

describe("foco preso", () => {
  it("Tab dá a volta nas pontas do balão", () => {
    expect(nextFocusIndex(0, 3, false)).toBe(1)
    expect(nextFocusIndex(2, 3, false)).toBe(0)
    expect(nextFocusIndex(0, 3, true)).toBe(2)
  })
  it("foco fora do balão entra pelo primeiro (Tab) ou último (Shift+Tab)", () => {
    expect(nextFocusIndex(-1, 3, false)).toBe(0)
    expect(nextFocusIndex(-1, 3, true)).toBe(2)
    expect(nextFocusIndex(0, 0, false)).toBe(-1)
  })
})
