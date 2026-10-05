import { Server, SquarePen } from "lucide-react"
import { InlineCode } from "@/components/ui/InlineCode"
import { requirementInfo, splitRequirements } from "@/lib/paymentGateway"

/**
 * Lista do que falta, em português, separada por ONDE se resolve: o que o
 * admin preenche nesta tela x variáveis do servidor (EasyPanel), que a tela
 * NÃO edita. Usada na prontidão de cada meio e no erro `GATEWAY_NOT_READY`.
 */
export function RequirementList({ codes, testId }: { codes: readonly string[]; testId?: string }) {
  const { screen, server } = splitRequirements(codes)

  return (
    <div className="space-y-3 text-sm" data-testid={testId}>
      {screen.length > 0 && (
        <div>
          <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-ink-softer">
            <SquarePen className="h-3.5 w-3.5" aria-hidden="true" />
            Preencha nesta tela
          </p>
          <ul className="mt-1.5 space-y-1 text-ink-soft">
            {screen.map((code) => {
              const info = requirementInfo(code)
              return (
                <li key={code} className="flex gap-2">
                  <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-warning" aria-hidden="true" />
                  <span>
                    {info.label}
                    {info.section && <span className="text-ink-softer"> — em “{info.section}”</span>}
                  </span>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {server.length > 0 && (
        <div>
          <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-ink-softer">
            <Server className="h-3.5 w-3.5" aria-hidden="true" />
            Só no servidor (EasyPanel)
          </p>
          <ul className="mt-1.5 space-y-1 text-ink-soft">
            {server.map((code) => {
              const info = requirementInfo(code)
              return (
                <li key={code} className="flex gap-2">
                  <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-warning" aria-hidden="true" />
                  <span className="min-w-0">
                    {info.label}
                    {info.envVar && (
                      <>
                        {" "}
                        — variável <InlineCode>{info.envVar}</InlineCode>
                      </>
                    )}
                    {info.note && <span className="text-ink-softer"> — {info.note}</span>}
                  </span>
                </li>
              )
            })}
          </ul>
          <p className="mt-2 text-xs text-ink-softer">
            Estes itens são variáveis de ambiente da API: esta tela não os edita. Quem cuida do servidor define no EasyPanel e reinicia a API.
          </p>
        </div>
      )}
    </div>
  )
}
