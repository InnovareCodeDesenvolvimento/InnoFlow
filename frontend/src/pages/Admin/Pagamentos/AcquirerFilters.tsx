import { useState, type FormEvent } from "react"
import { ChevronDown, Search, X } from "lucide-react"
import { Button } from "@/components/ui/Button"
import { Input } from "@/components/ui/Input"
import { cn } from "@/lib/utils"
import { EMPTY_ACQUIRER_FILTERS, type AcquirerFilterValues } from "@/lib/reversals"

const MAX_LENGTH = 64

/**
 * Busca da venda da Cielo pelos identificadores do AVISO (Tid, código de autorização, NSU) — o caminho para achar a venda de um chargeback (runbook §2.1). Igualdade EXATA no
 * servidor, então não filtra enquanto digita (cada letra seria uma busca vazia): aplica ao enviar o formulário. Recolhido por padrão, para não pesar a tela de quem só olha o
 * extrato; nasce aberto quando já há filtro aplicado (o motivo de a lista estar curta tem que estar à vista).
 */
export function AcquirerFilters({ applied, onApply }: { applied: AcquirerFilterValues; onApply: (values: AcquirerFilterValues) => void }) {
  const hasApplied = Boolean(applied.tid || applied.authorizationCode || applied.proofOfSale)
  const [open, setOpen] = useState(hasApplied)
  const [draft, setDraft] = useState<AcquirerFilterValues>(applied)

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()
    onApply({ tid: draft.tid.trim(), authorizationCode: draft.authorizationCode.trim(), proofOfSale: draft.proofOfSale.trim() })
  }

  const handleClear = () => {
    setDraft(EMPTY_ACQUIRER_FILTERS)
    onApply(EMPTY_ACQUIRER_FILTERS)
  }

  const expanded = open
  return (
    <div>
      <Button type="button" variant="outline" size="touch" aria-expanded={expanded} aria-controls="acquirer-filters" onClick={() => setOpen((v) => !v)}>
        <Search className="h-4 w-4" aria-hidden="true" />
        Buscar venda da Cielo
        <ChevronDown className={cn("h-4 w-4 transition-transform", expanded && "rotate-180")} aria-hidden="true" />
      </Button>

      {expanded && (
        <form id="acquirer-filters" className="mt-3 space-y-3 rounded-xl border border-border-subtle p-4" onSubmit={handleSubmit} noValidate>
          <div className="grid gap-3 sm:grid-cols-3">
            <Input label="Tid" autoComplete="off" maxLength={MAX_LENGTH} value={draft.tid} onChange={(e) => setDraft((d) => ({ ...d, tid: e.target.value }))} />
            <Input
              label="Código de autorização"
              autoComplete="off"
              maxLength={MAX_LENGTH}
              value={draft.authorizationCode}
              onChange={(e) => setDraft((d) => ({ ...d, authorizationCode: e.target.value }))}
            />
            <Input label="NSU" autoComplete="off" maxLength={MAX_LENGTH} value={draft.proofOfSale} onChange={(e) => setDraft((d) => ({ ...d, proofOfSale: e.target.value }))} />
          </div>
          <p className="text-xs text-ink-softer">Busca exata, só em vendas de cartão. Copie os códigos do aviso da Cielo; o período acima também vale.</p>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="touch">
              <Search className="h-4 w-4" aria-hidden="true" />
              Buscar
            </Button>
            <Button type="button" variant="ghost" size="touch" onClick={handleClear} disabled={!hasApplied && !draft.tid && !draft.authorizationCode && !draft.proofOfSale}>
              <X className="h-4 w-4" aria-hidden="true" />
              Limpar
            </Button>
          </div>
        </form>
      )}
    </div>
  )
}
