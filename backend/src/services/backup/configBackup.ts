import type { BackupConfig, Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { decryptPaymentSecret, encryptPaymentSecret, isPaymentSecretsKeyConfigured } from '../../lib/crypto/paymentSecrets'
import { BackupCryptoError, backupKeyFileText, formatBackupKey, generateBackupKey, keyFingerprint, parseBackupKey } from '../../lib/crypto/backupCrypto'
import { politicaDeDestinoDoBackup } from '../../lib/backup/s3'
import { diffEntity, type EntityDiff } from '../../core/auditoria/diffEntity'
import { enderecoNormalizado, prefixoNormalizado, validarEnderecoS3 } from '../../core/backup/enderecoS3'
import { ErroDeBackup } from '../../core/backup/erros'
import { CONFIRMACAO_TROCAR_CHAVE, TRAVA_EXPIRA_EM_MS, destinoAtivo, proximaExecucaoAgendada, situacaoDeAtraso, type DestinoDeBackup } from '../../core/backup/politica'
import { AppError } from '../../api/middleware/errorHandler'
import type { UpdateBackupConfigBody } from '../../api/schemas/backup.schema'
import { writeAuditLog } from '../auditoria/writeAuditLog'

/**
 * Configuração do backup (`BackupConfig`, singleton) — leitura, DTO, gravação e chave de criptografia.
 *
 *  - SEGREDOS (access/secret key do S3, client secret e refresh token do Google, cópia da chave do backup): cifrados com `encryptPaymentSecret` (mesma chave/formato dos
 *    pagamentos); NUNCA em log, auditoria, erro ou resposta. O DTO só diz se EXISTEM.
 *  - AUDITORIA FAIL-CLOSED: a gravação e a linha de `AuditLog` saem na MESMA transação; se a auditoria falhar, nada é gravado. `changes` leva só NOMES de campos e `{changed:true}` nos
 *    segredos (nunca o valor, nem cifrado).
 *  - CONCORRÊNCIA: `SELECT ... FOR UPDATE` na linha singleton serializa dois admins gravando juntos.
 *  - ANTI-EXFILTRAÇÃO: trocar o ENDEREÇO do bucket com segredo salvo exige reenviar o segredo (senão uma sessão roubada apontaria o endpoint para um servidor do atacante e receberia a
 *    credencial salva — e, no próximo backup, o dump cifrado — sem saber nenhuma senha).
 *  - ANTI-SSRF: o endereço passa por `core/backup/enderecoS3.ts` (e a conexão revalida o DNS).
 *  - LIGAR o automático exige destino completo E chave do backup: sem isso o primeiro backup agendado falharia de madrugada, sem ninguém olhando.
 */

export type LinhaDeBackup = BackupConfig

export async function carregarConfigDeBackup(tx: Prisma.TransactionClient | typeof prisma = prisma): Promise<LinhaDeBackup> {
  const existente = await tx.backupConfig.findUnique({ where: { id: 1 } })
  if (existente) return existente
  // A migration já semeia a linha; isto é só a rede de segurança (banco restaurado de antes da migration, teste).
  return tx.backupConfig.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} })
}

// ---------------------------------------------------------------------------------------------
// Segredos
// ---------------------------------------------------------------------------------------------

/** Decifra um segredo da config. Lança `ErroDeBackup('SECRETS_KEY')` (sem o conteúdo) se a PAYMENT_SECRETS_KEY faltar ou não decifrar. */
export function lerSegredoDaConfig(ciphertext: string | null, campo: string): string | null {
  if (!ciphertext) return null
  try {
    return decryptPaymentSecret(ciphertext)
  } catch {
    logger.error({ campo }, '[backup] não consegui decifrar um segredo da configuração (PAYMENT_SECRETS_KEY trocada ou ausente)')
    throw new ErroDeBackup('Não foi possível decifrar os segredos do backup.', 'SECRETS_KEY')
  }
}

