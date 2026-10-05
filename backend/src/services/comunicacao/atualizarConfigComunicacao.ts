import type { NotificationChannelConfig, Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { encryptPaymentSecret, isPaymentSecretsKeyConfigured } from '../../lib/crypto/paymentSecrets'
import { diffEntity, type EntityDiff } from '../../core/auditoria/diffEntity'
import { mensagemDeDestinoBloqueado, validarHostDeclarado, type PoliticaDeDestino } from '../../core/comunicacao/destinoSeguro'
import { AppError } from '../../api/middleware/errorHandler'
import type { UpdateCommunicationSettingsBody } from '../../api/schemas/communicationSettings.schema'
import { normalizarNumeroWhatsapp, urlHttpValida } from '../../lib/alertas/config'
import { emailDeCampos, evolutionDeCampos, politicaDeDestinoDoPainel } from '../../lib/alertas/configDb'
import { writeAuditLog } from '../auditoria/writeAuditLog'
import { invalidarCacheComunicacao } from './configComunicacao'

/**
 * Grava a configuração de comunicação — `PUT /api/admin/communication-settings`. Mesmo desenho de `atualizarConfigGateway`:
 *  - AUDITORIA FAIL-CLOSED: o upsert e a linha de `AuditLog` (`UPDATE`, entidade `NotificationChannelConfig`) saem na MESMA transação; se a auditoria falhar, nada é gravado.
 *  - CONCORRÊNCIA: `INSERT ... ON CONFLICT DO NOTHING` garante a linha singleton e `SELECT ... FOR UPDATE` a trava até o commit (dois admins gravando juntos se serializam).
 *  - SEGREDOS (senha SMTP, apikey): cifrados com `encryptPaymentSecret` antes de tocar o banco; NUNCA em log nem na auditoria (nem cifrados) — `changes` leva só `{changed: true}`.
 *    Destinatários entram na auditoria só como CONTAGEM (e-mails/telefones são dado pessoal e a tabela é imutável por 24 meses).
 *  - ANTI-EXFILTRAÇÃO: trocar o DESTINO de um segredo salvo (host/usuário SMTP, URL/instância da Evolution) exige reenviar o segredo — senão uma sessão roubada poderia apontar
 *    o host para um servidor do atacante e receber a senha salva no próximo aviso.
 *  - ANTI-SSRF: host SMTP e URL da Evolution passam por `core/comunicacao/destinoSeguro.ts` (e a conexão repete a checagem na hora de conectar).
 *  - ALERTA `communication_config_changed`: emitido ANTES de invalidar o cache, para o aviso sair pela configuração ANTIGA (quem troca o destinatário não silencia o próprio aviso).
 */

export interface AtorConfigComunicacao {
  userId: string
  role: 'ADMIN' | 'OPERATOR' | 'DRIVER'
  email: string
  name: string
  operatorId: string | null
}

export interface RequisicaoConfigComunicacao {
  method: string
  path: string
  ipAddress: string | null
  userAgent: string | null
  requestId: string | null
}

const CAMPOS_AUDITAVEIS = [
  'emailEnabled', 'smtpHost', 'smtpPort', 'smtpSecure', 'smtpUser', 'emailFromName', 'emailFromAddress', 'emailMinSeverity', 'emailRecipientsCount',
  'whatsappEnabled', 'evolutionBaseUrl', 'evolutionInstance', 'evolutionApiVersion', 'whatsappMinSeverity', 'whatsappRecipientsCount', 'alertDedupeMinutes',
] as const

function snapshotAuditavel(r: NotificationChannelConfig): Record<string, unknown> {
  return {
    emailEnabled: r.emailEnabled,
    smtpHost: r.smtpHost,
    smtpPort: r.smtpPort,
    smtpSecure: r.smtpSecure,
    smtpUser: r.smtpUser,
    emailFromName: r.emailFromName,
    emailFromAddress: r.emailFromAddress,
    emailMinSeverity: r.emailMinSeverity,
    emailRecipientsCount: r.alertEmailRecipients.length,
    whatsappEnabled: r.whatsappEnabled,
    evolutionBaseUrl: r.evolutionBaseUrl,
    evolutionInstance: r.evolutionInstance,
    evolutionApiVersion: r.evolutionApiVersion,
    whatsappMinSeverity: r.whatsappMinSeverity,
    whatsappRecipientsCount: r.alertWhatsappRecipients.length,
    alertDedupeMinutes: r.alertDedupeMinutes,
  }
}

const distintos = (xs: string[]): string[] => [...new Set(xs)]
const mesmoHost = (a: string | null, b: string): boolean => (a ?? '').toLowerCase() === b.toLowerCase()

/** 400 DESTINATION_NOT_ALLOWED: o endereço informado aponta para um destino proibido. */
function destinoProibido(campo: string, motivo: string, mensagem: string): AppError {
  return new AppError(mensagem, 400, 'DESTINATION_NOT_ALLOWED', [{ field: campo, reason: motivo }])
}

function validarDestinos(body: UpdateCommunicationSettingsBody, politica: PoliticaDeDestino): void {
  if (body.email?.host !== undefined) {
    const motivo = validarHostDeclarado(body.email.host, politica)
    if (motivo) throw destinoProibido('email.host', motivo, mensagemDeDestinoBloqueado(motivo))
  }
  if (body.whatsapp?.baseUrl !== undefined) {
    const avisos: string[] = []
    const u = urlHttpValida(body.whatsapp.baseUrl, politica.producao, 'URL da Evolution API', avisos, politica.permitirRedePrivada)
    if (!u) throw destinoProibido('whatsapp.baseUrl', politica.producao && body.whatsapp.baseUrl.startsWith('http:') ? 'HTTPS_REQUIRED' : 'INVALID_URL', avisos[0] ?? 'URL inválida.')
    const motivo = validarHostDeclarado(u.hostname, politica)
    if (motivo) throw destinoProibido('whatsapp.baseUrl', motivo, mensagemDeDestinoBloqueado(motivo))
  }
}

function numerosNormalizados(brutos: string[]): string[] {
  const saida: string[] = []
  brutos.forEach((b, i) => {
    const n = normalizarNumeroWhatsapp(b)
    if (!n) throw new AppError('Número de WhatsApp inválido: use só dígitos com DDI (ex.: 5511999999999).', 400, 'VALIDATION_ERROR', [{ path: `whatsapp.recipients.${i}`, message: 'Número inválido.' }])
    saida.push(n)
  })
  return distintos(saida)
}

export async function atualizarConfigComunicacao(params: { body: UpdateCommunicationSettingsBody; actor: AtorConfigComunicacao; request: RequisicaoConfigComunicacao }): Promise<{ camposAlterados: string[] }> {
  const { body, actor, request } = params
  const temSegredoNovo = body.email?.password !== undefined || body.whatsapp?.apiKey !== undefined
  if (temSegredoNovo && !isPaymentSecretsKeyConfigured()) {
    throw new AppError('O servidor não tem a chave de cifragem dos segredos utilizável (JWT_SECRET ausente/curto, ou PAYMENT_SECRETS_KEY inválida): não é possível guardar senhas e chaves.', 503, 'SECRETS_KEY_MISSING')
  }
  const politica = politicaDeDestinoDoPainel(process.env)
  validarDestinos(body, politica)
  const whatsappRecipients = body.whatsapp?.recipients !== undefined ? numerosNormalizados(body.whatsapp.recipients) : undefined
  const emailRecipients = body.email?.recipients !== undefined ? distintos(body.email.recipients) : undefined
  const limpar = new Set(body.clearSecrets ?? [])

  const camposAlterados = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`INSERT INTO "NotificationChannelConfig" ("id", "updatedAt") VALUES (1, NOW()) ON CONFLICT ("id") DO NOTHING`
    await tx.$queryRaw`SELECT "id" FROM "NotificationChannelConfig" WHERE "id" = 1 FOR UPDATE`
    const antes = await tx.notificationChannelConfig.findUniqueOrThrow({ where: { id: 1 } })

    const data: Prisma.NotificationChannelConfigUpdateInput = {}
    const segredosAlterados: string[] = []
    const e = body.email
    const w = body.whatsapp

    if (e) {
      if (e.enabled !== undefined) data.emailEnabled = e.enabled
      else if (antes.emailEnabled === null) data.emailEnabled = false // 1ª gravação do grupo: nasce DESLIGADO, o admin liga de propósito
      if (e.host !== undefined) data.smtpHost = e.host
      if (e.port !== undefined) data.smtpPort = e.port
      if (e.secure !== undefined) data.smtpSecure = e.secure
      if (e.user !== undefined) data.smtpUser = e.user
      if (e.fromName !== undefined) data.emailFromName = e.fromName
      if (e.fromAddress !== undefined) data.emailFromAddress = e.fromAddress
      if (emailRecipients !== undefined) data.alertEmailRecipients = emailRecipients
      if (e.minSeverity !== undefined) data.emailMinSeverity = e.minSeverity
      const mudouDestino = (e.host !== undefined && !mesmoHost(antes.smtpHost, e.host)) || (e.user !== undefined && (e.user ?? null) !== antes.smtpUser)
      if (mudouDestino && antes.smtpPasswordCiphertext && e.password === undefined && !limpar.has('smtpPassword')) {
        throw new AppError('Ao trocar o servidor ou o usuário SMTP, informe a senha de novo (a senha salva não é reaproveitada para outro destino).', 400, 'SECRET_REQUIRED_FOR_NEW_DESTINATION', [{ field: 'email.password' }])
      }
      if (e.password !== undefined) {
        data.smtpPasswordCiphertext = encryptPaymentSecret(e.password)
        segredosAlterados.push('smtpPassword')
      }
    }
    if (limpar.has('smtpPassword') && e?.password === undefined) {
      data.smtpPasswordCiphertext = null
      segredosAlterados.push('smtpPassword')
    }

    if (w) {
      if (w.enabled !== undefined) data.whatsappEnabled = w.enabled
      else if (antes.whatsappEnabled === null) data.whatsappEnabled = false
      if (w.baseUrl !== undefined) data.evolutionBaseUrl = w.baseUrl
      if (w.instance !== undefined) data.evolutionInstance = w.instance
      if (w.apiVersion !== undefined) data.evolutionApiVersion = w.apiVersion
      if (whatsappRecipients !== undefined) data.alertWhatsappRecipients = whatsappRecipients
      if (w.minSeverity !== undefined) data.whatsappMinSeverity = w.minSeverity
      const mudouDestino = (w.baseUrl !== undefined && w.baseUrl.replace(/\/+$/, '') !== (antes.evolutionBaseUrl ?? '').replace(/\/+$/, '')) || (w.instance !== undefined && w.instance !== antes.evolutionInstance)
      if (mudouDestino && antes.evolutionApiKeyCiphertext && w.apiKey === undefined && !limpar.has('evolutionApiKey')) {
        throw new AppError('Ao trocar a URL ou a instância da Evolution, informe a apikey de novo (a chave salva não é reaproveitada para outro destino).', 400, 'SECRET_REQUIRED_FOR_NEW_DESTINATION', [{ field: 'whatsapp.apiKey' }])
      }
      if (w.apiKey !== undefined) {
        data.evolutionApiKeyCiphertext = encryptPaymentSecret(w.apiKey)
        segredosAlterados.push('evolutionApiKey')
      }
    }
    if (limpar.has('evolutionApiKey') && w?.apiKey === undefined) {
      data.evolutionApiKeyCiphertext = null
      segredosAlterados.push('evolutionApiKey')
    }

    if (body.alerts?.dedupeMinutes !== undefined) data.alertDedupeMinutes = body.alerts.dedupeMinutes

    const depois = await tx.notificationChannelConfig.update({ where: { id: 1 }, data })

    // Canal LIGADO tem de estar completo e dentro da política: senão 409 e a transação inteira volta (nada é gravado).
    if (depois.emailEnabled === true) {
      const avisos: string[] = []
      const ok = emailDeCampos(
        {
          host: depois.smtpHost,
          porta: depois.smtpPort,
          secure: depois.smtpSecure,
          usuario: depois.smtpUser,
          senha: undefined,
          nomeRemetente: depois.emailFromName,
          emailRemetente: depois.emailFromAddress,
          destinatarios: depois.alertEmailRecipients,
          minSeveridade: depois.emailMinSeverity,
        },
        politica,
        avisos,
      )
      if (!ok) throw new AppError('O e-mail não pode ser ligado: a configuração está incompleta.', 409, 'CHANNEL_INCOMPLETE', [{ channel: 'email', problems: avisos }])
    }
    if (depois.whatsappEnabled === true) {
      const avisos: string[] = []
      const ok = evolutionDeCampos(
        {
          baseUrl: depois.evolutionBaseUrl,
          instancia: depois.evolutionInstance,
          apikey: depois.evolutionApiKeyCiphertext ? 'presente' : undefined,
          versao: depois.evolutionApiVersion,
          destinatarios: depois.alertWhatsappRecipients,
          minSeveridade: depois.whatsappMinSeverity,
        },
        politica,
        avisos,
      )
      if (!ok) throw new AppError('O WhatsApp não pode ser ligado: a configuração está incompleta.', 409, 'CHANNEL_INCOMPLETE', [{ channel: 'whatsapp', problems: avisos }])
    }

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
        actionDetail: 'communication_settings',
        outcome: 'SUCCESS',
        httpStatus: 200,
        entityType: 'NotificationChannelConfig',
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
    return Object.keys(changes)
  })

  // Só NOMES de campos (os enviados + os que mudaram) — nunca valores. Emitido ANTES de invalidar o cache (ver o comentário do módulo).
  const enviados = [
    ...Object.keys(body.email ?? {}).map((k) => `email.${k}`),
    ...Object.keys(body.whatsapp ?? {}).map((k) => `whatsapp.${k}`),
    ...Object.keys(body.alerts ?? {}).map((k) => `alerts.${k}`),
    ...(body.clearSecrets ?? []).map((k) => `clear.${k}`),
  ]
  logger.warn({ alert: 'communication_config_changed', actorUserId: actor.userId, changedFields: [...new Set([...enviados, ...camposAlterados])] }, '[comunicacao] configuração de avisos (e-mail/WhatsApp) atualizada pelo admin')
  invalidarCacheComunicacao()
  return { camposAlterados }
}
