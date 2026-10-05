import type {
  BackupConfigDTO,
  BackupDestination,
  BackupErrorCode,
  BackupProblemToEnable,
  BackupRunDTO,
  BackupRunsResponse,
  BackupStatusDTO,
  BackupTestDestinationResponse,
  BackupTrigger,
  GeneratedBackupKeyResponse,
} from "@/types/api"

/** Senha das contas de ADMIN do mock (a mesma de `mocks/data.ts`): as rotas com step-up conferem `currentPassword` contra ela. */
const MOCK_ADMIN_PASSWORD = "senha1234"
const HOUR = 3_600_000
const DAY = 24 * HOUR

/**
 * Espelho (no que a tela precisa provar) de `/api/admin/backup/*` (`docs/CONTRATO-BACKUP-ADMIN.md`). NÃO é a regra de negócio da Vega: serve para exercitar o contrato no
 * navegador. NADA aqui foi provado contra o backend real, nem contra S3/Drive reais.
 *
 * Regras do contrato espelhadas:
 *  - SEGREDOS (chave de acesso/segredo do bucket, Client Secret) NUNCA são guardados nem devolvidos: o mock só lembra os `*Set`. A chave do backup sai UMA vez (`POST /key`);
 *  - PUT parcial e `strict` (campo desconhecido = 400); intervalos como o schema (hora 0..23, retenção 1..365, alerta 6..720); ordem dos erros: 400 validação -> step-up
 *    (400 `CURRENT_PASSWORD_REQUIRED`, 403 `INVALID_CURRENT_PASSWORD`, 429 `RATE_LIMITED_BACKUP`, 503 `STEPUP_UNAVAILABLE`) -> negócio (URL/SSRF, 400
 *    `SECRET_REQUIRED_FOR_NEW_DESTINATION`, 503 `SECRETS_KEY_MISSING`, 409 `BACKUP_DESTINATION_MISSING`/`BACKUP_KEY_MISSING`). Nada é gravado em nenhum erro;
 *  - a senha só é pedida quando o PUT mexe em algo além de horário/frequência/alerta/desligar (`exigeSenha` em `lib/backup.ts`, mesma regra do servidor);
 *  - trocar o Client ID DESCONECTA a conta Google; trocar o host do bucket com credencial salva exige reenviar as duas credenciais;
 *  - "Fazer backup agora" e "Conferir" são ASSÍNCRONOS (202 `QUEUED`): o estado avança por CONSULTA (`GET /runs/:id`: 1ª = na fila, 2ª = em andamento, 3ª = final), não por relógio, para o
 *    teste ser determinístico; 409 `BACKUP_BUSY` se já há um; sem destino escolhido, "agora" é um TESTE do pg_dump (`objectKey: null`).
 *
 * CENÁRIOS por conta de ADMIN (estado por usuário, em memória da PÁGINA — um `page.goto` zera):
 *  - `admin@innoelektron.com`                        -> PRIMEIRO USO: sem destino, sem chave, automático desligado, nenhuma execução;
 *  - `backup-s3@innoelektron.com`                    -> S3 pronto, chave gerada, ligado, em dia, histórico de 27 execuções (3 páginas);
 *  - `backup-drive@innoelektron.com`                 -> Google Drive conectado (conta, Client ID/Secret salvos), ligado, em dia;
 *  - `backup-drive-desconectado@innoelektron.com`    -> Drive escolhido com Client ID/Secret salvos, conta NÃO conectada;
 *  - `backup-atrasado@innoelektron.com`              -> ligado, ATRASADO (último sucesso há ~80 h), últimas tentativas falharam por `CREDENTIAL`;
 *  - `backup-nunca@innoelektron.com`                 -> ligado e NUNCA saiu uma cópia (`neverRan`);
 *  - `backup-andamento@innoelektron.com`             -> um backup RODANDO agora (termina sozinho depois de 3 consultas do estado geral);
 *  - `backup-sem-chave@innoelektron.com`             -> chave de segredos do servidor INVÁLIDA/indisponível (override `PAYMENT_SECRETS_KEY` inválido) e sem `PUBLIC_API_BASE_URL` (`redirectUri: null`);
 *  - `backup-ilegivel@innoelektron.com`              -> S3 salvo cujos segredos NÃO decifram (`secretsReadable: false`);
 *  - `backup-indisponivel@innoelektron.com`          -> o GET da config devolve 503.
 *
 * GATILHOS (valem para qualquer ADMIN; nos erros do PUT/POST NADA é gravado):
 *  - senha atual `stepup-503` -> 503 `STEPUP_UNAVAILABLE`; `stepup-429` -> 429 `RATE_LIMITED_BACKUP` (com `Retry-After: 90`); 5 senhas ERRADAS seguidas -> 429; qualquer outra
 *    diferente de `senha1234` -> 403 `INVALID_CURRENT_PASSWORD`;
 *  - endereço do bucket: `http://` -> 400 `HTTPS_REQUIRED`; com usuário/senha -> `URL_HAS_CREDENTIALS`; com `?`/`#` -> `URL_HAS_EXTRAS`; `localhost`/`127.*`/`10.*`/`192.168.*`/
 *    `172.16-31.*`/`169.254.169.254`/`*.local`/`*.internal`/sem ponto -> 400 `DESTINATION_NOT_ALLOWED`; host `limite.exemplo.com` -> 429; `erro500.exemplo.com` -> 500;
 *  - `localStorage["mock:backup-execucao"]` = `BackupErrorCode` -> o PRÓXIMO backup/conferência termina em FAILED com esse código (`ok` ou ausente = sucesso);
 *    `localStorage["mock:backup-estado"]` = `HTTP_500` -> `GET /status` falha (a tela continua útil, só o cartão de estado mostra o erro);
 *    `localStorage["mock:backup-teste"]` = `BackupErrorCode` -> "Testar destino" falha com esse código; `HTTP_503` devolve 503 da rota; `localStorage["mock:backup-fila"]` = `off` ->
 *    `POST /run` e `/verify` devolvem 503 `QUEUE_UNAVAILABLE`;
 *  - limites: 6 pedidos de backup/conferência em 10 min e 5 testes de destino por minuto -> 429 `RATE_LIMITED_BACKUP`.
 */

