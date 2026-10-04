import { useMemo } from "react"
import { Link2 } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/Dialog"
import { useTariffAssignmentContext } from "@/hooks/useTariffAssignmentContext"
import { describeTariffPrice } from "@/lib/tariffAssignmentTargets"
import { getAssignmentStatus } from "@/lib/tariffAssignments"
import type { Tariff } from "@/types/api"
import { TariffAssignmentManager } from "./TariffAssignmentManager"

/**
 * "Onde esta tarifa vale": os vínculos de UMA tarifa (locais, carregadores, tomadas ou o operador inteiro) + vincular a um novo alvo.
 * Quem usa o fluxo por carregador ("Tarifas de CP-X") vê o resultado final por tomada; aqui o ponto de partida é a tarifa.
 * "Vale hoje" não é calculado nesta tela: depende de outras tarifas que concorrem na mesma tomada — para isso, abra "Tarifas" no carregador.
 */
export function TariffUsageDialog({ tariff, onOpenChange }: { tariff: Tariff | null; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={Boolean(tariff)} onOpenChange={onOpenChange}>
      <DialogContent widthClassName="sm:max-w-3xl">{tariff && <TariffUsageBody tariff={tariff} />}</DialogContent>
    </Dialog>
  )
}

const NO_EFFECTIVE: ReadonlySet<string> = new Set()

function TariffUsageBody({ tariff }: { tariff: Tariff }) {
  const ctx = useTariffAssignmentContext()
  const own = useMemo(() => ctx.assignments.filter((a) => a.tariffId === tariff.id), [ctx.assignments, tariff.id])
  const activeCount = own.filter((a) => getAssignmentStatus(a) === "active").length

  return (
    <>
      <DialogHeader icon={Link2}>
        <DialogTitle>Onde &quot;{tariff.name}&quot; vale</DialogTitle>
        <DialogDescription>
          {describeTariffPrice(tariff)}. {activeCount === 0 ? "Esta tarifa não está vinculada a nada ainda — sem vínculo ela não é cobrada de ninguém." : `${activeCount} ${activeCount === 1 ? "vínculo vigente" : "vínculos vigentes"}.`}
        </DialogDescription>
      </DialogHeader>

      <TariffAssignmentManager
        assignments={own}
        isLoading={ctx.isLoading}
        error={ctx.error}
        onRetry={ctx.refetch}
        effectiveIds={NO_EFFECTIVE}
        lookup={ctx.lookup}
        tariffsById={ctx.tariffsById}
        showTariff={false}
        fixedTariffId={tariff.id}
        emptyDescription="Vincule esta tarifa a um local, a um carregador, a uma tomada ou a todo o operador."
      />
    </>
  )
}
