#!/usr/bin/env node
/**
 * Trace de carregamento (e, opcionalmente, de rolagem) com CPU limitada, via Playwright + CDP, para achar ONDE o
 * tempo vai quando o Lighthouse diz "TBT/LCP alto". Complementa `medir-lighthouse.mjs`: o Lighthouse dá o placar, este
 * dá o porquê (tempo de "self" por tipo de evento da thread principal, tarefas longas, marcos de pintura).
 *
 * Uso (a partir de frontend/, com `vite preview` rodando — ex.: `npx vite preview --port 4173`):
 *   node scripts/trace-cpu.mjs                       # "/" a 4x de CPU, 5 s de observação
 *   node scripts/trace-cpu.mjs --path login --cpu 4
 *   node scripts/trace-cpu.mjs --css "* { font-family: Arial !important }"   # experimento: injeta CSS e mede
 *   node scripts/trace-cpu.mjs --scroll              # depois do load, rola a pagina inteira em passos e mede quadros
 *   node scripts/trace-cpu.mjs --save /tmp/trace.json   # guarda o trace p/ abrir no DevTools > Performance
 *   node scripts/trace-cpu.mjs --width 1440 --height 900 --desktop   # sem emulacao de celular
 *
 * Sem rede limitada de proposito (o servidor e local): isto isola o custo de CPU. Para rede+CPU use o Lighthouse.
 */
import { chromium } from "@playwright/test"
import { writeFileSync } from "node:fs"

const args = process.argv.slice(2)
const flag = (n) => args.includes(`--${n}`)
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d
}
const port = opt("port", "4173")
const raw = opt("path", "/").replace(/^[A-Za-z]:[\\/]Program Files[\\/]Git/, "")
const url = `http://localhost:${port}${raw.startsWith("/") ? raw : `/${raw}`}`
const cpu = Number(opt("cpu", "4"))
const observeMs = Number(opt("ms", "5000"))
const desktop = flag("desktop")
const width = Number(opt("width", desktop ? "1440" : "412"))
const height = Number(opt("height", desktop ? "900" : "823"))

const browser = await chromium.launch()
const ctx = await browser.newContext({
  viewport: { width, height },
  deviceScaleFactor: desktop ? 1 : 1.75,
  isMobile: !desktop,
  hasTouch: !desktop,
  serviceWorkers: "block",
})
const page = await ctx.newPage()
await page.addInitScript(() => {
  const w = window
  w.__m = { lcp: [], paint: [], long: [], cls: 0, events: [], shifts: [] }
  const obs = (type, cb, extra = {}) => {
    try {
      new PerformanceObserver((l) => l.getEntries().forEach(cb)).observe({ type, buffered: true, ...extra })
    } catch {
      /* tipo nao suportado */
    }
  }
  obs("largest-contentful-paint", (e) => w.__m.lcp.push({ t: Math.round(e.startTime), el: e.element ? e.element.tagName + "." + String(e.element.className).slice(0, 40) : "?" }))
  obs("paint", (e) => w.__m.paint.push({ n: e.name, t: Math.round(e.startTime) }))
  obs("longtask", (e) => w.__m.long.push({ t: Math.round(e.startTime), d: Math.round(e.duration) }))
  obs("layout-shift", (e) => {
    if (e.hadRecentInput) return
    w.__m.cls += e.value
    w.__m.shifts.push({
      t: Math.round(e.startTime),
      v: Number(e.value.toFixed(3)),
      src: e.sources.slice(0, 2).map((s) => `${s.node ? s.node.tagName + "." + String(s.node.className).slice(0, 28) : "?"} y${Math.round(s.previousRect.y)}->${Math.round(s.currentRect.y)} h${Math.round(s.previousRect.height)}->${Math.round(s.currentRect.height)}`),
    })
  })
  obs("event", (e) => w.__m.events.push({ n: e.name, d: Math.round(e.duration), delay: Math.round(e.processingStart - e.startTime) }), { durationThreshold: 16 })
})

// --css "<regras>": injeta CSS antes de tudo, para EXPERIMENTAR (ex.: "* { font-family: Arial !important }" mostra quanto
// do layout é a fonte). Nada é gravado no projeto.
const extraCss = opt("css", "")
if (extraCss) {
  await page.addInitScript((css) => {
    const add = () => {
      const st = document.createElement("style")
      st.textContent = css
      document.head.appendChild(st)
    }
    if (document.head) add()
    else document.addEventListener("DOMContentLoaded", add, { once: true })
  }, extraCss)
}
const cdp = await ctx.newCDPSession(page)
await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu })
const events = []
cdp.on("Tracing.dataCollected", (d) => events.push(...d.value))
const done = new Promise((r) => cdp.once("Tracing.tracingComplete", r))
await cdp.send("Tracing.start", {
  transferMode: "ReportEvents",
  traceConfig: {
    includedCategories: [
      "devtools.timeline",
      "v8.execute",
      "disabled-by-default-devtools.timeline",
      "blink.user_timing",
      "loading",
      "latencyInfo",
      // --invalidations: por que o estilo foi refeito (reason + nó), para achar o que invalida a cada quadro
      ...(flag("invalidations") ? ["disabled-by-default-devtools.timeline.invalidationTracking"] : []),
    ],
  },
})

await page.goto(url, { waitUntil: "load" })
await page.waitForTimeout(observeMs)

