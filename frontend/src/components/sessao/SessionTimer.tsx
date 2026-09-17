import { useEffect, useState } from "react"

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  const pad = (n: number) => String(n).padStart(2, "0")
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

/**
 * Cronômetro calculado no CLIENTE a partir de `startedAt` — não depende do
 * polling do servidor (a cada 5s) pra avançar, senão o relógio "trava"
 * visivelmente entre um poll e outro. `setInterval` de 1s só atualiza este
 * componente pequeno, não a árvore inteira da tela de sessão.
 */
export function SessionTimer({ startedAt }: { startedAt: string }) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const elapsedMs = now - new Date(startedAt).getTime()
  return <>{formatElapsed(elapsedMs)}</>
}
