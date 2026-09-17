import { create } from "zustand"

/**
 * Estado do prompt nativo de instalação (`beforeinstallprompt`) — GLOBAL de
 * propósito, não por conveniência: o evento dispara uma única vez por carga
 * de página, a qualquer momento depois que os critérios de instalabilidade
 * são atendidos (pode ser enquanto o motorista ainda está na landing `/c/...`
 * ou na sessão ativa, bem antes de chegar ao recibo). Se o listener vivesse
 * só dentro do componente do recibo, o evento já teria disparado e se
 * perdido antes do componente montar. Captura única na raiz (`App.tsx`),
 * consumida onde for preciso (ver `InstallPromptCard`).
 */

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>
}

interface InstallPromptState {
  deferredEvent: BeforeInstallPromptEvent | null
  installed: boolean
  setDeferredEvent: (event: BeforeInstallPromptEvent | null) => void
  markInstalled: () => void
}

export const useInstallPromptStore = create<InstallPromptState>((set) => ({
  deferredEvent: null,
  installed: false,
  setDeferredEvent: (deferredEvent) => set({ deferredEvent }),
  markInstalled: () => set({ installed: true, deferredEvent: null }),
}))

/** Registra os listeners globais uma única vez — chamado no topo de `App.tsx`. */
export function registerInstallPromptListeners() {
  const onBeforeInstallPrompt = (e: Event) => {
    e.preventDefault()
    useInstallPromptStore.getState().setDeferredEvent(e as BeforeInstallPromptEvent)
  }
  const onAppInstalled = () => {
    useInstallPromptStore.getState().markInstalled()
  }
  window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt)
  window.addEventListener("appinstalled", onAppInstalled)
  return () => {
    window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt)
    window.removeEventListener("appinstalled", onAppInstalled)
  }
}

/** Dispara o prompt nativo (só funciona depois de um gesto do usuário, ex.: clique em botão). */
export async function promptInstall(): Promise<boolean> {
  const { deferredEvent } = useInstallPromptStore.getState()
  if (!deferredEvent) return false
  await deferredEvent.prompt()
  const choice = await deferredEvent.userChoice
  useInstallPromptStore.getState().setDeferredEvent(null)
  return choice.outcome === "accepted"
}
