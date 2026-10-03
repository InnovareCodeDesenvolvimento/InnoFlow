import { useEffect, useRef } from "react"
import { buildNetwork, forwardOptions, mulberry32, type Network, type NodeKind } from "./flow-network"

/**
 * Fundo do hero: rede de linhas finas ligando eletropostos (raio) a pontos; partículas de energia lima viajam
 * pelas linhas para a direita (rumo ao mascote). Reage ao mouse (parallax leve + atração dos nós próximos).
 * Puramente decorativo: `aria-hidden`, sem foco, sem eventos próprios.
 *
 * Orçamento: canvas 2D, ~30 nós no desktop e ~12 no celular; no máx. ~30 quadros/s; devicePixelRatio ≤ 2; pausa
 * fora da tela (IntersectionObserver) e com a aba oculta; só começa quando o navegador está ocioso, depois do
 * primeiro paint (não compete com o LCP). No celular (ponteiro "coarse" ou tela estreita) não reage ao toque. Com
 * `prefers-reduced-motion` desenha UM quadro estático.
 */
type Particle = { edge: number; from: number; to: number; t: number; speed: number }

const LINE = "89, 164, 207" // primary-400
const LIME = "97, 219, 36" // accent-glow
const FRAME_MS = 1000 / 30
const FRAME_MS_SMALL = 1000 / 20

function drawBolt(ctx: CanvasRenderingContext2D, x: number, y: number, alpha: number) {
  ctx.save()
  ctx.translate(x, y)
  ctx.beginPath()
  ctx.moveTo(1.8, -7)
  ctx.lineTo(-4.2, 1.2)
  ctx.lineTo(-0.4, 1.2)
  ctx.lineTo(-1.8, 7)
  ctx.lineTo(4.4, -1.4)
  ctx.lineTo(0.6, -1.4)
  ctx.closePath()
  ctx.fillStyle = `rgba(${LIME}, ${alpha})`
  ctx.fill()
  ctx.restore()
}

