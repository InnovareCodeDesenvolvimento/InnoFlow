/** N-7 — o DTO da tela de comunicação tem um conjunto FECHADO de campos: nada além do contrato (docs/CONTRATO-COMUNICACAO-ADMIN.md), e nunca o texto cifrado nem o segredo. */
import { describe, expect, it } from 'vitest'
import { toCommunicationSettingsDto } from '../../src/services/comunicacao/comunicacaoDto'
import { resolverConfigAlertas, type LinhaComunicacao } from '../../src/lib/alertas/configDb'
import type { ConfigComunicacaoEfetiva } from '../../src/services/comunicacao/configComunicacao'

const SENHA = 'SENHA-SMTP-DO-TESTE-123'
const APIKEY = 'APIKEY-DO-TESTE-abcdef123456'
const decifrar = (c: string): string => c.replace(/^enc:/, '')

const linha: LinhaComunicacao = {
  emailEnabled: true,
  smtpHost: 'smtp.exemplo.com',
  smtpPort: 587,
  smtpSecure: false,
  smtpUser: 'u@exemplo.com',
  smtpPasswordCiphertext: `enc:${SENHA}`,
  emailFromName: 'InnoFlow',
  emailFromAddress: 'a@exemplo.com',
  alertEmailRecipients: ['dono@exemplo.com'],
  emailMinSeverity: 'IMPORTANTE',
  whatsappEnabled: true,
  evolutionBaseUrl: 'https://evo.exemplo.com',
  evolutionInstance: 'inst',
  evolutionApiKeyCiphertext: `enc:${APIKEY}`,
  evolutionApiVersion: 2,
  alertWhatsappRecipients: ['5511999999999'],
  whatsappMinSeverity: 'CRITICO',
  alertDedupeMinutes: null,
  updatedAt: new Date('2026-10-05T12:00:00Z'),
}

function efetiva(l: LinhaComunicacao | null, env: Record<string, string> = {}): ConfigComunicacaoEfetiva {
  return { ...resolverConfigAlertas(l, env, decifrar, undefined), linha: l, leituraFalhou: false }
}

describe('toCommunicationSettingsDto', () => {
  it('conjunto fechado de chaves (qualquer campo novo precisa entrar no contrato de propósito)', () => {
    const dto = toCommunicationSettingsDto(efetiva(linha), { secretsKeyConfigured: true, secretsDecryptable: true, fonteEnv: {} })
    expect(Object.keys(dto).sort()).toEqual(['alerts', 'email', 'privateHostsAllowed', 'secretsDecryptable', 'secretsKeyConfigured', 'source', 'updatedAt', 'warnings', 'whatsapp'])
    expect(Object.keys(dto.email).sort()).toEqual(['active', 'enabled', 'fromAddress', 'fromName', 'host', 'minSeverity', 'passwordSet', 'port', 'recipients', 'secure', 'source', 'user'])
    expect(Object.keys(dto.whatsapp).sort()).toEqual(['active', 'apiKeyHint', 'apiKeySet', 'apiVersion', 'baseUrl', 'enabled', 'instance', 'minSeverity', 'provider', 'recipients', 'source'])
    expect(Object.keys(dto.alerts).sort()).toEqual(['dedupeMinutes', 'dedupeSource', 'globalMinSeverity', 'maxPerHour'])
  })

  it('nunca carrega a senha, a apikey inteira nem o texto cifrado; a dica da apikey são só os 4 últimos caracteres', () => {
    const dto = toCommunicationSettingsDto(efetiva(linha), { secretsKeyConfigured: true, secretsDecryptable: true, fonteEnv: {} })
    const texto = JSON.stringify(dto)
    for (const s of [SENHA, APIKEY, 'enc:', 'Ciphertext']) expect(texto).not.toContain(s)
    expect(dto.email.passwordSet).toBe(true)
    expect(dto.whatsapp.apiKeySet).toBe(true)
    expect(dto.whatsapp.apiKeyHint).toBe(`…${APIKEY.slice(-4)}`)
  })

  it('env como fonte: segredo só como "configurado", sem dica; origem nos campos', () => {
    const env = { ALERT_EMAIL_TO: 'e@x.com', ALERT_SMTP_HOST: 'smtp.env.com', ALERT_EMAIL_FROM: 'e@x.com', ALERT_SMTP_PASS: 'SENHA-DA-ENV', ALERT_WHATSAPP_PROVIDER: 'evolution', ALERT_EVOLUTION_BASE_URL: 'https://evo.env.com', ALERT_EVOLUTION_INSTANCE: 'i', ALERT_EVOLUTION_APIKEY: 'KEY-DA-ENV-9999', ALERT_WHATSAPP_TO: '5511999999999' }
    const dto = toCommunicationSettingsDto(efetiva(null, env), { secretsKeyConfigured: true, secretsDecryptable: null, fonteEnv: env })
    expect(dto).toMatchObject({ source: 'env', email: { source: 'env', passwordSet: true }, whatsapp: { source: 'env', apiKeySet: true, apiKeyHint: null } })
    expect(JSON.stringify(dto)).not.toContain('SENHA-DA-ENV')
    expect(JSON.stringify(dto)).not.toContain('KEY-DA-ENV-9999')
  })
})
