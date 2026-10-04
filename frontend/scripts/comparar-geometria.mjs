#!/usr/bin/env node
/**
 * Classifica a diferença entre DUAS execuções do harness visual (baseline x novo) com prova, não com olho.
 *
 * Entrada: duas pastas geradas por `VISUAL_GEO_DIR=<pasta> npm run test:visual` (a sonda `e2e-visual/geometria.ts` grava, por rota×viewport, o DOM completo com retângulos e estilo
 * computado em `<vp>__<id>.json.gz` e a imagem da MESMA captura em `<vp>__<id>.jpg`).
 *
 * Veredito por página:
 *   IDENTICA  — DOM, retângulos, estilos e pixels idênticos.
 *   ACEITA    — SÓ recolor: árvore/texto/atributos idênticos; o retângulo de TODOS os elementos idêntico; nenhuma propriedade de layout/tipografia/sombra/fundo-imagem diferente;
 *               as únicas propriedades de COR diferentes são de TEXTO/ÍCONE (color, fill, stroke, -webkit-text-fill-color, text-decoration-color, caret-color); e TODO pixel alterado
 *               está dentro (± 16 px) do retângulo de um elemento de texto/ícone que teve a cor alterada.
 *   REPORTAR  — qualquer outra coisa (lista de motivos). `opacity` alterada é REPORTAR com a etiqueta "opacity" para decisão humana (pode ser recolor de texto OU mudar uma imagem).
 *
 * Normalizações (para não acusar o que não aparece na tela): `box-shadow` descarta sombras totalmente transparentes e sem deslocamento/blur (o Tailwind as acrescenta como anel
 * vazio); `outline-color` só conta se NÃO for a cor do texto (currentColor com outline-style none é invisível); `border-*-color` só conta se a borda tem largura > 0 e estilo ≠ none.
 *
 * Uso: node scripts/comparar-geometria.mjs --a <pastaA> --b <pastaB> [--json saida.json] [--md saida.md] [--margem 16] [--opacity-ok "regex do texto de um descendente"]
 *   --ruido-a / --ruido-b: pastas de uma 2ª execução do MESMO estado (A2 e B2). Pixels que variam entre duas execuções idênticas (ruído de renderização, medido) não contam como
 *   "fora da máscara" — mas são CONTADOS e listados em `explicadosPorRuido`. Sem estas pastas, todo pixel fora da máscara reprova.
 *   --orfaos-max N: tolera até N pixels "fora da máscara" SOMENTE quando todo o resto (DOM, retângulos, estilos) é idêntico — ruído de rasterização medido em execuções repetidas do
 *   MESMO estado (blocos de 8x8..16x16 em bordas/sombras, 37–325 px). Fica registrado em `observacao`. Padrão 0 (rígido).
 *   --aceitar-estilo "a|b": propriedades de estilo cuja diferença é ACEITA quando nenhum retângulo e nenhum pixel mudou (mudança latente de CSS, sem efeito no que foi fotografado). Registrada.
 *   --opacity-ok: aceita diferença de `opacity` SÓ em elementos cujo subárvore contém texto casando a regex (ex.: "Desenvolvido por" = selo do desenvolvedor, decisão do Atlas).
 * Sai com código 1 se existir REPORTAR.
 */
import { createRequire } from "node:module"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { gunzipSync } from "node:zlib"

const require = createRequire(import.meta.url)
const { jpegjs } = require("playwright-core/lib/utilsBundle")

const args = process.argv.slice(2)
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 ? args[i + 1] : d
}
const dirA = opt("a")
const dirB = opt("b")
const margem = Number(opt("margem", "16"))
const dirRuidoA = opt("ruido-a")
const dirRuidoB = opt("ruido-b")
const orfaosMax = Number(opt("orfaos-max", "0"))
const estiloLatenteOk = new Set((opt("aceitar-estilo", "") || "").split("|").filter(Boolean))
const opacityOk = opt("opacity-ok") ? new RegExp(opt("opacity-ok")) : null
if (!dirA || !dirB) {
  console.error("uso: --a <pastaA> --b <pastaB> [--json x] [--md y] [--margem 16]")
  process.exit(2)
}

const COR_TEXTO_ICONE = new Set(["color", "fill", "stroke", "-webkit-text-fill-color", "text-decoration-color", "caret-color"])
const EPS = 0.011

const carregar = (dir, chave) => JSON.parse(gunzipSync(readFileSync(path.join(dir, `${chave}.json.gz`))).toString("utf8"))
const jpeg = (dir, chave) => {
  const f = path.join(dir, `${chave}.jpg`)
  return existsSync(f) ? jpegjs.decode(readFileSync(f), { useTArray: true, formatAsRGBA: true }) : null
}
const chaves = readdirSync(dirA).filter((f) => f.endsWith(".json.gz")).map((f) => f.replace(/\.json\.gz$/, "")).sort()