if (flag("scroll")) {
  // Rolagem real em passos (como um dedo/roda): mede a duracao de cada quadro via rAF e tarefas longas durante ela.
  await page.evaluate(() => {
    window.__frames = []
    let last = performance.now()
    const tick = (now) => {
      window.__frames.push(now - last)
      last = now
      window.__raf = requestAnimationFrame(tick)
    }
    window.__raf = requestAnimationFrame(tick)
    window.__scrollStart = performance.now()
  })
  const total = await page.evaluate(() => document.documentElement.scrollHeight)
  const step = Math.round(height * 0.6)
  for (let y = 0; y < total; y += step) {
    await page.mouse.wheel(0, step)
    await page.waitForTimeout(250)
  }
  await page.waitForTimeout(800)
}

const m = await page.evaluate(() => ({ ...window.__m, frames: window.__frames, nodes: document.getElementsByTagName("*").length, heap: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null }))
await cdp.send("Tracing.end")
await done
await browser.close()

if (opt("save", "")) writeFileSync(opt("save", ""), JSON.stringify({ traceEvents: events }))

// ---- analise da thread principal (tempo "self" por tipo de evento) ----
const rendererMain = events.find((e) => e.name === "thread_name" && e.args?.name === "CrRendererMain")
const pid = rendererMain?.pid
const tid = rendererMain?.tid
const evAll = events.filter((e) => e.pid === pid && e.tid === tid && e.ph === "X" && e.dur !== undefined).sort((a, b) => a.ts - b.ts || b.dur - a.dur)
const t0 = events.find((e) => e.name === "navigationStart" && e.pid === pid)?.ts ?? evAll[0]?.ts ?? 0
// --window A-B (ms desde a navegacao): so conta eventos nesse intervalo (ex.: 0-LCP = fase de carga; LCP-5000 = ocioso).
const [wa, wb] = opt("window", "0-1000000").split("-").map(Number)
const ev = evAll.filter((e) => (e.ts - t0) / 1000 >= wa && (e.ts - t0) / 1000 <= wb)
const self = new Map()
const stack = []
for (const e of ev) {
  while (stack.length && e.ts >= stack[stack.length - 1].end) stack.pop()
  if (stack.length) stack[stack.length - 1].child += e.dur
  const node = { name: e.name, end: e.ts + e.dur, child: 0, dur: e.dur, ts: e.ts, url: e.args?.data?.url }
  stack.push(node)
  e.__node = node
}
for (const e of ev) {
  const n = e.__node
  const s = n.dur - n.child
  self.set(n.name, (self.get(n.name) ?? 0) + s)
}
const top = [...self.entries()].filter(([k]) => !["RunTask", "ThreadControllerImpl::RunTask", "ThreadControllerImpl::DoWork", "MessageLoop::RunTask"].includes(k)).sort((a, b) => b[1] - a[1]).slice(0, 14)
const tasks = ev.filter((e) => e.name === "RunTask" && e.dur > 50000).map((e) => ({ at: Math.round((e.ts - t0) / 1000), ms: Math.round(e.dur / 1000) }))
const block = ev.filter((e) => e.name === "RunTask").reduce((s, e) => s + Math.max(0, e.dur / 1000 - 50), 0)
if (flag("invalidations")) {
  const inv = events.filter((e) => e.name === "StyleRecalcInvalidationTracking" && (e.ts - t0) / 1000 >= wa && (e.ts - t0) / 1000 <= wb)
  const tally = new Map()
  for (const e of inv) {
    const d = e.args?.data ?? {}
    const k = `${d.reason ?? "?"} | ${String(d.nodeName ?? "?").slice(0, 60)} | ${d.extraData ?? ""} ${d.changedAttribute ?? d.changedClass ?? ""}`
    tally.set(k, (tally.get(k) ?? 0) + 1)
  }
  console.log(`
invalidacoes de estilo na janela: ${inv.length}`)
  for (const [k, v] of [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${String(v).padStart(5)}  ${k}`)
}
const busy = ev.filter((e) => e.name === "RunTask").reduce((t, e) => t + e.dur / 1000, 0)

console.log(`\n${url}  CPU ${cpu}x  ${width}x${height}${desktop ? " (desktop)" : " (movel)"}`)
console.log("paint:", JSON.stringify(m.paint), " LCP:", JSON.stringify(m.lcp.at(-1)), " CLS:", m.cls.toFixed(4), " nos DOM:", m.nodes, " heap MB:", m.heap)
if (m.shifts.length) console.log("deslocamentos de layout (maiores):", JSON.stringify(m.shifts.sort((a, b) => b.v - a.v).slice(0, 6)))
console.log(`thread principal ocupada na janela: ${Math.round(busy)} ms`)
console.log(`tarefas > 50 ms (${tasks.length}), bloqueio total (soma do que passa de 50 ms): ${Math.round(block)} ms`)
console.log("  ", tasks.slice(0, 14).map((t) => `${t.at}ms+${t.ms}`).join("  "))
console.log("tempo 'self' da thread principal por tipo (ms):")
for (const [k, v] of top) console.log(`  ${k.padEnd(34)} ${String(Math.round(v / 1000)).padStart(6)}`)
if (m.frames) {
  const f = m.frames.filter((x) => x > 0).sort((a, b) => a - b)
  const p = (q) => Math.round(f[Math.min(f.length - 1, Math.floor(f.length * q))])
  console.log(`rolagem: ${f.length} quadros; duracao p50 ${p(0.5)} ms, p95 ${p(0.95)} ms, max ${Math.round(f.at(-1))} ms; > 50 ms: ${f.filter((x) => x > 50).length}`)
  console.log("eventos lentos (INP-like):", JSON.stringify(m.events.sort((a, b) => b.d - a.d).slice(0, 5)))
  console.log("tarefas longas (PerformanceObserver):", m.long.length, "maior:", Math.max(0, ...m.long.map((l) => l.d)), "ms")
}
