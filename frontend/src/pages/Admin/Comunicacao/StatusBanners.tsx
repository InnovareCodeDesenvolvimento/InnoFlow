import { Database, Info, KeyRound, ShieldAlert, TriangleAlert } from "lucide-react"
import { Alert } from "@/components/ui/Alert"
import { InlineCode } from "@/components/ui/InlineCode"
import { formatDateTime } from "@/lib/utils"
import type { CommunicationSettingsDTO } from "@/types/api"

/**
 * Origem dos valores efetivos: `env` = nada salvo no painel (valem as variáveis `ALERT_*` do servidor; a primeira gravação cria a configuração do canal no banco);
 * `database` = configuração salva nesta tela, com data/hora. O painel manda e a variável de ambiente é a reserva.
 */
export function SourceBanner({ source, updatedAt }: Pick<CommunicationSettingsDTO, "source" | "updatedAt">) {
  if (source === "env") {
    return (
      <Alert tone="info" role="status" icon={Info} data-testid="source-banner-env">
        <p>
          <span className="font-bold">Usando as variáveis do servidor.</span> Nada foi salvo nesta tela ainda: valem as variáveis <InlineCode>ALERT_*</InlineCode> do ambiente. Daí em diante, o que for salvo aqui manda
          e a variável fica só de reserva.
        </p>
      </Alert>
    )
  }
  return (
    <Alert tone="neutral" role="status" icon={Database} iconClassName="text-primary" data-testid="source-banner-database">
      <p>
        <span className="font-bold text-ink">Configuração salva nesta tela.</span> Última alteração em {formatDateTime(updatedAt)}.
      </p>
    </Alert>
  )
}

/** `secretsKeyConfigured === false`: o servidor não tem como cifrar — senha SMTP e apikey não podem ser guardadas (503 `SECRETS_KEY_MISSING`). Perigo, não aviso. */
export function SecretsKeyMissingAlert() {
  return (
    <Alert tone="danger" role="alert" icon={KeyRound} data-testid="secrets-key-missing-alert">
      <p>
        <span className="font-bold">Servidor sem chave de cifragem.</span> A variável <InlineCode>PAYMENT_SECRETS_KEY</InlineCode> não está configurada, então não é possível guardar senha SMTP nem apikey.
        Você ainda pode salvar o que não envolve segredo. Peça para quem cuida do servidor criá-la no EasyPanel e reiniciar a API.
      </p>
    </Alert>
  )
}

/** `secretsDecryptable === false`: há segredo salvo que o servidor NÃO consegue decifrar (chave trocada/perdida) — o canal fica desligado até o segredo ser salvo de novo. */
export function UnreadableSecretsAlert() {
  return (
    <Alert tone="danger" role="alert" icon={ShieldAlert} data-testid="secrets-unreadable-alert">
      <p>
        <span className="font-bold">Segredos salvos ilegíveis.</span> O servidor não consegue decifrar a senha SMTP ou a apikey salvas (a chave de cifragem foi trocada ou o dado está corrompido). O canal afetado fica
        desligado até você digitar o segredo de novo e salvar.
      </p>
    </Alert>
  )
}

/** Problemas de configuração que o servidor detectou (PT-BR, sem segredo). */
export function WarningsAlert({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null
  return (
    <Alert tone="warning" role="status" icon={TriangleAlert} data-testid="warnings-alert">
      <p className="font-bold">{warnings.length === 1 ? "Atenção: 1 problema na configuração" : `Atenção: ${warnings.length} problemas na configuração`}</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5">
        {warnings.map((w, i) => (
          <li key={`${i}-${w}`}>{w}</li>
        ))}
      </ul>
    </Alert>
  )
}

/** Informativo: o deploy liberou destinos de rede privada (`COMMUNICATION_ALLOW_PRIVATE_HOSTS`). Não é editável pela tela. */
export function PrivateHostsNote() {
  return (
    <Alert tone="muted" size="sm" role="status" icon={Info} data-testid="private-hosts-note">
      <p>Este servidor aceita endereços de rede interna e http (liberado pelo deploy). Em produção normal isso é recusado: use sempre o endereço público do serviço.</p>
    </Alert>
  )
}
