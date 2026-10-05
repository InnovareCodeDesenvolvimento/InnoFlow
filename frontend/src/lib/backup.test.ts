import { AxiosError, type AxiosResponse } from "axios"
import { describe, expect, it } from "vitest"
import type { BackupConfigDTO, BackupRunDTO, BackupStatusDTO } from "@/types/api"
import {
  EMPTY_DRAFT,
  MSG,
  NO_SECRETS_KEY_MESSAGE,
  QUEUED_HINT_AFTER_MS,
  SECRETS_KEY_NOTICE,
  SECRET_AGAIN_MESSAGE,
  actionBlockReason,
  buildUpdatePayload,
  clearDraftScope,
  connectBlockReason,
  describeChanges,
  destinationReadyAfter,
  draftTouched,
  enableBlockers,
  exigeSenha,
  formatAge,
  formatBrasiliaLong,
  formatBytes,
  formatDuration,
  formatWait,
  hasChanges,
  healthOf,
  isBusy,
  isSafeGoogleUrl,
  parseBackupError,
  parseGoogleReturn,
  queuedTooLong,
  runErrorText,
  runRefetchInterval,
  runStateLabel,
  s3HostChanged,
  scopeDraft,
  situationOf,
  statusRefetchInterval,
  testDestinationText,
  validateDraft,
  validateEndpoint,
  withCurrentPassword,
  withoutGoogleParams,
  type BackupDraft,
} from "./backup"

function dto(over: Partial<BackupConfigDTO> = {}, s3: Partial<BackupConfigDTO["s3"]> = {}, drive: Partial<BackupConfigDTO["drive"]> = {}, key: Partial<BackupConfigDTO["encryptionKey"]> = {}): BackupConfigDTO {
  return {
    enabled: false,
    hourLocal: 3,
    frequencyDays: 1,
    retentionCount: 14,
    alertAfterHours: 36,
    destination: null,
    destinationReady: false,
    s3: { endpoint: null, region: null, bucket: null, prefix: null, accessKeySet: false, secretKeySet: false, ...s3 },
    drive: { clientId: null, clientSecretSet: false, connected: false, connectedAt: null, accountEmail: null, redirectUri: "https://api.x/cb", ...drive },
    encryptionKey: { exists: false, fingerprint: null, createdAt: null, shownAt: null, ...key },
    secretsKeyConfigured: true,
    secretsReadable: true,
    problemsToEnable: [],
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...over,
  }
}

const S3_SAVED = { endpoint: "https://a.r2.cloudflarestorage.com", bucket: "bk", region: "auto", prefix: "prod", accessKeySet: true, secretKeySet: true }
const READY = () => dto({ enabled: true, destination: "S3", destinationReady: true }, S3_SAVED, {}, { exists: true, fingerprint: "630dcd29" })
const draft = (over: Partial<BackupDraft> = {}): BackupDraft => ({ ...EMPTY_DRAFT, s3: {}, drive: {}, clear: {}, ...over })

function axiosError(status: number, body: unknown, headers: Record<string, string> = {}): AxiosError {
  const err = new AxiosError("falhou")
  err.response = { status, data: body, headers, statusText: "", config: {} as never } as AxiosResponse
  return err
}

