import { Toaster as SonnerToaster } from "sonner"

/** Instância única do sonner — montada uma vez perto da raiz (ver App.tsx). */
export function Toaster() {
  return (
    <SonnerToaster
      position="top-right"
      richColors
      closeButton
      toastOptions={{
        classNames: {
          toast: "rounded-xl border border-border-subtle shadow-lg",
        },
      }}
    />
  )
}