/** Remove sombras invisíveis (cor com alfa 0 e sem deslocamento/blur/spread) e normaliza espaços. */
function normalizarSombra(v) {
  if (!v || v === "none") return "none"
  const partes = []
  let nivel = 0
  let atual = ""
  for (const ch of v) {
    if (ch === "(") nivel++
    if (ch === ")") nivel--
    if (ch === "," && nivel === 0) {
      partes.push(atual.trim())
      atual = ""
    } else atual += ch
  }
  partes.push(atual.trim())
  const uteis = partes.filter((x) => !/^rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\)\s+0px 0px 0px 0px(\s+inset)?$/.test(x))
  return uteis.length ? uteis.join(", ") : "none"
}

function ehTextoOuIcone(no) {
  return no.x !== "" || no.t === "svg" || no.t === "path" || no.t === "input" || no.t === "textarea" || no.t === "select" || no.t === "circle" || no.t === "line" || no.t === "polyline" || no.t === "rect"
}

function classificar(chave) {
  const motivos = []
  if (!existsSync(path.join(dirB, `${chave}.json.gz`))) return { chave, status: "REPORTAR", motivos: ["página ausente no lado B"] }
  const A = carregar(dirA, chave)
  const B = carregar(dirB, chave)
  const r = { chave, status: "ACEITA", motivos, nos: A.nos.length, coresAlteradas: {}, nosComCorAlterada: 0, nosComOpacityAlterada: 0, pixels: null, estrutura: "igual" }

  if (A.doc.w !== B.doc.w || A.doc.h !== B.doc.h) motivos.push(`tamanho do documento ${A.doc.w}x${A.doc.h} -> ${B.doc.w}x${B.doc.h}`)
  if (A.viewport.w !== B.viewport.w || A.viewport.h !== B.viewport.h) motivos.push(`viewport efetiva ${A.viewport.w}x${A.viewport.h} -> ${B.viewport.w}x${B.viewport.h}`)
  if (A.nos.length !== B.nos.length) {
    motivos.push(`nº de elementos ${A.nos.length} -> ${B.nos.length}`)
    r.estrutura = "diferente"
  }
  const idxG = Object.fromEntries(A.propsGeometria.map((p, i) => [p, i]))
  const idxC = Object.fromEntries(A.propsCor.map((p, i) => [p, i]))
  const retangulosCor = []
  const retangulosFundo = []
  const geomProps = new Map()
  const estruturais = []
  const rectDiffs = []
  const naoTexto = new Map()
  const opacidade = []

  const n = Math.min(A.nos.length, B.nos.length)
  for (let i = 0; i < n; i++) {
    const a = A.nos[i]
    const b = B.nos[i]
    const rotulo = `${a.t}[${a.p}]${a.x ? ` "${a.x.slice(0, 30)}"` : ""}`
    if (a.p !== b.p || a.t !== b.t) {
      estruturais.push(`${rotulo} -> ${b.t}[${b.p}]`)
      r.estrutura = "diferente"
      continue
    }
    if (a.x !== b.x) estruturais.push(`${rotulo}: texto "${a.x}" -> "${b.x}"`)
    if (JSON.stringify(a.a) !== JSON.stringify(b.a)) estruturais.push(`${rotulo}: atributos ${JSON.stringify(a.a)} -> ${JSON.stringify(b.a)}`)
    if (a.r.some((v, k) => Math.abs(v - b.r[k]) > EPS)) rectDiffs.push(`${rotulo} [${a.r}] -> [${b.r}]`)
    for (let k = 0; k < a.g.length; k++) {
      const prop = A.propsGeometria[k]
      const va = prop === "box-shadow" ? normalizarSombra(a.g[k]) : a.g[k]
      const vb = prop === "box-shadow" ? normalizarSombra(b.g[k]) : b.g[k]
      if (va !== vb) {
        const l = geomProps.get(prop) ?? []
        l.push(`${rotulo}: ${va} -> ${vb}`)
        geomProps.set(prop, l)
      }
    }
    let corMudou = false
    for (let k = 0; k < a.c.length; k++) {
      if (a.c[k] === b.c[k]) continue
      const prop = A.propsCor[k]
      if (prop === "opacity") {
        r.nosComOpacityAlterada++
        const aceita = opacityOk && [a, ...A.nos.filter((o) => o.p.startsWith(`${a.p}.`))].some((o) => opacityOk.test(o.x))
        if (aceita) {
          r.opacityAceita = (r.opacityAceita ?? 0) + 1
          retangulosCor.push(a.r)
        } else opacidade.push(`${rotulo}: opacity ${a.c[k]} -> ${b.c[k]}`)
        continue
      }
      if (prop === "outline-color" && a.c[k] === a.c[idxC["color"]] && b.c[k] === b.c[idxC["color"]]) continue // currentColor derivado
      const lado = /^border-(top|right|bottom|left)-color$/.exec(prop)
      if (lado) {
        const largura = a.g[idxG[`border-${lado[1]}-width`]]
        const estilo = a.g[idxG[`border-${lado[1]}-style`]]
        if (largura === "0px" || estilo === "none" || estilo === "hidden") continue // borda inexistente: a cor computada é só herança de currentColor
      }
      r.coresAlteradas[prop] = (r.coresAlteradas[prop] ?? 0) + 1
      if (COR_TEXTO_ICONE.has(prop)) corMudou = true
      else {
        const l = naoTexto.get(prop) ?? []
        l.push(`${rotulo}: ${a.c[k]} -> ${b.c[k]}`)
        naoTexto.set(prop, l)
        retangulosFundo.push(a.r)
      }
    }
    if (corMudou) {
      r.nosComCorAlterada++
      if (ehTextoOuIcone(a)) retangulosCor.push(a.r)
    }
  }

  if (estruturais.length) motivos.push(`ESTRUTURA/TEXTO/ATRIBUTOS: ${estruturais.length} (ex.: ${estruturais.slice(0, 3).join(" | ")})`)
  if (rectDiffs.length) motivos.push(`GEOMETRIA (retângulo): ${rectDiffs.length} elementos (ex.: ${rectDiffs.slice(0, 3).join(" | ")})`)
  for (const [prop, l] of [...geomProps]) {
    if (estiloLatenteOk.has(prop) && rectDiffs.length === 0) {
      r.latentes = [...(r.latentes ?? []), `${prop} (${l.length} elemento(s): ${l.slice(0, 2).join(" | ")})`]
      geomProps.delete(prop)
    }
  }
  for (const [prop, l] of geomProps) motivos.push(`ESTILO não-cor "${prop}": ${l.length} elementos (ex.: ${l.slice(0, 2).join(" | ")})`)
  for (const [prop, l] of naoTexto) motivos.push(`COR que não é de texto/ícone "${prop}": ${l.length} elementos (ex.: ${l.slice(0, 2).join(" | ")})`)
  if (opacidade.length) motivos.push(`opacity: ${opacidade.length} elementos — decisão humana (ex.: ${opacidade.slice(0, 2).join(" | ")})`)
  if (r.opacityAceita) r.observacao = `opacity aceita (--opacity-ok) em ${r.opacityAceita} elemento(s)`
  r.opacity = opacidade

  // ---- pixels ----
  const ia = jpeg(dirA, chave)
  const ib = jpeg(dirB, chave)
  if (!ia || !ib) {
    motivos.push("imagem ausente (A ou B)")
  } else if (ia.width !== ib.width || ia.height !== ib.height) {
    motivos.push(`imagem com tamanho diferente ${ia.width}x${ia.height} -> ${ib.width}x${ib.height}`)
  } else {
    const W = ia.width
    const H = ia.height
    const dentro = new Uint8Array(W * H)
    for (const [x, y, w, h] of retangulosCor) {
      const x0 = Math.max(0, Math.floor(x - margem))
      const y0 = Math.max(0, Math.floor(y - margem))
      const x1 = Math.min(W, Math.ceil(x + w + margem))
      const y1 = Math.min(H, Math.ceil(y + h + margem))
      for (let yy = y0; yy < y1; yy++) dentro.fill(1, yy * W + x0, yy * W + x1)
    }
    // máscara de RUÍDO: pixels que mudam entre duas execuções do mesmo estado (inflados em 16 px)
    const ruido = new Uint8Array(W * H)
    const marcarRuido = (x1, y1, x2, y2) => {
      const x0 = Math.max(0, x1 - margem), yy0 = Math.max(0, y1 - margem), xe = Math.min(W, x2 + margem + 1), ye = Math.min(H, y2 + margem + 1)
      for (let yy = yy0; yy < ye; yy++) ruido.fill(1, yy * W + x0, yy * W + xe)
    }
    for (const [dirX, dirY] of [[dirA, dirRuidoA], [dirB, dirRuidoB]]) {
      if (!dirY) continue
      const ix = jpeg(dirX, chave)
      const iy = jpeg(dirY, chave)
      if (!ix || !iy || ix.width !== iy.width || ix.height !== iy.height) {
        if (ix && iy) {
          motivos.push(`execução repetida com tamanho diferente (${ix.width}x${ix.height} x ${iy.width}x${iy.height}) — estado instável`)
        }
        continue
      }
      for (let p = 0; p < W * H; p++) {
        const o = p * 4
        if (ix.data[o] !== iy.data[o] || ix.data[o + 1] !== iy.data[o + 1] || ix.data[o + 2] !== iy.data[o + 2]) {
          const x = p % W
          const y = (p - x) / W
          marcarRuido(x, y, x, y)
        }
      }
    }
    const dentroFundo = new Uint8Array(W * H)
    for (const [x, y, w, h] of retangulosFundo) {
      const x0 = Math.max(0, Math.floor(x - margem)), y0 = Math.max(0, Math.floor(y - margem)), x1 = Math.min(W, Math.ceil(x + w + margem)), y1 = Math.min(H, Math.ceil(y + h + margem))
      for (let yy = y0; yy < y1; yy++) dentroFundo.fill(1, yy * W + x0, yy * W + x1)
    }
    let foraDeTudo = 0
    let explicadosPorRuido = 0
    let alterados = 0
    let fora = 0
    let minX = W, minY = H, maxX = -1, maxY = -1
    let fMinX = W, fMinY = H, fMaxX = -1, fMaxY = -1
    for (let p = 0; p < W * H; p++) {
      const o = p * 4
      if (ia.data[o] === ib.data[o] && ia.data[o + 1] === ib.data[o + 1] && ia.data[o + 2] === ib.data[o + 2]) continue
      alterados++
      const x = p % W
      const y = (p - x) / W
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      if (!dentro[p] && !dentroFundo[p] && !ruido[p]) foraDeTudo++
      if (!dentro[p] && ruido[p]) explicadosPorRuido++
      else if (!dentro[p]) {
        fora++
        if (x < fMinX) fMinX = x
        if (x > fMaxX) fMaxX = x
        if (y < fMinY) fMinY = y
        if (y > fMaxY) fMaxY = y
      }
    }
    r.pixels = { total: W * H, alterados, explicadosPorRuido, foraDaMascara: fora, foraDeTudoInclusiveFundo: foraDeTudo, bbox: alterados ? [minX, minY, maxX, maxY] : null, bboxFora: fora ? [fMinX, fMinY, fMaxX, fMaxY] : null }
    if (fora > 0 && fora <= orfaosMax && motivos.length === 0) {
      r.observacao = `${r.observacao ? r.observacao + "; " : ""}ruído de raster: ${fora} px fora da máscara (≤ ${orfaosMax}) com DOM/retângulos/estilos idênticos`
      r.pixels.ruidoToleradoPx = fora
    } else if (fora > 0) motivos.push(`PIXELS alterados FORA dos elementos de texto/ícone recoloridos: ${fora} (bbox ${fMinX},${fMinY}..${fMaxX},${fMaxY})`)
    if (alterados === 0 && r.nosComCorAlterada > 0) r.observacao = "cor computada mudou mas nenhum pixel mudou (elemento oculto/sem texto visível)"
  }

  if (motivos.length) r.status = "REPORTAR"
  else if (r.nosComCorAlterada === 0 && (r.pixels?.alterados ?? 0) === 0 && r.nosComOpacityAlterada === 0) r.status = "IDENTICA"
  return r
}

