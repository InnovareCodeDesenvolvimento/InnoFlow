import type { Page } from "@playwright/test"
// @ts-expect-error pngjs (dependência transitiva do `qrcode`) não traz tipos; só usamos PNG.sync.read
import { PNG } from "pngjs"

/**
 * Contraste de TEXTO medido por PIXEL, independente do axe — para o que o axe declara "incompleto" (texto sobre degradê, vidro, sobreposição).
 *
 * Método: (1) coleta cada nó de texto visível com a(s) caixa(s) REAIS do texto (`Range.getClientRects`, não o retângulo do elemento) e a cor computada;
 * (2) esconde TODO o texto (`color` e `-webkit-text-fill-color` transparentes) e fotografa a página: o que sobra sob a caixa do texto é o FUNDO real, com degradê,
 * sobreposição e imagem; (3) para cada caixa, compara a cor do texto (composta sobre o pixel, se tiver alfa) com CADA pixel de fundo da caixa e fica com o PIOR par.
 * Limiar WCAG AA: 4,5:1 (texto normal) ou 3:1 (grande: >= 24 px, ou >= 18,66 px em negrito). Nada de média: um pixel claro dentro do degradê reprova a caixa.
 * O que NÃO cobre: texto em <canvas>/<img>/SVG, texto dentro de elemento `aria-hidden` (decorativo, ignorado de propósito), controles desabilitados (isentos pela WCAG).
 */

export interface TextoMedido {
  texto: string
  cor: string
  fonte: number
  negrito: boolean
  limiar: number
  pior: number
}

export interface ResultadoContrastePixel {
  textos: number
  menor: number
  reprovados: TextoMedido[]
  piores: TextoMedido[]
}