/** A chave do backup, decifrada do banco. `ErroDeBackup('KEY'|'SECRETS_KEY')` se faltar, não decifrar ou a impressão digital não bater. */
export function chaveDoBackupDaConfig(config: Pick<LinhaDeBackup, 'encryptionKeyCiphertext' | 'encryptionKeyFingerprint'>): { chave: Buffer; impressaoDigital: string } {
  if (!config.encryptionKeyCiphertext || !config.encryptionKeyFingerprint) throw new ErroDeBackup('Falta a chave de criptografia do backup.', 'KEY')
  const hex = lerSegredoDaConfig(config.encryptionKeyCiphertext, 'encryptionKey')
  const chave = hex ? parseBackupKey(hex) : null
  if (!chave || keyFingerprint(chave) !== config.encryptionKeyFingerprint) throw new ErroDeBackup('A chave de backup guardada no sistema não confere com a impressão digital registrada.', 'KEY')
  return { chave, impressaoDigital: config.encryptionKeyFingerprint }
}

function segredosLegiveis(config: LinhaDeBackup): boolean {
  if (!isPaymentSecretsKeyConfigured()) return false
  const campos: Array<[string | null, string]> = [
    [config.s3AccessKeyCiphertext, 's3AccessKey'],
    [config.s3SecretKeyCiphertext, 's3SecretKey'],
    [config.driveOauthClientSecretCiphertext, 'driveClientSecret'],
    [config.driveOauthRefreshTokenCiphertext, 'driveRefreshToken'],
    [config.encryptionKeyCiphertext, 'encryptionKey'],
  ]
  for (const [valor] of campos) {
    if (!valor) continue
    try {
      decryptPaymentSecret(valor)
    } catch {
      return false
    }
  }
  return true
}

// ---------------------------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------------------------

export type ProblemaParaLigar = 'DESTINATION_INCOMPLETE' | 'KEY_MISSING' | 'SECRETS_KEY_MISSING' | 'SECRETS_UNREADABLE'

export interface BackupConfigDto {
  enabled: boolean
  hourLocal: number
  frequencyDays: number
  retentionCount: number
  alertAfterHours: number
  destination: DestinoDeBackup | null
  destinationReady: boolean
  s3: { endpoint: string | null; region: string | null; bucket: string | null; prefix: string | null; accessKeySet: boolean; secretKeySet: boolean }
  drive: { clientId: string | null; clientSecretSet: boolean; connected: boolean; connectedAt: string | null; accountEmail: string | null }
  encryptionKey: { exists: boolean; fingerprint: string | null; createdAt: string | null; shownAt: string | null }
  secretsKeyConfigured: boolean
  secretsReadable: boolean
  /** O que ainda falta para ligar o automático (vazio = pode ligar). */
  problemsToEnable: ProblemaParaLigar[]
  updatedAt: string
}

export function problemasParaLigar(config: LinhaDeBackup, secretsKeyConfigured: boolean, secretsReadable: boolean): ProblemaParaLigar[] {
  const problemas: ProblemaParaLigar[] = []
  if (destinoAtivo(config) === null) problemas.push('DESTINATION_INCOMPLETE')
  if (!config.encryptionKeyCiphertext) problemas.push('KEY_MISSING')
  if (!secretsKeyConfigured) problemas.push('SECRETS_KEY_MISSING')
  else if (!secretsReadable) problemas.push('SECRETS_UNREADABLE')
  return problemas
}

/** O que a tela pode ver. Lista EXPLÍCITA: um segredo que escapa para a resposta não dá erro em lugar nenhum, some no meio de um objeto que "funciona". */
export function toBackupConfigDto(config: LinhaDeBackup): BackupConfigDto {
  const chaveConfigurada = isPaymentSecretsKeyConfigured()
  const legiveis = segredosLegiveis(config)
  return {
    enabled: config.enabled,
    hourLocal: config.hourLocal,
    frequencyDays: config.frequencyDays,
    retentionCount: config.retentionCount,
    alertAfterHours: config.alertAfterHours,
    destination: config.destination,
    destinationReady: destinoAtivo(config) !== null,
    s3: {
      endpoint: config.s3Endpoint,
      region: config.s3Region,
      bucket: config.s3Bucket,
      prefix: config.s3Prefix,
      accessKeySet: Boolean(config.s3AccessKeyCiphertext),
      secretKeySet: Boolean(config.s3SecretKeyCiphertext),
    },
    drive: {
      clientId: config.driveOauthClientId,
      clientSecretSet: Boolean(config.driveOauthClientSecretCiphertext),
      connected: Boolean(config.driveOauthConnectedAt && config.driveOauthRefreshTokenCiphertext),
      connectedAt: config.driveOauthConnectedAt?.toISOString() ?? null,
      accountEmail: config.driveOauthEmail,
    },
    encryptionKey: {
      exists: Boolean(config.encryptionKeyCiphertext),
      fingerprint: config.encryptionKeyFingerprint,
      createdAt: config.encryptionKeyCreatedAt?.toISOString() ?? null,
      shownAt: config.encryptionKeyShownAt?.toISOString() ?? null,
    },
    secretsKeyConfigured: chaveConfigurada,
    secretsReadable: legiveis,
    problemsToEnable: problemasParaLigar(config, chaveConfigurada, legiveis),
    updatedAt: config.updatedAt.toISOString(),
  }
}