const resultados = chaves.map(classificar)
const cont = {}
for (const r of resultados) cont[r.status] = (cont[r.status] ?? 0) + 1
console.log(`páginas: ${resultados.length}  ${Object.entries(cont).map(([k, v]) => `${k}=${v}`).join("  ")}`)
for (const r of resultados.filter((x) => x.status === "REPORTAR")) console.log(`REPORTAR ${r.chave}\n  - ${r.motivos.join("\n  - ")}`)

const saidaJson = opt("json")
if (saidaJson) writeFileSync(saidaJson, JSON.stringify({ margemPx: margem, contagem: cont, resultados }, null, 1))
const saidaMd = opt("md")
if (saidaMd) {
  const linhas = ["| Página (viewport__id) | Veredito | Nós com cor alterada | Pixels alterados | Fora da máscara | Props de cor |", "|---|---|---:|---:|---:|---|"]
  for (const r of resultados)
    linhas.push(`| ${r.chave} | ${r.status} | ${r.nosComCorAlterada ?? ""} | ${r.pixels?.alterados ?? ""} | ${r.pixels?.foraDaMascara ?? ""} | ${Object.entries(r.coresAlteradas ?? {}).map(([k, v]) => `${k}:${v}`).join(", ")} |`)
  writeFileSync(saidaMd, linhas.join("\n") + "\n")
}
process.exit(resultados.some((r) => r.status === "REPORTAR") ? 1 : 0)