function luminancia(r: number, g: number, b: number): number {
  const f = (v: number) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
const razao = (l1: number, l2: number) => (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)

export async function medirContrastePixel(page: Page): Promise<ResultadoContrastePixel> {
  const medidosPorChave = new Map<string, TextoMedido>()
  const vh = page.viewportSize()!.height
  const total = await page.evaluate(() => document.documentElement.scrollHeight)
  const passo = Math.max(200, Math.floor(vh * 0.85))
  for (let y = 0; y < Math.max(total - vh, 0) + passo; y += passo) {
    await page.evaluate((yy) => window.scrollTo(0, yy), y)
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
    const scrollY = await page.evaluate(() => window.scrollY)
    await medirJanela(page, scrollY, medidosPorChave)
    if (scrollY + vh >= total - 1) break
  }
  await page.evaluate(() => window.scrollTo(0, 0))
  const medidos = [...medidosPorChave.values()]
  const reprovados = medidos.filter((m) => m.pior < m.limiar)
  return { textos: medidos.length, menor: medidos.length ? Math.min(...medidos.map((m) => m.pior)) : 0, reprovados, piores: [...medidos].sort((a, b) => a.pior / a.limiar - b.pior / b.limiar).slice(0, 5) }
}

async function medirJanela(page: Page, scrollY: number, acumulado: Map<string, TextoMedido>): Promise<void> {
  const caixas = await page.evaluate(() => {
    const saida: Array<{ texto: string; cor: [number, number, number, number]; fonte: number; negrito: boolean; rects: Array<[number, number, number, number]> }> = []
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let n: Node | null
    while ((n = walker.nextNode())) {
      const texto = (n.nodeValue ?? "").replace(/\s+/g, " ").trim()
      if (!texto) continue
      const el = n.parentElement
      if (!el || ["SCRIPT", "STYLE", "NOSCRIPT"].includes(el.tagName)) continue
      if (el.closest("[aria-hidden='true'], [disabled], .sr-only, .leaflet-container, canvas, svg")) continue
      const cs = getComputedStyle(el)
      if (cs.visibility === "hidden" || cs.display === "none") continue
      let opacidade = 1
      for (let p: Element | null = el; p; p = p.parentElement) opacidade *= Number(getComputedStyle(p).opacity)
      if (opacidade < 0.05) continue
      const m = /rgba?\(([^)]+)\)/.exec(cs.color)
      if (!m) continue
      const [r, g, b, a = "1"] = m[1].split(/[,/]\s*|\s+/).filter(Boolean)
      const range = document.createRange()
      range.selectNodeContents(n)
      const rects = [...range.getClientRects()]
        .filter((q) => q.width > 1 && q.height > 1 && q.top >= 0 && q.bottom <= window.innerHeight && q.right > 0 && q.left < window.innerWidth)
        .map((q) => [q.x, q.y, q.width, q.height] as [number, number, number, number])
      if (!rects.length) continue
      // Oclusão: o texto rolado para baixo do cabeçalho/navegação FIXOS tem caixa dentro da janela mas não está (todo) visível. Os 4 cantos da caixa (1 px para dentro) e o centro têm de
      // cair no próprio texto (ou em pai/filho dele); senão a caixa está cortada por outro elemento e só vale a medição de uma rolagem em que ela esteja inteira.
      const cobertura = rects.every(([qx, qy, qw, qh]) =>
        [[qx + 1, qy + 1], [qx + qw - 1, qy + 1], [qx + 1, qy + qh - 1], [qx + qw - 1, qy + qh - 1], [qx + qw / 2, qy + qh / 2]].every(([px, py]) => {
          const topo = document.elementFromPoint(px, py)
          return !!topo && (el.contains(topo) || topo.contains(el))
        }),
      )
      if (!cobertura) continue
      saida.push({ texto: texto.slice(0, 48), cor: [Number(r), Number(g), Number(b), Number(a) * opacidade], fonte: parseFloat(cs.fontSize), negrito: Number(cs.fontWeight) >= 700, rects: rects.slice(0, 4) })
    }
    return saida
  })
  if (!caixas.length) return

  const estilo = await page.addStyleTag({ content: "*,*::before,*::after{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important;caret-color:transparent!important;text-decoration-color:transparent!important}" })
  let png
  try {
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
    png = PNG.sync.read(await page.screenshot({ animations: "disabled" }))
  } finally {
    await estilo.evaluate((e: HTMLStyleElement) => e.remove())
  }

  for (const c of caixas) {
    let pior = Infinity
    for (const [x, y, w, h] of c.rects) {
      const x0 = Math.max(0, Math.floor(x))
      const y0 = Math.max(0, Math.floor(y))
      const x1 = Math.min(png.width, Math.ceil(x + w))
      const y1 = Math.min(png.height, Math.ceil(y + h))
      for (let yy = y0; yy < y1; yy++)
        for (let xx = x0; xx < x1; xx++) {
          const o = (yy * png.width + xx) * 4
          const a = c.cor[3]
          const R = c.cor[0] * a + png.data[o] * (1 - a)
          const G = c.cor[1] * a + png.data[o + 1] * (1 - a)
          const B = c.cor[2] * a + png.data[o + 2] * (1 - a)
          const q = razao(luminancia(R, G, B), luminancia(png.data[o], png.data[o + 1], png.data[o + 2]))
          if (q < pior) pior = q
        }
    }
    if (!Number.isFinite(pior)) continue
    const grande = c.fonte >= 24 || (c.fonte >= 18.66 && c.negrito)
    const item: TextoMedido = { texto: c.texto, cor: `rgba(${c.cor.map((v, i) => (i < 3 ? Math.round(v) : +v.toFixed(2))).join(",")})`, fonte: c.fonte, negrito: c.negrito, limiar: grande ? 3 : 4.5, pior: +pior.toFixed(2) }
    const chave = `${c.texto}|${Math.round(c.rects[0][0])},${Math.round(c.rects[0][1] + scrollY)}`
    const antes = acumulado.get(chave)
    if (!antes || item.pior < antes.pior) acumulado.set(chave, item)
  }
}
