import { useEffect, useRef } from "react"

/**
 * Screen Wake Lock API — mantém a tela acesa enquanto `active` for `true`
 * (usado na sessão de recarga: o motorista guarda o celular no bolso com a
 * tela aberta). Degrada graciosamente onde não há suporte (Safari < 16.4,
 * navegadores antigos): `"wakeLock" in navigator` falha silenciosamente,
 * sem quebrar o resto da tela — não é um requisito bloqueante, é conforto.
 *
 * O sistema operacional libera o wake lock sozinho quando a aba fica oculta
 * (troca de app, tela bloqueada) — por isso reoculta/readquire no
 * `visibilitychange`, senão o celular volta a apagar a tela ao reabrir o
 * app no meio da recarga.
 */
export function useWakeLock(active: boolean) {
  const sentinelRef = useRef<WakeLockSentinel | null>(null)

  useEffect(() => {
    if (!active || typeof navigator === "undefined" || !("wakeLock" in navigator)) return

    let cancelled = false

    async function requestLock() {
      try {
        const sentinel = await navigator.wakeLock.request("screen")
        if (cancelled) {
          sentinel.release().catch(() => {})
          return
        }
        sentinelRef.current = sentinel
      } catch {
        // Permissão negada, documento não visível, ou API indisponível —
        // conforto, não requisito duro. Sem retry agressivo.
      }
    }

    requestLock()

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") requestLock()
    }
    document.addEventListener("visibilitychange", onVisibilityChange)

    return () => {
      cancelled = true
      document.removeEventListener("visibilitychange", onVisibilityChange)
      sentinelRef.current?.release().catch(() => {})
      sentinelRef.current = null
    }
  }, [active])
}
