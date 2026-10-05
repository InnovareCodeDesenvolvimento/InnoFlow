/**
 * L1.6 item 1 — o e-mail TRANSACIONAL (redefinição de senha, avisos ao motorista) deixou de depender do destinatário de ALERTA.
 *
 * MUDANÇA DELIBERADA (N-7 -> L1.6): antes o canal de e-mail só ficava ativo com >= 1 destinatário de alerta (`ALERT_EMAIL_TO` ou painel), então o "esqueci minha senha"
 * "funcionava" e nada saía (`EMAIL_NOT_CONFIGURED`). Agora o canal vale por SMTP completo + remetente + ligado; a lista de destinatários só decide se ALERTAS saem por e-mail.
 * SMTP falso real (smtp-server local, porta efêmera); sem Redis/banco (a configuração efetiva é injetada).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoriaDedupeStore } from '../../src/core/alertas/dedupe'
import { lerConfigAlertas, type ConfigAlertas } from '../../src/lib/alertas/config'
import { resolverConfigAlertas, type LinhaComunicacao } from '../../src/lib/alertas/configDb'
import { Notificador } from '../../src/lib/alertas/notificador'
import { iniciarSmtpFalso, type SmtpFalso } from './helpers/servidoresFalsos'

// A configuração efetiva que `enviarEmailTransacional` lê vem daqui (no lugar do banco/painel).
let configAtual: ConfigAlertas = lerConfigAlertas({}, undefined)
vi.mock('../../src/services/comunicacao/configComunicacao', async (importarOriginal) => ({
  ...(await importarOriginal<typeof import('../../src/services/comunicacao/configComunicacao')>()),
  getConfigComunicacao: async () => ({ config: configAtual }),
}))

let smtp: SmtpFalso
let enviarEmailTransacional: typeof import('../../src/services/comunicacao/email').enviarEmailTransacional
let montarCanais: typeof import('../../src/lib/alertas/instancia').montarCanais
let toDto: typeof import('../../src/services/comunicacao/comunicacaoDto').toCommunicationSettingsDto

beforeAll(async () => {
  smtp = await iniciarSmtpFalso()
  ;({ enviarEmailTransacional } = await import('../../src/services/comunicacao/email'))
  ;({ montarCanais } = await import('../../src/lib/alertas/instancia'))
  ;({ toCommunicationSettingsDto: toDto } = await import('../../src/services/comunicacao/comunicacaoDto'))
})
afterAll(async () => {
  await smtp.fechar()
})
beforeEach(() => {
  smtp.recebidos.length = 0
})

const SMTP_SEM_DESTINATARIO = () => ({ NODE_ENV: 'test', ALERT_SMTP_HOST: '127.0.0.1', ALERT_SMTP_PORT: String(smtp.porta), ALERT_EMAIL_FROM: 'InnoFlow <nao-responda@exemplo.com.br>' })
const SMTP_COM_DESTINATARIO = () => ({ ...SMTP_SEM_DESTINATARIO(), ALERT_EMAIL_TO: 'dono@exemplo.com.br' })

const MSG = { to: 'motorista@exemplo.com.br', subject: 'Teste transacional', text: 'corpo do aviso ao motorista' }

async function dispararAlerta(config: ConfigAlertas): Promise<'enfileirado' | string> {
  const n = new Notificador({ config, canais: montarCanais(config), store: new MemoriaDedupeStore(), log: () => undefined })
  const destino = n.notificar({ alerta: 'payment_void_manual_review', nivelPino: 50, mensagem: 'x', dados: { alert: 'payment_void_manual_review', paymentIntentId: 'pi_1' } })
  await n.aguardarOcioso()
  return destino
}

describe('env: SMTP completo SEM ALERT_EMAIL_TO', () => {
  it('o canal fica ATIVO (lista de alerta vazia) e sem aviso de "sem destinatário"', () => {
    const c = lerConfigAlertas(SMTP_SEM_DESTINATARIO(), undefined)
    expect(c.email).toMatchObject({ host: '127.0.0.1', de: 'InnoFlow <nao-responda@exemplo.com.br>', para: [] })
    expect(c.avisos.join(' ')).not.toMatch(/destinat|ALERT_EMAIL_TO/i)
  })

  it('destinatários TODOS inválidos: continua ativo (vazio) e avisa quantos foram ignorados', () => {
    const c = lerConfigAlertas({ ...SMTP_SEM_DESTINATARIO(), ALERT_EMAIL_TO: 'lixo' }, undefined)
    expect(c.email?.para).toEqual([])
    expect(c.avisos.join(' ')).toContain('1 endereco(s) invalido(s)')
  })

  it('o que continua exigido: servidor (host) e remetente — sem eles o canal NÃO está pronto', () => {
    expect(lerConfigAlertas({ ALERT_EMAIL_TO: 'a@b.com' }, undefined).email).toBeNull()
    expect(lerConfigAlertas({ ALERT_SMTP_HOST: 'smtp.exemplo.com.br' }, undefined).email).toBeNull() // sem remetente
  })
})

describe('painel: linha ligada com SMTP completo e SEM destinatário', () => {
  const linha = (extra: Partial<LinhaComunicacao> = {}): LinhaComunicacao => ({
    emailEnabled: true,
    smtpHost: '127.0.0.1',
    smtpPort: 25,
    smtpSecure: false,
    smtpUser: null,
    smtpPasswordCiphertext: null,
    emailFromName: 'InnoFlow',
    emailFromAddress: 'nao-responda@exemplo.com.br',
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
    updatedAt: new Date(),
    ...extra,
  })

  it('a resolução devolve o canal (para = []) e nenhum aviso de configuração incompleta', () => {
    const r = resolverConfigAlertas(linha(), { NODE_ENV: 'test' }, (c) => c, undefined)
    expect(r.config.email).toMatchObject({ host: '127.0.0.1', para: [], origem: 'database' })
    expect(r.avisos).toEqual([])
  })

  it('sem servidor ou sem remetente continua desligado, com aviso (a exigência que sobrou)', () => {
    const semHost = resolverConfigAlertas(linha({ smtpHost: null }), { NODE_ENV: 'test' }, (c) => c, undefined)
    expect(semHost.config.email).toBeNull()
    expect(semHost.avisos.join(' ')).toContain('sem servidor SMTP')
    const semRemetente = resolverConfigAlertas(linha({ emailFromAddress: null }), { NODE_ENV: 'test' }, (c) => c, undefined)
    expect(semRemetente.config.email).toBeNull()
    expect(semRemetente.avisos.join(' ')).toContain('sem remetente')
  })

  it('o DTO da tela mostra o canal ATIVO e acrescenta um aviso (a tela sabe que só o transacional funciona)', () => {
    const r = resolverConfigAlertas(linha(), { NODE_ENV: 'test' }, (c) => c, undefined)
    const dto = toDto({ ...r, linha: linha(), leituraFalhou: false }, { secretsKeyConfigured: true, secretsDecryptable: null, fonteEnv: {} })
    expect(dto.email).toMatchObject({ enabled: true, active: true, recipients: [] })
    expect(dto.warnings.join(' ')).toContain('sem destinatário de alertas')
  })
})

describe('os três cenários do item 1 (SMTP falso real)', () => {
  it('SEM destinatário de alerta: o e-mail TRANSACIONAL sai; o ALERTA não sai', async () => {
    configAtual = lerConfigAlertas(SMTP_SEM_DESTINATARIO(), undefined)

    const r = await enviarEmailTransacional(MSG)
    expect(r.ok).toBe(true)
    expect(smtp.recebidos).toHaveLength(1)
    expect(smtp.recebidos[0].para).toEqual(['motorista@exemplo.com.br'])
    expect(smtp.recebidos[0].bruto).toContain('corpo do aviso ao motorista')

    smtp.recebidos.length = 0
    expect(montarCanais(configAtual)).toEqual([]) // nenhum canal de alerta
    expect(await dispararAlerta(configAtual)).toBe('sem_canal')
    expect(smtp.recebidos).toHaveLength(0)
  })

  it('COM destinatário de alerta: os dois saem, cada um para o seu endereço (o transacional nunca vai para o dono)', async () => {
    configAtual = lerConfigAlertas(SMTP_COM_DESTINATARIO(), undefined)

    expect((await enviarEmailTransacional(MSG)).ok).toBe(true)
    expect(await dispararAlerta(configAtual)).toBe('enfileirado')

    expect(smtp.recebidos).toHaveLength(2)
    const transacional = smtp.recebidos.find((m) => m.bruto.includes('corpo do aviso ao motorista'))
    const alerta = smtp.recebidos.find((m) => m.bruto.includes('payment_void_manual_review'))
    expect(transacional?.para).toEqual(['motorista@exemplo.com.br'])
    expect(alerta?.para).toEqual(['dono@exemplo.com.br'])
  })

  it('canal NÃO pronto (sem host): o transacional recusa com EMAIL_NOT_CONFIGURED e nada sai', async () => {
    configAtual = lerConfigAlertas({ ALERT_EMAIL_TO: 'dono@exemplo.com.br' }, undefined)
    expect(await enviarEmailTransacional(MSG)).toEqual({ ok: false, code: 'EMAIL_NOT_CONFIGURED' })
    expect(smtp.recebidos).toHaveLength(0)
  })

  it('defesa em profundidade: um canal de ALERTA montado à mão com lista vazia não envia para ninguém (falha curta, sem endereço)', async () => {
    const { criarCanalEmail } = await import('../../src/lib/alertas/canais')
    const cfg = lerConfigAlertas(SMTP_SEM_DESTINATARIO(), undefined)
    const canal = criarCanalEmail(cfg.email!)
    await expect(canal.enviar({ alerta: 'x', severidade: 'CRITICO', servico: 's', ambiente: 'test', em: new Date().toISOString(), mensagem: '', contexto: {}, ocorrenciasSuprimidas: 0 })).rejects.toMatchObject({ motivo: 'sem destinatário' })
    expect(smtp.recebidos).toHaveLength(0)
  })
})
