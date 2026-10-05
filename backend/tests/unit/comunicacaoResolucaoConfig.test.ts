/** N-7 — resolução PURA da configuração de comunicação: painel (banco) > env, por canal; segredo ilegível não derruba; validações do canal vindo do banco. */
import { describe, expect, it } from 'vitest'
import { resolverConfigAlertas, type LinhaComunicacao } from '../../src/lib/alertas/configDb'

const linha = (o: Partial<LinhaComunicacao> = {}): LinhaComunicacao => ({
  emailEnabled: null,
  smtpHost: null,
  smtpPort: null,
  smtpSecure: false,
  smtpUser: null,
  smtpPasswordCiphertext: null,
  emailFromName: null,
  emailFromAddress: null,
  alertEmailRecipients: [],
  emailMinSeverity: 'IMPORTANTE',
  whatsappEnabled: null,
  evolutionBaseUrl: null,
  evolutionInstance: null,
  evolutionApiKeyCiphertext: null,
  evolutionApiVersion: 2,
  alertWhatsappRecipients: [],
  whatsappMinSeverity: 'CRITICO',
  alertDedupeMinutes: null,
  updatedAt: new Date('2026-10-05T12:00:00Z'),
  ...o,
})
// "cifra" de teste: prefixo reversível (a decifragem real é testada nos testes de integração)
const decifrar = (c: string): string => {
  if (!c.startsWith('enc:')) throw new Error('ilegivel')
  return c.slice(4)
}
const ENV_EMAIL = { ALERT_EMAIL_TO: 'env@x.com', ALERT_SMTP_HOST: 'smtp.env.com', ALERT_EMAIL_FROM: 'env@x.com' }
const completaEmail = { emailEnabled: true, smtpHost: 'smtp.db.com', smtpPort: 465, smtpSecure: true, smtpUser: 'u', smtpPasswordCiphertext: 'enc:SENHA', emailFromAddress: 'db@x.com', alertEmailRecipients: ['dono@x.com'] }
const completaWhats = { whatsappEnabled: true, evolutionBaseUrl: 'https://evo.db.com/', evolutionInstance: 'inst', evolutionApiKeyCiphertext: 'enc:KEY', alertWhatsappRecipients: ['+55 (11) 99999-9999'] }