export type BackupMockStatus = 400 | 403 | 404 | 409 | 429 | 500 | 503
export type BackupMockFailure = { ok: false; status: BackupMockStatus; code: string; message: string; details?: unknown; headers?: Record<string, string> }
const fail = (status: BackupMockStatus, code: string, message: string, details?: unknown, headers?: Record<string, string>): BackupMockFailure => ({ ok: false, status, code, message, details, headers })

interface Actor {
  userId: string
}

interface ConfigState {
  enabled: boolean
  hourLocal: number
  frequencyDays: 1 | 2 | 7
  retentionCount: number
  alertAfterHours: number
  destination: BackupDestination | null
  s3: { endpoint: string | null; region: string | null; bucket: string | null; prefix: string | null; accessKeySet: boolean; secretKeySet: boolean }
  drive: { clientId: string | null; clientSecretSet: boolean; connected: boolean; connectedAt: string | null; accountEmail: string | null }
  key: { exists: boolean; fingerprint: string | null; createdAt: string | null; shownAt: string | null }
  updatedAt: string
}

interface ActiveRun {
  run: BackupRunDTO
  /** Quantas vezes o estado desta execução foi consultado (decide QUEUED -> RUNNING -> final). */
  polls: number
  /** Execução semeada (a tela já abre com ela rodando): avança pelas consultas do ESTADO GERAL, porque ninguém consulta `/runs/:id` dela. */
  seeded: boolean
  /** Código de falha escolhido no pedido (ou `null` = sucesso). */
  failWith: BackupErrorCode | null
}

interface Scenario {
  secretsKey: boolean
  readable: boolean
  redirectUri: string | null
  config: ConfigState
  /** Mais recente primeiro. */
  runs: BackupRunDTO[]
  active: ActiveRun | null
  statusReads: number
  wrongPasswords: number
  runRequests: number[]
  testRequests: number[]
  seq: number
}

const REDIRECT_URI = "https://api.innoflow.example/api/backup/google/callback"

const BASE_CONFIG = (): ConfigState => ({
  enabled: false,
  hourLocal: 3,
  frequencyDays: 1,
  retentionCount: 14,
  alertAfterHours: 36,
  destination: null,
  s3: { endpoint: null, region: null, bucket: null, prefix: null, accessKeySet: false, secretKeySet: false },
  drive: { clientId: null, clientSecretSet: false, connected: false, connectedAt: null, accountEmail: null },
  key: { exists: false, fingerprint: null, createdAt: null, shownAt: null },
  updatedAt: "2026-10-01T12:00:00.000Z",
})

const S3_READY = (): ConfigState["s3"] => ({ endpoint: "https://abc123.r2.cloudflarestorage.com", region: "auto", bucket: "innoflow-backups", prefix: "producao", accessKeySet: true, secretKeySet: true })
const KEY_READY = () => ({ exists: true, fingerprint: "630dcd29", createdAt: "2026-09-20T15:10:00.000Z", shownAt: "2026-09-20T15:10:00.000Z" })
const DRIVE_CONNECTED = () => ({ clientId: "1234567890-abc.apps.googleusercontent.com", clientSecretSet: true, connected: true, connectedAt: "2026-09-21T11:00:00.000Z", accountEmail: "dono@gmail.example" })

// ---------------------------------------------------------------------------
// Execuções (semente e fábrica)
// ---------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0")
function fileNameAt(date: Date): string {
  // `backup-innoflow-AAAA-MM-DD-HHhMMmSSs.dump.enc` (UTC, como o servidor nomeia).
  return `backup-innoflow-${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}-${pad(date.getUTCHours())}h${pad(date.getUTCMinutes())}m${pad(date.getUTCSeconds())}s.dump.enc`
}

function objectKeyFor(config: ConfigState, fileName: string): string | null {
  if (config.destination === "S3") return config.s3.prefix ? `${config.s3.prefix}/${fileName}` : fileName
  if (config.destination === "DRIVE") return `drive:1AbCdEf/${fileName}`
  return null
}

let runCounter = 0
function runId(): string {
  runCounter += 1
  return `cmbk${String(runCounter).padStart(21, "0")}`
}

function successRun(config: ConfigState, trigger: BackupTrigger, at: Date, extra: Partial<BackupRunDTO> = {}): BackupRunDTO {
  const fileName = fileNameAt(at)
  const durationMs = trigger === "VERIFY" ? 8_400 : 134_000
  const hasDestination = config.destination !== null
  return {
    id: runId(),
    trigger,
    status: "SUCCESS",
    destination: config.destination,
    createdAt: at.toISOString(),
    startedAt: new Date(at.getTime() + 2_000).toISOString(),
    finishedAt: new Date(at.getTime() + 2_000 + durationMs).toISOString(),
    durationMs,
    fileName: hasDestination || trigger === "VERIFY" ? fileName : null,
    objectKey: objectKeyFor(config, fileName),
    sizeBytes: hasDestination ? 148_234_567 : null,
    checksumSha256: hasDestination ? "9f2c1a7be3d04c55a1f0e8b6c7d29e4a3b5c61d7e8f90a1b2c3d4e5f60718293" : null,
    tablesWithData: 41,
    keyFingerprint: hasDestination ? (config.key.fingerprint ?? "630dcd29") : null,
    errorCode: null,
    errorMessage: null,
    ...extra,
  }
}

