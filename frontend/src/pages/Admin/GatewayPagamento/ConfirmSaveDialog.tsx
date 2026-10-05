import { TriangleAlert } from "lucide-react"
import { Alert } from "@/components/ui/Alert"
import { ConfirmSaveDialog as AdminConfirmSaveDialog } from "@/components/admin/ConfirmSaveDialog"
import type { ChangeSummaryItem } from "@/lib/paymentGateway"

/**
 * Resumo do que vai ser enviado ao gateway, antes do PUT, + step-up de SENHA (F5.7). O diálogo em si (resumo, senha só no estado local e zerada ao enviar, foco no erro)
 * é o `components/admin/ConfirmSaveDialog`, compartilhado com a tela de Comunicação; aqui ficam só os textos do gateway e o aviso de cobrança real
 * (`goesToProduction`).
 */
export function ConfirmSaveDialog({
  items,
  goesToProduction,
  loading,
  passwordError,
  onConfirm,
  onCancel,
}: {
  items: ChangeSummaryItem[]
  goesToProduction: boolean
  loading: boolean
  passwordError?: string | null
  onConfirm: (currentPassword: string) => void
  onCancel: () => void
}) {
  return (
    <AdminConfirmSaveDialog
      title="Confirmar alterações no gateway"
      description="Revise o que será enviado ao servidor. Segredos nunca são exibidos."
      passwordHint="Pedida em toda alteração do gateway, para que só quem conhece a senha possa mexer na conta que recebe o dinheiro."
      items={items}
      destructive={goesToProduction}
      extra={
        goesToProduction ? (
          <Alert tone="danger" size="sm" role="alert" icon={TriangleAlert} className="mt-4 text-sm font-medium">
            <p>Depois de salvar, a plataforma passa a cobrar de verdade (cartões e Pix reais).</p>
          </Alert>
        ) : undefined
      }
      loading={loading}
      passwordError={passwordError}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  )
}
