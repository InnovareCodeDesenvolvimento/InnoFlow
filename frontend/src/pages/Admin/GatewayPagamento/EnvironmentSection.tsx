import { FlaskConical, Info, Rocket, TriangleAlert } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card"
import { cn } from "@/lib/utils"
import { ENVIRONMENT_LABELS } from "@/lib/paymentGateway"
import type { PaymentGatewayEnvironment } from "@/types/api"

const OPTIONS: Array<{ value: PaymentGatewayEnvironment; icon: typeof Rocket; description: string }> = [
  { value: "sandbox", icon: FlaskConical, description: "Ambiente de testes da Cielo. Nenhuma cobrança é real." },
  { value: "production", icon: Rocket, description: "Cobranças reais no cartão e no Pix dos motoristas." },
]

/**
 * Seletor de ambiente. Produção é a única escolha perigosa: ESCOLHÊ-LA não
 * muda o valor aqui — só pede a confirmação digitada (`onRequestProduction`);
 * quem muda o rascunho é o diálogo, depois de o admin digitar a palavra.
 */
export function EnvironmentSection({
  value,
  savedValue,
  pendingProduction,
  onSelectSandbox,
  onRequestProduction,
}: {
  /** Ambiente EFETIVO (rascunho sobre o salvo). */
  value: PaymentGatewayEnvironment
  /** Ambiente salvo no servidor. */
  savedValue: PaymentGatewayEnvironment
  /** Produção escolhida e confirmada, mas ainda NÃO salva. */
  pendingProduction: boolean
  onSelectSandbox: () => void
  onRequestProduction: () => void
}) {
  const isProduction = value === "production"

  return (
    <Card className="card-premium" data-testid="section-environment">
      <CardHeader>
        <CardTitle>Ambiente</CardTitle>
        <CardDescription>Em qual ambiente da Cielo a plataforma cobra.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div role="radiogroup" aria-label="Ambiente da Cielo" className="grid gap-2 sm:grid-cols-2">
          {OPTIONS.map(({ value: option, icon: Icon, description }) => {
            const selected = value === option
            const danger = option === "production"
            return (
              <label key={option} className="relative cursor-pointer">
                <input
                  type="radio"
                  name="gateway-environment"
                  value={option}
                  checked={selected}
                  onChange={() => (option === "production" ? onRequestProduction() : onSelectSandbox())}
                  className="peer sr-only"
                />
                <span
                  className={cn(
                    "flex min-h-11 items-start gap-3 rounded-xl border p-3.5 transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-primary peer-focus-visible:ring-offset-2",
                    selected ? (danger ? "border-danger-600 bg-danger-50" : "border-primary bg-primary/5") : "border-border bg-surface hover:bg-muted",
                  )}
                >
                  <Icon className={cn("mt-0.5 h-5 w-5 shrink-0", selected ? (danger ? "text-danger-700" : "text-primary") : "text-ink-softer")} aria-hidden="true" />
                  <span className="min-w-0">
                    <span className="block text-sm font-bold text-ink">{ENVIRONMENT_LABELS[option]}</span>
                    <span className="mt-0.5 block text-xs text-ink-softer">{description}</span>
                  </span>
                </span>
              </label>
            )
          })}
        </div>

        {isProduction ? (
          <div role="status" className="flex items-start gap-3 rounded-xl border border-danger-600/40 bg-danger-50 p-4 text-danger-700" data-testid="environment-production-banner">
            <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
            <div className="min-w-0 text-sm">
              <p className="font-bold">{pendingProduction ? "Produção selecionada — ainda não salva" : "Ambiente de PRODUÇÃO ativo"}</p>
              <p className="mt-0.5">
                {pendingProduction
                  ? "Ao salvar, a plataforma passa a cobrar de verdade: cartões e Pix reais dos motoristas."
                  : "A plataforma cobra de verdade: cartões e Pix reais dos motoristas. Confira tudo antes de mexer em credenciais."}
              </p>
            </div>
          </div>
        ) : (
          <p className="flex items-start gap-2 rounded-lg bg-muted/60 px-3 py-2 text-xs text-ink-softer" data-testid="environment-sandbox-note">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>
              {savedValue === "production"
                ? "Voltar para o sandbox encerra as cobranças reais — as credenciais de produção deixam de ser usadas."
                : "Sandbox: as credenciais de teste da Cielo valem só aqui. Ao ir para produção você vai precisar das credenciais de produção."}
            </span>
          </p>
        )}
      </CardContent>
    </Card>
  )
}
