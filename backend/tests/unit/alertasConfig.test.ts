/** N-7 — leitura das envs ALERT_*: tudo desligado por padrão, configuração torta nunca derruba, https em produção, segredo fora dos avisos. */
import { describe, expect, it } from 'vitest'
import { algumCanalAtivo, detectarServico, lerConfigAlertas, normalizarNumeroWhatsapp } from '../../src/lib/alertas/config'

const EMAIL_OK = { ALERT_EMAIL_TO: 'dono@exemplo.com.br', ALERT_SMTP_HOST: 'smtp.exemplo.com.br', ALERT_EMAIL_FROM: 'alertas@exemplo.com.br' }
const EVOLUTION_OK = {
  ALERT_WHATSAPP_PROVIDER: 'evolution',
  ALERT_EVOLUTION_BASE_URL: 'https://evo.exemplo.com.br',
  ALERT_EVOLUTION_INSTANCE: 'inst',
  ALERT_EVOLUTION_APIKEY: 'APIKEY-SECRETA',
  ALERT_WHATSAPP_TO: '5511999999999',
}

describe('lerConfigAlertas', () => {
  it('sem nenhuma env: tudo desligado, sem aviso e sem erro', () => {
    const c = lerConfigAlertas({}, undefined)
    expect(c.email).toBeNull()
    expect(c.whatsapp).toBeNull()
    expect(c.avisos).toEqual([])
    expect(algumCanalAtivo(c)).toBe(false)
    expect(c.minSeveridade).toBe('IMPORTANTE')
    expect(c.dedupeMinutos).toBe(30)
    expect(c.maxPorHora).toBe(20)
  })

  it('strings vazias (EasyPanel guarda env em branco como "") valem como ausentes', () => {
    const c = lerConfigAlertas({ ALERT_EMAIL_TO: '', ALERT_SMTP_HOST: ' ', ALERT_WHATSAPP_PROVIDER: '', ALERT_EVOLUTION_BASE_URL: '' }, undefined)
    expect(algumCanalAtivo(c)).toBe(false)
    expect(c.avisos).toEqual([])
  })

  it('e-mail: porta padrão 587 (STARTTLS) ou 465 (secure); exige TLS só em produção sem secure', () => {
    expect(lerConfigAlertas({ ...EMAIL_OK }, undefined).email).toMatchObject({ porta: 587, secure: false, exigirTls: false, minSeveridade: 'IMPORTANTE' })
    expect(lerConfigAlertas({ ...EMAIL_OK, NODE_ENV: 'production' }, undefined).email).toMatchObject({ porta: 587, exigirTls: true })
    expect(lerConfigAlertas({ ...EMAIL_OK, ALERT_SMTP_SECURE: 'true', NODE_ENV: 'production' }, undefined).email).toMatchObject({ porta: 465, secure: true, exigirTls: false })
    expect(lerConfigAlertas({ ...EMAIL_OK, ALERT_SMTP_SECURE: 'false' }, undefined).email?.secure).toBe(false)
  })

  it('e-mail: lista com endereços inválidos ignora só os inválidos (e avisa); nenhum válido = canal desligado', () => {
    const c = lerConfigAlertas({ ...EMAIL_OK, ALERT_EMAIL_TO: 'a@b.com, lixo, c@d.com.br' }, undefined)
    expect(c.email?.para).toEqual(['a@b.com', 'c@d.com.br'])
    expect(c.avisos.join(' ')).toContain('1 endereco(s) invalido(s)')
    const nenhum = lerConfigAlertas({ ...EMAIL_OK, ALERT_EMAIL_TO: 'lixo' }, undefined)
    expect(nenhum.email).toBeNull()
  })

  it('e-mail: sem host, ou sem remetente utilizável, desliga com aviso; remetente cai para o usuário SMTP se for e-mail', () => {
    expect(lerConfigAlertas({ ALERT_EMAIL_TO: 'a@b.com' }, undefined).email).toBeNull()
    expect(lerConfigAlertas({ ALERT_EMAIL_TO: 'a@b.com', ALERT_SMTP_HOST: 'h' }, undefined).avisos.join(' ')).toContain('ALERT_EMAIL_FROM')
    expect(lerConfigAlertas({ ALERT_EMAIL_TO: 'a@b.com', ALERT_SMTP_HOST: 'h', ALERT_SMTP_USER: 'robo@b.com', ALERT_SMTP_PASS: 'x' }, undefined).email?.de).toBe('robo@b.com')
    // injeção de cabeçalho no remetente
    expect(lerConfigAlertas({ ...EMAIL_OK, ALERT_EMAIL_FROM: 'a@b.com\r\nBcc: x@y.com' }, undefined).email).toBeNull()
  })

  it('severidades inválidas voltam ao padrão com aviso (não derrubam); WhatsApp padrão é CRITICO', () => {
    const c = lerConfigAlertas({ ...EMAIL_OK, ...EVOLUTION_OK, ALERT_MIN_SEVERITY: 'banana', ALERT_EMAIL_MIN_SEVERITY: 'critico' }, undefined)
    expect(c.minSeveridade).toBe('IMPORTANTE')
    expect(c.email?.minSeveridade).toBe('CRITICO')
    expect(c.whatsapp?.minSeveridade).toBe('CRITICO')
    expect(c.avisos.join(' ')).toContain('ALERT_MIN_SEVERITY invalida')
  })

  it('números fora de faixa em ALERT_DEDUPE_MINUTES / ALERT_MAX_PER_HOUR voltam ao padrão', () => {
    const c = lerConfigAlertas({ ALERT_DEDUPE_MINUTES: '0', ALERT_MAX_PER_HOUR: 'abc' }, undefined)
    expect(c.dedupeMinutos).toBe(30)
    expect(c.maxPorHora).toBe(20)
    expect(lerConfigAlertas({ ALERT_DEDUPE_MINUTES: '5', ALERT_MAX_PER_HOUR: '7' }, undefined)).toMatchObject({ dedupeMinutos: 5, maxPorHora: 7 })
  })

  describe('WhatsApp / Evolution', () => {
    it('config completa: normaliza número, versão 2 por padrão, tira a barra final da base', () => {
      const c = lerConfigAlertas({ ...EVOLUTION_OK, ALERT_EVOLUTION_BASE_URL: 'https://evo.exemplo.com.br/', ALERT_WHATSAPP_TO: '+55 (11) 99999-9999, 5521988887777' }, undefined)
      expect(c.whatsapp).toMatchObject({ provedor: 'evolution', baseUrl: 'https://evo.exemplo.com.br', instancia: 'inst', versao: 2, para: ['5511999999999', '5521988887777'] })
    })

    it('infere "evolution" quando só as envs da Evolution existem; "generic" quando só há a URL do webhook', () => {
      const { ALERT_WHATSAPP_PROVIDER: _p, ...semProvider } = EVOLUTION_OK
      expect(lerConfigAlertas(semProvider, undefined).whatsapp?.provedor).toBe('evolution')
      expect(lerConfigAlertas({ ALERT_WHATSAPP_WEBHOOK_URL: 'https://x.exemplo.com/h', ALERT_WHATSAPP_TO: '5511999999999' }, undefined).whatsapp?.provedor).toBe('generic')
    })

    it('versão 1 por env; versão inválida cai para 2 com aviso', () => {
      expect(lerConfigAlertas({ ...EVOLUTION_OK, ALERT_EVOLUTION_API_VERSION: '1' }, undefined).whatsapp).toMatchObject({ versao: 1 })
      const c = lerConfigAlertas({ ...EVOLUTION_OK, ALERT_EVOLUTION_API_VERSION: '3' }, undefined)
      expect(c.whatsapp).toMatchObject({ versao: 2 })
      expect(c.avisos.join(' ')).toContain('ALERT_EVOLUTION_API_VERSION')
    })

    it('https é OBRIGATÓRIO em produção (http só fora dela); credencial na URL é recusada', () => {
      const http = { ...EVOLUTION_OK, ALERT_EVOLUTION_BASE_URL: 'http://evo.interno:8080' }
      expect(lerConfigAlertas({ ...http, NODE_ENV: 'production' }, undefined).whatsapp).toBeNull()
      expect(lerConfigAlertas({ ...http, NODE_ENV: 'production' }, undefined).avisos.join(' ')).toContain('https')
      expect(lerConfigAlertas({ ...http, NODE_ENV: 'development' }, undefined).whatsapp).not.toBeNull()
      expect(lerConfigAlertas({ ...EVOLUTION_OK, ALERT_EVOLUTION_BASE_URL: 'https://u:p@evo.exemplo.com.br' }, undefined).whatsapp).toBeNull()
      expect(lerConfigAlertas({ ALERT_WHATSAPP_PROVIDER: 'generic', ALERT_WHATSAPP_WEBHOOK_URL: 'http://x.com/h', ALERT_WHATSAPP_TO: '5511999999999', NODE_ENV: 'production' }, undefined).whatsapp).toBeNull()
    })

    it('faltando peça (instância, apikey, URL, números) desliga com aviso; instância com caractere estranho é recusada (vai no caminho da URL)', () => {
      expect(lerConfigAlertas({ ...EVOLUTION_OK, ALERT_EVOLUTION_APIKEY: '' }, undefined).whatsapp).toBeNull()
      expect(lerConfigAlertas({ ...EVOLUTION_OK, ALERT_EVOLUTION_INSTANCE: '' }, undefined).whatsapp).toBeNull()
      expect(lerConfigAlertas({ ...EVOLUTION_OK, ALERT_EVOLUTION_INSTANCE: '../admin' }, undefined).whatsapp).toBeNull()
      expect(lerConfigAlertas({ ...EVOLUTION_OK, ALERT_WHATSAPP_TO: '123' }, undefined).whatsapp).toBeNull()
      expect(lerConfigAlertas({ ...EVOLUTION_OK, ALERT_WHATSAPP_PROVIDER: 'twilio' }, undefined).whatsapp).toBeNull()
    })

    it('os avisos de configuração NUNCA contêm a apikey, o token ou a senha', () => {
      const c = lerConfigAlertas(
        { ...EVOLUTION_OK, ALERT_WHATSAPP_TO: 'x', ALERT_SMTP_PASS: 'SENHA-SMTP-SECRETA', ALERT_EMAIL_TO: 'ruim', ALERT_SMTP_HOST: 'h', ALERT_WHATSAPP_WEBHOOK_TOKEN: 'TOKEN-SECRETO' },
        undefined,
      )
      const tudo = JSON.stringify(c.avisos)
      expect(c.avisos.length).toBeGreaterThan(0)
      for (const segredo of ['APIKEY-SECRETA', 'SENHA-SMTP-SECRETA', 'TOKEN-SECRETO']) expect(tudo).not.toContain(segredo)
    })
  })

  it('serviço: detectado pelo entrypoint; ALERT_SERVICE_NAME vence; fora de entrypoint = "processo"', () => {
    expect(detectarServico({}, '/app/dist/entrypoints/api.js')).toBe('api')
    expect(detectarServico({}, 'C:\\x\\src\\entrypoints\\ocpp.ts')).toBe('ocpp')
    expect(detectarServico({}, '/app/dist/entrypoints/worker.js')).toBe('worker')
    expect(detectarServico({}, '/usr/bin/vitest')).toBe('processo')
    expect(detectarServico({ ALERT_SERVICE_NAME: 'gateway' }, '/app/dist/entrypoints/api.js')).toBe('gateway')
  })

  it('normalizarNumeroWhatsapp', () => {
    expect(normalizarNumeroWhatsapp('+55 (11) 99999-9999')).toBe('5511999999999')
    expect(normalizarNumeroWhatsapp('12345')).toBeNull()
    expect(normalizarNumeroWhatsapp('1234567890123456')).toBeNull()
  })
})
