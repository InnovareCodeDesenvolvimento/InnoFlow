import axios from "axios"
import type {
  BackupConfigDTO,
  BackupDestination,
  BackupErrorCode,
  BackupProblemToEnable,
  BackupRunDTO,
  BackupRunStatus,
  BackupStatusDTO,
  BackupTrigger,
  UpdateBackupConfigRequest,
} from "@/types/api"

/**
 * Regras PURAS da tela Admin > Backups. Nada aqui toca rede, DOM nem React: montagem do diff do PUT, validação dos campos, regra do step-up, formatação, decisões de
 * polling e tradução dos erros POR `code` (nunca pelo texto do servidor). Contrato: `docs/CONTRATO-BACKUP-ADMIN.md`.
 *
 * Princípios (iguais aos do gateway e da comunicação):
 *  - SEGREDOS são só de escrita. O GET devolve `accessKeySet`/`secretKeySet`/`clientSecretSet`; o rascunho só guarda um segredo quando a pessoa decide SUBSTITUÍ-LO, e nada daqui
 *    devolve o valor de um segredo em texto (resumo, mensagem de erro);
 *  - campo ausente no PUT = "não mexer": só vai o que mudou. Texto em branco num campo obrigatório = não enviar (a validação pede o valor quando o destino escolhido precisa dele);
 *  - trocar o ENDEREÇO (host) do bucket com credencial salva exige reenviar as DUAS credenciais (`SECRET_REQUIRED_FOR_NEW_DESTINATION`);
 *  - a chave do backup nunca passa por aqui: só pelo estado local da tela.
 */

// ---------------------------------------------------------------------------
// Constantes e rótulos
// ---------------------------------------------------------------------------

export const FREQUENCY_OPTIONS = [
  { value: 1, label: "Todo dia" },
  { value: 2, label: "Dia sim, dia não" },
  { value: 7, label: "Toda semana" },
] as const

export const HOUR_MIN = 0
export const HOUR_MAX = 23
export const RETENTION_MIN = 1
export const RETENTION_MAX = 365
export const ALERT_MIN = 6
export const ALERT_MAX = 720

/** Frase exata que o servidor exige para TROCAR uma chave que já existe. */
export const REPLACE_KEY_CONFIRMATION = "GERAR NOVA CHAVE"

/**
 * Texto do aviso permanente da tela (decisão do dono, 05/10): a chave que cifra os segredos salvos agora é DERIVADA do `JWT_SECRET` do servidor (como no InnoChat). A cópia do
 * `JWT_SECRET` fora do sistema é o que permite recuperar os segredos; trocá-lo obriga a cadastrar os segredos de novo.
 */
export const SECRETS_KEY_NOTICE =
  "Os segredos salvos (credenciais, senhas, tokens) são cifrados com uma chave derivada do JWT_SECRET do servidor. Guarde uma cópia dele fora do sistema: se ele for trocado, os segredos salvos precisam ser cadastrados de novo."

export const RUNBOOK_PATH = "docs/RUNBOOK-BACKUP-RESTAURACAO.md"

export const DESTINATION_LABELS: Record<BackupDestination, string> = { S3: "Bucket S3-compatível", DRIVE: "Google Drive" }
export const TRIGGER_LABELS: Record<BackupTrigger, string> = { SCHEDULED: "Automático", MANUAL: "Manual", VERIFY: "Conferência" }
export const RUN_STATUS_LABELS: Record<BackupRunStatus, string> = { QUEUED: "Na fila", RUNNING: "Em andamento", SUCCESS: "Concluído", FAILED: "Falhou" }

export const hourLabel = (hour: number) => `${String(hour).padStart(2, "0")}h00`
export const HOUR_OPTIONS = Array.from({ length: 24 }, (_, hour) => ({ value: String(hour), label: `${hourLabel(hour)} (Brasília)` }))

const MIN = 60_000
/** Intervalo do polling do estado geral enquanto há execução ativa, e da execução que a pessoa acabou de pedir. */
export const STATUS_POLL_MS = 3_000
export const RUN_POLL_MS = 2_500
/** Depois disto na fila, a tela avisa que o worker pode estar fora do ar (o servidor só desiste com ~15 min). */
export const QUEUED_HINT_AFTER_MS = 1 * MIN

// ---------------------------------------------------------------------------
// Formatação
// ---------------------------------------------------------------------------

/** Data e hora em Brasília (o horário configurado é de Brasília, UTC-3 fixo), independentemente do fuso do navegador. */
export function formatBrasilia(iso: string | null | undefined): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "—"
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" }).format(d)
}

