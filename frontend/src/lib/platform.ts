/**
 * Detecção de plataforma para o coach de instalação do PWA — iOS não dispara
 * `beforeinstallprompt` (Apple não implementa o evento), então precisa de um
 * caminho manual ("Compartilhar → Adicionar à Tela de Início").
 */

/** iPhone/iPad/iPod — inclui iPadOS 13+, que se anuncia como "MacIntel" mas tem `maxTouchPoints > 0`. */
export function isIos(): boolean {
  if (typeof navigator === "undefined") return false
  const ua = navigator.userAgent
  const isAppleTouch = /iPhone|iPad|iPod/.test(ua)
  const isIpadOs13Plus = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1
  return isAppleTouch || isIpadOs13Plus
}

/** `true` quando o PWA já está instalado e rodando standalone (não faz sentido oferecer instalação de novo). */
export function isInStandaloneMode(): boolean {
  if (typeof window === "undefined") return false
  const iosStandalone = (window.navigator as Navigator & { standalone?: boolean }).standalone
  return window.matchMedia("(display-mode: standalone)").matches || iosStandalone === true
}
