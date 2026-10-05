import type { SeveridadeNotificacao } from '../../core/alertas/severidade'
import type { FonteDoCanal } from '../../lib/alertas/configDb'
import type { ConfigComunicacaoEfetiva } from './configComunicacao'
import { permitirRedePrivadaDaEnv } from '../../lib/alertas/config'

/**
 * DTO da tela de comunicação (`GET /api/admin/communication-settings`). Contrato literal em `docs/CONTRATO-COMUNICACAO-ADMIN.md`.
 * SEGREDOS NUNCA VOLTAM: só `passwordSet`/`apiKeySet` e, para a apikey da Evolution (chave longa e aleatória), os 4 últimos caracteres em `apiKeyHint`. A senha SMTP não tem
 * dica de propósito: 4 caracteres de uma senha escolhida por gente reduzem muito a entropia dela; a apikey é um token gerado, onde 4 caracteres não ajudam um atacante.
 */
export interface CommunicationSettingsDto {
  source: 'database' | 'env'
  email: {
    source: FonteDoCanal
    /** Intenção salva: o canal está LIGADO (painel) ou configurado pela env. */
    enabled: boolean
    /** O canal está funcionando agora (configuração completa e válida). `enabled && !active` = há um problema: ver `warnings`. */
    active: boolean
    host: string | null
    port: number | null
    secure: boolean
    user: string | null
    passwordSet: boolean
    fromName: string | null
    fromAddress: string | null
    recipients: string[]
    minSeverity: SeveridadeNotificacao
  }
  whatsapp: {
    source: FonteDoCanal
    enabled: boolean
    active: boolean
    provider: 'evolution' | 'generic' | null
    baseUrl: string | null
    instance: string | null
    apiKeySet: boolean
    apiKeyHint: string | null
    apiVersion: 1 | 2
    recipients: string[]
    minSeverity: SeveridadeNotificacao
  }
  alerts: {
    dedupeMinutes: number
    dedupeSource: 'database' | 'env'
    /** Piso global (env `ALERT_MIN_SEVERITY`): vale para qualquer canal, além do mínimo de cada um. */
    globalMinSeverity: SeveridadeNotificacao
    maxPerHour: number
  }
  /** `PAYMENT_SECRETS_KEY` presente e válida: sem ela não dá para GUARDAR segredo (PUT com senha/apikey responde 503 SECRETS_KEY_MISSING). */
  secretsKeyConfigured: boolean
  /** `true` = segredos salvos decifram agora; `false` = ao menos um não decifra (canal desligado até salvar de novo); `null` = não há segredo salvo no banco. */
  secretsDecryptable: boolean | null
  /** Informativo: o deploy liberou destinos de rede privada (`COMMUNICATION_ALLOW_PRIVATE_HOSTS`). Não é editável pelo painel. */
  privateHostsAllowed: boolean
  /** Problemas de configuração em PT-BR, sem segredo (ex.: "e-mail ligado no painel, mas sem destinatário válido"). */
  warnings: string[]
  updatedAt: string | null
}

const ultimos4 = (s: string): string => `…${s.slice(-4)}`

export function toCommunicationSettingsDto(c: ConfigComunicacaoEfetiva, extras: { secretsKeyConfigured: boolean; secretsDecryptable: boolean | null; fonteEnv: Readonly<Record<string, string | undefined>> }): CommunicationSettingsDto {
  const { linha, config, fontes } = c
  const noBancoEmail = linha !== null && linha.emailEnabled !== null
  const noBancoWhats = linha !== null && linha.whatsappEnabled !== null
  const e = config.email
  const w = config.whatsapp

  // Do banco mostra o que foi SALVO (mesmo incompleto, para o admin corrigir); da env, o que está valendo.
  const email: CommunicationSettingsDto['email'] = noBancoEmail
    ? {
        source: 'database',
        enabled: linha!.emailEnabled === true,
        active: e !== null,
        host: linha!.smtpHost,
        port: linha!.smtpPort,
        secure: linha!.smtpSecure,
        user: linha!.smtpUser,
        passwordSet: Boolean(linha!.smtpPasswordCiphertext),
        fromName: linha!.emailFromName,
        fromAddress: linha!.emailFromAddress,
        recipients: linha!.alertEmailRecipients,
        minSeverity: (linha!.emailMinSeverity as SeveridadeNotificacao) ?? 'IMPORTANTE',
      }
    : {
        source: fontes.email,
        enabled: e !== null,
        active: e !== null,
        host: e?.host ?? null,
        port: e?.porta ?? null,
        secure: e?.secure ?? false,
        user: e?.usuario ?? null,
        passwordSet: Boolean(e?.senha),
        fromName: null,
        fromAddress: e?.de ?? null,
        recipients: e?.para ?? [],
        minSeverity: e?.minSeveridade ?? 'IMPORTANTE',
      }

  const whatsapp: CommunicationSettingsDto['whatsapp'] = noBancoWhats
    ? {
        source: 'database',
        enabled: linha!.whatsappEnabled === true,
        active: w !== null,
        provider: 'evolution',
        baseUrl: linha!.evolutionBaseUrl,
        instance: linha!.evolutionInstance,
        apiKeySet: Boolean(linha!.evolutionApiKeyCiphertext),
        apiKeyHint: w?.provedor === 'evolution' ? ultimos4(w.apikey) : null,
        apiVersion: linha!.evolutionApiVersion === 1 ? 1 : 2,
        recipients: linha!.alertWhatsappRecipients,
        minSeverity: (linha!.whatsappMinSeverity as SeveridadeNotificacao) ?? 'CRITICO',
      }
    : {
        source: fontes.whatsapp,
        enabled: w !== null,
        active: w !== null,
        provider: w?.provedor ?? null,
        baseUrl: w ? (w.provedor === 'evolution' ? w.baseUrl : w.url) : null,
        instance: w?.provedor === 'evolution' ? w.instancia : null,
        apiKeySet: w?.provedor === 'evolution',
        apiKeyHint: null,
        apiVersion: w?.provedor === 'evolution' ? w.versao : 2,
        recipients: w?.para ?? [],
        minSeverity: w?.minSeveridade ?? 'CRITICO',
      }

  return {
    source: c.source,
    email,
    whatsapp,
    alerts: { dedupeMinutes: config.dedupeMinutos, dedupeSource: fontes.dedupe, globalMinSeverity: config.minSeveridade, maxPerHour: config.maxPorHora },
    secretsKeyConfigured: extras.secretsKeyConfigured,
    secretsDecryptable: extras.secretsDecryptable,
    privateHostsAllowed: permitirRedePrivadaDaEnv(extras.fonteEnv),
    // L1.6: canal pronto sem destinatário de alerta é um estado VÁLIDO (só o e-mail transacional ao motorista funciona) — a tela é avisada, mas `active` continua `true`.
    warnings: e !== null && e.para.length === 0 ? [...c.avisos, 'E-mail pronto só para mensagens ao motorista: sem destinatário de alertas, os avisos ao dono por e-mail não são enviados.'] : c.avisos,
    updatedAt: linha ? linha.updatedAt.toISOString() : null,
  }
}
