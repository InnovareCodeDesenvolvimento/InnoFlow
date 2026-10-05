import axios from "axios"
import { getApiErrorCode, getApiErrorStatus } from "@/services/api"
import { NETWORK_ERROR_MESSAGE, RATE_LIMITED_ACCOUNT_MESSAGE } from "@/lib/authErrors"
import type { ApiErrorBody, ConnectorStatus, MeCommandStatus } from "@/types/api"

/**
 * Regras da recarga remota pela administração (L1.5, `ChargePointCommandsMenu` → "Iniciar recarga"). Puras e testáveis; o servidor é a autoridade (papel, escopo,
 * saldo, dívida, conector) — isto só evita viagem de rede à toa e põe a mensagem em português, SEMPRE por `code`/status, nunca pelo texto do backend.
 */

// ---- Motivo ---------------------------------------------------------------------------------------------------------------------------------------------

/** 10 a 200 caracteres DEPOIS do `trim`. ESPELHA `REMOTE_START_REASON_MIN/MAX` do backend (`command.schema.ts`); a API não expõe os valores — se mudarem lá, o servidor responde 400 `VALIDATION_ERROR` e a tela mostra o texto do campo. */
export const REMOTE_START_REASON_MIN = 10
export const REMOTE_START_REASON_MAX = 200
// eslint-disable-next-line no-control-regex -- é exatamente o objetivo: recusar caracteres de controle (quebra de linha/tab vão para o log de auditoria)
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/

export const REASON_REQUIRED_MESSAGE = `Informe o motivo da recarga (de ${REMOTE_START_REASON_MIN} a ${REMOTE_START_REASON_MAX} caracteres) — fica registrado na auditoria.`

export interface ReasonValidation {
  /** Motivo já com `trim` (é o que o servidor grava). */
  reason: string
  /** Mensagem do campo, ou `null` se válido. */
  error: string | null
}

export function validateReason(raw: string): ReasonValidation {
  const reason = raw.trim()
  if (reason.length === 0) return { reason, error: REASON_REQUIRED_MESSAGE }
  if (reason.length < REMOTE_START_REASON_MIN) return { reason, error: `O motivo precisa de pelo menos ${REMOTE_START_REASON_MIN} caracteres (faltam ${REMOTE_START_REASON_MIN - reason.length}).` }
  if (reason.length > REMOTE_START_REASON_MAX) return { reason, error: `O motivo passa de ${REMOTE_START_REASON_MAX} caracteres (sobram ${reason.length - REMOTE_START_REASON_MAX}).` }
  if (CONTROL_CHARS.test(reason)) return { reason, error: "O motivo não pode ter quebras de linha nem caracteres de controle — escreva em uma linha só." }
  return { reason, error: null }
}

// ---- Conector -------------------------------------------------------------------------------------------------------------------------------------------

/**
 * Conector que dá para iniciar agora: status `AVAILABLE`. É o que o servidor aceita (`iniciarSessaoRemota` responde 409 `CONNECTOR_BUSY` para qualquer outro, inclusive
 * `PREPARING`) — a parte "carregador online" é do servidor (`CHARGE_POINT_OFFLINE`): o DTO admin de pontos de recarga não traz `online`, e reescrever o limiar de 5 min
 * aqui seria duplicar a regra única de `core/estacoes/disponibilidade.ts`.
 */
export function isConnectorStartable(status: ConnectorStatus): boolean {
  return status === "AVAILABLE"
}

// ---- Confirmação ----------------------------------------------------------------------------------------------------------------------------------------

/** "Vai debitar a carteira de Fulano" — a frase da confirmação (é a carteira de uma PESSOA: precisa ser inequívoca). */
export function remoteStartSummary(driverName: string): string {
  return `Vai debitar a carteira de ${driverName}`
}

// ---- Erros do POST remote-start -------------------------------------------------------------------------------------------------------------------------

export interface RemoteStartError {
  message: string
  /** Quando o erro é do motivo, a tela volta ao formulário e o mostra no campo. */
  field?: "reason"
}

export const REMOTE_START_FALLBACK_MESSAGE = "Não foi possível iniciar a recarga. Nada foi cobrado — tente de novo."
export const REMOTE_START_UNSURE_MESSAGE = "Não deu para confirmar se o comando chegou ao carregador. Confira em Sessões se a recarga começou antes de tentar de novo."

