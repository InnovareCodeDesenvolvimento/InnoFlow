import { useEffect, useRef, useState } from "react"
import { CheckCircle2, Download, ShieldCheck, TriangleAlert } from "lucide-react"
import { Alert } from "@/components/ui/Alert"
import { Button } from "@/components/ui/Button"
import { DeleteAccountDialog } from "@/components/perfil/DeleteAccountDialog"
import { ProfileSection } from "@/components/perfil/ProfileSection"
import { useExportMyData } from "@/hooks/useMePrivacy"
import { EXPORT_DESCRIPTION, EXPORT_DONE_MESSAGE, exportErrorMessage } from "@/lib/accountDeletion"
import { LEGAL_PATHS } from "@/lib/legalPaths"
import type { MeProfile } from "@/types/api"

const LINK = "font-semibold text-primary underline underline-offset-2 hover:text-primary-700"

/**
 * Seção "Privacidade e dados" do perfil (L1.4 + L1.9): baixar uma cópia dos dados e excluir a conta. Moldura = `ProfileSection` (uma seção a mais na pilha de `pages/App/Perfil.tsx`).
 *
 *  - Exportar: `GET /api/me/data-export` -> arquivo JSON (3 por dia). O resultado e o erro aparecem num aviso em linha (`role="status"`/`"alert"`), com o foco no aviso de erro. O arquivo é
 *    baixado dentro da mutation e a cópia dos dados não fica em memória do React Query (ver `useExportMyData`).
 *  - Excluir: abre o diálogo em passos (`DeleteAccountDialog`). O botão é `destructive` e fica separado do "Baixar" por uma divisória, para não ser clicado por engano.
 * Os dois textos de contexto são os definidos pelo time (ver `lib/accountDeletion.ts`).
 */
export function PrivacySection({ profile }: { profile: MeProfile }) {
  const exporter = useExportMyData()
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const errorRef = useRef<HTMLDivElement>(null)
  // O aviso só existe no DOM depois do render que o mostra: o foco vai para ele aqui (e remonta a cada tentativa, porque o início do envio o desmonta).
  useEffect(() => {
    if (error) errorRef.current?.focus()
  }, [error])

  const handleExport = async () => {
    setDone(false)
    setError(null)
    try {
      await exporter.mutateAsync()
      setDone(true)
    } catch (err) {
      setError(exportErrorMessage(err))
    } finally {
      exporter.reset()
    }
  }

  return (
    <ProfileSection icon={ShieldCheck} title="Privacidade e dados" description="Seus dados são seus: baixe uma cópia ou exclua a conta quando quiser.">
      <div className="space-y-5">
        <div>
          <h3 className="text-sm font-bold text-ink">Seus dados</h3>
          <p className="mt-1 text-sm text-ink-softer">{EXPORT_DESCRIPTION}</p>
          <Button type="button" variant="outline" size="touch" className="mt-3 w-full sm:w-auto" onClick={() => void handleExport()} loading={exporter.isPending}>
            {!exporter.isPending && <Download className="h-4 w-4" aria-hidden="true" />}
            Baixar meus dados
          </Button>
          {error && (
            <Alert ref={errorRef} tone="danger" icon={TriangleAlert} role="alert" tabIndex={-1} className="mt-3 outline-none focus-visible:ring-0 focus-visible:ring-offset-0" data-testid="export-error">
              {error}
            </Alert>
          )}
          {done && (
            <Alert tone="success" icon={CheckCircle2} role="status" className="mt-3" data-testid="export-done">
              {EXPORT_DONE_MESSAGE}
            </Alert>
          )}
        </div>

        <div className="border-t border-border pt-5">
          <h3 className="text-sm font-bold text-ink">Excluir conta</h3>
          <p className="mt-1 text-sm text-ink-softer">Apaga seus dados pessoais e encerra o acesso. Não dá para desfazer.</p>
          <Button type="button" variant="destructive" size="touch" className="mt-3 w-full sm:w-auto" onClick={() => setDeleteOpen(true)}>
            Excluir minha conta
          </Button>
        </div>

        <p className="text-xs text-ink-softer">
          Leia os{" "}
          <a href={LEGAL_PATHS.termos} target="_blank" rel="noopener noreferrer" className={LINK}>
            Termos de Uso<span className="sr-only"> (abre em nova aba)</span>
          </a>{" "}
          e a{" "}
          <a href={LEGAL_PATHS.privacidade} target="_blank" rel="noopener noreferrer" className={LINK}>
            Política de Privacidade<span className="sr-only"> (abre em nova aba)</span>
          </a>
          .
        </p>
      </div>

      {/* Sempre montado (o conteúdo é que some ao fechar): é o que permite ao Radix devolver o foco ao botão que abriu o diálogo. */}
      <DeleteAccountDialog open={deleteOpen} onOpenChange={setDeleteOpen} profile={profile} />
    </ProfileSection>
  )
}