describe("buildUpdatePayload: só o que mudou", () => {
  it("rascunho vazio = nada a enviar", () => {
    expect(buildUpdatePayload(READY(), EMPTY_DRAFT)).toEqual({})
    expect(hasChanges({})).toBe(false)
  })

  it("valor igual ao salvo não vira alteração; diferente vira", () => {
    const d = draft({ hourLocal: "3", retentionCount: "30", frequencyDays: 1, alertAfterHours: "48" })
    expect(buildUpdatePayload(READY(), d)).toEqual({ retentionCount: 30, alertAfterHours: 48 })
  })

  it("número inválido não vai (a validação o acusa)", () => {
    expect(buildUpdatePayload(READY(), draft({ hourLocal: "abc", retentionCount: "" }))).toEqual({})
  })

  it("região e pasta em branco com valor salvo = limpar (null); em branco sem valor salvo = nada", () => {
    expect(buildUpdatePayload(READY(), draft({ s3: { region: "", prefix: "  " } }))).toEqual({ s3: { region: null, prefix: null } })
    const vazio = dto({ destination: "S3" }, { endpoint: "https://x.com", bucket: "b" })
    expect(buildUpdatePayload(vazio, draft({ s3: { region: "", prefix: "" } }))).toEqual({})
  })

  it("endereço e bucket em branco NÃO são enviados (campos obrigatórios não têm 'limpar')", () => {
    expect(buildUpdatePayload(READY(), draft({ s3: { endpoint: "", bucket: " " } }))).toEqual({})
  })

  it("segredo: só vai se digitado (string vazia = manter); apagar só se existe e não há valor novo", () => {
    const base = READY()
    expect(buildUpdatePayload(base, draft({ s3: { accessKey: "", secretKey: "" } }))).toEqual({})
    expect(buildUpdatePayload(base, draft({ s3: { accessKey: "AK", secretKey: "SK" } }))).toEqual({ s3: { accessKey: "AK", secretKey: "SK" } })
    expect(buildUpdatePayload(base, draft({ clear: { s3SecretKey: true } }))).toEqual({ clearSecrets: ["s3SecretKey"] })
    expect(buildUpdatePayload(base, draft({ s3: { secretKey: "novo" }, clear: { s3SecretKey: true } }))).toEqual({ s3: { secretKey: "novo" } })
    // apagar um segredo que nem existe não vai
    expect(buildUpdatePayload(dto(), draft({ clear: { driveClientSecret: true } }))).toEqual({})
  })

  it("destino: troca e 'Nenhum' (null)", () => {
    expect(buildUpdatePayload(READY(), draft({ destination: "DRIVE" }))).toEqual({ destination: "DRIVE" })
    expect(buildUpdatePayload(READY(), draft({ destination: null }))).toEqual({ destination: null })
    expect(buildUpdatePayload(READY(), draft({ destination: "S3" }))).toEqual({})
  })

  it("Drive: Client ID vazio = null; o secret só se digitado", () => {
    const d = dto({}, {}, { clientId: "abc", clientSecretSet: true })
    expect(buildUpdatePayload(d, draft({ drive: { clientId: "" } }))).toEqual({ drive: { clientId: null } })
    expect(buildUpdatePayload(d, draft({ drive: { clientId: "novo", clientSecret: "seg" } }))).toEqual({ drive: { clientId: "novo", clientSecret: "seg" } })
  })

  it("withCurrentPassword só acrescenta a senha", () => {
    expect(withCurrentPassword({ enabled: true }, "x")).toEqual({ enabled: true, currentPassword: "x" })
  })

  it("draftTouched: abrir o campo de segredo já conta (habilita Descartar)", () => {
    expect(draftTouched(EMPTY_DRAFT)).toBe(false)
    expect(draftTouched(draft({ s3: { accessKey: "" } }))).toBe(true)
    expect(draftTouched(draft({ clear: { s3AccessKey: true } }))).toBe(true)
  })
})

describe("exigeSenha: espelha o servidor (decide pelos CAMPOS ENVIADOS)", () => {
  it("horário, frequência e limite de alerta não pedem senha", () => {
    expect(exigeSenha({ hourLocal: 4 })).toBe(false)
    expect(exigeSenha({ frequencyDays: 7, alertAfterHours: 72, hourLocal: 1 })).toBe(false)
  })
  it("desligar não pede; ligar pede", () => {
    expect(exigeSenha({ enabled: false })).toBe(false)
    expect(exigeSenha({ enabled: false, hourLocal: 2 })).toBe(false)
    expect(exigeSenha({ enabled: true })).toBe(true)
  })
  it("cópias a manter, destino, credenciais e apagar segredo pedem", () => {
    expect(exigeSenha({ retentionCount: 5 })).toBe(true)
    expect(exigeSenha({ destination: null })).toBe(true)
    expect(exigeSenha({ s3: { prefix: "x" } })).toBe(true)
    expect(exigeSenha({ drive: { clientId: null } })).toBe(true)
    expect(exigeSenha({ clearSecrets: ["s3AccessKey"] })).toBe(true)
    expect(exigeSenha({ hourLocal: 1, retentionCount: 3 })).toBe(true)
  })
})

