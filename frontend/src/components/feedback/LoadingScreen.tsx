import { useEffect, useState, type ReactNode } from "react"

/**
 * Carregamento de TELA (rota/chunk), não de dado: dado usa `Skeleton` no lugar onde ele vai aparecer.
 *
 * Superfície escura de marca (`.surface-dark-rich`) com um anel girando em lima. A `art` (o rosto do mascote — passado pelo chamador, porque este
 * módulo entra no bundle inicial e NÃO pode importar `components/brand`) só aparece depois de `artDelayMs`: uma troca de rota rápida (< 0,7 s, a
 * maioria) mostra só o anel e não pisca o robô; uma espera longa ganha presença de marca. Sob `prefers-reduced-motion` o anel para (regra global do
 * `index.css`) e a arte aparece do mesmo jeito, sem transição.
 *
 * SEM `cn`/`@/lib/utils` de propósito: este módulo entra no bundle INICIAL (`App.tsx`) e puxar `lib/utils` arrastaria o chunk `ui-kit` para o `modulepreload` do index (medido: 6 -> 7).
 *
 * `variant="screen"`: tela inteira (Suspense da rota). `variant="inline"`: bloco dentro do shell (o cabeçalho e a navegação continuam visíveis).
 */
export function LoadingScreen({
  art,
  artDelayMs = 700,
  variant = "screen",
  className,
}: {
  art?: ReactNode
  artDelayMs?: number
  variant?: "screen" | "inline"
  className?: string
}) {
  const [showArt, setShowArt] = useState(false)
  useEffect(() => {
    if (!art) return
    const id = setTimeout(() => setShowArt(true), artDelayMs)
    return () => clearTimeout(id)
  }, [art, artDelayMs])

  return (
    <div
      role="status"
      className={`surface-dark surface-dark-rich flex flex-col items-center justify-center gap-4 ${variant === "screen" ? "min-h-screen" : "mx-4 min-h-[56svh] rounded-feature"} ${className ?? ""}`}
    >
      <span className="sr-only">Carregando…</span>
      {art && showArt && (
        <span className="flex h-16 w-16 items-center justify-center rounded-full bg-white/10 ring-1 ring-white/15" aria-hidden="true">
          {art}
        </span>
      )}
      <span className="h-8 w-8 animate-spin rounded-full border-[3px] border-white/15 border-t-lime" aria-hidden="true" />
    </div>
  )
}
