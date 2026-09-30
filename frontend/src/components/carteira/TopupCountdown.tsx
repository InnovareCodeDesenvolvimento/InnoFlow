import { useEffect, useState } from "react"

function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
}

/**
 * Contador regressivo calculado no CLIENTE a partir de `expiresAt` — mesmo
 * espírito de `SessionTimer` (não depende do polling do servidor pra avançar
 * visualmente). Quando chega a 00:00 não muda o status sozinho: quem manda é
 * o próximo poll de `useMeTopup` (o servidor pode expirar num instante
 * ligeiramente diferente do relógio do cliente).
 */
export function TopupCountdown({ expiresAt }: { expiresAt: string }) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const remainingMs = new Date(expiresAt).getTime() - now
  return <>{formatRemaining(remainingMs)}</>
}