describe("validateDraft", () => {
  it("faixas: hora 0..23, cópias 1..365, alerta 6..720", () => {
    const e = validateDraft(READY(), draft({ hourLocal: "24", retentionCount: "0", alertAfterHours: "5" }))
    expect(Object.keys(e).sort()).toEqual(["alertAfterHours", "hourLocal", "retentionCount"])
    expect(validateDraft(READY(), draft({ hourLocal: "23", retentionCount: "365", alertAfterHours: "720" }))).toEqual({})
    expect(validateDraft(READY(), draft({ retentionCount: "3,5" })).retentionCount).toBeTruthy()
  })

  it("S3 escolhido: endereço e bucket são obrigatórios", () => {
    const e = validateDraft(dto({ destination: "S3" }), draft({ s3: { endpoint: "", bucket: "" } }))
    expect(e["s3.endpoint"]).toBeTruthy()
    expect(e["s3.bucket"]).toBeTruthy()
  })

  it("endereço: URL, sem usuário/senha, sem ? nem #", () => {
    expect(validateEndpoint("https://x.com")).toBeNull()
    expect(validateEndpoint("x.com")).toMatch(/inválido/)
    expect(validateEndpoint("ftp://x.com")).toMatch(/https/)
    expect(validateEndpoint("https://u:p@x.com")).toMatch(/usuário/)
    expect(validateEndpoint("https://x.com/?a=1")).toMatch(/“\?”/)
    expect(validateEndpoint("")).toMatch(/Informe/)
  })

  it("região, bucket e pasta seguem as regras do servidor", () => {
    const e = validateDraft(READY(), draft({ s3: { region: "us east", bucket: "-x", prefix: "a$b" } }))
    expect(e["s3.region"]).toBeTruthy()
    expect(e["s3.bucket"]).toBeTruthy()
    expect(e["s3.prefix"]).toBeTruthy()
  })

  it("segredo com quebra de linha ou grande demais é recusado, sem ecoar o valor", () => {
    const e = validateDraft(READY(), draft({ s3: { accessKey: "AK\nSEGREDO-NAO-ECOAR", secretKey: "x".repeat(513) } }))
    expect(e["s3.accessKey"]).toBeTruthy()
    expect(e["s3.secretKey"]).toMatch(/512/)
    expect(JSON.stringify(e)).not.toContain("SEGREDO-NAO-ECOAR")
  })

  it("trocar o HOST do bucket com credencial salva exige as DUAS credenciais de novo", () => {
    const d = draft({ s3: { endpoint: "https://outro.exemplo.com" } })
    expect(s3HostChanged(READY(), d)).toBe(true)
    const e = validateDraft(READY(), d)
    expect(e["s3.accessKey"]).toBe(SECRET_AGAIN_MESSAGE)
    expect(e["s3.secretKey"]).toBe(SECRET_AGAIN_MESSAGE)
    const meio = validateDraft(READY(), draft({ s3: { endpoint: "https://outro.exemplo.com", accessKey: "AK" } }))
    expect(meio["s3.accessKey"]).toBeUndefined()
    expect(meio["s3.secretKey"]).toBe(SECRET_AGAIN_MESSAGE)
    expect(validateDraft(READY(), draft({ s3: { endpoint: "https://outro.exemplo.com", accessKey: "AK", secretKey: "SK" } }))).toEqual({})
  })

  it("mesmo host (só caminho/maiúscula/barra) NÃO é troca de destino; sem credencial salva também não", () => {
    expect(s3HostChanged(READY(), draft({ s3: { endpoint: "https://A.r2.cloudflarestorage.com/" } }))).toBe(false)
    expect(s3HostChanged(dto({ destination: "S3" }, { endpoint: "https://a.com", bucket: "b" }), draft({ s3: { endpoint: "https://b.com" } }))).toBe(false)
  })

  it("servidor sem a chave dos segredos (JWT_SECRET): segredo digitado é recusado antes do pedido, sem citar PAYMENT_SECRETS_KEY", () => {
    const e = validateDraft(dto({ secretsKeyConfigured: false }), draft({ s3: { accessKey: "AK" }, drive: { clientSecret: "CS" } }))
    expect(e["s3.accessKey"]).toBe(NO_SECRETS_KEY_MESSAGE)
    expect(e["drive.clientSecret"]).toBe(NO_SECRETS_KEY_MESSAGE)
    expect(NO_SECRETS_KEY_MESSAGE).toMatch(/JWT_SECRET/)
    expect(NO_SECRETS_KEY_MESSAGE).not.toMatch(/PAYMENT_SECRETS_KEY/)
  })

  it("LIGAR: exige destino completo e chave; o rascunho pode completar o destino na mesma gravação", () => {
    const sem = dto({}, {}, {}, { exists: true, fingerprint: "aaaaaaaa" })
    expect(validateDraft(sem, draft({ enabled: true })).enabled).toMatch(/destino/i)
    const completando = draft({ enabled: true, destination: "S3", s3: { endpoint: "https://a.com", bucket: "bk", accessKey: "AK", secretKey: "SK" } })
    expect(validateDraft(sem, completando).enabled).toBeUndefined()
    const semChave = dto({ destination: "S3", destinationReady: true }, S3_SAVED)
    expect(validateDraft(semChave, draft({ enabled: true })).enabled).toMatch(/chave/i)
  })

  it("já ligado: uma alteração que deixa o destino incompleto é barrada (o servidor valida o estado futuro)", () => {
    expect(validateDraft(READY(), draft({ clear: { s3SecretKey: true } })).destination).toMatch(/completo/)
    expect(validateDraft(READY(), draft({ s3: { bucket: "outro" } })).destination).toBeUndefined()
  })

  it("Drive: trocar o Client ID desconecta a conta e deixa o destino incompleto", () => {
    const drive = dto({ enabled: true, destination: "DRIVE", destinationReady: true }, {}, { clientId: "abc", clientSecretSet: true, connected: true }, { exists: true, fingerprint: "aaaaaaaa" })
    expect(destinationReadyAfter(drive, EMPTY_DRAFT)).toBe(true)
    expect(destinationReadyAfter(drive, draft({ drive: { clientId: "outro" } }))).toBe(false)
    expect(validateDraft(drive, draft({ drive: { clientId: "outro" } })).destination).toBeTruthy()
  })

  it("enableBlockers lista chave, destino e problemas do servidor", () => {
    expect(enableBlockers(dto({ secretsKeyConfigured: false }), EMPTY_DRAFT).join(" ")).toMatch(/JWT_SECRET/)
    expect(enableBlockers(dto({ secretsKeyConfigured: false }), EMPTY_DRAFT).join(" ")).not.toMatch(/PAYMENT_SECRETS_KEY/)
    expect(enableBlockers(dto({ secretsReadable: false }), EMPTY_DRAFT).join(" ")).toMatch(/lidos/)
    expect(enableBlockers(dto({ secretsReadable: false }), EMPTY_DRAFT).join(" ")).toMatch(/JWT_SECRET/)
    expect(enableBlockers(READY(), EMPTY_DRAFT)).toEqual([])
  })
})