/** Texto "cru" do servidor, de propósito reconhecível: a tela NUNCA o mostra (o texto vem do `code`, `RUN_ERROR_TEXT`); o E2E prova isso procurando este marcador na página. */
const ERROR_MESSAGE_SERVER: Record<BackupErrorCode, string> = Object.fromEntries(
  ["CONFIG", "CREDENTIAL", "FOLDER", "QUOTA", "NETWORK", "OAUTH_DISCONNECTED", "DUMP", "DUMP_TIMEOUT", "KEY", "SECRETS_KEY", "TOO_BIG", "NO_BACKUP", "VERIFY", "CHECKSUM", "BUSY", "INTERRUPTED", "NOT_PICKED_UP", "UNKNOWN"].map((code) => [
    code,
    `MENSAGEM-CRUA-DO-SERVIDOR (${code})`,
  ]),
) as Record<BackupErrorCode, string>

function failedRun(config: ConfigState, trigger: BackupTrigger, at: Date, code: BackupErrorCode): BackupRunDTO {
  return {
    id: runId(),
    trigger,
    status: "FAILED",
    destination: config.destination,
    createdAt: at.toISOString(),
    startedAt: new Date(at.getTime() + 2_000).toISOString(),
    finishedAt: new Date(at.getTime() + 9_000).toISOString(),
    durationMs: 7_000,
    fileName: null,
    objectKey: null,
    sizeBytes: null,
    checksumSha256: null,
    tablesWithData: null,
    keyFingerprint: config.key.fingerprint,
    errorCode: code,
    errorMessage: ERROR_MESSAGE_SERVER[code],
  }
}

/** Histórico de `n` execuções, uma a cada `stepHours` horas para trás a partir de `latestHoursAgo`, com uma conferência a cada 7 e uma falha passageira a cada 9. */
function seedHistory(config: ConfigState, now: number, n: number, latestHoursAgo: number, stepHours = 24): BackupRunDTO[] {
  const out: BackupRunDTO[] = []
  for (let i = 0; i < n; i += 1) {
    const at = new Date(now - (latestHoursAgo + i * stepHours) * HOUR)
    if (i % 7 === 6) out.push(successRun(config, "VERIFY", at))
    else if (i % 9 === 8) out.push(failedRun(config, "SCHEDULED", at, "NETWORK"))
    else out.push(successRun(config, i % 5 === 4 ? "MANUAL" : "SCHEDULED", at))
  }
  return out
}

function seed(userId: string, now: number): Scenario {
  const config = BASE_CONFIG()
  const scenario: Scenario = {
    secretsKey: true,
    readable: true,
    redirectUri: REDIRECT_URI,
    config,
    runs: [],
    active: null,
    statusReads: 0,
    wrongPasswords: 0,
    runRequests: [],
    testRequests: [],
    seq: 0,
  }
  switch (userId) {
    case "user_admin_backup_s3":
      Object.assign(config, { enabled: true, destination: "S3" as const, s3: S3_READY(), key: KEY_READY(), retentionCount: 30, updatedAt: "2026-09-25T10:00:00.000Z" })
      scenario.runs = seedHistory(config, now, 27, 5)
      break
    case "user_admin_backup_drive":
      Object.assign(config, { enabled: true, destination: "DRIVE" as const, drive: DRIVE_CONNECTED(), key: KEY_READY(), frequencyDays: 2, hourLocal: 2 })
      scenario.runs = seedHistory(config, now, 8, 9, 48)
      break
    case "user_admin_backup_drive_desconectado":
      Object.assign(config, { destination: "DRIVE" as const, drive: { ...DRIVE_CONNECTED(), connected: false, connectedAt: null, accountEmail: null }, key: KEY_READY() })
      break
    case "user_admin_backup_atrasado":
      Object.assign(config, { enabled: true, destination: "S3" as const, s3: S3_READY(), key: KEY_READY(), alertAfterHours: 36 })
      scenario.runs = [
        failedRun(config, "SCHEDULED", new Date(now - 3 * HOUR), "CREDENTIAL"),
        failedRun(config, "SCHEDULED", new Date(now - 27 * HOUR), "CREDENTIAL"),
        failedRun(config, "MANUAL", new Date(now - 50 * HOUR), "CREDENTIAL"),
        successRun(config, "SCHEDULED", new Date(now - 80 * HOUR)),
        successRun(config, "SCHEDULED", new Date(now - 104 * HOUR)),
      ]
      break
    case "user_admin_backup_nunca":
      Object.assign(config, { enabled: true, destination: "S3" as const, s3: S3_READY(), key: KEY_READY() })
      break
    case "user_admin_backup_andamento": {
      Object.assign(config, { enabled: true, destination: "S3" as const, s3: S3_READY(), key: KEY_READY() })
      scenario.runs = seedHistory(config, now, 4, 26)
      const startedAt = new Date(now - 40_000)
      scenario.active = {
        run: { ...successRun(config, "MANUAL", startedAt), status: "RUNNING", finishedAt: null, durationMs: null, fileName: null, objectKey: null, sizeBytes: null, checksumSha256: null, tablesWithData: null },
        polls: 0,
        seeded: true,
        failWith: null,
      }
      break
    }
    case "user_admin_backup_sem_chave":
      scenario.secretsKey = false
      scenario.redirectUri = null
      break
    case "user_admin_backup_ilegivel":
      scenario.readable = false
      Object.assign(config, { enabled: false, destination: "S3" as const, s3: S3_READY(), key: KEY_READY() })
      scenario.runs = seedHistory(config, now, 3, 60)
      break
    default:
      // `admin@`: primeiro uso.
      break
  }
  return scenario
}