export interface BackupStatusDto {
  lastSuccessAt: string | null
  lastAttemptAt: string | null
  /** Há uma execução em andamento (trava viva). */
  running: boolean
  stale: boolean
  neverRan: boolean
  ageHours: number | null
  /** Próxima execução agendada (Brasília), ISO. `null` com o automático desligado. */
  nextRunAt: string | null
}

export function toBackupStatusDto(config: LinhaDeBackup, agora: Date): BackupStatusDto {
  const atraso = situacaoDeAtraso(config, agora)
  return {
    lastSuccessAt: config.lastSuccessAt?.toISOString() ?? null,
    lastAttemptAt: config.lastAttemptAt?.toISOString() ?? null,
    running: Boolean(config.runningSince && agora.getTime() - config.runningSince.getTime() < TRAVA_EXPIRA_EM_MS),
    stale: atraso.atrasado,
    neverRan: atraso.nuncaRodou && config.enabled,
    ageHours: atraso.idadeEmHoras,
    nextRunAt: config.enabled ? proximaExecucaoAgendada(config.hourLocal, agora).toISOString() : null,
  }
}

// ---------------------------------------------------------------------------------------------
// Gravação (PUT)
// ---------------------------------------------------------------------------------------------

export interface AtorDaConfigDeBackup {
  userId: string
  role: 'ADMIN' | 'OPERATOR' | 'DRIVER'
  email: string
  name: string
  operatorId: string | null
}

export interface RequisicaoDaConfigDeBackup {
  method: string
  path: string
  ipAddress: string | null
  userAgent: string | null
  requestId: string | null
}

/**
 * Este PUT mexe em algo que exige a senha do ADMIN (step-up)? Só dispensa quem muda horário/frequência/limite de alerta ou DESLIGA o automático: tudo que aponta para onde o
 * dump vai, que credencial usa, quantas cópias sobram (reduzir apaga cópias no próximo backup) ou LIGA o automático exige.
 */
export function exigeSenhaDoAdmin(body: UpdateBackupConfigBody): boolean {
  const inofensivos = new Set(['hourLocal', 'frequencyDays', 'alertAfterHours'])
  for (const campo of Object.keys(body)) {
    if (inofensivos.has(campo)) continue
    if (campo === 'enabled' && body.enabled === false) continue
    return true
  }
  return false
}

const CAMPOS_AUDITAVEIS = ['enabled', 'hourLocal', 'frequencyDays', 'retentionCount', 'alertAfterHours', 'destination', 's3Endpoint', 's3Region', 's3Bucket', 's3Prefix', 'driveOauthClientId'] as const

function snapshotAuditavel(c: LinhaDeBackup): Record<string, unknown> {
  return {
    enabled: c.enabled,
    hourLocal: c.hourLocal,
    frequencyDays: c.frequencyDays,
    retentionCount: c.retentionCount,
    alertAfterHours: c.alertAfterHours,
    destination: c.destination,
    s3Endpoint: c.s3Endpoint,
    s3Region: c.s3Region,
    s3Bucket: c.s3Bucket,
    s3Prefix: c.s3Prefix,
    driveOauthClientId: c.driveOauthClientId,
  }
}

function mesmoHost(a: string | null, b: string): boolean {
  const host = (u: string): string => {
    try {
      return new URL(u).host.toLowerCase()
    } catch {
      return u.toLowerCase()
    }
  }
  return a !== null && host(a) === host(b)
}

function erroDeValidacao(campo: string, codigo: string, mensagem: string, status = 400): AppError {
  return new AppError(mensagem, status, codigo, [{ field: campo }])
}

