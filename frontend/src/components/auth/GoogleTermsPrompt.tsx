import { useEffect, useRef, useState } from "react"
import { ScrollText } from "lucide-react"
import { Alert } from "@/components/ui/Alert"
import { Button } from "@/components/ui/Button"
import { TermsAcceptance } from "@/components/auth/TermsAcceptance"
import { usePublicLegal } from "@/hooks/useLegal"
import { TERMS_OUTDATED_MESSAGE, TERMS_REQUIRED_MESSAGE } from "@/lib/termsAcceptance"

/**
 * Aceite pedido DEPOIS de o Google responder 400 `acceptedTermsVersion` (a credencial é de uma conta que ainda NÃO existe, então o servidor vai CRIAR uma e exige o aceite dos
 * Termos - L1.9) ou 409 `TERMS_VERSION_OUTDATED`. Quem já tem conta nunca vê isto: entra direto. A credencial fica guardada por quem monta esta peça (`GoogleAuthSection`) e é
 * REENVIADA com a versão vigente quando a pessoa aceita - não precisa clicar no botão do Google de novo.
 * Falha ao carregar a versão vigente: mostra o erro com "Tentar de novo" (sem a versão não há como aceitar) e deixa "Cancelar" livre.
 */
export function GoogleTermsPrompt({ outdated, submitting, onAccept, onCancel }: { outdated: boolean; submitting: boolean; onAccept: (termsVersion: string) => void; onCancel: () => void }) {
  const legal = usePublicLegal()
  const [accepted, setAccepted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const checkboxRef = useRef<HTMLInputElement>(null)

  // O foco vai para a caixa quando o pedido aparece (ele surge depois do clique do Google, longe de onde a pessoa estava olhando).
  useEffect(() => {
    checkboxRef.current?.focus()
  }, [])
  // 409: a versão que a tela tinha ficou velha - busca a vigente de novo (o `legal.data` em cache seria a antiga).
  const { refetch } = legal
  useEffect(() => {
    if (outdated) void refetch()
  }, [outdated, refetch])

  const handleAccept = () => {
    if (!accepted) {
      setError(TERMS_REQUIRED_MESSAGE)
      checkboxRef.current?.focus()
      return
    }
    if (!legal.data) {
      void legal.refetch()
      return
    }
    onAccept(legal.data.termsVersion)
  }

  return (
    <div role="group" aria-label="Aceite dos Termos de Uso" className="space-y-3 rounded-card border border-border bg-surface p-4" data-testid="google-terms-prompt">
      <Alert tone={outdated ? "warning" : "info"} icon={ScrollText} size="sm" role="status">
        {outdated ? TERMS_OUTDATED_MESSAGE : "Para criar sua conta com o Google, aceite os Termos de Uso e a Política de Privacidade."}
      </Alert>
      <TermsAcceptance
        ref={checkboxRef}
        checked={accepted}
        onChange={(e) => {
          setAccepted(e.target.checked)
          if (e.target.checked) setError(null)
        }}
        error={error ?? undefined}
        loadFailed={legal.isError}
        onRetry={() => void legal.refetch()}
        retrying={legal.isFetching}
      />
      <div className="flex flex-col gap-2 sm:flex-row-reverse">
        <Button type="button" size="touch" className="sm:flex-1" loading={submitting} disabled={legal.isError} onClick={handleAccept}>
          Aceitar e continuar
        </Button>
        <Button type="button" variant="ghost" size="touch" className="sm:flex-1" disabled={submitting} onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </div>
  )
}