const scenarios = new Map<string, Scenario>()
function scenarioFor(userId: string): Scenario {
  let scenario = scenarios.get(userId)
  if (!scenario) {
    scenario = seed(userId, Date.now())
    scenarios.set(userId, scenario)
  }
  return scenario
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

function destinationReady(s: Scenario): boolean {
  const c = s.config
  if (c.destination === "S3") return Boolean(c.s3.endpoint && c.s3.bucket && c.s3.accessKeySet && c.s3.secretKeySet)
  if (c.destination === "DRIVE") return c.drive.connected
  return false
}

function problemsToEnable(s: Scenario): BackupProblemToEnable[] {
  const out: BackupProblemToEnable[] = []
  if (!destinationReady(s)) out.push("DESTINATION_INCOMPLETE")
  if (!s.config.key.exists) out.push("KEY_MISSING")
  if (!s.secretsKey) out.push("SECRETS_KEY_MISSING")
  else if (!s.readable) out.push("SECRETS_UNREADABLE")
  return out
}

function toConfigDto(s: Scenario): BackupConfigDTO {
  const c = s.config
  return {
    enabled: c.enabled,
    hourLocal: c.hourLocal,
    frequencyDays: c.frequencyDays,
    retentionCount: c.retentionCount,
    alertAfterHours: c.alertAfterHours,
    destination: c.destination,
    destinationReady: destinationReady(s),
    s3: { ...c.s3 },
    drive: { ...c.drive, redirectUri: s.redirectUri },
    encryptionKey: { ...c.key },
    secretsKeyConfigured: s.secretsKey,
    secretsReadable: s.readable,
    problemsToEnable: problemsToEnable(s),
    updatedAt: c.updatedAt,
  }
}

/** Próxima execução agendada: a próxima ocorrência de `hourLocal` (Brasília, UTC-3) depois de agora, somando `frequencyDays - 1` dias quando não é diário. */
function nextRunAt(c: ConfigState, now: number): string {
  const brasilia = new Date(now - 3 * HOUR)
  const slot = Date.UTC(brasilia.getUTCFullYear(), brasilia.getUTCMonth(), brasilia.getUTCDate(), c.hourLocal) + 3 * HOUR
  let next = slot
  if (next <= now) next += DAY
  if (c.frequencyDays > 1) next += (c.frequencyDays - 1) * DAY
  return new Date(next).toISOString()
}

function toStatusDto(s: Scenario): BackupStatusDTO {
  const now = Date.now()
  const finished = s.runs.filter((r) => r.status === "SUCCESS" || r.status === "FAILED")
  const lastBackupRun = finished.find((r) => r.trigger !== "VERIFY") ?? null
  const lastVerifyRun = finished.find((r) => r.trigger === "VERIFY") ?? null
  // Só conta como cópia quem SAIU do servidor (`objectKey`); o teste do pg_dump sem destino não vale.
  const lastSuccess = finished.find((r) => r.trigger !== "VERIFY" && r.status === "SUCCESS" && r.objectKey !== null) ?? null
  const lastSuccessAt = lastSuccess?.finishedAt ?? null
  const ageHours = lastSuccessAt ? Math.max(0, Math.floor((now - new Date(lastSuccessAt).getTime()) / HOUR)) : null
  const c = s.config
  const attempts = [...s.runs, ...(s.active ? [s.active.run] : [])].map((r) => r.startedAt ?? r.createdAt).sort()
  const attempt = attempts.length > 0 ? attempts[attempts.length - 1] : null
  return {
    lastSuccessAt,
    lastAttemptAt: attempt,
    running: s.active?.run.status === "RUNNING",
    stale: c.enabled && ageHours !== null && ageHours > c.alertAfterHours,
    neverRan: c.enabled && lastSuccessAt === null && s.active === null,
    ageHours,
    nextRunAt: c.enabled ? nextRunAt(c, now) : null,
    activeRun: s.active ? { ...s.active.run } : null,
    lastBackupRun,
    lastVerifyRun,
  }
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

export function getBackupConfig(actor: Actor): { ok: true; dto: BackupConfigDTO } | BackupMockFailure {
  if (actor.userId === "user_admin_backup_indisponivel") return fail(503, "BACKUP_UNAVAILABLE", "Não foi possível ler a configuração de backup.")
  return { ok: true, dto: toConfigDto(scenarioFor(actor.userId)) }
}

/** O estado geral avança a execução SEMEADA (só ela): 3 consultas depois de a tela abrir, o backup termina. */
export function getBackupStatus(actor: Actor, trigger: string | null = null): { ok: true; dto: BackupStatusDTO } | BackupMockFailure {
  if (trigger === "HTTP_500") return fail(500, "INTERNAL_ERROR", "Erro inesperado.")
  const s = scenarioFor(actor.userId)
  s.statusReads += 1
  if (s.active?.seeded) {
    s.active.polls += 1
    if (s.active.polls >= 3) finishActive(s)
  }
  return { ok: true, dto: toStatusDto(s) }
}

export function listBackupRuns(actor: Actor, query: { page: number; pageSize: number; trigger?: string; status?: string }): { ok: true; dto: BackupRunsResponse } | BackupMockFailure {
  const s = scenarioFor(actor.userId)
  const all = s.runs.filter((r) => (!query.trigger || r.trigger === query.trigger) && (!query.status || r.status === query.status))
  const pageSize = Math.min(100, Math.max(1, query.pageSize || 20))
  const totalPages = Math.max(1, Math.ceil(all.length / pageSize))
  const page = Math.min(Math.max(1, query.page || 1), totalPages)
  return { ok: true, dto: { items: all.slice((page - 1) * pageSize, page * pageSize), meta: { page, pageSize, total: all.length, totalPages } } }
}

export function getBackupRun(actor: Actor, id: string): { ok: true; dto: BackupRunDTO } | BackupMockFailure {
  const s = scenarioFor(actor.userId)
  if (s.active && s.active.run.id === id) {
    const active = s.active
    if (!active.seeded) {
      active.polls += 1
      // 1ª consulta = na fila, 2ª = em andamento, 3ª = final.
      if (active.polls === 2 && active.run.status === "QUEUED") {
        active.run = { ...active.run, status: "RUNNING", startedAt: new Date().toISOString() }
      } else if (active.polls >= 3) {
        const finished = finishActive(s)
        return { ok: true, dto: finished }
      }
    }
    return { ok: true, dto: { ...active.run } }
  }
  const found = s.runs.find((r) => r.id === id)
  if (!found) return fail(404, "NOT_FOUND", "Execução não encontrada.")
  return { ok: true, dto: { ...found } }
}

/** Fecha a execução ativa (sucesso ou falha pelo código escolhido) e a põe no histórico. */
function finishActive(s: Scenario): BackupRunDTO {
  const active = s.active as ActiveRun
  const at = new Date(active.run.createdAt)
  const trigger = active.run.trigger
  let done: BackupRunDTO
  if (active.failWith) {
    done = { ...failedRun(s.config, trigger, at, active.failWith), id: active.run.id }
  } else {
    // Sem destino escolhido, "agora" é um TESTE do pg_dump (`objectKey: null` em `successRun`).
    done = { ...successRun(s.config, trigger, at), id: active.run.id }
  }
  s.runs = [done, ...s.runs]
  s.active = null
  return done
}

// ---------------------------------------------------------------------------
// Step-up
// ---------------------------------------------------------------------------

function stepUp(s: Scenario, password: unknown): BackupMockFailure | null {
  if (typeof password !== "string" || password.length === 0) return fail(400, "CURRENT_PASSWORD_REQUIRED", "Informe a senha atual.")
  if (password === "stepup-503") return fail(503, "STEPUP_UNAVAILABLE", "Não foi possível confirmar a senha agora.")
  if (password === "stepup-429") return fail(429, "RATE_LIMITED_BACKUP", "Muitas tentativas.", undefined, { "Retry-After": "90" })
  if (password !== MOCK_ADMIN_PASSWORD) {
    s.wrongPasswords += 1
    if (s.wrongPasswords > 5) return fail(429, "RATE_LIMITED_BACKUP", "Muitas tentativas de senha.", undefined, { "Retry-After": "600" })
    return fail(403, "INVALID_CURRENT_PASSWORD", "Senha atual incorreta.")
  }
  s.wrongPasswords = 0
  return null
}

// ---------------------------------------------------------------------------
// PUT /config
// ---------------------------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
const hasControl = (v: string) => [...v].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)
const REGION_RE = /^[A-Za-z0-9-]{1,40}$/
const BUCKET_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$/
const PREFIX_RE = /^[A-Za-z0-9._\-/ ]*$/

const validationFail = (path: string, message: string) => fail(400, "VALIDATION_ERROR", `${path}: ${message}`, [{ path, message }])

function secretOk(v: unknown, max: number): boolean {
  return typeof v === "string" && v.trim().length > 0 && v.length <= max && !hasControl(v)
}

function validatePut(input: Record<string, unknown>): BackupMockFailure | null {
  const known = new Set(["enabled", "hourLocal", "frequencyDays", "retentionCount", "alertAfterHours", "destination", "s3", "drive", "clearSecrets", "currentPassword"])
  for (const key of Object.keys(input)) if (!known.has(key)) return validationFail(key, "campo desconhecido.")
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") return validationFail("enabled", "deve ser booleano.")
  const int = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max
  if (input.hourLocal !== undefined && !int(input.hourLocal, 0, 23)) return validationFail("hourLocal", "de 0 a 23.")
  if (input.frequencyDays !== undefined && ![1, 2, 7].includes(input.frequencyDays as number)) return validationFail("frequencyDays", "deve ser 1, 2 ou 7.")
  if (input.retentionCount !== undefined && !int(input.retentionCount, 1, 365)) return validationFail("retentionCount", "de 1 a 365.")
  if (input.alertAfterHours !== undefined && !int(input.alertAfterHours, 6, 720)) return validationFail("alertAfterHours", "de 6 a 720.")
  if (input.destination !== undefined && input.destination !== null && input.destination !== "S3" && input.destination !== "DRIVE") return validationFail("destination", "S3, DRIVE ou null.")
  if (input.s3 !== undefined) {
    if (!isObject(input.s3)) return validationFail("s3", "inválido.")
    const s3 = input.s3
    for (const key of Object.keys(s3)) if (!["endpoint", "region", "bucket", "prefix", "accessKey", "secretKey"].includes(key)) return validationFail(`s3.${key}`, "campo desconhecido.")
    if (s3.endpoint !== undefined && (typeof s3.endpoint !== "string" || s3.endpoint.trim().length === 0 || s3.endpoint.length > 300)) return validationFail("s3.endpoint", "inválido.")
    if (s3.region !== undefined && s3.region !== null && (typeof s3.region !== "string" || !REGION_RE.test(s3.region))) return validationFail("s3.region", "região inválida.")
    if (s3.bucket !== undefined && (typeof s3.bucket !== "string" || !BUCKET_RE.test(s3.bucket))) return validationFail("s3.bucket", "nome de bucket inválido.")
    if (s3.prefix !== undefined && s3.prefix !== null && (typeof s3.prefix !== "string" || s3.prefix.length > 200 || !PREFIX_RE.test(s3.prefix))) return validationFail("s3.prefix", "prefixo inválido.")
    if (s3.accessKey !== undefined && !secretOk(s3.accessKey, 256)) return validationFail("s3.accessKey", "inválida.")
    if (s3.secretKey !== undefined && !secretOk(s3.secretKey, 512)) return validationFail("s3.secretKey", "inválido.")
  }
  if (input.drive !== undefined) {
    if (!isObject(input.drive)) return validationFail("drive", "inválido.")
    const drive = input.drive
    for (const key of Object.keys(drive)) if (!["clientId", "clientSecret"].includes(key)) return validationFail(`drive.${key}`, "campo desconhecido.")
    if (drive.clientId !== undefined && drive.clientId !== null && (typeof drive.clientId !== "string" || drive.clientId.trim().length === 0 || drive.clientId.length > 300)) return validationFail("drive.clientId", "inválido.")
    if (drive.clientSecret !== undefined && !secretOk(drive.clientSecret, 512)) return validationFail("drive.clientSecret", "inválido.")
  }
  if (input.clearSecrets !== undefined && (!Array.isArray(input.clearSecrets) || input.clearSecrets.some((k) => !["s3AccessKey", "s3SecretKey", "driveClientSecret"].includes(String(k))))) {
    return validationFail("clearSecrets", "valor inválido.")
  }
  if (input.currentPassword !== undefined && (typeof input.currentPassword !== "string" || input.currentPassword.length === 0)) return validationFail("currentPassword", "inválida.")
  return null
}

function exigeSenhaDoAdmin(body: Record<string, unknown>): boolean {
  const harmless = new Set(["hourLocal", "frequencyDays", "alertAfterHours"])
  for (const key of Object.keys(body)) {
    if (harmless.has(key)) continue
    if (key === "enabled" && body.enabled === false) continue
    return true
  }
  return false
}

function internalHostReason(rawHost: string): string | null {
  const host = rawHost.toLowerCase().replace(/^\[|\]$/g, "")
  if (host === "localhost" || host === "::1" || /^127\./.test(host)) return "LOOPBACK"
  if (host === "169.254.169.254") return "ENDERECO_DE_METADADOS"
  if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return "REDE_PRIVADA"
  if (/\.(local|internal|lan|intranet)$/.test(host) || (!host.includes(".") && !host.includes(":"))) return "NOME_INTERNO"
  return null
}

function endpointFailure(endpoint: string): BackupMockFailure | null {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return fail(400, "INVALID_URL", "Endereço inválido.", [{ field: "s3.endpoint" }])
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return fail(400, "INVALID_URL", "Endereço inválido.", [{ field: "s3.endpoint" }])
  if (url.username || url.password) return fail(400, "URL_HAS_CREDENTIALS", "O endereço não pode ter usuário e senha.", [{ field: "s3.endpoint" }])
  if (url.search || url.hash) return fail(400, "URL_HAS_EXTRAS", "O endereço não pode ter ? nem #.", [{ field: "s3.endpoint" }])
  if (url.protocol === "http:") return fail(400, "HTTPS_REQUIRED", "O endereço precisa usar https.", [{ field: "s3.endpoint" }])
  const reason = internalHostReason(url.hostname)
  if (reason) return fail(400, "DESTINATION_NOT_ALLOWED", "Destino não permitido.", [{ field: "s3.endpoint", reason }])
  if (url.hostname === "limite.exemplo.com") return fail(429, "RATE_LIMITED_BACKUP", "Muitas alterações.", undefined, { "Retry-After": "45" })
  if (url.hostname === "erro500.exemplo.com") return fail(500, "INTERNAL_ERROR", "Erro inesperado.")
  return null
}

const hostOf = (endpoint: string | null) => {
  try {
    return endpoint ? new URL(endpoint).host.toLowerCase() : null
  } catch {
    return null
  }
}

export function updateBackupConfig(actor: Actor, raw: unknown): { ok: true; dto: BackupConfigDTO } | BackupMockFailure {
  const s = scenarioFor(actor.userId)
  if (!isObject(raw)) return validationFail("body", "corpo inválido.")
  const invalid = validatePut(raw)
  if (invalid) return invalid
  const { currentPassword, ...body } = raw as Record<string, unknown>
  if (Object.keys(body).length === 0) return validationFail("body", "informe ao menos um campo.")

  if (exigeSenhaDoAdmin(body)) {
    const blocked = stepUp(s, currentPassword)
    if (blocked) return blocked
  }

  // Negócio.
  const s3In = isObject(body.s3) ? body.s3 : {}
  const driveIn = isObject(body.drive) ? body.drive : {}
  const c = s.config
  if (typeof s3In.endpoint === "string") {
    const failure = endpointFailure(s3In.endpoint.trim())
    if (failure) return failure
  }
  const hasSecretInput = s3In.accessKey !== undefined || s3In.secretKey !== undefined || driveIn.clientSecret !== undefined
  if (hasSecretInput && !s.secretsKey) return fail(503, "SECRETS_KEY_MISSING", "A chave de segredos do servidor está inválida ou indisponível.")
  if (typeof s3In.endpoint === "string") {
    const next = hostOf(s3In.endpoint.trim())
    const saved = hostOf(c.s3.endpoint)
    if (saved !== null && next !== saved && (c.s3.accessKeySet || c.s3.secretKeySet) && (s3In.accessKey === undefined || s3In.secretKey === undefined)) {
      return fail(400, "SECRET_REQUIRED_FOR_NEW_DESTINATION", "Trocar o endereço do bucket exige reenviar as credenciais.", [{ field: "s3.accessKey" }, { field: "s3.secretKey" }])
    }
  }

  // Aplica numa CÓPIA (nada é gravado se o "ligar" for recusado).
  const next: ConfigState = { ...c, s3: { ...c.s3 }, drive: { ...c.drive }, key: { ...c.key } }
  const clear = new Set<string>((body.clearSecrets as string[] | undefined) ?? [])
  if (typeof body.hourLocal === "number") next.hourLocal = body.hourLocal
  if (body.frequencyDays !== undefined) next.frequencyDays = body.frequencyDays as 1 | 2 | 7
  if (typeof body.retentionCount === "number") next.retentionCount = body.retentionCount
  if (typeof body.alertAfterHours === "number") next.alertAfterHours = body.alertAfterHours
  if (body.destination !== undefined) next.destination = body.destination as BackupDestination | null
  if (typeof s3In.endpoint === "string") next.s3.endpoint = s3In.endpoint.trim().replace(/\/+$/, "")
  if (s3In.region !== undefined) next.s3.region = (s3In.region as string | null) || null
  if (typeof s3In.bucket === "string") next.s3.bucket = s3In.bucket.trim()
  if (s3In.prefix !== undefined) next.s3.prefix = ((s3In.prefix as string | null) ?? "").trim().replace(/^\/+|\/+$/g, "") || null
  if (typeof s3In.accessKey === "string") next.s3.accessKeySet = true
  if (typeof s3In.secretKey === "string") next.s3.secretKeySet = true
  if (clear.has("s3AccessKey") && s3In.accessKey === undefined) next.s3.accessKeySet = false
  if (clear.has("s3SecretKey") && s3In.secretKey === undefined) next.s3.secretKeySet = false
  if (driveIn.clientId !== undefined) {
    const clientId = (driveIn.clientId as string | null)?.trim() || null
    if (clientId !== c.drive.clientId) {
      // O escopo `drive.file` é por app: trocar o Client ID desconecta a conta.
      next.drive.clientId = clientId
      next.drive.connected = false
      next.drive.connectedAt = null
      next.drive.accountEmail = null
    }
  }
  if (typeof driveIn.clientSecret === "string") next.drive.clientSecretSet = true
  if (clear.has("driveClientSecret") && driveIn.clientSecret === undefined) next.drive.clientSecretSet = false

  if (body.enabled === true) {
    const probe: Scenario = { ...s, config: next }
    if (!destinationReady(probe)) return fail(409, "BACKUP_DESTINATION_MISSING", "Complete o destino antes de ligar.")
    if (!next.key.exists) return fail(409, "BACKUP_KEY_MISSING", "Gere a chave antes de ligar.")
  }
  if (typeof body.enabled === "boolean") next.enabled = body.enabled

  next.updatedAt = new Date().toISOString()
  s.config = next
  return { ok: true, dto: toConfigDto(s) }
}

// ---------------------------------------------------------------------------
// Chave
// ---------------------------------------------------------------------------

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("")
}

