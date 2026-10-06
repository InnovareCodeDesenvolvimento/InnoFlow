import { useEffect, useMemo, useRef, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"
import { CheckCircle2, Trash2, TriangleAlert } from "lucide-react"
import { Alert } from "@/components/ui/Alert"
import { Button } from "@/components/ui/Button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/Dialog"
import { Input } from "@/components/ui/Input"
import { Skeleton } from "@/components/ui/Skeleton"
import { GoogleAuthSection } from "@/components/auth/GoogleAuthSection"
import { useBalanceForDeletion, useDeleteAccount } from "@/hooks/useMePrivacy"
import { usePublicConfig } from "@/hooks/usePublicConfig"
import {
  accountDeletedState,
  accountDeletionError,
  DELETION_CONFIRM_WORD,
  DELETION_WARNING_TEXT,
  isDeletionWordConfirmed,
  type DeletionError,
  type DeletionStepId,
} from "@/lib/accountDeletion"
import { googleErrorMessageForCode, shouldShowGoogleButton } from "@/lib/googleAuth"
import { formatPixKeyForDisplay, parsePixKey, pixKeyError } from "@/lib/pixKey"
import { getApiErrorCode, getApiErrorStatus } from "@/services/api"
import { TOKEN_STORAGE_KEY } from "@/lib/storageKeys"
import { formatCents } from "@/lib/utils"
import type { MeAccountDeletionRequest, MeProfile } from "@/types/api"

/**
 * Exclusão de conta (L1.4) em PASSOS, dentro de um `Dialog`:
 *   1. Entenda (texto definido pelo time + saldo + dívida) -> 2. Chave Pix (SÓ se há saldo) -> 3. Confirmar (reautenticação + palavra EXCLUIR).
 * O botão final é `destructive` (vermelho): lima é ação principal, nunca destrutiva. Conta COM senha reautentica por senha; conta SÓ-Google (`hasPassword=false`) reautentica com o ID
 * token do Google (o mesmo botão do login, via `GoogleAuthSection onCredential`).
 *
 * Regras:
 *  - O saldo e a dívida vêm de uma consulta feita AGORA (`useBalanceForDeletion`), não do cache: "precisa de chave Pix?" e "tem dívida?" não podem usar um valor de minutos atrás.
 *    Mesmo assim o servidor é a palavra final: `REFUND_PIX_KEY_REQUIRED` (o saldo apareceu entre a consulta e o envio) leva ao passo da chave.
 *  - Todo erro do servidor deixa a conta INTACTA (a exclusão é uma transação só) e é tratado por `code` (`lib/accountDeletion.ts`): dívida/sessão/pagamento em andamento voltam ao
 *    passo 1 com o caminho de saída (carteira, sessão); chave Pix e senha vão no campo, com foco; limite e indisponibilidade (503) ficam como aviso.
 *  - Só depois do 200: o token já não vale, então o estado local é limpo (`logout` + cache) e a pessoa vai ao login com o aviso. NUNCA se limpa a sessão por causa de um erro.
 *  - Os segredos (senha, credencial do Google, chave Pix) ficam só em estado local do diálogo (desmontado ao fechar) e a mutation usa `gcTime: 0` + `reset()`.
 * O diálogo não fecha enquanto o envio está em andamento.
 */
export function DeleteAccountDialog({ open, onOpenChange, profile }: { open: boolean; onOpenChange: (open: boolean) => void; profile: MeProfile }) {
  const [submitting, setSubmitting] = useState(false)
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && submitting) return // não fecha no meio do envio (a resposta decide o que acontece)
        onOpenChange(next)
      }}
    >
      <DialogContent widthClassName="sm:max-w-xl">
        <DeleteAccountFlow profile={profile} onClose={() => onOpenChange(false)} onSubmittingChange={setSubmitting} />
      </DialogContent>
    </Dialog>
  )
}