describe('resolverConfigAlertas', () => {
  it('sem linha: tudo da env', () => {
    const r = resolverConfigAlertas(null, ENV_EMAIL, decifrar, undefined)
    expect(r.source).toBe('env')
    expect(r.fontes).toEqual({ email: 'env', whatsapp: 'none', dedupe: 'env' })
    expect(r.config.email).toMatchObject({ host: 'smtp.env.com', origem: 'env' })
  })

  it('linha com e-mail ligado: usa SÓ o banco (nada de misturar com a env); segredo decifrado; WhatsApp sem grupo segue na env', () => {
    const r = resolverConfigAlertas(linha(completaEmail), { ...ENV_EMAIL, ALERT_WHATSAPP_PROVIDER: 'evolution', ALERT_EVOLUTION_BASE_URL: 'https://evo.env.com', ALERT_EVOLUTION_INSTANCE: 'ie', ALERT_EVOLUTION_APIKEY: 'ke', ALERT_WHATSAPP_TO: '5511999999999' }, decifrar, undefined)
    expect(r.source).toBe('database')
    expect(r.fontes).toMatchObject({ email: 'database', whatsapp: 'env' })
    expect(r.config.email).toMatchObject({ host: 'smtp.db.com', porta: 465, secure: true, usuario: 'u', senha: 'SENHA', para: ['dono@x.com'], de: 'db@x.com', origem: 'database', exigirTls: false })
    expect(r.config.whatsapp).toMatchObject({ origem: 'env', instancia: 'ie' })
  })

  it('enabled=false no banco DESLIGA o canal mesmo com a env configurada; nulo = segue a env', () => {
    expect(resolverConfigAlertas(linha({ emailEnabled: false }), ENV_EMAIL, decifrar, undefined).config.email).toBeNull()
    expect(resolverConfigAlertas(linha({ emailEnabled: null }), ENV_EMAIL, decifrar, undefined).config.email).toMatchObject({ origem: 'env' })
  })

  it('WhatsApp do banco: normaliza URL (sem barra final) e número; versão 1; severidade do canal', () => {
    const r = resolverConfigAlertas(linha({ ...completaWhats, evolutionApiVersion: 1, whatsappMinSeverity: 'IMPORTANTE' }), {}, decifrar, undefined)
    expect(r.config.whatsapp).toMatchObject({ provedor: 'evolution', baseUrl: 'https://evo.db.com', instancia: 'inst', apikey: 'KEY', versao: 1, para: ['5511999999999'], minSeveridade: 'IMPORTANTE', origem: 'database' })
  })

  it('dedupe: o do banco vence quando preenchido; senão env/padrão', () => {
    expect(resolverConfigAlertas(linha({ alertDedupeMinutes: 7 }), { ALERT_DEDUPE_MINUTES: '45' }, decifrar, undefined).config.dedupeMinutos).toBe(7)
    expect(resolverConfigAlertas(linha(), { ALERT_DEDUPE_MINUTES: '45' }, decifrar, undefined).config.dedupeMinutos).toBe(45)
    expect(resolverConfigAlertas(linha(), {}, decifrar, undefined).config.dedupeMinutos).toBe(30)
  })

  it('segredo que NÃO decifra: canal desligado, segredosIlegiveis=true, aviso SEM o segredo; o outro canal segue', () => {
    const r = resolverConfigAlertas(linha({ ...completaEmail, smtpPasswordCiphertext: 'lixo-corrompido', ...completaWhats }), {}, decifrar, undefined)
    expect(r.segredosIlegiveis).toBe(true)
    expect(r.config.email).toBeNull()
    expect(r.config.whatsapp).not.toBeNull()
    expect(r.avisos.join(' ')).toContain('não pôde ser decifrada')
    expect(JSON.stringify(r.avisos)).not.toContain('lixo-corrompido')
  })

  it('canal ligado mas incompleto/proibido NUNCA derruba: desliga com aviso (host interno em produção, http em produção, sem apikey; e-mail SEM destinatário de alerta NÃO desliga mais — MUDANÇA DELIBERADA L1.6)', () => {
    const prod = { NODE_ENV: 'production' }
    expect(resolverConfigAlertas(linha({ ...completaEmail, smtpHost: '10.0.0.5' }), prod, decifrar, undefined).config.email).toBeNull()
    expect(resolverConfigAlertas(linha({ ...completaEmail, alertEmailRecipients: [] }), prod, decifrar, undefined).config.email).toMatchObject({ para: [] })
    expect(resolverConfigAlertas(linha({ ...completaWhats, evolutionBaseUrl: 'http://evo.db.com' }), prod, decifrar, undefined).config.whatsapp).toBeNull()
    expect(resolverConfigAlertas(linha({ ...completaWhats, evolutionBaseUrl: 'https://169.254.169.254' }), prod, decifrar, undefined).config.whatsapp).toBeNull()
    expect(resolverConfigAlertas(linha({ ...completaWhats, evolutionApiKeyCiphertext: null }), prod, decifrar, undefined).config.whatsapp).toBeNull()
    expect(resolverConfigAlertas(linha({ ...completaWhats, alertWhatsappRecipients: ['123'] }), prod, decifrar, undefined).config.whatsapp).toBeNull()
    // e em produção o STARTTLS é obrigatório quando não é TLS direto
    expect(resolverConfigAlertas(linha({ ...completaEmail, smtpSecure: false, smtpHost: 'smtp.db.com' }), prod, decifrar, undefined).config.email).toMatchObject({ exigirTls: true })
  })

  it('com a permissão de rede privada do deploy, a Evolution interna por http passa em produção (e o loopback continua barrado)', () => {
    const prodPrivado = { NODE_ENV: 'production', COMMUNICATION_ALLOW_PRIVATE_HOSTS: 'true' }
    expect(resolverConfigAlertas(linha({ ...completaWhats, evolutionBaseUrl: 'http://evolution:8080' }), prodPrivado, decifrar, undefined).config.whatsapp).toMatchObject({ baseUrl: 'http://evolution:8080' })
    expect(resolverConfigAlertas(linha({ ...completaWhats, evolutionBaseUrl: 'http://127.0.0.1:8080' }), prodPrivado, decifrar, undefined).config.whatsapp).toBeNull()
  })

  it('o remetente com nome é montado sem injeção de cabeçalho', () => {
    const r = resolverConfigAlertas(linha({ ...completaEmail, emailFromName: 'Inno<>"Flow\r\nBcc: x@y.com' }), {}, decifrar, undefined)
    expect(r.config.email?.de).not.toMatch(/[\r\n]/)
  })
})
