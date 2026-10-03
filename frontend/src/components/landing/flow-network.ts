/**
 * Rede de "fluxo de energia" do fundo do hero: nós (eletropostos e pontos) ligados por linhas finas; partículas
 * de energia viajam pelas linhas, sempre para a direita (rumo ao mascote/carro). Módulo PURO (sem DOM): é o que
 * os testes exercitam; o desenho em canvas mora em `FlowCanvas.tsx`.
 */

export type NodeKind = "dot" | "bolt"
export interface NetNode {
  /** Posição-base (sem parallax). */
  bx: number
  by: number
  /** Posição atual (suavizada até o alvo). */
  x: number
  y: number
  depth: number
  kind: NodeKind
  pulse: number
}
export interface Edge {
  a: number
  b: number
}
export interface Network {
  nodes: NetNode[]
  edges: Edge[]
}

/** PRNG determinístico (mesmo desenho a cada render — nada de layout "pulando" entre recargas). */
export function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Distribui nós numa grade com folga aleatória e liga os vizinhos próximos. Raios (bolt) ficam espalhados pela esquerda e pelo meio. */
export function buildNetwork(width: number, height: number, small: boolean, seed = 20261003): Network {
  const rand = mulberry32(seed)
  const cell = small ? 150 : 175
  const cols = Math.max(2, Math.round(width / cell))
  const rows = Math.max(2, Math.round(height / cell))
  const nodes: NetNode[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = ((c + 0.5 + (rand() - 0.5) * 0.7) / cols) * width
      const y = ((r + 0.5 + (rand() - 0.5) * 0.7) / rows) * height
      nodes.push({ bx: x, by: y, x, y, depth: 0.4 + rand() * 0.6, kind: "dot", pulse: 0 })
    }
  }
  // Eletropostos (raio) em ~1 de cada 4 nós da metade esquerda: a energia nasce neles e flui para a direita.
  const byX = nodes.map((_, i) => i).sort((i, j) => nodes[i].bx - nodes[j].bx)
  const pick = Math.max(3, Math.round(nodes.length * 0.34))
  byX.slice(0, pick).forEach((i, k) => {
    if (k % 2 === 0) nodes[i].kind = "bolt"
  })

  const edges: Edge[] = []
  const seen = new Set<string>()
  const reach = cell * 1.65
  nodes.forEach((n, i) => {
    const near = nodes
      .map((m, j) => ({ j, d: Math.hypot(m.bx - n.bx, m.by - n.by) }))
      .filter((o) => o.j !== i && o.d < reach)
      .sort((p, q) => p.d - q.d)
      .slice(0, 3)
    for (const o of near) {
      const key = i < o.j ? `${i}-${o.j}` : `${o.j}-${i}`
      if (seen.has(key)) continue
      seen.add(key)
      edges.push({ a: i, b: o.j })
    }
  })
  return { nodes, edges }
}

/** Arestas que saem de `from` avançando para a direita (a energia nunca volta). `prev` evita o vai-e-volta imediato. */
export function forwardOptions(net: Network, from: number, prev: number): Array<{ edge: number; to: number }> {
  const out: Array<{ edge: number; to: number }> = []
  net.edges.forEach((e, edge) => {
    if (e.a !== from && e.b !== from) return
    const to = e.a === from ? e.b : e.a
    if (to !== prev && net.nodes[to].bx > net.nodes[from].bx) out.push({ edge, to })
  })
  return out
}
