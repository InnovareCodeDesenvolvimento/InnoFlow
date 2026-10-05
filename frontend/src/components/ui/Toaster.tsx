import { Toaster as SonnerToaster } from "sonner"

/**
 * Instância única do sonner — montada uma vez perto da raiz (ver App.tsx). O tema do PWA (raio de controle, sombra tingida) vem de
 * `[data-sonner-toast]` em `index.css` (vale para o app inteiro desde a F-D).
 * Cores de estado seguem as do sonner (`richColors`): sucesso verde, erro vermelho — lima é AÇÃO, nunca estado.
 */
export function Toaster() {
  return (
    <SonnerToaster
      position="top-right"
      richColors
      closeButton
      toastOptions={{
        classNames: {
          toast: "rounded-xl border border-border-subtle shadow-lg font-sans",
        },
      }}
    />
  )
}