describe("describeChanges: segredo nunca aparece", () => {
  it("segredos viram texto fixo", () => {
    const items = describeChanges(READY(), { s3: { accessKey: "AK-SECRETO", secretKey: "SK-SECRETO" }, drive: { clientSecret: "CS-SECRETO" }, clearSecrets: ["s3AccessKey"] })
    const text = JSON.stringify(items)
    expect(text).not.toMatch(/SECRETO/)
    expect(items.filter((i) => i.secret)).toHaveLength(4)
  })
  it("trocar o Client ID avisa que a conta será desconectada", () => {
    const d = dto({}, {}, { clientId: "abc", connected: true, accountEmail: "a@b.c" })
    const items = describeChanges(d, { drive: { clientId: "novo" } })
    expect(items.map((i) => i.key)).toEqual(["drive.clientId", "drive.disconnect"])
  })
  it("mostra de -> para dos campos normais", () => {
    const [item] = describeChanges(READY(), { retentionCount: 5 })
    expect(item).toMatchObject({ label: "Cópias a manter", from: "14", to: "5" })
  })
})

describe("erros por `code` (nunca o texto do servidor)", () => {
  const body = (code: string, extra: Record<string, unknown> = {}) => ({ error: "TEXTO-CRU-DO-SERVIDOR com SEGREDO", code, ...extra })

  it("sem resposta = rede; 401 = sessão expirada (rascunho perdido)", () => {
    expect(parseBackupError(new Error("x")).message).toBe(MSG.network)
    const e = parseBackupError(axiosError(401, body("UNAUTHORIZED")))
    expect(e.message).toBe(MSG.session)
    expect(e.draftKept).toBe(false)
  })

  it("403 de senha errada e 400 de senha ausente", () => {
    expect(parseBackupError(axiosError(403, body("INVALID_CURRENT_PASSWORD"))).message).toBe(MSG.wrongPassword)
    expect(parseBackupError(axiosError(400, body("CURRENT_PASSWORD_REQUIRED"))).message).toBe(MSG.passwordRequired)
  })

  it("429 RATE_LIMITED_BACKUP usa o Retry-After", () => {
    const e = parseBackupError(axiosError(429, body("RATE_LIMITED_BACKUP"), { "retry-after": "90" }))
    expect(e.retryAfterSeconds).toBe(90)
    expect(e.message).toMatch(/2 minutos/)
    expect(parseBackupError(axiosError(429, body("RATE_LIMITED_BACKUP"))).message).toMatch(/Aguarde um pouco/)
  })

  it("endereço do bucket: cada code aponta o campo", () => {
    for (const code of ["INVALID_URL", "HTTPS_REQUIRED", "URL_HAS_CREDENTIALS", "URL_HAS_EXTRAS", "DESTINATION_NOT_ALLOWED"]) {
      expect(parseBackupError(axiosError(400, body(code))).fields).toEqual(["s3.endpoint"])
    }
  })

  it("SECRET_REQUIRED_FOR_NEW_DESTINATION aponta as duas credenciais", () => {
    const e = parseBackupError(axiosError(400, body("SECRET_REQUIRED_FOR_NEW_DESTINATION")))
    expect(e.fields).toEqual(["s3.accessKey", "s3.secretKey"])
    expect(e.message).toBe(SECRET_AGAIN_MESSAGE)
  })

  it("409/503 conhecidos", () => {
    expect(parseBackupError(axiosError(409, body("BACKUP_BUSY"))).message).toBe(MSG.busy)
    expect(parseBackupError(axiosError(409, body("BACKUP_KEY_CHANGED"))).message).toBe(MSG.keyChanged)
    expect(parseBackupError(axiosError(409, body("BACKUP_DESTINATION_MISSING"))).message).toBe(MSG.destinationMissing)
    expect(parseBackupError(axiosError(503, body("QUEUE_UNAVAILABLE"))).message).toBe(MSG.queueUnavailable)
    expect(parseBackupError(axiosError(503, body("STEPUP_UNAVAILABLE"))).message).toBe(MSG.stepUpUnavailable)
    expect(parseBackupError(axiosError(503, body("SECRETS_KEY_MISSING"))).message).toBe(MSG.secretsKeyMissing)
    expect(parseBackupError(axiosError(409, body("PUBLIC_URL_UNKNOWN"))).message).toBe(MSG.publicUrlUnknown)
  })

  it("nunca ecoa o `error` do servidor, nem em código desconhecido", () => {
    for (const [status, code] of [[500, "INTERNAL_ERROR"], [418, "ALGO_NOVO"], [503, "OUTRO"], [400, "VALIDATION_ERROR"]] as const) {
      expect(parseBackupError(axiosError(status, body(code, { details: [{ path: "hourLocal" }] }))).message).not.toMatch(/TEXTO-CRU|SEGREDO/)
    }
    expect(parseBackupError(axiosError(400, body("VALIDATION_ERROR", { details: [{ path: "retentionCount" }] }))).fields).toEqual(["retentionCount"])
  })

  it("sem code: 429 vira limite, 503 indisponível, 5xx interno", () => {
    expect(parseBackupError(axiosError(429, {})).message).toMatch(/Muitas tentativas/)
    expect(parseBackupError(axiosError(503, {})).message).toBe(MSG.unavailable)
    expect(parseBackupError(axiosError(502, {})).message).toBe(MSG.internal)
  })
})