export function generateBackupKey(actor: Actor, raw: unknown): { ok: true; dto: GeneratedBackupKeyResponse } | BackupMockFailure {
  const s = scenarioFor(actor.userId)
  if (!isObject(raw)) return validationFail("body", "corpo inválido.")
  for (const key of Object.keys(raw)) if (!["currentPassword", "replace", "confirmation", "expectedFingerprint"].includes(key)) return validationFail(key, "campo desconhecido.")
  if (typeof raw.currentPassword !== "string" || raw.currentPassword.length === 0) return validationFail("currentPassword", "Informe a senha atual.")
  const blocked = stepUp(s, raw.currentPassword)
  if (blocked) return blocked
  if (!s.secretsKey) return fail(503, "SECRETS_KEY_MISSING", "A chave de segredos do servidor está inválida ou indisponível.")

  const exists = s.config.key.exists
  if (exists && raw.replace !== true) return fail(409, "BACKUP_KEY_EXISTS", "Já existe uma chave de backup.")
  if (exists && raw.confirmation !== "GERAR NOVA CHAVE") return fail(400, "BACKUP_KEY_CONFIRMATION_REQUIRED", "Digite a frase de confirmação.")
  if (raw.expectedFingerprint !== undefined && raw.expectedFingerprint !== s.config.key.fingerprint) return fail(409, "BACKUP_KEY_CHANGED", "A chave mudou.")
  if (s.active) return fail(409, "BACKUP_BUSY", "Há um backup em andamento.")

  const groups = Array.from({ length: 8 }, () => randomHex(4))
  const key = groups.join("-")
  const fingerprint = randomHex(4)
  const now = new Date().toISOString()
  s.config = { ...s.config, key: { exists: true, fingerprint, createdAt: now, shownAt: now }, updatedAt: now }
  return {
    ok: true,
    dto: {
      key,
      fingerprint,
      fileName: `chave-backup-innoflow-${fingerprint}.txt`,
      fileText: `# Chave de backup do InnoFlow\n# Impressão digital: ${fingerprint}\n# Guarde fora do servidor. Sem ela os backups não abrem.\nCHAVE: ${key}\n`,
      replaced: exists,
    },
  }
}