/** "05/10/2026 às 14:30" em Brasília (a faixa de estado e a chave usam este; a tabela do histórico usa o curto de `formatBrasilia`). */
export function formatBrasiliaLong(iso: string | null | undefined): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "—"
  const parts = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "America/Sao_Paulo" }).formatToParts(d)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ""
  return `${get("day")}/${get("month")}/${get("year")} às ${get("hour")}:${get("minute")}`
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "—"
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  return `${value.toFixed(value >= 100 ? 0 : 1).replace(".", ",")} ${units[i]}`
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "—"
  if (ms < 1000) return `${Math.round(ms)} ms`
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds} s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`
}

/** "3 h", "1 dia e 4 h", "12 dias": o tempo desde o último sucesso, para o destaque "Sem backup há …". */
export function formatAge(hours: number | null | undefined): string {
  if (hours === null || hours === undefined || !Number.isFinite(hours) || hours < 0) return "—"
  const total = Math.floor(hours)
  if (total < 1) return "menos de 1 hora"
  if (total < 24) return `${total} h`
  const days = Math.floor(total / 24)
  const rest = total % 24
  const dayText = `${days} ${days === 1 ? "dia" : "dias"}`
  return rest === 0 || days >= 10 ? dayText : `${dayText} e ${rest} h`
}

/** "30 segundos", "2 minutos": o `Retry-After` do 429, em palavras. */
export function formatWait(seconds: number | undefined): string | null {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return null
  if (seconds < 90) return `${Math.ceil(seconds)} ${Math.ceil(seconds) === 1 ? "segundo" : "segundos"}`
  const minutes = Math.ceil(seconds / 60)
  return `${minutes} minutos`
}

// ---------------------------------------------------------------------------
// Estado geral e polling
// ---------------------------------------------------------------------------

export function isRunFinished(run: Pick<BackupRunDTO, "status"> | null | undefined): boolean {
  return run?.status === "SUCCESS" || run?.status === "FAILED"
}

/** Há algo em andamento (execução ativa ou trava viva)? Decide o polling e desabilita os botões de ação. */
export function isBusy(status: BackupStatusDTO | undefined): boolean {
  return Boolean(status && (status.running || status.activeRun !== null))
}

/** Intervalo do `refetchInterval` do estado geral: só enquanto algo roda (`false` = sem polling). */
export function statusRefetchInterval(status: BackupStatusDTO | undefined): number | false {
  return isBusy(status) ? STATUS_POLL_MS : false
}

/** Intervalo do `refetchInterval` de UMA execução: para no estado final. Sem dado ainda (1ª consulta) mantém o ritmo. */
export function runRefetchInterval(run: BackupRunDTO | undefined, failedTimes: number): number | false {
  if (isRunFinished(run)) return false
  // Consulta que já falhou 3 vezes: a tela para de insistir e avisa (o histórico/estado geral continuam valendo).
  if (failedTimes >= 3) return false
  return RUN_POLL_MS
}

export function queuedTooLong(run: Pick<BackupRunDTO, "status" | "createdAt"> | null | undefined, nowMs: number): boolean {
  if (!run || run.status !== "QUEUED") return false
  const created = new Date(run.createdAt).getTime()
  return Number.isFinite(created) && nowMs - created >= QUEUED_HINT_AFTER_MS
}

/** Por que um botão de ação está desabilitado (sempre ESCRITO na tela, não só uma opacidade). `null` = pode usar. As ações usam a configuração SALVA. */
export function actionBlockReason(kind: "run" | "verify" | "test", ctx: { dto: Pick<BackupConfigDTO, "destination" | "destinationReady">; dirty: boolean; busy: boolean }): string | null {
  if (ctx.busy) return "Já há um backup ou uma conferência em andamento. Espere terminar."
  if (ctx.dirty) return "Há alterações não salvas: salve ou descarte antes. Estas ações usam a configuração salva."
  if (kind === "run") return ctx.dto.destination && !ctx.dto.destinationReady ? "O destino escolhido está incompleto: complete e salve antes." : null
  if (!ctx.dto.destination) return "Escolha um destino e salve antes."
  if (!ctx.dto.destinationReady) return "O destino escolhido está incompleto: complete e salve antes."
  return null
}

/** Por que "Conectar com Google" está desabilitado (escrito na tela). `null` = pode conectar. O Google usa o Client ID/Secret SALVOS: por isso a alteração pendente bloqueia. */
export function connectBlockReason(dto: Pick<BackupConfigDTO, "drive">, dirty: boolean): string | null {
  if (dirty) return "Há alterações não salvas: salve antes de conectar. O Google usa o Client ID e o Client Secret salvos."
  if (!dto.drive.clientId) return "Salve o Client ID do app do Google antes de conectar."
  if (!dto.drive.clientSecretSet) return "Salve o Client Secret do app do Google antes de conectar."
  if (!dto.drive.redirectUri) return "O servidor não sabe o próprio endereço público (PUBLIC_API_BASE_URL): quem cuida da infraestrutura precisa configurá-lo."
  return null
}

export type HealthTone = "ok" | "late" | "never" | "off"

/** O que o destaque do topo diz. `late` e `never` são o alerta vermelho ("Sem backup há X"). */
export function healthOf(status: BackupStatusDTO, enabled: boolean): { tone: HealthTone; title: string; detail: string } {
  if (status.neverRan) {
    return { tone: "never", title: "Ligado, mas nunca saiu uma cópia", detail: "O backup automático está ligado e ainda não gerou nenhuma cópia. Use “Fazer backup agora” para provar o caminho inteiro." }
  }
  if (status.stale) {
    return {
      tone: "late",
      title: `Sem backup há ${formatAge(status.ageHours)}`,
      detail: "A última cópia é mais antiga que o limite de alerta. Veja o motivo no histórico e corrija; se for preciso, faça um backup agora.",
    }
  }
  if (!enabled) {
    return {
      tone: "off",
      title: "Backup automático desligado",
      detail: status.lastSuccessAt ? `A última cópia foi em ${formatBrasilia(status.lastSuccessAt)}. Desligado, só o botão “Fazer backup agora” copia o banco.` : "Desligado, só o botão “Fazer backup agora” copia o banco.",
    }
  }
  return { tone: "ok", title: "Backups em dia", detail: status.lastSuccessAt ? `Última cópia com sucesso em ${formatBrasilia(status.lastSuccessAt)}.` : "Automático ligado." }
}

export type SituationTone = "success" | "danger" | "neutral" | "primary"

/**
 * O selo "Situação" da faixa de estado (como no InnoChat): verde "Em dia", vermelho "Atrasado" / "Nunca rodou", cinza "Desligado", azul "Copiando agora". `detail` é a linha de apoio
 * (só quando acrescenta algo que o selo não diz). Decidido pelo MESMO `healthOf`, então o selo e o resto da tela nunca discordam.
 */
export function situationOf(status: BackupStatusDTO, enabled: boolean): { tone: SituationTone; label: string; detail: string | null; health: HealthTone } {
  const health = healthOf(status, enabled)
  if (status.running) return { tone: "primary", label: "Copiando agora", detail: null, health: health.tone }
  if (health.tone === "never") return { tone: "danger", label: "Nunca rodou", detail: health.title, health: health.tone }
  if (health.tone === "late") return { tone: "danger", label: "Atrasado", detail: health.title, health: health.tone }
  if (health.tone === "off") return { tone: "neutral", label: "Desligado", detail: "Só o botão “Fazer backup agora” copia o banco.", health: health.tone }
  return { tone: "success", label: "Em dia", detail: null, health: health.tone }
}

// ---------------------------------------------------------------------------
// Textos por CÓDIGO (execução de backup, teste de destino)
// ---------------------------------------------------------------------------

export const RUN_ERROR_TEXT: Record<BackupErrorCode, { title: string; action: string }> = {
  CONFIG: { title: "Configuração incompleta ou recusada", action: "Confira o destino (endereço, bucket e credenciais) e salve de novo. Depois use “Testar destino”." },
  CREDENTIAL: { title: "O destino recusou a credencial", action: "A chave de acesso ou o segredo estão errados, expiraram ou perderam a permissão. Gere uma credencial nova no provedor e salve aqui." },
  FOLDER: { title: "Bucket ou pasta inacessível", action: "O bucket não existe ou a credencial não tem acesso a ele. Confira o nome do bucket e as permissões." },
  QUOTA: { title: "Sem espaço no destino", action: "Libere espaço no bucket ou no Drive, ou reduza quantas cópias manter." },
  NETWORK: { title: "Falha de rede com o destino", action: "O destino não respondeu. Costuma ser instabilidade passageira: tente de novo daqui a pouco." },
  OAUTH_DISCONNECTED: { title: "Conta Google desconectada", action: "O acesso foi revogado ou expirou. Conecte a conta Google de novo. Com o app do Google Cloud em modo “Teste”, o acesso expira em 7 dias." },
  DUMP: { title: "Falha ao copiar o banco", action: "O pg_dump não rodou (cliente ausente na imagem, versão antiga…). É um problema do servidor: avise quem cuida da infraestrutura." },
  DUMP_TIMEOUT: { title: "A cópia do banco passou do prazo", action: "O banco demorou mais que o limite para ser copiado. Avise quem cuida da infraestrutura." },
  KEY: { title: "Problema com a chave do backup", action: "A chave está ausente, ilegível ou é diferente da que cifrou o arquivo. Confira a impressão digital da chave." },
  SECRETS_KEY: { title: "A chave dos segredos (JWT_SECRET) ausente ou trocada", action: "Sem o JWT_SECRET original o servidor não decifra as credenciais do destino. Restaure o JWT_SECRET original ou salve as credenciais de novo." },
  TOO_BIG: { title: "Arquivo maior que 5 GiB", action: "O envio simples do S3 não aceita arquivo desse tamanho. Avise quem cuida da infraestrutura." },
  NO_BACKUP: { title: "Nenhuma cópia no destino", action: "Não há arquivo para conferir. Faça um backup primeiro." },
  VERIFY: { title: "A conferência reprovou a cópia", action: "O arquivo está vazio, adulterado, sem a marca do sistema ou sem tabelas. Faça um backup novo e confira de novo." },
  CHECKSUM: { title: "O arquivo no destino não bate com o enviado", action: "O SHA-256 do arquivo no destino é diferente do gravado no envio. Faça um backup novo e confira de novo." },
  BUSY: { title: "Já havia um backup em andamento", action: "Espere o outro terminar e tente de novo." },
  INTERRUPTED: { title: "O processo foi interrompido no meio", action: "O servidor reiniciou durante a cópia. Faça um backup novo." },
  NOT_PICKED_UP: { title: "Ninguém pegou o pedido", action: "O worker não pegou o pedido em 15 minutos: ele pode estar fora do ar. Avise quem cuida da infraestrutura." },
  UNKNOWN: { title: "Erro desconhecido", action: "Tente de novo. Se repetir, avise quem cuida da infraestrutura." },
}

export function runErrorText(code: string | null | undefined): { title: string; action: string } {
  return (code && (RUN_ERROR_TEXT as Record<string, { title: string; action: string }>)[code]) || RUN_ERROR_TEXT.UNKNOWN
}

/** Rótulo curto do estado de uma linha do histórico (sucesso sem destino = só teste do pg_dump). */
export function runStateLabel(run: Pick<BackupRunDTO, "status" | "trigger" | "objectKey">): { label: string; tone: "success" | "danger" | "primary" | "neutral" | "warning" } {
  if (run.status === "QUEUED") return { label: "Na fila", tone: "neutral" }
  if (run.status === "RUNNING") return { label: "Em andamento", tone: "primary" }
  if (run.status === "FAILED") return { label: run.trigger === "VERIFY" ? "Reprovou" : "Falhou", tone: "danger" }
  if (run.trigger === "VERIFY") return { label: "Conferida", tone: "success" }
  return run.objectKey ? { label: "Enviado", tone: "success" } : { label: "Só teste", tone: "warning" }
}

export const PROBLEM_TEXT: Record<BackupProblemToEnable, string> = {
  DESTINATION_INCOMPLETE: "Complete e salve o destino (S3: endereço, bucket, chave de acesso e segredo; Drive: conecte a conta Google).",
  KEY_MISSING: "Gere a chave de criptografia do backup.",
  SECRETS_KEY_MISSING: "O servidor não tem a chave dos segredos, derivada do JWT_SECRET (quem cuida da infraestrutura precisa conferir o JWT_SECRET).",
  SECRETS_UNREADABLE: "Os segredos salvos não podem ser lidos (o JWT_SECRET mudou): salve as credenciais de novo.",
}

// ---------------------------------------------------------------------------
// Retorno do Google (`?google=ok` / `?google=erro&motivo=<código>`)
// ---------------------------------------------------------------------------

export const GOOGLE_REASON_TEXT: Record<string, string> = {
  invalid_state: "O link de conexão expirou ou já foi usado. Clique em “Conectar com Google” para tentar de novo.",
  access_denied: "Você não autorizou o acesso no Google. Clique em “Conectar com Google” e aceite para continuar.",
  refused_by_google: "O Google recusou a autorização. Confira se o app está publicado (“Em produção”) e se a sua conta pode usá-lo.",
  no_code: "O Google não devolveu o código de autorização. Tente de novo.",
  bad_credentials: "O Google recusou o Client ID ou o Client Secret (errados, revogados ou sem o endereço de retorno cadastrado no app). Confira os três.",
  no_refresh_token: "O Google não entregou o acesso de longa duração. Remova o app em myaccount.google.com/permissions e conecte de novo.",
  account_check_failed: "O Google autorizou, mas não deu para confirmar qual é a conta. Tente de novo.",
  folder_create_failed: "A conta conectou, mas não deu para criar a pasta de backups no Drive. Tente de novo.",
  secrets_key_missing: "O servidor não tem a chave dos segredos (derivada do JWT_SECRET), então não pode guardar o acesso ao Google. Avise quem cuida da infraestrutura.",
  network: "Não deu para falar com o Google agora. Tente de novo daqui a pouco.",
  unknown: "O Google não concluiu a conexão. Tente de novo.",
}

export type GoogleReturn = { ok: true } | { ok: false; reason: string }

/** Lê `?google=` da URL. Código desconhecido vira `unknown` (nunca ecoa o texto da URL). Sem o parâmetro, `null`. */
export function parseGoogleReturn(search: string): GoogleReturn | null {
  const params = new URLSearchParams(search)
  const value = params.get("google")
  if (value === "ok") return { ok: true }
  if (value === "erro") {
    const reason = params.get("motivo") ?? ""
    return { ok: false, reason: Object.prototype.hasOwnProperty.call(GOOGLE_REASON_TEXT, reason) ? reason : "unknown" }
  }
  return null
}

/** A query sem `google`/`motivo` (o resto, se houver, fica). */
export function withoutGoogleParams(search: string): string {
  const params = new URLSearchParams(search)
  params.delete("google")
  params.delete("motivo")
  const rest = params.toString()
  return rest ? `?${rest}` : ""
}

/** Só navega para o Google de verdade: https e o host do consentimento OAuth. Qualquer outra coisa (inclusive `javascript:`) é recusada. */
export function isSafeGoogleUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === "https:" && parsed.hostname === "accounts.google.com"
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Rascunho (sobreposições sobre o DTO)
// ---------------------------------------------------------------------------

/** `undefined` = a pessoa não mexeu. Segredo `undefined` = intocado; string (mesmo "") = abriu o campo para substituir. */
export interface BackupDraft {
  enabled?: boolean
  hourLocal?: string
  frequencyDays?: 1 | 2 | 7
  retentionCount?: string
  alertAfterHours?: string
  destination?: BackupDestination | null
  s3: { endpoint?: string; region?: string; bucket?: string; prefix?: string; accessKey?: string; secretKey?: string }
  drive: { clientId?: string; clientSecret?: string }
  clear: { s3AccessKey?: boolean; s3SecretKey?: boolean; driveClientSecret?: boolean }
}

export const EMPTY_DRAFT: BackupDraft = { s3: {}, drive: {}, clear: {} }

/**
 * A tela salva POR CARTÃO (como o InnoChat): "Agendamento" e "Destino" têm cada um o seu "Salvar", mas o rascunho é um só. Um escopo é o pedaço do rascunho que o cartão enxerga:
 * `schedule` = ligado/horário/frequência/cópias a manter/alerta; `destination` = destino, bucket S3, Google Drive e apagar segredos. Salvar um cartão envia SÓ o diff do seu escopo.
 */
export type BackupScope = "schedule" | "destination"

/** O rascunho SEM o escopo dado (volta ao salvo naquele pedaço). Depois de salvar um cartão só o escopo dele é descartado; o outro cartão segue editando. */
export function clearDraftScope(draft: BackupDraft, scope: BackupScope): BackupDraft {
  if (scope === "schedule") return { ...draft, enabled: undefined, hourLocal: undefined, frequencyDays: undefined, retentionCount: undefined, alertAfterHours: undefined }
  return { ...draft, destination: undefined, s3: {}, drive: {}, clear: {} }
}

/** O rascunho SÓ com o escopo dado: o que o cartão valida, resume e envia. Ligar o automático, por exemplo, só vale com o destino JÁ SALVO (o servidor valida o estado futuro). */
export function scopeDraft(draft: BackupDraft, scope: BackupScope): BackupDraft {
  return clearDraftScope(draft, scope === "schedule" ? "destination" : "schedule")
}

/** O PUT sem a senha atual (que só entra na hora de enviar, `withCurrentPassword`). */
export type BackupChanges = Omit<UpdateBackupConfigRequest, "currentPassword">

export function withCurrentPassword(changes: BackupChanges, currentPassword: string): UpdateBackupConfigRequest {
  return { ...changes, currentPassword }
}

const trimmed = (value: string | undefined) => (value ?? "").trim()
/** Número inteiro de um campo de texto (`null` se não for um inteiro). */
export function parseIntField(text: string | undefined): number | null {
  const t = (text ?? "").trim()
  return /^-?\d+$/.test(t) ? Number(t) : null
}

/** Host (minúsculo, com porta) de um endereço, ou `null` se não for uma URL. */
export function hostOf(endpoint: string | null | undefined): string | null {
  const t = (endpoint ?? "").trim()
  if (!t) return null
  try {
    return new URL(t).host.toLowerCase()
  } catch {
    return null
  }
}

/** Valores efetivos de cada campo: o rascunho por cima do que o servidor tem. */
export function effectiveOf(dto: BackupConfigDTO, draft: BackupDraft) {
  return {
    enabled: draft.enabled ?? dto.enabled,
    hourLocal: draft.hourLocal ?? String(dto.hourLocal),
    frequencyDays: draft.frequencyDays ?? dto.frequencyDays,
    retentionCount: draft.retentionCount ?? String(dto.retentionCount),
    alertAfterHours: draft.alertAfterHours ?? String(dto.alertAfterHours),
    destination: draft.destination !== undefined ? draft.destination : dto.destination,
    s3: {
      endpoint: draft.s3.endpoint ?? dto.s3.endpoint ?? "",
      region: draft.s3.region ?? dto.s3.region ?? "",
      bucket: draft.s3.bucket ?? dto.s3.bucket ?? "",
      prefix: draft.s3.prefix ?? dto.s3.prefix ?? "",
    },
    drive: { clientId: draft.drive.clientId ?? dto.drive.clientId ?? "" },
  }
}

/** A pessoa digitou um valor novo para o segredo (campo aberto e não vazio)? */
const typed = (value: string | undefined) => value !== undefined && value.length > 0

/** O endereço (host) do bucket mudou em relação ao salvo, com credencial salva? Então as duas credenciais precisam ser digitadas de novo. */
export function s3HostChanged(dto: BackupConfigDTO, draft: BackupDraft): boolean {
  if (draft.s3.endpoint === undefined) return false
  const saved = hostOf(dto.s3.endpoint)
  if (saved === null) return false
  if (!dto.s3.accessKeySet && !dto.s3.secretKeySet) return false
  const next = hostOf(draft.s3.endpoint)
  return next !== null && next !== saved
}

/** Trocar o Client ID desconecta a conta Google (o escopo `drive.file` é por app). */
export function driveClientIdChanged(dto: BackupConfigDTO, draft: BackupDraft): boolean {
  if (draft.drive.clientId === undefined) return false
  return trimmed(draft.drive.clientId) !== (dto.drive.clientId ?? "")
}

/** Com o rascunho aplicado, o destino escolhido ficaria completo? (espelha `destinationReady` do servidor.) */
export function destinationReadyAfter(dto: BackupConfigDTO, draft: BackupDraft): boolean {
  const eff = effectiveOf(dto, draft)
  if (eff.destination === "S3") {
    const accessKey = typed(draft.s3.accessKey) || (dto.s3.accessKeySet && !draft.clear.s3AccessKey)
    const secretKey = typed(draft.s3.secretKey) || (dto.s3.secretKeySet && !draft.clear.s3SecretKey)
    return trimmed(eff.s3.endpoint) !== "" && trimmed(eff.s3.bucket) !== "" && accessKey && secretKey
  }
  if (eff.destination === "DRIVE") return dto.drive.connected && !driveClientIdChanged(dto, draft)
  return false
}

// ---------------------------------------------------------------------------
// Diff do PUT
// ---------------------------------------------------------------------------

export function buildUpdatePayload(dto: BackupConfigDTO, draft: BackupDraft): BackupChanges {
  const out: BackupChanges = {}

  if (draft.enabled !== undefined && draft.enabled !== dto.enabled) out.enabled = draft.enabled

  const hour = draft.hourLocal === undefined ? null : parseIntField(draft.hourLocal)
  if (hour !== null && hour !== dto.hourLocal) out.hourLocal = hour
  if (draft.frequencyDays !== undefined && draft.frequencyDays !== dto.frequencyDays) out.frequencyDays = draft.frequencyDays
  const retention = draft.retentionCount === undefined ? null : parseIntField(draft.retentionCount)
  if (retention !== null && retention !== dto.retentionCount) out.retentionCount = retention
  const alert = draft.alertAfterHours === undefined ? null : parseIntField(draft.alertAfterHours)
  if (alert !== null && alert !== dto.alertAfterHours) out.alertAfterHours = alert

  if (draft.destination !== undefined && draft.destination !== dto.destination) out.destination = draft.destination

  const s3: NonNullable<BackupChanges["s3"]> = {}
  const endpoint = trimmed(draft.s3.endpoint)
  if (draft.s3.endpoint !== undefined && endpoint !== "" && endpoint !== (dto.s3.endpoint ?? "")) s3.endpoint = endpoint
  const bucket = trimmed(draft.s3.bucket)
  if (draft.s3.bucket !== undefined && bucket !== "" && bucket !== (dto.s3.bucket ?? "")) s3.bucket = bucket
  // Região e pasta aceitam `null` (limpar): em branco com valor salvo = limpar; em branco sem valor salvo = nada a mandar.
  if (draft.s3.region !== undefined) {
    const region = trimmed(draft.s3.region)
    if (region !== (dto.s3.region ?? "")) s3.region = region === "" ? null : region
  }
  if (draft.s3.prefix !== undefined) {
    const prefix = trimmed(draft.s3.prefix)
    if (prefix !== (dto.s3.prefix ?? "")) s3.prefix = prefix === "" ? null : prefix
  }
  if (typed(draft.s3.accessKey)) s3.accessKey = draft.s3.accessKey
  if (typed(draft.s3.secretKey)) s3.secretKey = draft.s3.secretKey
  if (Object.keys(s3).length > 0) out.s3 = s3

  const drive: NonNullable<BackupChanges["drive"]> = {}
  if (draft.drive.clientId !== undefined) {
    const clientId = trimmed(draft.drive.clientId)
    if (clientId !== (dto.drive.clientId ?? "")) drive.clientId = clientId === "" ? null : clientId
  }
  if (typed(draft.drive.clientSecret)) drive.clientSecret = draft.drive.clientSecret
  if (Object.keys(drive).length > 0) out.drive = drive

  // Apagar um segredo só faz sentido se ele existe e a pessoa não digitou um novo no lugar.
  const clearSecrets: NonNullable<BackupChanges["clearSecrets"]> = []
  if (draft.clear.s3AccessKey && dto.s3.accessKeySet && !typed(draft.s3.accessKey)) clearSecrets.push("s3AccessKey")
  if (draft.clear.s3SecretKey && dto.s3.secretKeySet && !typed(draft.s3.secretKey)) clearSecrets.push("s3SecretKey")
  if (draft.clear.driveClientSecret && dto.drive.clientSecretSet && !typed(draft.drive.clientSecret)) clearSecrets.push("driveClientSecret")
  if (clearSecrets.length > 0) out.clearSecrets = clearSecrets

  return out
}

export function hasChanges(payload: BackupChanges): boolean {
  return Object.keys(payload).length > 0
}

/** O rascunho tem algo digitado/marcado, mesmo que ainda não vire alteração (ex.: abriu o campo do segredo e não digitou)? Habilita "Descartar". */
export function draftTouched(draft: BackupDraft): boolean {
  return (
    draft.enabled !== undefined ||
    draft.hourLocal !== undefined ||
    draft.frequencyDays !== undefined ||
    draft.retentionCount !== undefined ||
    draft.alertAfterHours !== undefined ||
    draft.destination !== undefined ||
    Object.values(draft.s3).some((v) => v !== undefined) ||
    Object.values(draft.drive).some((v) => v !== undefined) ||
    Object.values(draft.clear).some(Boolean)
  )
}

/**
 * Este PUT exige a senha atual do ADMIN (step-up)? ESPELHA `exigeSenhaDoAdmin` do servidor: só dispensa horário, frequência, limite de alerta e DESLIGAR o automático;
 * destino, credenciais, quantas cópias manter (reduzir apaga cópias) e LIGAR exigem. Decidido pelos CAMPOS ENVIADOS, não pelo valor.
 */
export function exigeSenha(payload: BackupChanges): boolean {
  const harmless = new Set(["hourLocal", "frequencyDays", "alertAfterHours"])
  for (const key of Object.keys(payload)) {
    if (harmless.has(key)) continue
    if (key === "enabled" && payload.enabled === false) continue
    return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Validação
// ---------------------------------------------------------------------------

export type DraftErrors = Partial<Record<string, string>>

export const SECRET_AGAIN_MESSAGE = "Você mudou o endereço do bucket: digite a chave de acesso E o segredo de novo (elas só valem para o destino em que foram salvas)."
export const NO_SECRETS_KEY_MESSAGE = "O servidor não tem a chave dos segredos (derivada do JWT_SECRET): não dá para guardar este segredo."
const REGION_RE = /^[A-Za-z0-9-]{1,40}$/
const BUCKET_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$/
const PREFIX_RE = /^[A-Za-z0-9._\-/ ]*$/
const hasControl = (v: string) => [...v].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)

/** Endereço do bucket: URL http(s) sem usuário/senha e sem `?`/`#` (o https obrigatório em produção quem confere é o servidor: `HTTPS_REQUIRED`). */
export function validateEndpoint(value: string): string | null {
  const t = value.trim()
  if (!t) return "Informe o endereço do bucket (ex.: https://SEU-ID.r2.cloudflarestorage.com)."
  let url: URL
  try {
    url = new URL(t)
  } catch {
    return "Endereço inválido. Use algo como https://SEU-ID.r2.cloudflarestorage.com."
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "O endereço precisa começar com https://."
  if (url.username || url.password) return "O endereço não pode conter usuário e senha. Eles vão nos campos de credencial."
  if (url.search || url.hash) return "O endereço não pode ter “?” nem “#”. Informe só o endereço do serviço."
  return null
}

function validateSecret(value: string | undefined, max: number): string | null {
  if (!typed(value)) return null
  if (value!.length > max) return `Até ${max} caracteres.`
  if (hasControl(value!)) return "Não pode conter quebra de linha nem caracteres de controle. Cole só o valor, sem espaços ou linhas extras."
  return null
}

export function validateDraft(dto: BackupConfigDTO, draft: BackupDraft): DraftErrors {
  const errors: DraftErrors = {}
  const eff = effectiveOf(dto, draft)

  if (draft.hourLocal !== undefined) {
    const hour = parseIntField(draft.hourLocal)
    if (hour === null || hour < HOUR_MIN || hour > HOUR_MAX) errors.hourLocal = `Escolha uma hora de ${HOUR_MIN} a ${HOUR_MAX}.`
  }
  if (draft.retentionCount !== undefined) {
    const n = parseIntField(draft.retentionCount)
    if (n === null || n < RETENTION_MIN || n > RETENTION_MAX) errors.retentionCount = `Informe um número inteiro de ${RETENTION_MIN} a ${RETENTION_MAX}.`
  }
  if (draft.alertAfterHours !== undefined) {
    const n = parseIntField(draft.alertAfterHours)
    if (n === null || n < ALERT_MIN || n > ALERT_MAX) errors.alertAfterHours = `Informe um número inteiro de ${ALERT_MIN} a ${ALERT_MAX} horas.`
  }

  // Endereço e bucket só são OBRIGATÓRIOS com o S3 escolhido (sem destino, um endereço digitado só é conferido se não estiver em branco).
  const s3Chosen = eff.destination === "S3"
  if (s3Chosen || trimmed(draft.s3.endpoint) !== "") {
    const endpointError = validateEndpoint(eff.s3.endpoint)
    if (endpointError) errors["s3.endpoint"] = endpointError
  }
  if (trimmed(eff.s3.region) !== "" && !REGION_RE.test(trimmed(eff.s3.region))) errors["s3.region"] = "Região inválida (ex.: us-east-1, auto)."
  if (s3Chosen && trimmed(eff.s3.bucket) === "") errors["s3.bucket"] = "Informe o nome do bucket."
  else if (trimmed(eff.s3.bucket) !== "" && !BUCKET_RE.test(trimmed(eff.s3.bucket))) errors["s3.bucket"] = "Nome de bucket inválido (letras, números, ponto, hífen e sublinhado; 2 a 63 caracteres)."
  if (eff.s3.prefix.length > 200 || !PREFIX_RE.test(eff.s3.prefix)) errors["s3.prefix"] = "A pasta só aceita letras, números, ponto, hífen, sublinhado, espaço e barra (até 200 caracteres)."

  const accessKeyError = validateSecret(draft.s3.accessKey, 256)
  if (accessKeyError) errors["s3.accessKey"] = accessKeyError
  const secretKeyError = validateSecret(draft.s3.secretKey, 512)
  if (secretKeyError) errors["s3.secretKey"] = secretKeyError
  const clientSecretError = validateSecret(draft.drive.clientSecret, 512)
  if (clientSecretError) errors["drive.clientSecret"] = clientSecretError
  if (draft.drive.clientId !== undefined && trimmed(draft.drive.clientId).length > 300) errors["drive.clientId"] = "Até 300 caracteres."

  // Trocar o endereço do bucket com credencial salva exige as DUAS credenciais de novo (o servidor recusa: SECRET_REQUIRED_FOR_NEW_DESTINATION).
  if (s3HostChanged(dto, draft)) {
    if (!typed(draft.s3.accessKey) && !errors["s3.accessKey"]) errors["s3.accessKey"] = SECRET_AGAIN_MESSAGE
    if (!typed(draft.s3.secretKey) && !errors["s3.secretKey"]) errors["s3.secretKey"] = SECRET_AGAIN_MESSAGE
  }

  // Sem a chave dos segredos no servidor (derivada do JWT_SECRET), não dá para guardar nenhum segredo (503 `SECRETS_KEY_MISSING`).
  if (!dto.secretsKeyConfigured) {
    if (typed(draft.s3.accessKey) && !errors["s3.accessKey"]) errors["s3.accessKey"] = NO_SECRETS_KEY_MESSAGE
    if (typed(draft.s3.secretKey) && !errors["s3.secretKey"]) errors["s3.secretKey"] = NO_SECRETS_KEY_MESSAGE
    if (typed(draft.drive.clientSecret) && !errors["drive.clientSecret"]) errors["drive.clientSecret"] = NO_SECRETS_KEY_MESSAGE
  }

  // O servidor valida o estado FUTURO: com o automático ligado (ou sendo ligado agora) o destino precisa estar completo e a chave gerada (409). O aviso vem ANTES do pedido,
  // sem perder o rascunho.
  if (eff.enabled && hasChanges(buildUpdatePayload(dto, draft))) {
    if (draft.enabled === true && !dto.enabled) {
      const missing = enableBlockers(dto, draft)
      if (missing.length > 0) errors.enabled = missing[0]
    } else if (dto.enabled && !destinationReadyAfter(dto, draft)) {
      errors.destination = "Com o backup automático ligado o destino precisa continuar completo. Complete os dados do destino ou desligue o automático."
    }
  }

  return errors
}

/** O que impede LIGAR o automático agora (vazio = pode). A chave e os segredos do servidor vêm do DTO; o destino considera o rascunho. */
export function enableBlockers(dto: BackupConfigDTO, draft: BackupDraft): string[] {
  const out: string[] = []
  if (dto.problemsToEnable.includes("SECRETS_KEY_MISSING") || !dto.secretsKeyConfigured) out.push(PROBLEM_TEXT.SECRETS_KEY_MISSING)
  else if (dto.problemsToEnable.includes("SECRETS_UNREADABLE") || !dto.secretsReadable) out.push(PROBLEM_TEXT.SECRETS_UNREADABLE)
  if (!dto.encryptionKey.exists || dto.problemsToEnable.includes("KEY_MISSING")) out.push(PROBLEM_TEXT.KEY_MISSING)
  if (!destinationReadyAfter(dto, draft)) out.push(PROBLEM_TEXT.DESTINATION_INCOMPLETE)
  return out
}

// ---------------------------------------------------------------------------
// Resumo do que muda (diálogo de confirmação)
// ---------------------------------------------------------------------------

export interface ChangeSummaryItem {
  key: string
  label: string
  from?: string
  /** Para segredos é um texto fixo ("Será substituída"), NUNCA o valor digitado. */
  to: string
  secret?: boolean
}

const yesNo = (v: boolean) => (v ? "Ligado" : "Desligado")
const frequencyText = (days: number) => FREQUENCY_OPTIONS.find((o) => o.value === days)?.label ?? `${days} dias`
const destinationText = (d: BackupDestination | null) => (d ? DESTINATION_LABELS[d] : "Nenhum")
const orDash = (v: string | null | undefined) => (v ? v : "—")

export function describeChanges(dto: BackupConfigDTO, payload: BackupChanges): ChangeSummaryItem[] {
  const items: ChangeSummaryItem[] = []
  if (payload.enabled !== undefined) items.push({ key: "enabled", label: "Backup automático", from: yesNo(dto.enabled), to: yesNo(payload.enabled) })
  if (payload.frequencyDays !== undefined) items.push({ key: "frequencyDays", label: "Frequência", from: frequencyText(dto.frequencyDays), to: frequencyText(payload.frequencyDays) })
  if (payload.hourLocal !== undefined) items.push({ key: "hourLocal", label: "Horário (Brasília)", from: hourLabel(dto.hourLocal), to: hourLabel(payload.hourLocal) })
  if (payload.retentionCount !== undefined) items.push({ key: "retentionCount", label: "Cópias a manter", from: String(dto.retentionCount), to: String(payload.retentionCount) })
  if (payload.alertAfterHours !== undefined) items.push({ key: "alertAfterHours", label: "Avisar sem backup após (h)", from: String(dto.alertAfterHours), to: String(payload.alertAfterHours) })
  if (payload.destination !== undefined) items.push({ key: "destination", label: "Destino", from: destinationText(dto.destination), to: destinationText(payload.destination) })
  const s3 = payload.s3
  if (s3) {
    if (s3.endpoint !== undefined) items.push({ key: "s3.endpoint", label: "Endereço do bucket", from: orDash(dto.s3.endpoint), to: s3.endpoint })
    if (s3.bucket !== undefined) items.push({ key: "s3.bucket", label: "Bucket", from: orDash(dto.s3.bucket), to: s3.bucket })
    if (s3.region !== undefined) items.push({ key: "s3.region", label: "Região", from: orDash(dto.s3.region), to: orDash(s3.region) })
    if (s3.prefix !== undefined) items.push({ key: "s3.prefix", label: "Pasta no bucket", from: orDash(dto.s3.prefix), to: orDash(s3.prefix) })
    if (s3.accessKey !== undefined) items.push({ key: "s3.accessKey", label: "Chave de acesso do bucket", to: dto.s3.accessKeySet ? "Será substituída" : "Será definida", secret: true })
    if (s3.secretKey !== undefined) items.push({ key: "s3.secretKey", label: "Segredo do bucket", to: dto.s3.secretKeySet ? "Será substituído" : "Será definido", secret: true })
  }
  const drive = payload.drive
  if (drive) {
    if (drive.clientId !== undefined) {
      items.push({ key: "drive.clientId", label: "Client ID do Google", from: orDash(dto.drive.clientId), to: orDash(drive.clientId) })
      if (dto.drive.connected) items.push({ key: "drive.disconnect", label: "Conta Google conectada", from: dto.drive.accountEmail ?? "Conectada", to: "Será desconectada (trocar o Client ID desconecta a conta)" })
    }
    if (drive.clientSecret !== undefined) items.push({ key: "drive.clientSecret", label: "Client Secret do Google", to: dto.drive.clientSecretSet ? "Será substituído" : "Será definido", secret: true })
  }
  for (const secret of payload.clearSecrets ?? []) {
    const label = secret === "s3AccessKey" ? "Chave de acesso do bucket" : secret === "s3SecretKey" ? "Segredo do bucket" : "Client Secret do Google"
    items.push({ key: `clear.${secret}`, label, to: "Será apagado", secret: true })
  }
  return items
}

// ---------------------------------------------------------------------------
// Erros por `code`
// ---------------------------------------------------------------------------

export interface BackupError {
  code: string | undefined
  status: number | undefined
  /** Texto pronto, escolhido por `code`. NUNCA o `error` do servidor. */
  message: string
  /** Campos da tela a que o erro aponta (`s3.endpoint`...), quando dá para saber. */
  fields: string[]
  /** Segundos de `Retry-After` do 429. */
  retryAfterSeconds?: number
  /** O que a pessoa preencheu continua intacto e dá para tentar de novo (tudo, menos sessão expirada). */
  draftKept: boolean
}

export const MSG = {
  network: "Não foi possível falar com o servidor. Confira a conexão e tente de novo. Nada foi alterado.",
  session: "Sua sessão expirou. Entre de novo para continuar. Nada foi alterado.",
  forbidden: "Somente administradores podem ver e alterar os backups.",
  wrongPassword: "Senha incorreta.",
  passwordRequired: "Informe sua senha atual para confirmar esta alteração.",
  stepUpUnavailable: "Não foi possível confirmar sua senha agora. Nada foi salvo. Tente de novo em instantes.",
  secretsKeyMissing:
    "O servidor não tem a chave que cifra os segredos (derivada do JWT_SECRET), então não consegue guardar credenciais nem a chave do backup. Nada foi salvo. Peça para quem cuida da infraestrutura conferir o JWT_SECRET e reiniciar a API.",
  internal: "Não foi possível concluir e nada foi alterado. Tente novamente.",
  generic: "Não foi possível concluir a operação. Tente de novo em instantes.",
  unavailable: "O servidor não conseguiu atender agora. Nada foi alterado. Tente de novo em instantes.",
  invalidUrl: "O endereço do bucket é inválido. Use algo como https://SEU-ID.r2.cloudflarestorage.com.",
  httpsRequired: "O endereço do bucket precisa usar https:// (o servidor recusa http em produção).",
  urlCredentials: "O endereço do bucket não pode conter usuário e senha. Eles vão nos campos de credencial.",
  urlExtras: "O endereço do bucket não pode ter “?” nem “#”. Informe só o endereço do serviço.",
  destinationNotAllowed: "Esse endereço aponta para a rede interna do servidor e foi recusado. Use o endereço PÚBLICO do provedor (R2, Backblaze, AWS…).",
  secretAgain: SECRET_AGAIN_MESSAGE,
  destinationMissing: "O destino está incompleto. Complete o destino escolhido (ou conecte a conta Google) e salve antes.",
  keyMissing: "Gere a chave de criptografia do backup antes de ligar o automático.",
  keyExists: "Já existe uma chave. Para trocar, use “Substituir chave” e confirme a frase de segurança.",
  keyConfirmation: `Digite exatamente “${REPLACE_KEY_CONFIRMATION}” para trocar a chave.`,
  keyChanged: "A chave acabou de ser gerada por outra pessoa. Recarregue a página para ver a impressão digital atual. Nada foi trocado.",
  busy: "Já há um backup ou uma conferência em andamento. Espere terminar e tente de novo.",
  queueUnavailable: "A fila de tarefas (Redis) está fora do ar, então o pedido não foi aceito. Tente de novo em instantes ou avise quem cuida da infraestrutura.",
  driveCredentialsMissing: "Salve o Client ID e o Client Secret do Google antes de conectar.",
  publicUrlUnknown: "O servidor não sabe o próprio endereço público (PUBLIC_API_BASE_URL). Avise quem cuida da infraestrutura: sem isso o Google não consegue devolver a conexão.",
  notFound: "Essa execução não foi encontrada.",
} as const

function rateLimitMessage(retryAfterSeconds: number | undefined): string {
  const wait = formatWait(retryAfterSeconds)
  return `Muitas tentativas em pouco tempo. ${wait ? `Aguarde ${wait} e tente de novo.` : "Aguarde um pouco e tente de novo."} Nada foi alterado.`
}

function readDetails(details: unknown): Array<Record<string, unknown>> {
  return Array.isArray(details) ? details.filter((d): d is Record<string, unknown> => !!d && typeof d === "object") : []
}

const VALIDATION_FIELD_LABELS: Record<string, string> = {
  hourLocal: "Horário",
  frequencyDays: "Frequência",
  retentionCount: "Cópias a manter",
  alertAfterHours: "Limite de alerta",
  destination: "Destino",
  "s3.endpoint": "Endereço do bucket",
  "s3.region": "Região",
  "s3.bucket": "Bucket",
  "s3.prefix": "Pasta no bucket",
  "s3.accessKey": "Chave de acesso",
  "s3.secretKey": "Segredo",
  "drive.clientId": "Client ID",
  "drive.clientSecret": "Client Secret",
}

/**
 * Traduz o erro de qualquer rota de backup para texto + campos, SEMPRE por `code` (na falta dele, por status). Nunca ecoa o corpo da requisição (que carrega
 * credenciais e a senha atual) nem o `error` do servidor.
 */
export function parseBackupError(err: unknown): BackupError {
  const base = { code: undefined, status: undefined, fields: [] as string[], draftKept: true }
  if (!axios.isAxiosError(err) || !err.response) return { ...base, message: MSG.network }

  const status = err.response.status
  const body = err.response.data as { code?: unknown; details?: unknown } | undefined
  const code = typeof body?.code === "string" ? body.code : undefined
  const details = readDetails(body?.details)
  const retryHeader = Number(err.response.headers?.["retry-after"])
  const retryAfterSeconds = Number.isFinite(retryHeader) && retryHeader > 0 ? retryHeader : undefined
  const out = (message: string, extra: Partial<BackupError> = {}): BackupError => ({ ...base, code, status, message, retryAfterSeconds, ...extra })

  if (code === "UNAUTHORIZED" || (code === undefined && status === 401)) return out(MSG.session, { draftKept: false })

  switch (code) {
    case "INVALID_CURRENT_PASSWORD":
      return out(MSG.wrongPassword)
    case "CURRENT_PASSWORD_REQUIRED":
      return out(MSG.passwordRequired)
    case "RATE_LIMITED_BACKUP":
    case "RATE_LIMITED":
      return out(rateLimitMessage(retryAfterSeconds))
    case "STEPUP_UNAVAILABLE":
      return out(MSG.stepUpUnavailable)
    case "SECRETS_KEY_MISSING":
      return out(MSG.secretsKeyMissing)
    case "FORBIDDEN":
      return out(MSG.forbidden)
    case "INTERNAL_ERROR":
      return out(MSG.internal)
    case "INVALID_URL":
      return out(MSG.invalidUrl, { fields: ["s3.endpoint"] })
    case "HTTPS_REQUIRED":
      return out(MSG.httpsRequired, { fields: ["s3.endpoint"] })
    case "URL_HAS_CREDENTIALS":
      return out(MSG.urlCredentials, { fields: ["s3.endpoint"] })
    case "URL_HAS_EXTRAS":
      return out(MSG.urlExtras, { fields: ["s3.endpoint"] })
    case "DESTINATION_NOT_ALLOWED":
      return out(MSG.destinationNotAllowed, { fields: ["s3.endpoint"] })
    case "SECRET_REQUIRED_FOR_NEW_DESTINATION":
      return out(MSG.secretAgain, { fields: ["s3.accessKey", "s3.secretKey"] })
    case "BACKUP_DESTINATION_MISSING":
      return out(MSG.destinationMissing)
    case "BACKUP_KEY_MISSING":
      return out(MSG.keyMissing)
    case "BACKUP_KEY_EXISTS":
      return out(MSG.keyExists)
    case "BACKUP_KEY_CONFIRMATION_REQUIRED":
      return out(MSG.keyConfirmation)
    case "BACKUP_KEY_CHANGED":
      return out(MSG.keyChanged)
    case "BACKUP_BUSY":
      return out(MSG.busy)
    case "QUEUE_UNAVAILABLE":
      return out(MSG.queueUnavailable)
    case "DRIVE_OAUTH_CREDENTIALS_MISSING":
      return out(MSG.driveCredentialsMissing)
    case "PUBLIC_URL_UNKNOWN":
      return out(MSG.publicUrlUnknown)
    case "NOT_FOUND":
      return out(MSG.notFound)
    case "VALIDATION_ERROR": {
      const paths = details.map((d) => (typeof d.path === "string" ? d.path : typeof d.field === "string" ? d.field : "")).filter(Boolean)
      const labels = [...new Set(paths.map((p) => VALIDATION_FIELD_LABELS[p]).filter(Boolean))]
      return out(`O servidor não aceitou algum valor${labels.length > 0 ? ` (${labels.join(", ")})` : ""}. Revise os campos e tente de novo.`, {
        fields: paths.filter((p) => p in VALIDATION_FIELD_LABELS),
      })
    }
    default:
      if (code === undefined && status === 429) return out(rateLimitMessage(retryAfterSeconds))
      if (status === 503) return out(MSG.unavailable)
      return out(status >= 500 ? MSG.internal : MSG.generic)
  }
}

/** Resultado do "Testar destino" (200 com `ok`): título e ação por `code`, nunca o `message` do servidor. */
export function testDestinationText(code: string | undefined): { title: string; action: string } {
  return runErrorText(code)
}
