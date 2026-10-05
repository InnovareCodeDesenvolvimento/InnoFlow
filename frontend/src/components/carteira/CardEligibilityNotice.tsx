import { Clock, CreditCard, ShieldCheck } from "lucide-react"
import { IconBadge } from "@/components/ui/IconBadge"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { authService } from "@/services/auth"
import { getApiErrorCode, getApiErrorStatus } from "@/services/api"
import { GoogleAuthSection } from "@/components/auth/GoogleAuthSection"
import { usePublicConfig } from "@/hooks/usePublicConfig"
import { BLOCKED_TEXT, CHARGEBACK_BLOCKED_TEXT, CHARGEBACK_BLOCKED_TITLE, GOOGLE_REQUIRED_TEXT, GOOGLE_REQUIRED_TITLE, blockedMessage, type CardEligibilityIssue } from "@/lib/cardEligibility"
import { linkGoogleErrorMessage, shouldShowGoogleButton } from "@/lib/googleAuth"
import { useAuthStore } from "@/store/authStore"

/**
 * Explica por que o CARTÃO não está disponível e o que fazer (I-7). Pix e carteira seguem normais - o texto sempre diz isso.
 *
 *  - `GOOGLE_LOGIN_REQUIRED`: CTA "Continuar com o Google" que chama `POST /api/auth/google/link` (autenticado) - vincula o Google a ESTA conta sem trocar de
 *    conta, sem zerar a senha e sem token novo. O e-mail do Google tem que ser o da conta (senão 403 `GOOGLE_EMAIL_MISMATCH`, explicado com o e-mail certo).
 *    NÃO usa o `POST /api/auth/google` público (ignora quem está logado, zera a senha e pode cair em outra conta).
 *  - `TEMPORARILY_BLOCKED`: "indisponível até HH:MM", sem CTA (não há o que fazer além de esperar).
 *  - `CHARGEBACK_BLOCKED` (L1.8): texto da API, tom neutro, SEM CTA (entrar com o Google não resolve; quem resolve é o suporte). Visual neutro (`card-elevated`): não é alarme nem culpa.
 */
export function CardEligibilityNotice({ issue, className, onLinked }: { issue: CardEligibilityIssue; className?: string; /** Chamado depois de o servidor confirmar o vínculo (a tela solta o aviso que guardava do servidor). */ onLinked?: () => void }) {
  const user = useAuthStore((s) => s.user)
  const queryClient = useQueryClient()
  const { data: config } = usePublicConfig()

  if (issue.reason === "CHARGEBACK_BLOCKED") {
    return (
      <div role="status" data-testid="card-eligibility-notice" data-reason="CHARGEBACK_BLOCKED" className={`card-elevated flex items-start gap-3 p-4 ${className ?? ""}`}>
        <IconBadge icon={CreditCard} size="lg" />
        <div className="min-w-0">
          <p className="text-sm font-bold text-ink">{CHARGEBACK_BLOCKED_TITLE}</p>
          <p className="mt-1 text-xs leading-relaxed text-ink-soft">{CHARGEBACK_BLOCKED_TEXT}</p>
        </div>
      </div>
    )
  }

  if (issue.reason === "TEMPORARILY_BLOCKED") {
    return (
      <div role="status" data-testid="card-eligibility-notice" data-reason="TEMPORARILY_BLOCKED" className={`flex items-start gap-3 rounded-card bg-warning-50 p-4 ring-1 ring-warning-600/30 ${className ?? ""}`}>
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-card bg-warning-100 text-warning-700" aria-hidden="true">
          <Clock className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-bold text-warning-700">{blockedMessage(issue).replace(/\.$/, "")}</p>
          <p className="mt-1 text-xs leading-relaxed text-ink-soft">{BLOCKED_TEXT}</p>
        </div>
      </div>
    )
  }

  // `POST /api/auth/google/link` (autenticado): vincula o Google a ESTA conta, sem trocar de conta e sem mexer na senha nem na sessão. Só resta recarregar a
  // elegibilidade (`cardEligibility` vem do GET de cartões) - nada de token novo.
  const handleCredential = async (credential: string) => {
    await authService.linkGoogle({ credential })
    toast.success("Pronto! Agora você pode pagar com cartão.")
    onLinked?.()
    await queryClient.invalidateQueries({ queryKey: ["me"] })
  }

  const googleAvailable = shouldShowGoogleButton(config)

  return (
    <div role="status" data-testid="card-eligibility-notice" data-reason="GOOGLE_LOGIN_REQUIRED" className={`card-elevated p-4 ${className ?? ""}`}>
      <div className="flex items-start gap-3">
        <IconBadge icon={ShieldCheck} size="lg" tinted />
        <div className="min-w-0">
          <p className="text-sm font-bold text-ink">{GOOGLE_REQUIRED_TITLE}</p>
          <p className="mt-1 text-xs leading-relaxed text-ink-soft">{GOOGLE_REQUIRED_TEXT}</p>
        </div>
      </div>

      {googleAvailable ? (
        <>
          <GoogleAuthSection
            onCredential={handleCredential}
            mapError={(err) => linkGoogleErrorMessage(getApiErrorCode(err), getApiErrorStatus(err), user?.email)}
            showDivider={false}
            className="mt-3"
          />
          <p className="mt-3 text-xs leading-relaxed text-ink-softer" data-testid="card-eligibility-link-note">
            Use a conta Google do <strong className="font-semibold text-ink-soft">mesmo e-mail</strong> desta conta{user?.email ? ` (${user.email})` : ""}. Sua senha continua valendo.
          </p>
        </>
      ) : (
        <p className="mt-3 text-xs leading-relaxed text-ink-softer" data-testid="card-eligibility-google-off">
          O login com Google não está disponível no momento. Use o Pix ou a carteira por enquanto.
        </p>
      )}
    </div>
  )
}
