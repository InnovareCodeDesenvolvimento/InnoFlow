import { type FormEvent, useEffect, useId, useRef, useState } from "react"
import { Check, ClipboardCopy, Download, KeyRound, TriangleAlert, X } from "lucide-react"
import { toast } from "sonner"
import { Alert } from "@/components/ui/Alert"
import { Button } from "@/components/ui/Button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/Dialog"
import { Input } from "@/components/ui/Input"
import { REPLACE_KEY_CONFIRMATION } from "@/lib/backup"
import type { GeneratedBackupKeyResponse } from "@/types/api"

export interface KeyRequest {
  currentPassword: string
  confirmation?: string
}

/**
 * Diálogo de GERAR / SUBSTITUIR a chave do backup. Gerar pede só a senha atual. Substituir é uma ação de risco (as cópias antigas continuam precisando da chave antiga): mostra o aviso forte,
 * pede a frase exata `GERAR NOVA CHAVE` E a senha, e só habilita o botão com as duas. A senha vive só no estado deste diálogo (que desmonta ao fechar) e é zerada ao enviar; `passwordError`
 * (403 `INVALID_CURRENT_PASSWORD`) aparece aqui e devolve o foco ao campo.
 */
export function KeyActionDialog({
  mode,
  loading,
  passwordError,
  error,
  onConfirm,
  onCancel,
}: {
  mode: "generate" | "replace"
  loading: boolean
  passwordError: string | null
  /** Erro que NÃO é de senha (ex.: já há um backup rodando, a chave mudou): fica no diálogo, que continua aberto. */
  error: string | null
  onConfirm: (request: KeyRequest) => void
  onCancel: () => void
}) {
  const replace = mode === "replace"
  const [password, setPassword] = useState("")
  const [phrase, setPhrase] = useState("")
  const passwordRef = useRef<HTMLInputElement>(null)
  const formId = useId()

  useEffect(() => {
    if (passwordError) passwordRef.current?.focus()
  }, [passwordError])

  const phraseOk = !replace || phrase === REPLACE_KEY_CONFIRMATION
  const canConfirm = password.length > 0 && phraseOk && !loading

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()
    if (!canConfirm) return
    const typed = password
    setPassword("")
    onConfirm({ currentPassword: typed, ...(replace ? { confirmation: phrase } : {}) })
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !loading && onCancel()}>
      <DialogContent widthClassName="sm:max-w-lg">
        <DialogHeader icon={KeyRound}>
          <DialogTitle>{replace ? "Substituir a chave do backup" : "Gerar a chave do backup"}</DialogTitle>
          <DialogDescription>
            {replace
              ? "Uma chave nova passa a cifrar os backups daqui para frente."
              : "A chave é gerada uma vez, aparece uma única vez e o sistema guarda só uma cópia cifrada para o agendador."}
          </DialogDescription>
        </DialogHeader>

        {replace && (
          <Alert tone="danger" role="alert" icon={TriangleAlert} data-testid="replace-key-warning">
            <p className="font-bold">As cópias que já existem continuam precisando da chave ANTIGA.</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              <li>O sistema não guarda a chave antiga: se você não a tiver guardada, essas cópias nunca mais abrem.</li>
              <li>Só troque se a chave atual vazou, ou se você já tem as DUAS guardadas fora do servidor.</li>
              <li>Não dá para trocar com um backup em andamento.</li>
            </ul>
          </Alert>
        )}

        <form id={formId} onSubmit={handleSubmit} className="mt-4 space-y-4" noValidate>
          {replace && (
            <Input
              label={`Para confirmar, digite ${REPLACE_KEY_CONFIRMATION}`}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
              disabled={loading}
              data-testid="replace-key-phrase"
            />
          )}
          <Input
            ref={passwordRef}
            type="password"
            name="currentPassword"
            label="Sua senha atual"
            required
            autoComplete="current-password"
            data-lpignore="true"
            data-1p-ignore="true"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={loading}
            error={passwordError ?? undefined}
            hint="Pedida para que só quem conhece a senha possa gerar ou trocar a chave dos backups."
          />
        </form>

        {error && (
          <Alert tone="danger" size="sm" role="alert" icon={TriangleAlert} className="mt-4 font-medium" data-testid="key-dialog-error">
            <p>{error}</p>
          </Alert>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" size="touch" onClick={onCancel} disabled={loading}>
            <X className="h-4 w-4" aria-hidden="true" />
            Cancelar
          </Button>
          <Button type="submit" form={formId} size="touch" variant={replace ? "destructive" : "default"} loading={loading} disabled={!canConfirm} data-testid="key-confirm">
            {!loading && <KeyRound className="h-4 w-4" aria-hidden="true" />}
            {replace ? "Substituir a chave" : "Gerar a chave"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * A chave recém-gerada, mostrada UMA vez. O diálogo NÃO fecha por Esc, clique fora nem pelo X enquanto a pessoa não marcar "guardei a chave": tentar fechar antes só destaca o aviso e leva o
 * foco à caixa de confirmação. Oferece copiar e baixar o `.txt` (o `fileText` do servidor). A chave vive SÓ nas props deste diálogo (estado local do pai): nenhum atributo, storage ou log.
 * Com a chave na tela, sair da página (F5/fechar a aba) pede confirmação ao navegador.
 */
export function KeyRevealDialog({ result, onDone }: { result: GeneratedBackupKeyResponse; onDone: () => void }) {
  const [saved, setSaved] = useState(false)
  const [warned, setWarned] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const checkboxRef = useRef<HTMLInputElement>(null)
  const checkboxId = useId()

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [])

  const tryClose = () => {
    if (saved) {
      onDone()
      return
    }
    setWarned(true)
    checkboxRef.current?.focus()
  }

  async function copyKey() {
    try {
      await navigator.clipboard.writeText(result.key)
      setCopyFailed(false)
      toast.success("Chave copiada.")
    } catch {
      setCopyFailed(true)
    }
  }

  function downloadKey() {
    const url = URL.createObjectURL(new Blob([result.fileText], { type: "text/plain;charset=utf-8" }))
    const link = document.createElement("a")
    link.href = url
    link.download = result.fileName
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <Dialog open onOpenChange={(open) => !open && tryClose()}>
      <DialogContent
        widthClassName="sm:max-w-xl"
        onEscapeKeyDown={(event) => {
          if (!saved) {
            event.preventDefault()
            tryClose()
          }
        }}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        data-testid="key-reveal-dialog"
      >
        <DialogHeader icon={KeyRound}>
          <DialogTitle>{result.replaced ? "Chave nova gerada" : "Chave do backup gerada"}</DialogTitle>
          <DialogDescription>Esta é a única vez que a chave aparece inteira. Guarde-a agora, fora do servidor.</DialogDescription>
        </DialogHeader>

        <Alert tone="warning" role="alert" icon={TriangleAlert} data-testid="key-reveal-warning">
          <p className="font-bold">Sem esta chave, os backups são inúteis.</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            <li>Guarde num gerenciador de senhas E numa cópia offline (papel ou pen drive trancado). Não guarde só no servidor: ele é o que pode se perder.</li>
            {result.replaced && <li>A chave antiga continua necessária para abrir as cópias antigas. Não a jogue fora.</li>}
            <li>Ela NÃO substitui a PAYMENT_SECRETS_KEY: sem esta, restaurar não devolve as credenciais cifradas (Cielo, SMTP…).</li>
          </ul>
        </Alert>

        <div className="mt-4 space-y-1.5">
          <p className="text-xs font-bold uppercase tracking-wide text-ink-softer">
            Chave (impressão digital <span className="font-mono normal-case">{result.fingerprint}</span>)
          </p>
          <code data-testid="generated-key" className="block break-all rounded-xl border border-border bg-muted/50 p-3 font-mono text-sm font-semibold text-ink [user-select:all]">
            {result.key}
          </code>
        </div>

        <div className="mt-3 grid grid-cols-1 gap-2 sm:flex sm:flex-wrap">
          <Button type="button" variant="outline" size="touch" onClick={() => void copyKey()} data-testid="key-copy">
            <ClipboardCopy className="h-4 w-4" aria-hidden="true" />
            Copiar a chave
          </Button>
          <Button type="button" variant="outline" size="touch" onClick={downloadKey} data-testid="key-download">
            <Download className="h-4 w-4" aria-hidden="true" />
            Baixar o arquivo .txt
          </Button>
        </div>
        {copyFailed && (
          <p role="alert" className="mt-2 text-xs font-medium text-danger-700" data-testid="key-copy-failed">
            O navegador não deixou copiar. Selecione a chave na caixa acima e copie à mão, ou baixe o arquivo.
          </p>
        )}

        <div className="mt-5 flex items-start gap-3 rounded-xl border border-border-subtle p-3">
          <input
            ref={checkboxRef}
            id={checkboxId}
            type="checkbox"
            checked={saved}
            onChange={(e) => {
              setSaved(e.target.checked)
              if (e.target.checked) setWarned(false)
            }}
            className="mt-0.5 h-5 w-5 shrink-0 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2"
            aria-describedby={warned ? `${checkboxId}-warn` : undefined}
            data-testid="key-saved-checkbox"
          />
          <label htmlFor={checkboxId} className="min-w-0 cursor-pointer py-0.5 text-sm font-medium text-ink">
            Guardei a chave num lugar seguro, fora do servidor.
          </label>
        </div>
        {warned && !saved && (
          <p id={`${checkboxId}-warn`} role="alert" className="mt-2 text-xs font-medium text-danger-700" data-testid="key-saved-warning">
            Marque que guardou a chave antes de fechar. Depois disto ela não aparece de novo.
          </p>
        )}

        <DialogFooter>
          <Button type="button" size="touch" onClick={tryClose} disabled={!saved} data-testid="key-done">
            <Check className="h-4 w-4" aria-hidden="true" />
            Concluir
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