export async function atualizarConfigDeBackup(params: {
  body: UpdateBackupConfigBody
  actor: AtorDaConfigDeBackup
  request: RequisicaoDaConfigDeBackup
  agora?: Date
}): Promise<{ config: LinhaDeBackup; camposAlterados: string[] }> {
  const { body, actor, request } = params
  const agora = params.agora ?? new Date()
  const temSegredoNovo = body.s3?.accessKey !== undefined || body.s3?.secretKey !== undefined || body.drive?.clientSecret !== undefined
  if (temSegredoNovo && !isPaymentSecretsKeyConfigured()) {
    throw new AppError('O servidor não tem a chave de cifragem (PAYMENT_SECRETS_KEY) configurada: não é possível guardar credenciais.', 503, 'SECRETS_KEY_MISSING')
  }
  const politica = politicaDeDestinoDoBackup()
  let enderecoNovo: string | undefined
  if (body.s3?.endpoint !== undefined) {
    const v = validarEnderecoS3(body.s3.endpoint, politica)
    if (!v.ok) throw erroDeValidacao('s3.endpoint', v.codigo === 'DESTINATION_NOT_ALLOWED' ? 'DESTINATION_NOT_ALLOWED' : v.codigo, v.mensagem)
    enderecoNovo = enderecoNormalizado(v.url)
  }
  const limpar = new Set(body.clearSecrets ?? [])

  const resultado = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`INSERT INTO "BackupConfig" ("id", "updatedAt") VALUES (1, NOW()) ON CONFLICT ("id") DO NOTHING`
    await tx.$queryRaw`SELECT "id" FROM "BackupConfig" WHERE "id" = 1 FOR UPDATE`
    const antes = await tx.backupConfig.findUniqueOrThrow({ where: { id: 1 } })
    const data: Prisma.BackupConfigUpdateInput = {}
    const segredosAlterados: string[] = []

    if (body.hourLocal !== undefined) data.hourLocal = body.hourLocal
    if (body.frequencyDays !== undefined) data.frequencyDays = body.frequencyDays
    if (body.retentionCount !== undefined) data.retentionCount = body.retentionCount
    if (body.alertAfterHours !== undefined) data.alertAfterHours = body.alertAfterHours
    if (body.destination !== undefined) data.destination = body.destination

    const s3 = body.s3
    if (s3) {
      if (enderecoNovo !== undefined) {
        const mudouDestino = !mesmoHost(antes.s3Endpoint, enderecoNovo)
        const reenviouCredencial = s3.accessKey !== undefined && s3.secretKey !== undefined
        if (mudouDestino && (antes.s3AccessKeyCiphertext || antes.s3SecretKeyCiphertext) && !reenviouCredencial) {
          throw erroDeValidacao('s3.accessKey', 'SECRET_REQUIRED_FOR_NEW_DESTINATION', 'Ao trocar o endereço do bucket, informe a chave de acesso e o segredo de novo (as credenciais salvas não são reaproveitadas para outro destino).')
        }
        data.s3Endpoint = enderecoNovo
      }
      if (s3.region !== undefined) data.s3Region = s3.region
      if (s3.bucket !== undefined) data.s3Bucket = s3.bucket
      if (s3.prefix !== undefined) data.s3Prefix = s3.prefix === null ? null : prefixoNormalizado(s3.prefix) || null
      if (s3.accessKey !== undefined) {
        data.s3AccessKeyCiphertext = encryptPaymentSecret(s3.accessKey)
        segredosAlterados.push('s3AccessKey')
      }
      if (s3.secretKey !== undefined) {
        data.s3SecretKeyCiphertext = encryptPaymentSecret(s3.secretKey)
        segredosAlterados.push('s3SecretKey')
      }
    }
    if (limpar.has('s3AccessKey') && s3?.accessKey === undefined) {
      data.s3AccessKeyCiphertext = null
      segredosAlterados.push('s3AccessKey')
    }
    if (limpar.has('s3SecretKey') && s3?.secretKey === undefined) {
      data.s3SecretKeyCiphertext = null
      segredosAlterados.push('s3SecretKey')
    }

    const drive = body.drive
    if (drive) {
      if (drive.clientId !== undefined) {
        const novo = drive.clientId === null ? null : drive.clientId
        // Trocar o Client ID invalida a conexão anterior: o escopo `drive.file` só enxerga o que o app que criou o arquivo vê, e "app" aqui é o projeto do Google Cloud.
        if (novo !== antes.driveOauthClientId) {
          data.driveOauthRefreshTokenCiphertext = null
          data.driveOauthConnectedAt = null
          data.driveOauthEmail = null
          data.driveOauthFolderId = null
          data.driveOauthConnectedById = null
          if (antes.driveOauthRefreshTokenCiphertext) segredosAlterados.push('driveRefreshToken')
        }
        data.driveOauthClientId = novo
      }
      if (drive.clientSecret !== undefined) {
        data.driveOauthClientSecretCiphertext = encryptPaymentSecret(drive.clientSecret)
        segredosAlterados.push('driveClientSecret')
      }
    }
    if (limpar.has('driveClientSecret') && drive?.clientSecret === undefined) {
      data.driveOauthClientSecretCiphertext = null
      segredosAlterados.push('driveClientSecret')
    }

    // Estado FUTURO validado antes de gravar.
    const futuro = { ...antes, ...(data as Partial<LinhaDeBackup>) } as LinhaDeBackup
    const ligar = body.enabled ?? antes.enabled
    if (body.enabled !== undefined) {
      data.enabled = body.enabled
      if (body.enabled && !antes.enabled) data.enabledAt = agora
      if (!body.enabled) data.enabledAt = null
    }
    if (ligar) {
      if (destinoAtivo(futuro) === null) {
        throw new AppError('Escolha o destino e complete os dados antes de ligar o backup automático. Uma cópia que fica no mesmo servidor do banco morre junto com ele.', 409, 'BACKUP_DESTINATION_MISSING')
      }
      if (!futuro.encryptionKeyCiphertext) {
        throw new AppError('Gere a chave de criptografia antes de ligar o backup automático. Sem ela as cópias não saem do servidor.', 409, 'BACKUP_KEY_MISSING')
      }
    }
    data.updatedById = actor.userId

    const depois = await tx.backupConfig.update({ where: { id: 1 }, data })

    const changes: EntityDiff = { ...(diffEntity(snapshotAuditavel(antes), snapshotAuditavel(depois), CAMPOS_AUDITAVEIS) ?? {}) }
    for (const s of segredosAlterados) changes[s] = { changed: true } // marcador — NUNCA o valor, nem cifrado

    // FAIL-CLOSED: se isto lançar, o `$transaction` inteiro reverte.
    await writeAuditLog(
      {
        actorUserId: actor.userId,
        actorRole: actor.role,
        actorEmail: actor.email,
        actorName: actor.name,
        actorOperatorId: actor.operatorId,
        action: 'UPDATE',
        actionDetail: 'backup_config',
        outcome: 'SUCCESS',
        httpStatus: 200,
        entityType: 'BackupConfig',
        entityId: '1',
        method: request.method,
        path: request.path,
        ipAddress: request.ipAddress,
        userAgent: request.userAgent,
        requestId: request.requestId,
        changes: Object.keys(changes).length > 0 ? changes : null,
      },
      tx,
    )
    return { config: depois, camposAlterados: Object.keys(changes) }
  })

  // Só NOMES de campos (os enviados + os que mudaram) — nunca valores.
  const enviados = [
    ...Object.keys(body).filter((k) => k !== 's3' && k !== 'drive' && k !== 'clearSecrets'),
    ...Object.keys(body.s3 ?? {}).map((k) => `s3.${k}`),
    ...Object.keys(body.drive ?? {}).map((k) => `drive.${k}`),
    ...(body.clearSecrets ?? []).map((k) => `clear.${k}`),
  ]
  if (exigeSenhaDoAdmin(body)) {
    logger.warn({ alert: 'backup_config_changed', escopo: 'config', actorUserId: actor.userId, changedFields: [...new Set([...enviados, ...resultado.camposAlterados])] }, '[backup] configuração do backup alterada pelo admin')
  }
  return resultado
}