describe("texto por código de execução", () => {
  it("todo código do contrato tem texto próprio; desconhecido cai em UNKNOWN", () => {
    const codes = ["CONFIG", "CREDENTIAL", "FOLDER", "QUOTA", "NETWORK", "OAUTH_DISCONNECTED", "DUMP", "DUMP_TIMEOUT", "KEY", "SECRETS_KEY", "TOO_BIG", "NO_BACKUP", "VERIFY", "CHECKSUM", "BUSY", "INTERRUPTED", "NOT_PICKED_UP", "UNKNOWN"]
    const titles = new Set(codes.map((c) => runErrorText(c).title))
    expect(titles.size).toBe(codes.length)
    expect(runErrorText("NOVO_CODIGO").title).toBe(runErrorText("UNKNOWN").title)
    expect(runErrorText(null).title).toBe(runErrorText("UNKNOWN").title)
  })
  it("estado de uma linha: teste sem destino é 'Só teste', não 'Enviado'", () => {
    expect(runStateLabel({ status: "SUCCESS", trigger: "MANUAL", objectKey: "a/b" }).label).toBe("Enviado")
    expect(runStateLabel({ status: "SUCCESS", trigger: "MANUAL", objectKey: null }).label).toBe("Só teste")
    expect(runStateLabel({ status: "SUCCESS", trigger: "VERIFY", objectKey: null }).label).toBe("Conferida")
    expect(runStateLabel({ status: "FAILED", trigger: "VERIFY", objectKey: null }).label).toBe("Reprovou")
    expect(runStateLabel({ status: "FAILED", trigger: "SCHEDULED", objectKey: null }).label).toBe("Falhou")
  })
})

describe("retorno do Google", () => {
  it("ok e erro com motivo conhecido", () => {
    expect(parseGoogleReturn("?google=ok")).toEqual({ ok: true })
    expect(parseGoogleReturn("?google=erro&motivo=access_denied")).toEqual({ ok: false, reason: "access_denied" })
  })
  it("motivo desconhecido ou ausente vira `unknown` (nunca ecoa a URL)", () => {
    expect(parseGoogleReturn("?google=erro&motivo=<script>")).toEqual({ ok: false, reason: "unknown" })
    expect(parseGoogleReturn("?google=erro")).toEqual({ ok: false, reason: "unknown" })
    expect(parseGoogleReturn("?google=outra")).toBeNull()
    expect(parseGoogleReturn("")).toBeNull()
  })
  it("os 11 motivos do contrato têm texto", () => {
    for (const m of ["invalid_state", "access_denied", "refused_by_google", "no_code", "bad_credentials", "no_refresh_token", "account_check_failed", "folder_create_failed", "secrets_key_missing", "network", "unknown"]) {
      expect(parseGoogleReturn(`?google=erro&motivo=${m}`)).toEqual({ ok: false, reason: m })
    }
  })
  it("limpa só google/motivo da query", () => {
    expect(withoutGoogleParams("?google=erro&motivo=network")).toBe("")
    expect(withoutGoogleParams("?google=ok&x=1")).toBe("?x=1")
  })
  it("só navega para https://accounts.google.com", () => {
    expect(isSafeGoogleUrl("https://accounts.google.com/o/oauth2/v2/auth?x=1")).toBe(true)
    for (const bad of ["http://accounts.google.com/", "https://accounts.google.com.evil.com/", "javascript:alert(1)", "/admin", "https://evil.com/?https://accounts.google.com", ""]) {
      expect(isSafeGoogleUrl(bad)).toBe(false)
    }
  })
})

