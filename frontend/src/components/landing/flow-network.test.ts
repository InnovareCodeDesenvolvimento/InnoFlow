import { describe, expect, it } from "vitest"
import { buildNetwork, forwardOptions, mulberry32 } from "./flow-network"

describe("flow-network", () => {
  it("é determinístico: mesma semente, mesma rede", () => {
    const a = buildNetwork(1200, 700, false)
    const b = buildNetwork(1200, 700, false)
    expect(a.nodes.map((n) => [n.bx, n.by, n.kind])).toEqual(b.nodes.map((n) => [n.bx, n.by, n.kind]))
    expect(a.edges).toEqual(b.edges)
  })

  it("mantém todos os nós dentro da área e cria arestas válidas sem duplicatas", () => {
    const { nodes, edges } = buildNetwork(900, 600, false)
    for (const n of nodes) {
      expect(n.bx).toBeGreaterThanOrEqual(0)
      expect(n.bx).toBeLessThanOrEqual(900)
      expect(n.by).toBeGreaterThanOrEqual(0)
      expect(n.by).toBeLessThanOrEqual(600)
    }
    const keys = new Set<string>()
    for (const e of edges) {
      expect(e.a).not.toBe(e.b)
      expect(e.a).toBeLessThan(nodes.length)
      expect(e.b).toBeLessThan(nodes.length)
      const key = e.a < e.b ? `${e.a}-${e.b}` : `${e.b}-${e.a}`
      expect(keys.has(key)).toBe(false)
      keys.add(key)
    }
  })

  it("coloca eletropostos (bolt) só na metade esquerda e tem pelo menos um", () => {
    const { nodes } = buildNetwork(1200, 700, false)
    const bolts = nodes.filter((n) => n.kind === "bolt")
    expect(bolts.length).toBeGreaterThan(0)
    const median = [...nodes].sort((p, q) => p.bx - q.bx)[Math.floor(nodes.length / 2)].bx
    for (const b of bolts) expect(b.bx).toBeLessThanOrEqual(median)
  })

  it("usa menos nós no celular (orçamento do canvas)", () => {
    const wide = buildNetwork(1200, 700, false)
    const narrow = buildNetwork(375, 700, true)
    expect(narrow.nodes.length).toBeLessThan(wide.nodes.length)
  })

  it("forwardOptions só avança para a direita e não volta ao nó anterior", () => {
    const net = buildNetwork(1200, 700, false)
    net.nodes.forEach((_, from) => {
      for (const o of forwardOptions(net, from, -1)) {
        expect(net.nodes[o.to].bx).toBeGreaterThan(net.nodes[from].bx)
      }
    })
    const from = net.edges[0].a
    const first = forwardOptions(net, from, -1)[0]
    if (first) expect(forwardOptions(net, from, first.to).some((o) => o.to === first.to)).toBe(false)
  })

  it("mulberry32 devolve valores em [0,1)", () => {
    const r = mulberry32(7)
    for (let i = 0; i < 200; i++) {
      const v = r()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})