/** Erro do axios → texto da tela. Ordem: sem resposta/5xx (resultado incerto) → 429 → `code`. */
export function remoteStartError(err: unknown): RemoteStartError {
  const status = getApiErrorStatus(err)
  const code = getApiErrorCode(err)
  if (axios.isAxiosError(err)) {
    if (status === undefined) return { message: `${NETWORK_ERROR_MESSAGE} ${REMOTE_START_UNSURE_MESSAGE}` }
    if (status >= 500) return { message: `O serviço está instável agora. ${REMOTE_START_UNSURE_MESSAGE}` }
  }
  if (status === 429) return { message: RATE_LIMITED_ACCOUNT_MESSAGE }
  switch (code) {
    case "VALIDATION_ERROR": {
      const paths = axios.isAxiosError<ApiErrorBody>(err) ? (err.response?.data?.details ?? []).map((d) => d.path) : []
      if (paths.includes("reason")) return { field: "reason", message: `O servidor recusou o motivo: use de ${REMOTE_START_REASON_MIN} a ${REMOTE_START_REASON_MAX} caracteres, em uma linha só.` }
      return { message: "O servidor recusou os dados enviados. Volte, confira o conector, o motorista e o motivo, e tente de novo." }
    }
    case "FORBIDDEN":
      return { message: "Só administradores da plataforma podem iniciar uma recarga remota." }
    case "CHARGE_POINT_NOT_FOUND":
      return { message: "Este carregador não foi encontrado (pode ter sido desativado). Atualize a lista de pontos de recarga." }
    case "CONNECTOR_NOT_FOUND":
      return { message: "Este conector não existe mais neste carregador. Atualize a lista e escolha outro." }
    case "USER_NOT_FOUND":
      return { message: "Motorista não encontrado. Volte e busque de novo." }
    case "DRIVER_HAS_OPEN_DEBT":
      return { message: "Este motorista tem uma dívida em aberto e não pode iniciar recargas. Ele precisa quitá-la na carteira antes." }
    case "INSUFFICIENT_BALANCE":
      return { message: "O saldo da carteira deste motorista é insuficiente para iniciar uma recarga. Ele precisa recarregar o saldo antes." }
    case "CONNECTOR_BUSY":
      return { message: "Este conector não está livre agora (já está em uso ou reservado). Escolha outro conector ou aguarde." }
    case "CHARGE_POINT_OFFLINE":
      return { message: "O carregador está offline — o comando não pode ser enviado. Confira a energia e a rede do equipamento." }
    default:
      return { message: REMOTE_START_FALLBACK_MESSAGE }
  }
}

// ---- Acompanhamento do resultado ------------------------------------------------------------------------------------------------------------------------

/** Consulta a cada 2 s por até 60 s (o servidor dá TIMEOUT sozinho em 35 s; os 60 s são folga). */
export const COMMAND_POLL_INTERVAL_MS = 2_000
export const COMMAND_POLL_TIMEOUT_MS = 60_000
/** Falhas de rede/5xx SEGUIDAS toleradas durante o acompanhamento antes de desistir (uma falha isolada não derruba o acompanhamento). */
export const COMMAND_POLL_MAX_FAILURES = 3

/**
 * Onde o acompanhamento está. `PENDING` do servidor vira `POLLING` aqui; os 3 desfechos do carregador vêm do contrato (`MeCommandStatus`); os demais são NOSSOS:
 * `UNAVAILABLE` (404: expirou/fora de escopo — "resultado indisponível"), `NO_ANSWER` (passou dos 60 s ainda pendente) e `ERROR` (conexão com o servidor falhou).
 */
export type CommandPhase = "POLLING" | Exclude<MeCommandStatus, "PENDING"> | "UNAVAILABLE" | "NO_ANSWER" | "ERROR"

const TERMINAL_PHASES: ReadonlySet<string> = new Set<CommandPhase>(["ACCEPTED", "REJECTED", "TIMEOUT", "UNAVAILABLE", "NO_ANSWER", "ERROR"])

/** `true` quando o acompanhamento terminou (qualquer desfecho). `IDLE`/`POLLING` = ainda não. */
export function isTerminalPhase(phase: CommandPhase | "IDLE"): boolean {
  return TERMINAL_PHASES.has(phase)
}

export interface CommandPhaseCopy {
  title: string
  detail: string
  tone: "info" | "success" | "warning" | "danger"
}

/** Texto de cada fase. REJECTED NÃO é "erro": o carregador respondeu, só disse não (cabo desconectado, equipamento ocupado…). */
export const COMMAND_PHASE_COPY: Record<CommandPhase, CommandPhaseCopy> = {
  POLLING: { title: "Aguardando o carregador…", detail: "O comando foi enviado. O carregador costuma responder em poucos segundos.", tone: "info" },
  ACCEPTED: { title: "O carregador aceitou.", detail: "A recarga está começando. A sessão aparece em Sessões assim que o carregador confirmar o início.", tone: "success" },
  REJECTED: { title: "O carregador recusou o início da recarga.", detail: "Nenhuma sessão foi iniciada e nada foi cobrado. Confira se o cabo está conectado ao veículo e se o conector está livre, e tente de novo.", tone: "warning" },
  TIMEOUT: { title: "Sem resposta do carregador.", detail: "O carregador não respondeu a tempo. A recarga pode ter começado mesmo assim: confira em Sessões antes de tentar de novo.", tone: "warning" },
  UNAVAILABLE: { title: "Resultado indisponível.", detail: "Não deu para ler o resultado deste comando (ele pode ter expirado). Confira em Sessões se a recarga começou.", tone: "warning" },
  NO_ANSWER: { title: "Ainda sem resposta.", detail: "Passou de 1 minuto sem resultado. Confira em Sessões se a recarga começou antes de tentar de novo.", tone: "warning" },
  ERROR: { title: "Perdemos a conexão com o servidor.", detail: "Não deu para acompanhar o resultado. Confira em Sessões se a recarga começou antes de tentar de novo.", tone: "danger" },
}