describe("escopos por cartão (Agendamento / Destino)", () => {
  const mixed = draft({
    enabled: false,
    retentionCount: "9",
    alertAfterHours: "48",
    destination: "DRIVE",
    s3: { bucket: "outro", secretKey: "SEGREDO" },
    drive: { clientId: "novo" },
    clear: { s3AccessKey: true },
  })

  it("scopeDraft mantém só o pedaço do cartão; clearDraftScope descarta só esse pedaço", () => {
    const schedule = scopeDraft(mixed, "schedule")
    expect(schedule.retentionCount).toBe("9")
    expect(schedule.alertAfterHours).toBe("48")
    expect(schedule.destination).toBeUndefined()
    expect(schedule.s3).toEqual({})
    expect(schedule.clear).toEqual({})
    const destination = scopeDraft(mixed, "destination")
    expect(destination.destination).toBe("DRIVE")
    expect(destination.s3).toEqual({ bucket: "outro", secretKey: "SEGREDO" })
    expect(destination.clear).toEqual({ s3AccessKey: true })
    expect(destination.retentionCount).toBeUndefined()
    expect(destination.enabled).toBeUndefined()
    // depois de salvar o Agendamento, o Destino segue editando
    const afterSchedule = clearDraftScope(mixed, "schedule")
    expect(afterSchedule.retentionCount).toBeUndefined()
    expect(afterSchedule.destination).toBe("DRIVE")
    expect(afterSchedule.s3.secretKey).toBe("SEGREDO")
    // e vice-versa: salvar o Destino leva embora o segredo digitado, mas não a retenção
    const afterDestination = clearDraftScope(mixed, "destination")
    expect(afterDestination.s3).toEqual({})
    expect(afterDestination.drive).toEqual({})
    expect(afterDestination.retentionCount).toBe("9")
  })

  it("cada cartão envia só o seu diff (o segredo digitado no Destino NUNCA vai no PUT do Agendamento)", () => {
    const base = READY()
    expect(buildUpdatePayload(base, scopeDraft(mixed, "schedule"))).toEqual({ enabled: false, retentionCount: 9, alertAfterHours: 48 })
    const dest = buildUpdatePayload(base, scopeDraft(mixed, "destination"))
    expect(dest).not.toHaveProperty("retentionCount")
    expect(dest).not.toHaveProperty("alertAfterHours")
    expect(dest.destination).toBe("DRIVE")
    expect(JSON.stringify(buildUpdatePayload(base, scopeDraft(mixed, "schedule")))).not.toContain("SEGREDO")
  })

  it("exigeSenha por cartão: horário/frequência/alerta não pedem; cópias a manter e ligar pedem; destino pede", () => {
    const base = READY()
    expect(exigeSenha(buildUpdatePayload(base, scopeDraft(draft({ hourLocal: "5", frequencyDays: 7, alertAfterHours: "48" }), "schedule")))).toBe(false)
    expect(exigeSenha(buildUpdatePayload(base, scopeDraft(draft({ retentionCount: "3" }), "schedule")))).toBe(true)
    expect(exigeSenha(buildUpdatePayload(base, scopeDraft(draft({ s3: { bucket: "x" } }), "destination")))).toBe(true)
  })

  it("LIGAR só vale com o destino JÁ SALVO: completar o destino no rascunho do outro cartão não libera o interruptor", () => {
    const sem = dto({}, {}, {}, { exists: true, fingerprint: "aaaaaaaa" })
    const completando = draft({ enabled: true, destination: "S3", s3: { endpoint: "https://a.com", bucket: "bk", accessKey: "AK", secretKey: "SK" } })
    // visão do cartão Agendamento: o destino digitado e não salvo não conta
    expect(enableBlockers(sem, scopeDraft(completando, "schedule")).join(" ")).toMatch(/Complete e salve o destino/)
    expect(validateDraft(sem, scopeDraft(completando, "schedule")).enabled).toMatch(/destino/i)
    // visão do cartão Destino: sem ligar nada, não há erro de "ligar"
    expect(validateDraft(sem, scopeDraft(completando, "destination")).enabled).toBeUndefined()
  })

  it("já ligado: o cartão Destino continua barrando uma alteração que o deixaria incompleto; o Agendamento não se mete", () => {
    const apagar = draft({ clear: { s3SecretKey: true }, retentionCount: "9" })
    expect(validateDraft(READY(), scopeDraft(apagar, "destination")).destination).toMatch(/completo/)
    expect(validateDraft(READY(), scopeDraft(apagar, "schedule")).destination).toBeUndefined()
  })
})

describe("situação da faixa de estado (selo)", () => {
  it("Em dia / Atrasado / Nunca rodou / Desligado / Copiando agora, pelo mesmo healthOf", () => {
    expect(situationOf(status(), true)).toMatchObject({ tone: "success", label: "Em dia", detail: null, health: "ok" })
    expect(situationOf(status({ stale: true, ageHours: 79 }), true)).toMatchObject({ tone: "danger", label: "Atrasado", detail: "Sem backup há 3 dias e 7 h", health: "late" })
    expect(situationOf(status({ neverRan: true, lastSuccessAt: null, ageHours: null }), true)).toMatchObject({ tone: "danger", label: "Nunca rodou", health: "never" })
    expect(situationOf(status(), false)).toMatchObject({ tone: "neutral", label: "Desligado", health: "off" })
    expect(situationOf(status({ running: true }), true)).toMatchObject({ tone: "primary", label: "Copiando agora" })
  })
})

