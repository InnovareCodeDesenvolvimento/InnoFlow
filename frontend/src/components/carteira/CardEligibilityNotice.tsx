import { Clock, ShieldCheck } from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { GoogleAuthSection } from "@/components/auth/GoogleAuthSection"
import { usePublicConfig } from "@/hooks/usePublicConfig"
import { BLOCKED_TEXT, GOOGLE_REQUIRED_TEXT, GOOGLE_REQUIRED_TITLE, blockedMessage, type CardEligibilityIssue } from "@/lib/cardEligibility"
import { shouldShowGoogleButton } from "@/lib/googleAuth"
import { useAuthStore } from "@/store/authStore"
import type { User } from "@/types/api"

/**
 * Explica por que o CARTÃO não está disponível e o que fazer (I-7). Pix e carteira seguem normais - o texto sempre diz isso.
 *
 *  - `GOOGLE_LOGIN_REQUIRED`: CTA "Continuar com o Google". O app não tem um "vincular" separado: o botão chama `POST /api/auth/google`, que para conta de
 *    motorista com o MESMO e-mail verificado VINCULA o Google à conta existente (o servidor zera a senha e devolve token novo - o login normal continua sendo
 *    esta mesma rota). Duas consequências que o motorista precisa saber ANTES de clicar, e por isso estão no texto: (1) tem que ser o Google do mesmo e-mail
 *    desta conta; (2) depois disso a conta entra pelo Google. Se o Google for de OUTRO e-mail, o servidor cria/entra em OUTRA conta de motorista: detectado
 *    pela troca de `user.id` e avisado em toast (a tela passa a mostrar a outra conta, sem a carteira desta).
 *  - `TEMPORARILY_BLOCKED`: "indisponível até HH:MM", sem CTA (não há o que fazer além de esperar).
 */
export function CardEligibilityNotice({ issue, className, onLinked }: { issue: CardEligibilityIssue; className?: string; /** Chamado depois do Google responder com sucesso (a tela solta o aviso que guardava do servidor). */ onLinked?: () => void }) {
  const user = useAuthStore((s) => s.user)
  const queryClient = useQueryClient()
  const { data: config } = usePublicConfig()

  if (issue.reason === "TEMPORARILY_BLOCKED") {
    return (
      <div role="status" data-testid="card-eligibility-notice" data-reason="TEMPORARILY_BLOCKED" className={`flex items-start gap-3 rounded-2xl bg-warning-50 p-4 ring-1 ring-warning-600/30 ${className ?? ""}`}>
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-warning-100 text-warning-700" aria-hidden="true">
          <Clock className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-bold text-warning-700">{blockedMessage(issue).replace(/\.$/, "")}</p>
          <p className="mt-1 text-xs leading-relaxed text-ink-soft">{BLOCKED_TEXT}</p>
        </div>
      </div>
    )
  }

  const handleLinked = (next: User) => {
    // O servidor pode ter vinculado (mesma conta) OU entrado/criado outra conta (Google de outro e-mail): só o `user.id` diz qual.
    if (user && next.id !== user.id) {
      toast.warning("Você entrou em outra conta.", {
        description: "O Google usado tem um e-mail diferente do desta conta. Para pagar com cartão nesta conta, vincule o Google do mesmo e-mail dela.",
      })
    } else {
      toast.success("Conta Google vinculada.", { description: "Agora você pode pagar com cartão." })
    }
    onLinked?.()
    void queryClient.invalidateQueries({ queryKey: ["me"] })
  }

  const googleAvailable = shouldShowGoogleButton(config)

  return (
    <div role="status" data-testid="card-eligibility-notice" data-reason="GOOGLE_LOGIN_REQUIRED" className={`rounded-2xl bg-primary/5 p-4 ring-1 ring-primary/25 ${className ?? ""}`}>
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary-700" aria-hidden="true">
          <ShieldCheck className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-bold text-ink">{GOOGLE_REQUIRED_TITLE}</p>
          <p className="mt-1 text-xs leading-relaxed text-ink-soft">{GOOGLE_REQUIRED_TEXT}</p>
        </div>
      </div>

      {googleAvailable ? (
        <>
          <GoogleAuthSection onSuccess={handleLinked} showDivider={false} className="mt-3" />
          <p className="mt-3 text-xs leading-relaxed text-ink-softer" data-testid="card-eligibility-link-note">
            Use a conta Google do <strong className="font-semibold text-ink-soft">mesmo e-mail</strong> desta conta{user?.email ? ` (${user.email})` : ""}. Depois de vincular, você passa a entrar
            pelo Google e a senha atual deixa de valer.
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