// ---------------------------------------------------------------------------------------------
// Chave do backup
// ---------------------------------------------------------------------------------------------

export interface ChaveGerada {
  /** A chave inteira, em 8 grupos. É a ÚNICA vez em que ela sai do servidor. */
  key: string
  fingerprint: string
  fileName: string
  fileText: string
  replaced: boolean
}

export async function gerarChaveDoBackup(params: {
  substituir: boolean
  confirmacao?: string
  impressaoEsperada?: string | null
  actor: AtorDaConfigDeBackup
  request: RequisicaoDaConfigDeBackup
  agora?: Date
}): Promise<ChaveGerada> {
  const { actor, request } = params
  const agora = params.agora ?? new Date()
  if (!isPaymentSecretsKeyConfigured()) {
    throw new AppError('O servidor não tem a chave de cifragem (PAYMENT_SECRETS_KEY) configurada: não é possível guardar a chave do backup.', 503, 'SECRETS_KEY_MISSING')
  }
  const chave = generateBackupKey()
  const impressao = keyFingerprint(chave)

  const substituiu = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`INSERT INTO "BackupConfig" ("id", "updatedAt") VALUES (1, NOW()) ON CONFLICT ("id") DO NOTHING`
    await tx.$queryRaw`SELECT "id" FROM "BackupConfig" WHERE "id" = 1 FOR UPDATE`
    const antes = await tx.backupConfig.findUniqueOrThrow({ where: { id: 1 } })
    const jaExiste = Boolean(antes.encryptionKeyCiphertext)
    if (jaExiste && !params.substituir) {
      throw new AppError('Já existe uma chave de backup. Para trocar, confirme que as cópias antigas continuam precisando da chave antiga.', 409, 'BACKUP_KEY_EXISTS')
    }
    if (jaExiste && params.confirmacao !== CONFIRMACAO_TROCAR_CHAVE) {
      throw new AppError(`Para trocar a chave, digite exatamente "${CONFIRMACAO_TROCAR_CHAVE}".`, 400, 'BACKUP_KEY_CONFIRMATION_REQUIRED')
    }
    if (params.impressaoEsperada !== undefined && params.impressaoEsperada !== antes.encryptionKeyFingerprint) {
      throw new AppError('A chave acabou de ser gerada por outra pessoa. Recarregue a tela para ver a impressão digital atual.', 409, 'BACKUP_KEY_CHANGED')
    }
    if (antes.runningSince && agora.getTime() - antes.runningSince.getTime() < TRAVA_EXPIRA_EM_MS) {
      throw new AppError('Há um backup em andamento: espere terminar para trocar a chave.', 409, 'BACKUP_BUSY')
    }
    await tx.backupConfig.update({
      where: { id: 1 },
      data: { encryptionKeyCiphertext: encryptPaymentSecret(chave.toString('hex')), encryptionKeyFingerprint: impressao, encryptionKeyCreatedAt: agora, encryptionKeyShownAt: agora, updatedById: actor.userId },
    })
    await writeAuditLog(
      {
        actorUserId: actor.userId,
        actorRole: actor.role,
        actorEmail: actor.email,
        actorName: actor.name,
        actorOperatorId: actor.operatorId,
        action: 'UPDATE',
        actionDetail: jaExiste ? 'backup_key:replaced' : 'backup_key:generated',
        outcome: 'SUCCESS',
        httpStatus: 201,
        entityType: 'BackupConfig',
        entityId: '1',
        method: request.method,
        path: request.path,
        ipAddress: request.ipAddress,
        userAgent: request.userAgent,
        requestId: request.requestId,
        // A impressão digital é PÚBLICA (8 hex de um hash; não permite recuperar a chave): é o que identifica qual chave cifrou cada cópia.
        changes: { encryptionKeyFingerprint: { from: antes.encryptionKeyFingerprint, to: impressao } },
      },
      tx,
    )
    return jaExiste
  })

  logger.warn({ alert: 'backup_config_changed', escopo: 'key', actorUserId: actor.userId, desfecho: substituiu ? 'replaced' : 'generated' }, '[backup] chave de criptografia do backup gerada pelo admin')
  return { key: formatBackupKey(chave), fingerprint: impressao, fileName: `chave-backup-innoflow-${impressao}.txt`, fileText: backupKeyFileText({ key: chave, createdAt: agora }), replaced: substituiu }
}

/** Traduz a falha de cifra em erro de backup com a causa que a pessoa consegue agir. */
export function erroDeCifraParaBackup(err: unknown): ErroDeBackup {
  if (err instanceof ErroDeBackup) return err
  if (err instanceof BackupCryptoError) {
    if (err.code === 'WRONG_KEY' || err.code === 'BAD_KEY') return new ErroDeBackup('Chave do backup diferente da que cifrou a cópia.', 'KEY')
    return new ErroDeBackup('A cópia não passou na verificação de integridade.', 'VERIFY')
  }
  return new ErroDeBackup('Erro inesperado.', 'UNKNOWN')
}