describe("textos do JWT_SECRET (a chave dos segredos agora é derivada dele)", () => {
  it("o aviso permanente é o texto do dono e nenhum texto de erro cita PAYMENT_SECRETS_KEY", () => {
    expect(SECRETS_KEY_NOTICE).toBe(
      "Os segredos salvos (credenciais, senhas, tokens) são cifrados com uma chave derivada do JWT_SECRET do servidor. Guarde uma cópia dele fora do sistema: se ele for trocado, os segredos salvos precisam ser cadastrados de novo.",
    )
    const all = [
      MSG.secretsKeyMissing,
      NO_SECRETS_KEY_MESSAGE,
      runErrorText("SECRETS_KEY").title,
      runErrorText("SECRETS_KEY").action,
      ...enableBlockers(dto({ secretsKeyConfigured: false }), EMPTY_DRAFT),
      ...enableBlockers(dto({ secretsReadable: false }), EMPTY_DRAFT),
    ].join(" ")
    expect(all).toMatch(/JWT_SECRET/)
    expect(all).not.toMatch(/PAYMENT_SECRETS_KEY/)
    // o NOME do código do servidor continua o mesmo
    expect(parseBackupError(axiosError(503, { code: "SECRETS_KEY_MISSING" })).code).toBe("SECRETS_KEY_MISSING")
  })
})

describe("erro KEY x SECRETS_KEY (JWT_SECRET trocado): cada um aponta para a sua saída", () => {
  it("KEY manda gerar a chave do backup de novo; não manda cadastrar o destino", () => {
    const { title, action } = runErrorText("KEY")
    expect(title).toMatch(/chave do backup/i)
    expect(action).toMatch(/Gere a chave de novo/)
    expect(action).not.toMatch(/Cadastre o destino/i)
  })

  it("SECRETS_KEY manda cadastrar o destino de novo; não manda gerar a chave", () => {
    const { title, action } = runErrorText("SECRETS_KEY")
    expect(title).toMatch(/destino/i)
    expect(action).toMatch(/Cadastre o destino de novo/)
    expect(action).not.toMatch(/Gere a chave/i)
  })

  it("o 'Testar destino' usa o mesmo texto por código", () => {
    expect(testDestinationText("KEY")).toEqual(runErrorText("KEY"))
    expect(testDestinationText("SECRETS_KEY")).toEqual(runErrorText("SECRETS_KEY"))
  })
})

describe("formatação", () => {
  it("data e hora longas em Brasília (dd/mm/aaaa às hh:mm), independentes do fuso do navegador", () => {
    expect(formatBrasiliaLong("2026-10-05T17:30:00.000Z")).toBe("05/10/2026 às 14:30")
    expect(formatBrasiliaLong("2026-10-05T02:05:00.000Z")).toBe("04/10/2026 às 23:05")
    expect(formatBrasiliaLong(null)).toBe("—")
    expect(formatBrasiliaLong("lixo")).toBe("—")
  })

  it("bytes, duração, idade e espera", () => {
    expect(formatBytes(null)).toBe("—")
    expect(formatBytes(512)).toBe("512 B")
    expect(formatBytes(148_234_567)).toBe("141 MB")
    expect(formatBytes(1536)).toBe("1,5 KB")
    expect(formatDuration(850)).toBe("850 ms")
    expect(formatDuration(134_000)).toBe("2 min 14 s")
    expect(formatDuration(120_000)).toBe("2 min")
    expect(formatAge(0.4)).toBe("menos de 1 hora")
    expect(formatAge(5)).toBe("5 h")
    expect(formatAge(79)).toBe("3 dias e 7 h")
    expect(formatAge(24)).toBe("1 dia")
    expect(formatAge(24 * 12 + 3)).toBe("12 dias")
    expect(formatWait(1)).toBe("1 segundo")
    expect(formatWait(45)).toBe("45 segundos")
    expect(formatWait(600)).toBe("10 minutos")
    expect(formatWait(undefined)).toBeNull()
  })
})

function status(over: Partial<BackupStatusDTO> = {}): BackupStatusDTO {
  return { lastSuccessAt: "2026-10-04T10:00:00.000Z", lastAttemptAt: null, running: false, stale: false, neverRan: false, ageHours: 4, nextRunAt: null, activeRun: null, lastBackupRun: null, lastVerifyRun: null, ...over }
}
function run(over: Partial<BackupRunDTO> = {}): BackupRunDTO {
  return { id: "r1", trigger: "MANUAL", status: "QUEUED", destination: "S3", createdAt: "2026-10-05T10:00:00.000Z", startedAt: null, finishedAt: null, durationMs: null, fileName: null, objectKey: null, sizeBytes: null, checksumSha256: null, tablesWithData: null, keyFingerprint: null, errorCode: null, errorMessage: null, ...over }
}

