import { Info, KeyRound, ShieldAlert, TriangleAlert } from "lucide-react"
import { Alert } from "@/components/ui/Alert"
import { InlineCode } from "@/components/ui/InlineCode"
import { RUNBOOK_PATH, SECRETS_KEY_NOTICE } from "@/lib/backup"

/**
 * AVISO PERMANENTE (pedido do dono; texto trocado em 05/10): a chave que cifra os segredos salvos é DERIVADA do `JWT_SECRET` do servidor, então o `JWT_SECRET` precisa de uma cópia fora do
 * sistema. O backup guarda os segredos (Cielo, SMTP, credenciais do destino) CIFRADOS com ela: sem o `JWT_SECRET` original, restaurar o banco não devolve esses segredos. A chave do backup
 * é outra coisa (cifra o arquivo) e não a substitui. Mora no rodapé da tela, sempre visível (não depende de abrir um "ⓘ").
 */
export function SecretsKeyPermanentNotice() {
  return (
    <Alert tone="warning" role="note" icon={KeyRound} data-testid="secrets-key-notice">
      <p>
        <span className="font-bold">{SECRETS_KEY_NOTICE}</span> A chave do backup (acima) é outra coisa: ela abre o arquivo da cópia e <span className="font-semibold">não substitui</span> o <InlineCode>JWT_SECRET</InlineCode>. Guarde as duas fora do servidor.
      </p>
    </Alert>
  )
}

/** `secretsKeyConfigured === false`: o servidor não consegue cifrar nem decifrar segredo: não dá para guardar credencial do destino nem a chave do backup. */
export function SecretsKeyMissingAlert() {
  return (
    <Alert tone="danger" role="alert" icon={TriangleAlert} data-testid="secrets-key-missing-alert">
      <p>
        <span className="font-bold">Servidor sem chave de cifragem.</span> O servidor não conseguiu montar a chave que cifra os segredos (ela é derivada do <InlineCode>JWT_SECRET</InlineCode>), então não é possível guardar as credenciais do destino nem a
        chave do backup. Peça para quem cuida do servidor conferir o <InlineCode>JWT_SECRET</InlineCode> no EasyPanel e reiniciar a API. Você ainda pode salvar horário, frequência e limite de alerta.
      </p>
    </Alert>
  )
}

/** `secretsReadable === false`: há segredo salvo que o servidor não decifra (o `JWT_SECRET` mudou). */
export function SecretsUnreadableAlert() {
  return (
    <Alert tone="danger" role="alert" icon={ShieldAlert} data-testid="secrets-unreadable-alert">
      <p>
        <span className="font-bold">Segredos salvos ilegíveis.</span> O servidor não consegue decifrar as credenciais do destino salvas (o <InlineCode>JWT_SECRET</InlineCode> foi trocado ou o dado está corrompido). O backup para esse destino falha até você
        digitar as credenciais de novo e salvar. Se o <InlineCode>JWT_SECRET</InlineCode> original existe em algum lugar, restaurá-lo resolve sem redigitar nada.
      </p>
    </Alert>
  )
}

/** Restaurar NÃO tem botão aqui, de propósito: um clique que apaga o banco é risco desproporcional. É operação de infraestrutura, por linha de comando. Discreto, no rodapé. */
export function RestoreNotice() {
  return (
    <p className="flex items-start gap-2 text-xs text-ink-softer" role="note" data-testid="restore-notice">
      <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span>
        <span className="font-semibold text-ink-soft">Restaurar não tem botão aqui, de propósito.</span> Um botão que apaga e recria o banco a um clique é um risco grande demais. Restaurar é uma operação de infraestrutura, feita por linha de comando por quem cuida
        do servidor: o passo a passo (restauração total, parcial e o ensaio trimestral) está no runbook <InlineCode>{RUNBOOK_PATH}</InlineCode>. Use “Conferir backup” para provar que a cópia abre.
      </span>
    </p>
  )
}
