/**
 * Verificação MEDIDA no navegador (não deduzida do CSS) dos slides gerados: nada sai da grade (margens 96 px, rodapé 64 px),
 * nenhum texto estoura a própria caixa e nenhuma imagem ficou quebrada. Uso: node apresentacao/verificar.mjs
 */
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { chromium } from "@playwright/test"

const AQUI = path.dirname(fileURLToPath(import.meta.url))
const browser = await chromium.launch()
let problemas = 0
try {
  for (const id of ["admin", "motorista"]) {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
    await page.goto(pathToFileURL(path.join(AQUI, "saida", "html", `${id}.html`)).href, { waitUntil: "load" })
    await page.evaluate(() => document.fonts.ready)
    const achados = await page.evaluate(() => {
      const out = []
      document.querySelectorAll(".slide").forEach((sl, i) => {
        const base = sl.getBoundingClientRect()
        const n = i + 1
        const claro = !sl.classList.contains("escuro")
        const corpo = sl.querySelector(".corpo")
        if (corpo) {
          corpo.querySelectorAll("*").forEach((el) => {
            const r = el.getBoundingClientRect()
            if (!r.width || !r.height) return
            const b = r.bottom - base.top
            const x2 = r.right - base.left
            const x1 = r.left - base.left
            // .palco usa margem negativa de propósito (sangra o painel até o limite do corpo); só cobra os demais
            if (b > 1016.5) out.push(`slide ${n}: <${el.tagName.toLowerCase()} class="${el.className}"> passa do rodapé (bottom ${b.toFixed(1)})`)
            if (x2 > 1824.5 || x1 < 95.5) out.push(`slide ${n}: <${el.tagName.toLowerCase()} class="${el.className}"> fora das margens (x ${x1.toFixed(1)}–${x2.toFixed(1)})`)
          })
        }
        sl.querySelectorAll("h1,h2,h3,p,li,span,b,small,div").forEach((el) => {
          if (el.children.length === 0 && el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== "visible") out.push(`slide ${n}: texto estoura ${el.textContent.slice(0, 40)}`)
        })
        if (claro && !sl.querySelector(".topo")) out.push(`slide ${n}: sem faixa de topo`)
        sl.querySelectorAll("img").forEach((img) => {
          if (!img.naturalWidth) out.push(`slide ${n}: imagem quebrada ${img.getAttribute("src")}`)
        })
      })
      return out
    })
    const total = await page.locator(".slide").count()
    console.log(`${id}: ${total} slides, ${achados.length} achados`)
    achados.forEach((a) => console.log("  -", a))
    problemas += achados.length
    await page.close()
  }
} finally {
  await browser.close()
}
process.exit(problemas ? 1 : 0)
