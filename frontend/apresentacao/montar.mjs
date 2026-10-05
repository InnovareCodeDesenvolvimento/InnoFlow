/**
 * Monta os slides (HTML, 1920x1080) a partir de conteudo-*.mjs + capturas/ e gera o PDF com o Chromium (page.pdf).
 * O HTML fica em saida/html/<id>.html — é a "fonte editável": abra no navegador, ajuste o texto e use Imprimir > Salvar como PDF
 * (tamanho de página 1920x1080, margens nenhuma, "gráficos de segundo plano" ligado) ou rode `node apresentacao/gerar.mjs --so-pdf`.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { chromium } from "@playwright/test"
import { MODELOS } from "./slides/modelos.mjs"

const AQUI = path.dirname(fileURLToPath(import.meta.url))
export const PASTA_SAIDA = path.join(AQUI, "saida")
const PASTA_HTML = path.join(PASTA_SAIDA, "html")

function expandir(conteudo, { gatewayPronto }) {
  const ctx = { produto: conteudo.produto }
  const secoes = new Map(conteudo.secoes.map((s, i) => [s.id, { ...s, indice: i + 1 }]))
  const lista = []
  const vistas = new Set()
  for (const s of conteudo.slides) {
    const sec = s.secao ? secoes.get(s.secao) : null
    if (s.secao && !sec) throw new Error(`Seção desconhecida: ${s.secao}`)
    if (sec && !vistas.has(sec.id)) {
      vistas.add(sec.id)
      const telas = conteudo.slides.filter((x) => x.secao === sec.id && x.rotulo)
      lista.push({ tipo: "abertura", indice: sec.indice, titulo: sec.titulo, subtitulo: sec.subtitulo, telas: telas.map((t) => ({ rotulo: t.rotulo, resumo: t.resumo })) })
    }
    let spec = { ...s, secaoNome: s.secaoNome ?? sec?.titulo }
    // Slide marcado como pendente de recaptura: só usa a captura real com --gateway-pronto.
    if (s.pendenteRecaptura && !gatewayPronto) {
      spec = { ...spec, midia: { tipo: "janela", pendente: s.pendenteRecaptura } }
    }
    lista.push(spec)
  }
  const total = lista.length
  lista.forEach((s) => {
    if (s.tipo === "abertura") s.total = total
  })
  lista.forEach((s, i) => {
    if (s.tipo === "abertura") s.pg = i + 1
  })
  return { ctx, lista, total }
}

/** Inter (as mesmas faces do app) embutida em base64: o HTML funciona de qualquer pasta e o Chromium não precisa ler fonte via file:// (bloqueado por CORS). */
function cssFontes() {
  const dir = path.join(AQUI, "..", "src", "assets", "fonts")
  const ler = (f) => readFileSync(path.join(dir, f)).toString("base64")
  const latin = "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD"
  const ext = "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF"
  const face = (f, range) => `@font-face{font-family:"Inter";font-style:normal;font-weight:100 900;src:url(data:font/woff2;base64,${ler(f)}) format("woff2");unicode-range:${range}}`
  return face("inter-latin-var.woff2", latin) + face("inter-latin-ext-var.woff2", ext)
}

export function montarHtml(conteudo, opcoes = {}) {
  const { ctx, lista, total } = expandir(conteudo, opcoes)
  const css = "../../slides/estilo.css"
  const corpo = lista
    .map((s, i) => {
      const modelo = MODELOS[s.tipo]
      if (!modelo) throw new Error(`Modelo de slide desconhecido: ${s.tipo}`)
      return modelo(ctx, s, i + 1, total)
    })
    .join("\n")
  const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<title>${conteudo.titulo}</title>
<meta name="description" content="${conteudo.descricao}" />
<style>${cssFontes()}</style>
<link rel="stylesheet" href="${css}" />
</head>
<body>
${corpo}
</body>
</html>
`
  mkdirSync(PASTA_HTML, { recursive: true })
  const arquivo = path.join(PASTA_HTML, `${conteudo.id}.html`)
  writeFileSync(arquivo, html)
  return { arquivo, total, titulos: lista.map((s) => s.titulo ?? s.tipo) }
}

export async function gerarPdf(conteudo, opcoes = {}) {
  const { arquivo, total } = montarHtml(conteudo, opcoes)
  const saida = path.join(PASTA_SAIDA, `${conteudo.arquivo}.pdf`)
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
    await page.goto(pathToFileURL(arquivo).href, { waitUntil: "load" })
    await page.evaluate(async () => {
      await Promise.all(["400", "500", "600", "700", "800", "900"].map((w) => document.fonts.load(`${w} 16px Inter`, "AaÇãé0123 R$")))
      await document.fonts.ready
      await Promise.all(Array.from(document.images).map((img) => img.decode().catch(() => undefined)))
    })
    const quebradas = await page.evaluate(() => Array.from(document.images).filter((i) => !i.naturalWidth).map((i) => i.getAttribute("src")))
    if (quebradas.length) throw new Error(`Imagens que não carregaram: ${quebradas.join(", ")}\nRode primeiro: node apresentacao/gerar.mjs --so-capturas`)
    const fonte = await page.evaluate(() => document.fonts.check("700 16px Inter"))
    if (!fonte) throw new Error("A fonte Inter não carregou: o PDF sairia com a fonte de reserva.")
    await page.pdf({
      path: saida,
      width: "1920px",
      height: "1080px",
      printBackground: true,
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
      preferCSSPageSize: true,
      tagged: true,
      outline: true,
    })
  } finally {
    await browser.close()
  }
  const mb = (statSync(saida).size / 1024 / 1024).toFixed(2)
  console.log(`  ${path.relative(process.cwd(), saida)} — ${total} páginas, ${mb} MB`)
  return { saida, total }
}

export function carregarManifesto() {
  const p = path.join(AQUI, "capturas", "manifesto.json")
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {}
}
