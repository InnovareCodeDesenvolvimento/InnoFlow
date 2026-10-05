import { useRef, useState } from "react"
import axios from "axios"
import { ScrollText } from "lucide-react"
import { toast } from "sonner"
import { useTour } from "@/components/onboarding/tourContext"
import { TermsAcceptance } from "@/components/auth/TermsAcceptance"
import { Alert } from "@/components/ui/Alert"
import { Button } from "@/components/ui/Button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/Dialog"
import { useAcceptConsents, useMeConsents, usePublicLegal } from "@/hooks/useLegal"
import { getApiErrorStatus } from "@/services/api"
import { NETWORK_ERROR_MESSAGE, SERVER_UNSTABLE_MESSAGE } from "@/lib/authErrors"
import { isTermsOutdatedError, TERMS_OUTDATED_MESSAGE, TERMS_REQUIRED_MESSAGE } from "@/lib/termsAcceptance"

/** "Agora não" vale só nesta aba (`sessionStorage`): o aviso volta no próximo acesso até a pessoa aceitar. */
export const CONSENT_DISMISSED_KEY = "innoflow:consent-dismissed"

function readDismissed(): boolean {
  try {
    return sessionStorage.getItem(CONSENT_DISMISSED_KEY) === "1"
  } catch {
    return false
  }
}

function writeDismissed(): void {
  try {
    sessionStorage.setItem(CONSENT_DISMISSED_KEY, "1")
  } catch {
    // armazenamento bloqueado: o aviso só reaparece no próximo carregamento
  }
}

function acceptError(err: unknown): string {
  if (isTermsOutdatedError(err)) return TERMS_OUTDATED_MESSAGE
  if (axios.isAxiosError(err)) {
    const status = getApiErrorStatus(err)
    if (status === undefined) return NETWORK_ERROR_MESSAGE
    if (status >= 500) return SERVER_UNSTABLE_MESSAGE
  }
  return "Não foi possível registrar o aceite agora. Tente novamente."
}

/**
 * Pedido de novo aceite (L1.9) no app do motorista: `GET /api/me/consents` com `upToDate=false` (versão nova dos Termos/Privacidade, ou conta anterior ao L1.9 que nunca aceitou)
 * abre este diálogo UMA vez por acesso. É um aviso LEVE, não um muro: "Agora não" (ou Esc/fechar) o dispensa nesta aba e o app segue funcionando; ele volta no próximo acesso.
 * Aceitar exige marcar a caixa (com os dois links, que abrem em outra aba) e manda `POST /api/me/consents` com as versões vigentes de `GET /api/public/legal`.
 *  - Falha ao carregar o status: silêncio (o aviso é secundário; nada de erro na cara de quem só quer recarregar).
 *  - Falha ao carregar a versão vigente: erro no diálogo com "Tentar de novo".
 *  - 409 `TERMS_VERSION_OUTDATED`: a versão mudou enquanto o diálogo estava aberto - recarrega a vigente e pede o aceite de novo.
 * Não abre enquanto o tour de boas-vindas está aberto (dois diálogos ao mesmo tempo).
 */
export default function ConsentReacceptDialog() {
  const tour = useTour()
  const consents = useMeConsents()
  const needsAccept = consents.data !== undefined && !consents.data.upToDate
  const legal = usePublicLegal(needsAccept)
  const accept = useAcceptConsents()
  const [dismissed, setDismissed] = useState(readDismissed)
  const [checked, setChecked] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const checkboxRef = useRef<HTMLInputElement>(null)

  const open = needsAccept && !dismissed && !tour.active

  const dismiss = () => {
    writeDismissed()
    setDismissed(true)
  }

  const handleAccept = async () => {
    setSubmitError(null)
    if (!checked) {
      setError(TERMS_REQUIRED_MESSAGE)
      checkboxRef.current?.focus()
      return
    }
    if (!legal.data) {
      void legal.refetch()
      return
    }
    try {
      await accept.mutateAsync({ termsVersion: legal.data.termsVersion, privacyVersion: legal.data.privacyVersion })
      setDismissed(true)
      toast.success("Obrigado! Seu aceite foi registrado.")
    } catch (err) {
      if (isTermsOutdatedError(err)) {
        void legal.refetch()
        setChecked(false)
      }
      setSubmitError(acceptError(err))
    }
  }

  if (!needsAccept) return null

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !accept.isPending && dismiss()}>
      <DialogContent widthClassName="sm:max-w-md">
        <DialogHeader icon={ScrollText}>
          <DialogTitle>Atualizamos nossos Termos</DialogTitle>
          <DialogDescription>Para continuar com tudo em dia, leia e aceite a versão atual.</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <p className="text-sm text-ink-soft">
            Os Termos de Uso e a Política de Privacidade do InnoFlow têm uma versão nova. Você continua usando o aplicativo normalmente; só precisamos registrar o seu aceite.
          </p>
          <TermsAcceptance
            ref={checkboxRef}
            checked={checked}
            onChange={(e) => {
              setChecked(e.target.checked)
              if (e.target.checked) setError(null)
            }}
            error={error ?? undefined}
            loadFailed={legal.isError}
            onRetry={() => void legal.refetch()}
            retrying={legal.isFetching}
          />
          {submitError && (
            <Alert tone="danger" size="sm" role="alert">
              {submitError}
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" size="touch" onClick={dismiss} disabled={accept.isPending}>
            Agora não
          </Button>
          <Button type="button" size="touch" onClick={() => void handleAccept()} loading={accept.isPending} disabled={legal.isError}>
            Aceitar e continuar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
