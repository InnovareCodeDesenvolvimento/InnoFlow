import { Clock, ServerCrash } from "lucide-react"
import type { DriverClosureNotice } from "@/lib/sessionClosure"

/**
 * Aviso de fechamento no recibo do motorista (F5.9). `pending` = o carregador
 * ainda não confirmou o fim (nada cobrado); `server` = o servidor encerrou
 * por falta de resposta (cobrado só até o último valor medido). Os textos vêm
 * prontos de `getDriverClosureNotice` (copy em `sessionClosureCopy.ts`).
 * `role="status"`: leitor de tela anuncia sem roubar o foco.
 */
export function SessionClosureNotice({ notice }: { notice: DriverClosureNotice }) {
  const pending = notice.kind === "pending"
  const Icon = pending ? Clock : ServerCrash
  return (
    <div
      role="status"
      data-testid="session-closure-notice"
      data-kind={notice.kind}
      className={`animate-enter mt-4 flex items-start gap-3 rounded-card px-4 py-3.5 text-sm ${
        pending ? "bg-warning-50 text-warning-700 ring-1 ring-warning/30" : "bg-info-50 text-info-700 ring-1 ring-info/30"
      }`}
    >
      <Icon className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
      <div className="min-w-0 space-y-1.5 font-semibold">
        {notice.lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
    </div>
  )
}
