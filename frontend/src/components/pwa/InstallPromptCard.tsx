import { useState } from "react"
import { Download, Share, X } from "lucide-react"
import { Button } from "@/components/ui/Button"
import { IconBadge } from "@/components/ui/IconBadge"
import { useInstallPromptStore, promptInstall } from "@/store/installPromptStore"
import { isIos, isInStandaloneMode } from "@/lib/platform"

const IOS_COACH_DISMISSED_KEY = "innoflow_ios_install_coach_dismissed"

/**
 * Oferece a instalação do PWA — só deve ser montado onde o produto já
 * entregou valor (recibo de uma recarga concluída), nunca na primeira tela.
 * Ver PROGRESSO.md §PWA: pedir instalação antes de qualquer valor é o jeito
 * clássico de ganhar um "não" definitivo.
 *
 * Dois caminhos, mutuamente exclusivos:
 * - Android/Chrome-like: `beforeinstallprompt` capturado globalmente
 *   (`installPromptStore`) — botão dispara o prompt nativo do SO.
 * - iOS: não existe evento equivalente — coach manual, dispensável,
 *   lembrado por navegador via `localStorage` (mesmo padrão de conveniência
 *   já usado no projeto, nunca dado que precise sobreviver entre
 *   dispositivos).
 */
export function InstallPromptCard() {
  const { deferredEvent, installed } = useInstallPromptStore()
  const [installing, setInstalling] = useState(false)
  const [iosDismissed, setIosDismissed] = useState(
    () => typeof localStorage !== "undefined" && localStorage.getItem(IOS_COACH_DISMISSED_KEY) === "true",
  )

  if (installed || isInStandaloneMode()) return null

  const showAndroidPrompt = !!deferredEvent
  const showIosCoach = !showAndroidPrompt && isIos() && !iosDismissed

  if (!showAndroidPrompt && !showIosCoach) return null

  const dismissIosCoach = () => {
    localStorage.setItem(IOS_COACH_DISMISSED_KEY, "true")
    setIosDismissed(true)
  }

  const handleInstall = async () => {
    setInstalling(true)
    try {
      await promptInstall()
    } finally {
      setInstalling(false)
    }
  }

  return (
    <div className="card-elevated animate-fade-in-up p-4">
      <div className="flex items-start gap-3">
        <IconBadge icon={showAndroidPrompt ? Download : Share} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-ink">Instale o InnoFlow no seu celular</p>
          {showAndroidPrompt ? (
            <>
              <p className="mt-0.5 text-xs text-ink-softer">Acesso rápido na próxima recarga, direto da tela inicial.</p>
              <Button type="button" variant="lime" size="sm" className="mt-3" loading={installing} onClick={handleInstall}>
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                Instalar app
              </Button>
            </>
          ) : (
            <p className="mt-0.5 text-xs text-ink-softer">
              Toque em <Share className="mx-0.5 inline h-3 w-3 -translate-y-px" aria-hidden="true" /> Compartilhar e depois em
              "Adicionar à Tela de Início".
            </p>
          )}
        </div>
        {showIosCoach && (
          <button
            type="button"
            onClick={dismissIosCoach}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--field-radius)] text-ink-softer hover:bg-muted hover:text-ink"
            aria-label="Dispensar sugestão de instalação"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  )
}
