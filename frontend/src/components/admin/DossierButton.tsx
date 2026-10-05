import { useState } from "react"
import { Download } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/Button"
import { downloadJsonFile } from "@/lib/downloadJson"
import { parseReversalError } from "@/lib/reversals"
import { reversalsService } from "@/services/reversals"

/**
 * "Baixar dossiê" do chargeback (ADMIN). Cada GET do dossiê é AUDITADO no backend, então só vai ao servidor no clique (nunca por query/refetch) e o conteúdo não é guardado em
 * cache: vira arquivo na hora. O dossiê é o snapshot imutável do registro — o ADMIN o anexa à resposta no portal da Cielo.
 */
export function DossierButton({ chargebackId, caseReference, size = "touch-sm", variant = "outline" }: { chargebackId: string; caseReference?: string; size?: "touch-sm" | "touch"; variant?: "outline" | "ghost" }) {
  const [loading, setLoading] = useState(false)

  const handleClick = async () => {
    setLoading(true)
    try {
      const dossier = await reversalsService.dossier(chargebackId)
      downloadJsonFile(`dossie-chargeback-${chargebackId}.json`, dossier)
      toast.success("Dossiê baixado.", { description: "O download fica registrado na auditoria." })
    } catch (err) {
      toast.error("Não foi possível baixar o dossiê.", { description: parseReversalError(err, "chargeback").message })
    } finally {
      setLoading(false)
    }
  }

  return (
    <Button type="button" variant={variant} size={size} loading={loading} onClick={() => void handleClick()} aria-label={caseReference ? `Baixar dossiê do caso ${caseReference}` : undefined}>
      {!loading && <Download className="h-3.5 w-3.5" aria-hidden="true" />}
      Baixar dossiê
    </Button>
  )
}
