import { forwardRef, useId, type InputHTMLAttributes } from "react"
import { Alert } from "@/components/ui/Alert"
import { Button } from "@/components/ui/Button"
import { LEGAL_PATHS } from "@/lib/legalPaths"
import { TERMS_LOAD_ERROR_MESSAGE } from "@/lib/termsAcceptance"
import { cn } from "@/lib/utils"

const LINK = "font-semibold text-primary underline underline-offset-2 hover:text-primary-700"

/**
 * Aceite obrigatório dos Termos de Uso e da Política de Privacidade (L1.9): caixa de seleção com os dois links. Os links abrem em OUTRA aba de propósito: quem está no meio do
 * cadastro não perde o que digitou. A área de toque é a linha inteira (>= 44 px) - clicar nos links NÃO marca a caixa (âncora dentro de `label` não aciona o controle).
 *
 * `error` é o texto do erro (aviso do campo, ligado por `aria-describedby`); `loadFailed` mostra que a versão vigente não carregou, com "Tentar de novo" - sem a versão não há como
 * mandar o aceite, mas isso NÃO afeta o login de quem já tem conta (esta peça só existe onde uma conta é CRIADA). Aceita `ref`/`name`/`onChange` de `react-hook-form` direto.
 */
export const TermsAcceptance = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { error?: string; loadFailed?: boolean; onRetry?: () => void; retrying?: boolean }
>(({ error, loadFailed, onRetry, retrying, className, id, ...props }, ref) => {
  const reactId = useId()
  const inputId = id ?? reactId
  const errorId = `${inputId}-error`
  return (
    <div className={cn("space-y-2", className)}>
      <label htmlFor={inputId} className="flex min-h-11 cursor-pointer items-start gap-3 py-1 text-sm leading-snug text-ink-soft">
        <input
          id={inputId}
          ref={ref}
          type="checkbox"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          aria-required="true"
          className="mt-0.5 h-5 w-5 shrink-0 cursor-pointer accent-primary"
          {...props}
        />
        <span>
          Li e aceito os{" "}
          <a href={LEGAL_PATHS.termos} target="_blank" rel="noopener noreferrer" className={LINK}>
            Termos de Uso<span className="sr-only"> (abre em nova aba)</span>
          </a>{" "}
          e a{" "}
          <a href={LEGAL_PATHS.privacidade} target="_blank" rel="noopener noreferrer" className={LINK}>
            Política de Privacidade<span className="sr-only"> (abre em nova aba)</span>
          </a>
          . <span className="text-danger">*</span>
        </span>
      </label>
      {error && (
        <p id={errorId} role="alert" className="text-xs font-medium text-danger">
          {error}
        </p>
      )}
      {loadFailed && (
        <Alert tone="warning" size="sm" role="alert">
          <p>{TERMS_LOAD_ERROR_MESSAGE}</p>
          {onRetry && (
            <Button type="button" variant="outline" size="touch-sm" className="mt-2" onClick={onRetry} loading={retrying}>
              Tentar de novo
            </Button>
          )}
        </Alert>
      )}
    </div>
  )
})
TermsAcceptance.displayName = "TermsAcceptance"