// ---------------------------------------------------------------------------
// Ações: backup agora / conferir / testar destino
// ---------------------------------------------------------------------------

function withinLimit(times: number[], limit: number, windowMs: number): boolean {
  const now = Date.now()
  const recent = times.filter((t) => now - t < windowMs)
  times.length = 0
  times.push(...recent)
  if (times.length >= limit) return false
  times.push(now)
  return true
}

function startRun(actor: Actor, trigger: "MANUAL" | "VERIFY", gate: { executionTrigger: string | null; queueTrigger: string | null }): { ok: true; dto: BackupRunDTO } | BackupMockFailure {
  const s = scenarioFor(actor.userId)
  if (s.active) return fail(409, "BACKUP_BUSY", "Já há um backup em andamento.")
  if (!withinLimit(s.runRequests, 6, 10 * 60_000)) return fail(429, "RATE_LIMITED_BACKUP", "Muitos pedidos de backup.", undefined, { "Retry-After": "300" })
  const chosen = s.config.destination
  if (trigger === "VERIFY" && !chosen) return fail(409, "BACKUP_DESTINATION_MISSING", "Escolha e complete um destino para conferir.")
  if (chosen && !destinationReady(s)) return fail(409, "BACKUP_DESTINATION_MISSING", "O destino escolhido está incompleto.")
  if (gate.queueTrigger === "off") return fail(503, "QUEUE_UNAVAILABLE", "A fila está fora do ar.")

  const code = gate.executionTrigger && gate.executionTrigger !== "ok" && gate.executionTrigger in ERROR_MESSAGE_SERVER ? (gate.executionTrigger as BackupErrorCode) : null
  // Sem chave gerada, um backup para um destino não consegue cifrar: falha por `KEY`.
  const failWith = code ?? (chosen && !s.config.key.exists ? "KEY" : null)
  const run: BackupRunDTO = {
    id: runId(),
    trigger,
    status: "QUEUED",
    destination: chosen,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    fileName: null,
    objectKey: null,
    sizeBytes: null,
    checksumSha256: null,
    tablesWithData: null,
    keyFingerprint: null,
    errorCode: null,
    errorMessage: null,
  }
  s.active = { run, polls: 0, seeded: false, failWith }
  return { ok: true, dto: { ...run } }
}

