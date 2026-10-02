import { useState } from "react"
import { Check, Copy } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/Button"

/**
 * Copia um texto para a área de transferência. O toast é GENÉRICO ("Copiado.")
 * de propósito: este botão também copia o segredo recém-gerado do webhook, e
 * valor de segredo nunca vai para toast/console.
 */
export function CopyButton({ value, label, disabled }: { value: string; label: string; disabled?: boolean }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      toast.success("Copiado.")
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error("Não foi possível copiar. Selecione o texto e copie manualmente.")
    }
  }

  return (
    <Button type="button" variant="outline" onClick={() => void handleCopy()} disabled={disabled} aria-label={label} className="shrink-0">
      {copied ? <Check className="h-4 w-4 text-success-700" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
      <span>{copied ? "Copiado" : "Copiar"}</span>
    </Button>
  )
}