export function FlowCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const host = canvas?.parentElement
    const ctx = canvas?.getContext("2d")
    if (!canvas || !host || !ctx) return

    const reduceQuery = window.matchMedia("(prefers-reduced-motion: reduce)")
    let width = 0
    let height = 0
    let dpr = 1
    let small = false
    let net: Network = buildNetwork(10, 10, true)
    let particles: Particle[] = []
    const pointer = { x: 0, y: 0, active: false }
    const parallax = { x: 0, y: 0, tx: 0, ty: 0 }
    let raf = 0
    let last = 0
    let onScreen = true
    let started = false
    let animating = false
    let disposed = false
    const rand = mulberry32(11)

    const nextHop = (from: number, prev: number): Particle | null => {
      const options = forwardOptions(net, from, prev)
      if (options.length === 0) return null
      const o = options[Math.floor(rand() * options.length)]
      return { edge: o.edge, from, to: o.to, t: 0, speed: 0.00022 + rand() * 0.00018 }
    }
    const spawn = (): Particle | null => {
      const bolts = net.nodes.map((n, i) => (n.kind === "bolt" ? i : -1)).filter((i) => i >= 0)
      const start = bolts.length ? bolts[Math.floor(rand() * bolts.length)] : Math.floor(rand() * net.nodes.length)
      return nextHop(start, -1)
    }

    const draw = (dt: number) => {
      ctx.clearRect(0, 0, width, height)
      const { nodes, edges } = net
      const useMouse = pointer.active && !small

      parallax.x += (parallax.tx - parallax.x) * 0.06
      parallax.y += (parallax.ty - parallax.y) * 0.06
      for (const n of nodes) {
        let tx = n.bx + parallax.x * 14 * n.depth
        let ty = n.by + parallax.y * 14 * n.depth
        if (useMouse) {
          const dx = pointer.x - n.bx
          const dy = pointer.y - n.by
          const d = Math.hypot(dx, dy)
          if (d < 180 && d > 0.001) {
            const pull = (1 - d / 180) * 22
            tx += (dx / d) * pull
            ty += (dy / d) * pull
          }
        }
        n.x += (tx - n.x) * 0.12
        n.y += (ty - n.y) * 0.12
        n.pulse = Math.max(0, n.pulse - dt * 0.0012)
      }

      ctx.lineWidth = 1
      for (const e of edges) {
        const a = nodes[e.a]
        const b = nodes[e.b]
        let alpha = 0.15
        if (useMouse) {
          const mx = (a.x + b.x) / 2 - pointer.x
          const my = (a.y + b.y) / 2 - pointer.y
          alpha += Math.max(0, 1 - Math.hypot(mx, my) / 220) * 0.24
        }
        ctx.strokeStyle = `rgba(${LINE}, ${alpha})`
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.stroke()
      }

      for (const n of nodes) {
        const kind: NodeKind = n.kind
        if (kind === "dot") {
          ctx.fillStyle = `rgba(${LINE}, ${0.32 + n.pulse * 0.45})`
          ctx.beginPath()
          ctx.arc(n.x, n.y, 1.8, 0, Math.PI * 2)
          ctx.fill()
        } else {
          // Disco escuro para as linhas não atravessarem o raio.
          ctx.fillStyle = "rgba(6, 22, 33, 0.92)"
          ctx.beginPath()
          ctx.arc(n.x, n.y, 13, 0, Math.PI * 2)
          ctx.fill()
          ctx.strokeStyle = `rgba(${LIME}, ${0.3 + n.pulse * 0.55})`
          ctx.lineWidth = 1
          ctx.stroke()
          drawBolt(ctx, n.x, n.y, 0.7 + n.pulse * 0.3)
        }
      }

      if (dt > 0) {
        particles = particles.map((p) => {
          const t = p.t + dt * p.speed
          if (t < 1) return { ...p, t }
          nodes[p.to].pulse = 1
          return nextHop(p.to, p.from) ?? spawn() ?? { ...p, t: 0 }
        })
      }
      for (const p of particles) {
        const a = nodes[p.from]
        const b = nodes[p.to]
        const x = a.x + (b.x - a.x) * p.t
        const y = a.y + (b.y - a.y) * p.t
        const glow = ctx.createRadialGradient(x, y, 0, x, y, 10)
        glow.addColorStop(0, "rgba(230, 255, 210, 0.98)")
        glow.addColorStop(0.35, `rgba(${LIME}, 0.5)`)
        glow.addColorStop(1, `rgba(${LIME}, 0)`)
        ctx.fillStyle = glow
        ctx.beginPath()
        ctx.arc(x, y, 10, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    const resize = () => {
      const rect = host.getBoundingClientRect()
      width = Math.max(1, Math.round(rect.width))
      height = Math.max(1, Math.round(rect.height))
      small = width < 768 || window.matchMedia("(pointer: coarse)").matches
      // Celular: DPR 1 (a rede é feita de linhas finas e pontos; ninguém nota) — o canvas cobre o hero inteiro e cada
      // quadro vira textura enviada ao compositor, então menos pixels = menos custo de "Commit" por quadro.
      dpr = small ? 1 : Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      net = buildNetwork(width, height, small)
      particles = []
      const count = small ? 3 : 7
      for (let i = 0; i < count; i++) {
        const p = spawn()
        if (p) {
          p.t = rand()
          particles.push(p)
        }
      }
      draw(0)
    }

    const frame = (now: number) => {
      raf = 0
      if (disposed || !onScreen || document.hidden || reduceQuery.matches) return
      raf = window.requestAnimationFrame(frame)
      const dt = now - last
      if (dt < (small ? FRAME_MS_SMALL : FRAME_MS)) return
      last = now
      draw(Math.min(dt, 64))
    }
    const kick = () => {
      if (!raf && started && animating && onScreen && !document.hidden && !reduceQuery.matches) {
        last = performance.now()
        raf = window.requestAnimationFrame(frame)
      }
    }
    const stop = () => {
      if (raf) window.cancelAnimationFrame(raf)
      raf = 0
    }

    const onMove = (event: PointerEvent) => {
      if (small || event.pointerType === "touch") return
      const rect = host.getBoundingClientRect()
      pointer.x = event.clientX - rect.left
      pointer.y = event.clientY - rect.top
      pointer.active = true
      parallax.tx = (pointer.x / rect.width - 0.5) * 2
      parallax.ty = (pointer.y / rect.height - 0.5) * 2
    }
    const onLeave = () => {
      pointer.active = false
      parallax.tx = 0
      parallax.ty = 0
    }
    const onVisibility = () => (document.hidden ? stop() : kick())
    const onReduceChange = () => {
      stop()
      draw(0)
      kick()
    }

    const observer = new IntersectionObserver(
      (entries) => {
        onScreen = entries.some((e) => e.isIntersecting)
        if (onScreen) kick()
        else stop()
      },
      { threshold: 0 },
    )
    const resizeObserver = new ResizeObserver(() => {
      if (started) resize()
    })

    // 1) O PRIMEIRO QUADRO (rede estática) entra junto com o hero: ele é conteúdo visível e, se chegasse depois, o
    //    Speed Index contaria como progresso visual tardio. O desenho vem do ResizeObserver (dispara depois do layout,
    //    no ciclo de renderização) — chamar `resize()` aqui leria `getBoundingClientRect` e forçaria o layout do
    //    documento inteiro numa tarefa só (medido: ~250 ms vistos como bloqueio pelo Lighthouse).
    started = true
    observer.observe(host)
    resizeObserver.observe(host)
    host.addEventListener("pointermove", onMove, { passive: true })
    host.addEventListener("pointerleave", onLeave)
    document.addEventListener("visibilitychange", onVisibility)
    reduceQuery.addEventListener("change", onReduceChange)

    // 2) A ANIMAÇÃO (partículas, parallax) só liga com a página carregada, o navegador ocioso e +1,2 s: é enfeite, o
    //    texto do hero, o LCP e a primeira interação vêm antes.
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number
      cancelIdleCallback?: (id: number) => void
    }
    const hasIdle = typeof w.requestIdleCallback === "function"
    let loadTimer = 0
    let startTimer = 0
    const startAnimation = () => {
      if (disposed) return
      animating = true
      kick()
    }
    const whenLoaded = () => {
      loadTimer = window.setTimeout(() => {
        if (hasIdle) startTimer = w.requestIdleCallback!(startAnimation, { timeout: 2500 })
        else startAnimation()
      }, 1200)
    }
    if (document.readyState === "complete") whenLoaded()
    else window.addEventListener("load", whenLoaded, { once: true })

    return () => {
      disposed = true
      stop()
      window.removeEventListener("load", whenLoaded)
      window.clearTimeout(loadTimer)
      if (hasIdle) w.cancelIdleCallback?.(startTimer)
      observer.disconnect()
      resizeObserver.disconnect()
      host.removeEventListener("pointermove", onMove)
      host.removeEventListener("pointerleave", onLeave)
      document.removeEventListener("visibilitychange", onVisibility)
      reduceQuery.removeEventListener("change", onReduceChange)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      data-testid="hero-flow"
      className="pointer-events-none absolute inset-0 -z-10 h-full w-full"
    />
  )
}
