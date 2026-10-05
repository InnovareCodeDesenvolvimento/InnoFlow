import { Info, KeyRound, ShieldAlert, TriangleAlert } from "lucide-react"
import { Alert } from "@/components/ui/Alert"
import { InlineCode } from "@/components/ui/InlineCode"
import { RUNBOOK_PATH, SECRETS_KEY_NOTICE } from "@/lib/backup"

/**
 * AVISO PERMANENTE (pedido do dono): a PAYMENT_SECRETS_KEY precisa de uma cópia fora do sistema. O backup guarda os segredos (Cielo, SMTP, credenciais do destino) CIFRADOS com ela:
 * sem a chave original, restaurar o banco não devolve esses segredos. A chave do backup é outra coisa (cifra o arquivo) e não a substitui.
 */
export function SecretsKeyPermanentNotice() {
  return (
    <Alert tone="warning" role="note" icon={KeyRound} data-testid="secrets-key-notice">
      <p>
        <span className="font-bold">{SECRETS_KEY_NOTICE}</span> A chave de criptografia do backup (abaixo) é outra coisa: ela abre o arquivo da cópia e <span className="font-semibold">não substitui</span> a <InlineCode>PAYMENT_SECRETS_KEY</InlineCode>. Guarde as duas
        fora do servidor.
      </p>
    </Alert>
  )
}

/** `secretsKeyConfigured === false`: o servidor não consegue cifrar nem decifrar segredo: não dá para guardar credencial do destino nem a chave do backup. */
export function SecretsKeyMissingAlert() {
  return (
    <Alert tone="danger" role="alert" icon={TriangleAlert} data-testid="secrets-key-missing-alert">
      <p>
        <span className="font-bold">Servidor sem chave de cifragem.</span> A variável <InlineCode>PAYMENT_SECRETS_KEY</InlineCode> não está configurada, então não é possível guardar as credenciais do destino nem a chave do backup. Peça para quem
        cuida do servidor criá-la no EasyPanel e reiniciar a API. Você ainda pode salvar horário, frequência e limite de alerta.
      </p>
    </Alert>
  )
}

/** `secretsReadable === false`: há segredo salvo que o servidor não decifra (a PAYMENT_SECRETS_KEY mudou). */
export function SecretsUnreadableAlert() {
  return (
    <Alert tone="danger" role="alert" icon={ShieldAlert} data-testid="secrets-unreadable-alert">
      <p>
        <span className="font-bold">Segredos salvos ilegíveis.</span> O servidor não consegue decifrar as credenciais do destino salvas (a <InlineCode>PAYMENT_SECRETS_KEY</InlineCode> foi trocada ou o dado está corrompido). O backup para esse destino falha até
        você digitar as credenciais de novo e salvar. Se a chave original existe em algum lugar, restaurá-la resolve sem redigitar nada.
      </p>
    </Alert>
  )
}

/** Restaurar NÃO tem botão aqui, de propósito: um clique que apaga o banco é risco desproporcional. É operação de infraestrutura, por linha de comando. */
export function RestoreNotice() {
  return (
    <Alert tone="muted" role="note" icon={Info} data-testid="restore-notice">
      <p>
        <span className="font-bold text-ink">Restaurar não tem botão aqui, de propósito.</span> Um botão que apaga e recria o banco a um clique é um risco grande demais para ficar a um toque de distância. Restaurar é uma operação de infraestrutura, feita por linha
        de comando por quem cuida do servidor. O passo a passo (restauração total, parcial e o ensaio trimestral) está no runbook <InlineCode>{RUNBOOK_PATH}</InlineCode> do repositório. Use “Conferir backup” para provar que a cópia abre.
      </p>
    </Alert>
  )
}