function DeleteAccountFlow({ profile, onClose, onSubmittingChange }: { profile: MeProfile; onClose: () => void; onSubmittingChange: (v: boolean) => void }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { data: config } = usePublicConfig()
  const wallet = useBalanceForDeletion(true)
  const del = useDeleteAccount()

  const balanceCents = wallet.data?.balanceCents ?? 0
  const debtCents = wallet.data?.openDebtCents ?? 0
  const walletReady = wallet.data !== undefined
  // O servidor pode exigir a chave Pix mesmo com a consulta dizendo "sem saldo" (saldo apareceu no meio do caminho): `pixForced` mantém o passo.
  const [pixForced, setPixForced] = useState(false)
  const needsPix = balanceCents > 0 || pixForced
  const steps: DeletionStepId[] = useMemo(() => (needsPix ? ["info", "pix", "confirm"] : ["info", "confirm"]), [needsPix])

  const [stepId, setStepId] = useState<DeletionStepId>("info")
  const [pixKey, setPixKey] = useState("")
  const [pixErr, setPixErr] = useState<string | null>(null)
  const [password, setPassword] = useState("")
  const [passwordErr, setPasswordErr] = useState<string | null>(null)
  const [googleCredential, setGoogleCredential] = useState<string | null>(null)
  const [googleErr, setGoogleErr] = useState<string | null>(null)
  const [word, setWord] = useState("")
  const [wordErr, setWordErr] = useState<string | null>(null)
  const [blocked, setBlocked] = useState(false)
  const [notice, setNotice] = useState<(Pick<DeletionError, "message" | "link"> & { key: number }) | null>(null)

  const usesPassword = profile.hasPassword
  const googleAvailable = shouldShowGoogleButton(config)
  const stepIndex = Math.max(steps.indexOf(stepId), 0)

  const stepLabelRef = useRef<HTMLParagraphElement>(null)
  const noticeRef = useRef<HTMLDivElement>(null)
  const pixRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)
  const wordRef = useRef<HTMLInputElement>(null)
  const lastStep = useRef<DeletionStepId>("info")

  // Troca de passo: o foco vai para a linha "Passo X de N" (programático; só quem usa teclado/leitor de tela precisa dele - mouse e toque não são afetados). Compara com o passo
  // ANTERIOR (e não com um "primeira vez" que o StrictMode estragaria): focar na montagem roubaria o foco do diálogo e o Radix devolveria o foco ao `body` ao fechar.
  useEffect(() => {
    if (lastStep.current === stepId) return
    lastStep.current = stepId
    stepLabelRef.current?.focus()
  }, [stepId])

  // O aviso de erro do servidor leva o foco ao aparecer (e de novo se o MESMO erro se repetir: `key` muda a cada envio).
  useEffect(() => {
    if (notice) noticeRef.current?.focus()
  }, [notice])

  const goTo = (id: DeletionStepId) => {
    setNotice(null)
    setStepId(id)
  }
  const next = () => goTo(steps[Math.min(stepIndex + 1, steps.length - 1)]!)
  const back = () => goTo(steps[Math.max(stepIndex - 1, 0)]!)

  const continueFromInfo = () => {
    if (!walletReady || debtCents > 0 || blocked) return
    next()
  }

  const continueFromPix = () => {
    const err = pixKeyError(pixKey)
    setPixErr(err)
    if (err) {
      pixRef.current?.focus()
      return
    }
    next()
  }

  const finish = (status: "DELETED" | "DELETED_PENDING_REFUND") => {
    // O token já não vale: nada de chamar a API de novo. Para o que está em voo, limpa o estado da sessão e do cache e vai direto ao login com o aviso.
    // NÃO chama `logout()` aqui: o `AppLayout` redireciona quem fica sem sessão para `/login` (guardando o destino de retorno) e ganharia a corrida contra esta navegação (o React Router a aplica em
    // transição), perdendo o aviso do estado da rota. Em vez disso: o token sai do storage já (nenhuma chamada em voo sai com ele), vai-se ao login com o aviso, e é o PRÓPRIO Login
    // que limpa o estado da sessão e o cache ao montar (ver `pages/Auth/Login.tsx`), quando o `AppLayout` já foi desmontado.
    void queryClient.cancelQueries()
    localStorage.removeItem(TOKEN_STORAGE_KEY)
    navigate("/login", { replace: true, state: accountDeletedState(status) })
  }

  const submit = async () => {
    setNotice(null)
    // Validação do que o servidor também confere, só para não gastar a tentativa (o limite de exclusão é curto).
    let invalid = false
    if (usesPassword && password === "") {
      setPasswordErr("Informe a sua senha atual.")
      passwordRef.current?.focus()
      invalid = true
    } else setPasswordErr(null)
    if (!usesPassword && !googleCredential) {
      setGoogleErr("Confirme com o Google para continuar.")
      invalid = true
    } else setGoogleErr(null)
    if (!isDeletionWordConfirmed(word)) {
      setWordErr(`Digite ${DELETION_CONFIRM_WORD} para confirmar.`)
      if (!invalid) wordRef.current?.focus()
      invalid = true
    } else setWordErr(null)
    if (invalid) return

    const parsedKey = needsPix ? parsePixKey(pixKey) : null
    if (needsPix && !parsedKey) {
      goTo("pix")
      setPixErr(pixKeyError(pixKey))
      return
    }
    const payload: MeAccountDeletionRequest = {
      confirmation: DELETION_CONFIRM_WORD,
      ...(usesPassword ? { currentPassword: password } : { googleCredential: googleCredential ?? undefined }),
      ...(parsedKey ? { refundPixKey: parsedKey.normalized } : {}),
    }

    onSubmittingChange(true)
    try {
      const result = await del.mutateAsync(payload)
      finish(result.status)
    } catch (err) {
      const mapped = accountDeletionError(err)
      if (mapped.step === "pix") setPixForced(true)
      if (mapped.blocking) setBlocked(true)
      if (mapped.resetGoogle) setGoogleCredential(null)
      if (mapped.step) setStepId(mapped.step)
      if (mapped.field === "pix") setPixErr(mapped.message)
      if (mapped.field === "password") {
        setPasswordErr(mapped.message)
        // a senha errada não deve ficar preenchida para um novo envio às cegas
        setPassword("")
      }
      if (mapped.field === "google") setGoogleErr(mapped.message)
      // Erro de UM campo fica no campo; o resto (dívida, sessão, limite, 503...) vira o aviso do diálogo, com o caminho de saída quando existe.
      if (!mapped.field) setNotice({ message: mapped.message, link: mapped.link, key: Date.now() })
    } finally {
      del.reset() // a senha/credencial/chave não ficam guardadas em `variables`
      onSubmittingChange(false)
    }
  }

  // Foco no campo com erro quando o passo muda por causa dele (o campo só existe depois do render do passo).
  useEffect(() => {
    if (stepId === "pix" && pixErr) pixRef.current?.focus()
    if (stepId === "confirm" && passwordErr) passwordRef.current?.focus()
    // só reage a troca de passo; o erro em si já vem no estado
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepId])

  const pixPreview = needsPix && pixKey.trim() !== "" ? parsePixKey(pixKey) : null
  const stepTitle: Record<DeletionStepId, string> = { info: "Entenda o que acontece", pix: "Chave Pix para devolver o saldo", confirm: "Confirme que é você" }

  return (
    <>
      <DialogHeader icon={Trash2}>
        <DialogTitle>Excluir minha conta</DialogTitle>
        <DialogDescription>
          <span ref={stepLabelRef} tabIndex={-1} className="rounded-sm outline-none focus-visible:ring-0 focus-visible:ring-offset-0" data-testid="deletion-step">
            Passo {stepIndex + 1} de {steps.length}: {stepTitle[stepId]}
          </span>
        </DialogDescription>
      </DialogHeader>

      {notice && (
        <Alert ref={noticeRef} tone="danger" icon={TriangleAlert} role="alert" tabIndex={-1} className="mb-4 outline-none focus-visible:ring-0 focus-visible:ring-offset-0" data-testid="deletion-notice">
          <p>{notice.message}</p>
          {notice.link && (
            <Link to={notice.link.to} onClick={onClose} className="mt-2 inline-flex min-h-11 items-center font-semibold underline underline-offset-2">
              {notice.link.label}
            </Link>
          )}
        </Alert>
      )}

      {stepId === "info" && (
        <div className="space-y-4">
          <Alert tone="danger" icon={TriangleAlert} data-testid="deletion-warning">
            {DELETION_WARNING_TEXT}
          </Alert>

          {wallet.isLoading && <Skeleton className="h-16 rounded-card" />}
          {wallet.isError && (
            <Alert tone="warning" role="alert" data-testid="deletion-wallet-error">
              <p>Não foi possível conferir o seu saldo agora. Sem isso não dá para seguir com a exclusão.</p>
              <Button type="button" variant="outline" size="touch-sm" className="mt-2" onClick={() => void wallet.refetch()} loading={wallet.isFetching}>
                Tentar de novo
              </Button>
            </Alert>
          )}
          {walletReady && (
            <div className="rounded-card border border-border bg-muted/50 p-4 text-sm" data-testid="deletion-balance">
              <p className="text-ink-softer">Seu saldo agora</p>
              <p className="mt-0.5 text-xl font-extrabold tabular-nums text-ink">{formatCents(balanceCents)}</p>
              <p className="mt-1.5 text-ink-soft">
                {balanceCents > 0
                  ? "Este valor é devolvido por Pix, em até 30 dias, para a chave que você informar no próximo passo."
                  : "Você não tem saldo a devolver."}
              </p>
            </div>
          )}
          {walletReady && debtCents > 0 && (
            <Alert tone="warning" role="alert" data-testid="deletion-debt">
              <p>
                Você tem <strong className="tabular-nums">{formatCents(debtCents)}</strong> em dívida em aberto. Quite o valor na carteira para poder excluir a conta.
              </p>
              <Link to="/app/carteira" onClick={onClose} className="mt-1 inline-flex min-h-11 items-center font-semibold underline underline-offset-2">
                Ir para a carteira
              </Link>
            </Alert>
          )}
          {blocked && !notice && (
            <p className="text-sm text-ink-softer">Resolva o que foi indicado acima, feche esta janela e abra a exclusão de novo.</p>
          )}
        </div>
      )}

      {stepId === "pix" && (
        <div className="space-y-4">
          <Input
            ref={pixRef}
            label="Chave Pix para a devolução"
            required
            value={pixKey}
            onChange={(e) => {
              setPixKey(e.target.value)
              if (pixErr) setPixErr(null)
            }}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={100}
            hint="CPF, CNPJ, celular, e-mail ou chave aleatória."
            error={pixErr ?? undefined}
          />
          <p className="min-h-5 text-sm text-ink-soft" aria-live="polite" data-testid="deletion-pix-preview">
            {pixPreview ? (
              <>
                Devolvemos <strong className="tabular-nums">{formatCents(balanceCents)}</strong> para: <strong>{formatPixKeyForDisplay(pixPreview)}</strong>
              </>
            ) : null}
          </p>
          <Alert tone="muted" size="sm">
            Confira com atenção: depois da exclusão a conta deixa de existir e não conseguimos corrigir a chave. A chave é guardada cifrada e apagada quando a devolução é feita.
          </Alert>
        </div>
      )}

      {stepId === "confirm" && (
        <div className="space-y-4">
          {usesPassword ? (
            <Input
              ref={passwordRef}
              type="password"
              label="Sua senha atual"
              required
              value={password}
              onChange={(e) => {
                setPassword(e.target.value)
                if (passwordErr) setPasswordErr(null)
              }}
              autoComplete="current-password"
              error={passwordErr ?? undefined}
            />
          ) : (
            <div className="space-y-2" data-testid="deletion-google">
              <p className="text-sm font-medium text-ink-soft">
                Sua conta entra pelo Google. Confirme que é você entrando de novo com ele. <span className="text-danger">*</span>
              </p>
              {googleCredential ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Alert tone="success" size="sm" icon={CheckCircle2} role="status" className="flex-1">
                    Identidade confirmada com o Google.
                  </Alert>
                  <Button type="button" variant="ghost" size="touch-sm" onClick={() => setGoogleCredential(null)}>
                    Usar outra conta
                  </Button>
                </div>
              ) : googleAvailable ? (
                <GoogleAuthSection
                  className="mt-1"
                  showDivider={false}
                  onCredential={async (credential) => {
                    setGoogleErr(null)
                    setGoogleCredential(credential)
                  }}
                  mapError={(err) => googleErrorMessageForCode(getApiErrorCode(err), getApiErrorStatus(err))}
                />
              ) : (
                <Alert tone="warning" size="sm" role="alert">
                  O login com o Google está indisponível no momento. Não dá para confirmar a sua identidade agora: tente de novo mais tarde.
                </Alert>
              )}
              {googleErr && (
                <p role="alert" className="text-xs font-medium text-danger">
                  {googleErr}
                </p>
              )}
            </div>
          )}

          <Input
            ref={wordRef}
            label={`Digite ${DELETION_CONFIRM_WORD} para confirmar`}
            required
            value={word}
            onChange={(e) => {
              setWord(e.target.value)
              if (wordErr) setWordErr(null)
            }}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            hint="Isto confirma que você entendeu que a exclusão é definitiva."
            error={wordErr ?? undefined}
          />
        </div>
      )}

      <DialogFooter>
        {stepId === "info" ? (
          <>
            <Button type="button" variant="outline" size="touch" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="button" size="touch" onClick={continueFromInfo} disabled={!walletReady || debtCents > 0 || blocked}>
              Continuar
            </Button>
          </>
        ) : stepId === "pix" ? (
          <>
            <Button type="button" variant="outline" size="touch" onClick={back}>
              Voltar
            </Button>
            <Button type="button" size="touch" onClick={continueFromPix}>
              Continuar
            </Button>
          </>
        ) : (
          <>
            <Button type="button" variant="outline" size="touch" onClick={back} disabled={del.isPending}>
              Voltar
            </Button>
            <Button type="button" variant="destructive" size="touch" onClick={() => void submit()} loading={del.isPending} disabled={blocked || (!usesPassword && !googleAvailable && !googleCredential)}>
              Excluir minha conta
            </Button>
          </>
        )}
      </DialogFooter>
    </>
  )
}
