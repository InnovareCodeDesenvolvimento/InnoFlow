import { afterEach, describe, expect, it, vi } from "vitest"
import { ensureVisible, findTarget, isRendered, measureVisibleRect } from "./tourDom"

/** jsdom não faz layout (todo `getBoundingClientRect` é 0): cada teste dá ao elemento a caixa que o navegador daria. */
function box(el: Element, left: number, top: number, width: number, height: number) {
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect)
}

function mount(html: string): HTMLElement {
  const host = document.createElement("div")
  host.innerHTML = html
  document.body.appendChild(host)
  return host
}

afterEach(() => {
  document.body.innerHTML = ""
  vi.restoreAllMocks()
})

describe("achar o alvo (fallback para o balão centralizado)", () => {
  it("alvo AUSENTE: null", () => {
    mount("<div></div>")
    expect(findTarget("nav-sites")).toBeNull()
  })

  it("alvo sem caixa (display:none: width/height 0): null", () => {
    const host = mount('<a data-tour="nav-sites" style="display:none">Sites</a>')
    expect(findTarget("nav-sites")).toBeNull()
    expect(isRendered(host.firstElementChild as HTMLElement)).toBe(false)
  })

  it("alvo com caixa: devolve o elemento", () => {
    const host = mount('<a data-tour="nav-sites">Sites</a>')
    box(host.firstElementChild!, 10, 10, 200, 40)
    expect(findTarget("nav-sites")).toBe(host.firstElementChild)
  })

  it("o mesmo nome na sidebar (oculta) e no drawer (visível): pega o visível", () => {
    const host = mount('<a id="oculto" data-tour="nav-sites">a</a><a id="visivel" data-tour="nav-sites">b</a>')
    box(host.querySelector("#visivel")!, 10, 10, 200, 40)
    expect(findTarget("nav-sites")?.id).toBe("visivel")
  })
})

describe("parte visível do alvo", () => {
  it("alvo inteiro dentro da janela: devolve o retângulo todo", () => {
    const host = mount('<a data-tour="x">x</a>')
    box(host.firstElementChild!, 20, 100, 200, 40)
    expect(measureVisibleRect(host.firstElementChild as HTMLElement)).toEqual({ left: 20, top: 100, width: 200, height: 40 })
  })

  it("alvo fora da janela (rolado para fora): null → balão centralizado", () => {
    const host = mount('<a data-tour="x">x</a>')
    box(host.firstElementChild!, 20, window.innerHeight + 300, 200, 40)
    expect(measureVisibleRect(host.firstElementChild as HTMLElement)).toBeNull()
  })

  it("grupo recolhido do menu (ancestral overflow:hidden com altura 0): o alvo existe mas ninguém o vê → null", () => {
    // longhand de propósito: o jsdom não expande o atalho `overflow:hidden` em overflow-x/overflow-y (o navegador expande)
    const host = mount('<div id="grupo" style="overflow-x:hidden;overflow-y:hidden"><a data-tour="x">x</a></div>')
    box(host.querySelector("#grupo")!, 0, 200, 240, 0)
    box(host.querySelector("a")!, 10, 200, 200, 48)
    expect(measureVisibleRect(host.querySelector("a")!)).toBeNull()
  })

  it("lista rolável cortando o alvo ao meio (<60% visível): null; com 80% visível: o recorte", () => {
    const host = mount('<div id="lista" style="overflow-y:auto"><a data-tour="x">x</a></div>')
    box(host.querySelector("#lista")!, 0, 0, 256, 400)
    box(host.querySelector("a")!, 10, 380, 200, 48) // 20 de 48 visíveis (42%)
    expect(measureVisibleRect(host.querySelector("a")!)).toBeNull()
    vi.restoreAllMocks()
    box(host.querySelector("#lista")!, 0, 0, 256, 400)
    box(host.querySelector("a")!, 10, 362, 200, 48) // 38 de 48 visíveis (79%)
    expect(measureVisibleRect(host.querySelector("a")!)).toEqual({ left: 10, top: 362, width: 200, height: 38 })
  })
})

describe("trazer o alvo para a vista", () => {
  it("rola a lista do menu até o alvo, sem rolar a janela quando o alvo é fixo", () => {
    const host = mount('<div id="lista" style="overflow-y:auto;position:fixed"><a data-tour="x">x</a></div>')
    const lista = host.querySelector("#lista") as HTMLElement
    Object.defineProperty(lista, "scrollHeight", { value: 900, configurable: true })
    Object.defineProperty(lista, "clientHeight", { value: 400, configurable: true })
    box(lista, 0, 0, 256, 400)
    box(host.querySelector("a")!, 10, 600, 200, 48) // abaixo da lista
    const scrollBy = vi.fn()
    vi.stubGlobal("scrollBy", scrollBy)
    ensureVisible(host.querySelector("a")!)
    expect(lista.scrollTop).toBeGreaterThan(0)
    expect(scrollBy).not.toHaveBeenCalled()
  })
})
