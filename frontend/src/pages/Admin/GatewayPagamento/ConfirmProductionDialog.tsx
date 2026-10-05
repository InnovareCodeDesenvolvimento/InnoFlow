import { useState } from "react"
import { Rocket, TriangleAlert, X } from "lucide-react"
import { Button } from "@/components/ui/Button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/Dialog"
import { Input } from "@/components/ui/Input"
import { isProductionConfirmation, PRODUCTION_CONFIRM_WORD } from "@/lib/paymentGateway"

/**
 * Passo de segurança antes de virar PRODUÇÃO (cobrança real): o botão só
 * habilita depois de o admin DIGITAR a palavra (tolerante a caixa e acento).
 * Montado só enquanto aberto, então o texto digitado nunca sobra de uma
 * abertura para outra. Isto só SELECIONA produção no rascunho — nada é
 * enviado até o admin salvar (e confirmar de novo o resumo).
 */
export function ConfirmProductionDialog({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  const [typed, setTyped] = useState("")
  const matches = isProductionConfirmation(typed)

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent widthClassName="sm:max-w-md">
        <DialogHeader>
          <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-card bg-danger-100 text-danger-600" aria-hidden="true">
            <TriangleAlert className="h-5 w-5" />
          </div>
          <DialogTitle>Passar para produção?</DialogTitle>
          <DialogDescription>Em produção a plataforma cobra de verdade: cartões e Pix reais dos motoristas, com dinheiro de verdade.</DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault()
            if (matches) onConfirm()
          }}
        >
          <Input
            label={`Para confirmar, digite ${PRODUCTION_CONFIRM_WORD}`}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            hint="Isso só seleciona o ambiente. Nada muda até você salvar."
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>
              <X className="h-4 w-4" aria-hidden="true" />
              Cancelar
            </Button>
            <Button type="submit" variant="destructive" disabled={!matches}>
              <Rocket className="h-4 w-4" aria-hidden="true" />
              Selecionar produção
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