export function runBackupNow(actor: Actor, gate: { executionTrigger: string | null; queueTrigger: string | null }) {
  return startRun(actor, "MANUAL", gate)
}

export function verifyBackup(actor: Actor, gate: { executionTrigger: string | null; queueTrigger: string | null }) {
  return startRun(actor, "VERIFY", gate)
}

export function testBackupDestination(actor: Actor, trigger: string | null): { ok: true; dto: BackupTestDestinationResponse } | BackupMockFailure {
  const s = scenarioFor(actor.userId)
  if (trigger === "HTTP_503") return fail(503, "BACKUP_UNAVAILABLE", "Não foi possível testar agora.")
  if (!withinLimit(s.testRequests, 5, 60_000)) return fail(429, "RATE_LIMITED_BACKUP", "Muitos testes seguidos.", undefined, { "Retry-After": "30" })
  const destination = s.config.destination
  if (!destination) {
    return { ok: true, dto: { ok: false, destination: null, message: "Nenhum destino escolhido.", error: { code: "CONFIG", message: ERROR_MESSAGE_SERVER.CONFIG } } }
  }
  if (!destinationReady(s)) return { ok: true, dto: { ok: false, destination, message: "Destino incompleto.", error: { code: "CONFIG", message: ERROR_MESSAGE_SERVER.CONFIG } } }
  if (trigger && trigger !== "ok" && trigger in ERROR_MESSAGE_SERVER) {
    const code = trigger as BackupErrorCode
    return { ok: true, dto: { ok: false, destination, message: "O teste falhou.", error: { code, message: ERROR_MESSAGE_SERVER[code] } } }
  }
  return {
    ok: true,
    dto: { ok: true, destination, message: destination === "S3" ? "Gravei e apaguei um arquivo de teste no bucket." : "Abri a pasta Backups InnoFlow no Drive." },
  }
}