describe("estado geral e polling", () => {
  it("atrasado vira alerta 'Sem backup há X'; nunca rodou vira alerta próprio", () => {
    const late = healthOf(status({ stale: true, ageHours: 79 }), true)
    expect(late.tone).toBe("late")
    expect(late.title).toBe("Sem backup há 3 dias e 7 h")
    expect(healthOf(status({ neverRan: true, lastSuccessAt: null, ageHours: null }), true).tone).toBe("never")
    expect(healthOf(status(), true).tone).toBe("ok")
    expect(healthOf(status(), false).tone).toBe("off")
  })

  it("isBusy: execução ativa OU trava viva", () => {
    expect(isBusy(undefined)).toBe(false)
    expect(isBusy(status())).toBe(false)
    expect(isBusy(status({ running: true }))).toBe(true)
    expect(isBusy(status({ activeRun: run() }))).toBe(true)
  })

  it("o estado geral só faz polling enquanto algo roda", () => {
    expect(statusRefetchInterval(undefined)).toBe(false)
    expect(statusRefetchInterval(status())).toBe(false)
    expect(statusRefetchInterval(status({ activeRun: run() }))).toBe(3000)
  })

  it("a execução acompanhada: polling até o estado final, e para depois de 3 falhas seguidas", () => {
    expect(runRefetchInterval(undefined, 0)).toBe(2500)
    expect(runRefetchInterval(run({ status: "QUEUED" }), 0)).toBe(2500)
    expect(runRefetchInterval(run({ status: "RUNNING" }), 2)).toBe(2500)
    expect(runRefetchInterval(run({ status: "RUNNING" }), 3)).toBe(false)
    expect(runRefetchInterval(run({ status: "SUCCESS" }), 0)).toBe(false)
    expect(runRefetchInterval(run({ status: "FAILED" }), 0)).toBe(false)
  })

  it("fila parada: avisa depois de 1 minuto", () => {
    const created = new Date("2026-10-05T10:00:00.000Z").getTime()
    expect(queuedTooLong(run(), created + QUEUED_HINT_AFTER_MS - 1)).toBe(false)
    expect(queuedTooLong(run(), created + QUEUED_HINT_AFTER_MS)).toBe(true)
    expect(queuedTooLong(run({ status: "RUNNING" }), created + 10 * QUEUED_HINT_AFTER_MS)).toBe(false)
    expect(queuedTooLong(null, 0)).toBe(false)
  })
})

describe("motivo de botão desabilitado (sempre escrito)", () => {
  const ready = { destination: "S3" as const, destinationReady: true }
  it("em andamento e alteração não salva bloqueiam as três ações", () => {
    expect(actionBlockReason("run", { dto: ready, dirty: false, busy: true })).toMatch(/em andamento/)
    expect(actionBlockReason("verify", { dto: ready, dirty: true, busy: false })).toMatch(/não salvas/)
    expect(actionBlockReason("test", { dto: ready, dirty: true, busy: false })).toMatch(/não salvas/)
    expect(actionBlockReason("run", { dto: ready, dirty: false, busy: false })).toBeNull()
  })
  it("sem destino: só 'fazer agora' (que vira teste do pg_dump) está liberado", () => {
    const none = { destination: null, destinationReady: false }
    expect(actionBlockReason("run", { dto: none, dirty: false, busy: false })).toBeNull()
    expect(actionBlockReason("verify", { dto: none, dirty: false, busy: false })).toMatch(/Escolha um destino/)
    expect(actionBlockReason("test", { dto: none, dirty: false, busy: false })).toMatch(/Escolha um destino/)
  })
  it("destino incompleto bloqueia as três", () => {
    const incomplete = { destination: "S3" as const, destinationReady: false }
    for (const kind of ["run", "verify", "test"] as const) expect(actionBlockReason(kind, { dto: incomplete, dirty: false, busy: false })).toMatch(/incompleto/)
  })
  it("conectar o Google: alteração pendente, Client ID/Secret ausentes e URL pública desconhecida", () => {
    const d = dto({}, {}, { clientId: "abc", clientSecretSet: true })
    expect(connectBlockReason(d, false)).toBeNull()
    expect(connectBlockReason(d, true)).toMatch(/não salvas/)
    expect(connectBlockReason(dto(), false)).toMatch(/Client ID/)
    expect(connectBlockReason(dto({}, {}, { clientId: "abc" }), false)).toMatch(/Client Secret/)
    expect(connectBlockReason(dto({}, {}, { clientId: "abc", clientSecretSet: true, redirectUri: null }), false)).toMatch(/PUBLIC_API_BASE_URL/)
  })
})