// ---------------------------------------------------------------------------
// Google
// ---------------------------------------------------------------------------

export function startGoogle(actor: Actor, raw: unknown): { ok: true; dto: { url: string; redirectUri: string | null } } | BackupMockFailure {
  const s = scenarioFor(actor.userId)
  if (!isObject(raw) || typeof raw.currentPassword !== "string" || raw.currentPassword.length === 0) return validationFail("currentPassword", "Informe a senha atual.")
  const blocked = stepUp(s, raw.currentPassword)
  if (blocked) return blocked
  if (!s.config.drive.clientId || !s.config.drive.clientSecretSet) return fail(409, "DRIVE_OAUTH_CREDENTIALS_MISSING", "Salve o Client ID e o Client Secret antes.")
  if (!s.redirectUri) return fail(409, "PUBLIC_URL_UNKNOWN", "O deploy não definiu PUBLIC_API_BASE_URL.")
  return { ok: true, dto: { url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=mock&state=mock", redirectUri: s.redirectUri } }
}

export function disconnectGoogle(actor: Actor, raw: unknown): { ok: true; dto: BackupConfigDTO } | BackupMockFailure {
  const s = scenarioFor(actor.userId)
  if (!isObject(raw) || typeof raw.currentPassword !== "string" || raw.currentPassword.length === 0) return validationFail("currentPassword", "Informe a senha atual.")
  const blocked = stepUp(s, raw.currentPassword)
  if (blocked) return blocked
  s.config = { ...s.config, drive: { ...s.config.drive, connected: false, connectedAt: null, accountEmail: null }, updatedAt: new Date().toISOString() }
  return { ok: true, dto: toConfigDto(s) }
}
