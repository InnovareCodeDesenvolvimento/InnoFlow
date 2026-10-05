/**
 * N-7 — INTEGRAÇÃO: um `logger.warn/error({ alert })` REAL (a instância do pino do processo, com o hook `logMethod`) dispara o envio por e-mail
 * (SMTP falso) e WhatsApp (Evolution falsa), passando pelo dedupe/teto no Redis REAL. Nenhum call site é tocado: o hook é o único ponto.
 *
 * O logger é importado DEPOIS de subir os servidores falsos e setar as envs ALERT_* (o notificador as lê na criação do logger).
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { esperarAte, iniciarHttpFalso, iniciarSmtpFalso, type HttpFalso, type SmtpFalso } from '../unit/helpers/servidoresFalsos'

type Logger = typeof import('../../src/lib/logger').logger

let smtp: SmtpFalso
let evolution: HttpFalso
let logger: Logger
let alertarSessao: typeof import('../../src/services/sessao/alertasSessao').alertarSessao

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const id = () => `pi_${randomUUID()}`
const comAssunto = (trecho: string) => smtp.recebidos.filter((m) => m.bruto.includes(trecho))

beforeAll(async () => {
  smtp = await iniciarSmtpFalso()
  evolution = await iniciarHttpFalso()
  Object.assign(process.env, {
    NODE_ENV: 'test',
    ALERT_EMAIL_TO: 'dono@exemplo.com.br',
    ALERT_SMTP_HOST: '127.0.0.1',
    ALERT_SMTP_PORT: String(smtp.porta),
    ALERT_EMAIL_FROM: 'alertas@exemplo.com.br',
    ALERT_WHATSAPP_PROVIDER: 'evolution',
    ALERT_EVOLUTION_BASE_URL: evolution.base,
    ALERT_EVOLUTION_INSTANCE: 'inst',
    ALERT_EVOLUTION_APIKEY: 'APIKEY-INTEGRACAO',
    ALERT_WHATSAPP_TO: '5511999999999',
    // O Redis é compartilhado entre as suítes e entre execuções: o teto por hora (default 20) já estaria gasto.
    ALERT_MAX_PER_HOUR: '100000',
    ALERT_DEDUPE_MINUTES: '30',
  })
  vi.resetModules()
  ;({ logger } = await import('../../src/lib/logger'))
  ;({ alertarSessao } = await import('../../src/services/sessao/alertasSessao'))
  await sleep(300) // o notificador é montado em setImmediate depois da criação do logger (e abre a conexão Redis dele)
})

afterAll(async () => {
  await smtp.fechar()
  await evolution.fechar()
})

describe('hook do logger -> notificador (logger REAL, Redis REAL)', () => {
  it('logger.error({ alert }) CRITICO chega por e-mail e WhatsApp, sem tocar no call site', async () => {
    const pi = id()
    logger.error({ alert: 'payment_void_manual_review', paymentIntentId: pi, paymentId: 'pay_1', returnCode: '57', motivo: 'recusado' }, '[teste] REVISAO MANUAL de pre-autorizacao')
    await esperarAte(() => comAssunto(pi).length >= 1 && evolution.recebidas.some((r) => r.corpo.includes(pi)), 8_000)

    const mail = comAssunto(pi)[0]
    expect(mail.bruto).toContain('Subject: [InnoFlow][CRITICO] payment_void_manual_review (test)')
    expect(mail.bruto).toContain(`paymentIntentId: ${pi}`)
    expect(mail.bruto).toContain('Servico: processo') // vitest não é um entrypoint
    const zap = evolution.recebidas.find((r) => r.corpo.includes(pi))!
    expect(zap.cabecalhos.apikey).toBe('APIKEY-INTEGRACAO')
    expect(zap.url).toBe('/message/sendText/inst')
  })

  it('logger.warn({ alert }) IMPORTANTE chega só por e-mail', async () => {
    const cp = `cp_${randomUUID()}`
    const antes = evolution.recebidas.length
    logger.warn({ alert: 'ocpp_message_flood', chargePointId: cp, maxMessages: 1000, windowSeconds: 10 }, '[teste] flood')
    await esperarAte(() => comAssunto(cp).length >= 1, 8_000)
    expect(comAssunto(cp)[0].bruto).toContain('[IMPORTANTE] ocpp_message_flood')
    await sleep(200)
    expect(evolution.recebidas.length).toBe(antes)
  })

  it('log SEM o campo alert, e alerta INFO, não geram aviso nenhum', async () => {
    const marca = id()
    const antes = smtp.recebidos.length
    logger.error({ paymentIntentId: marca, motivo: 'erro comum' }, '[teste] erro comum sem alert')
    logger.warn({ alertTipo: 'ocpp_message_flood', chargePointId: marca }, '[teste] campo com nome parecido')
    logger.warn({ alert: 'login_account_locked', lockSeconds: 60 }, '[teste] INFO')
    logger.info('texto puro')
    logger.error(new Error('só um erro'), 'erro como primeiro argumento')
    await sleep(500)
    expect(smtp.recebidos.length).toBe(antes)
  })

  it('o aviso passa pelo dedupe no Redis: 5 logs idênticos = 1 e-mail', async () => {
    const pi = id()
    for (let i = 0; i < 5; i++) logger.error({ alert: 'payment_capture_retry_exhausted', paymentIntentId: pi, ageMinutes: 100 + i }, '[teste] captura esgotada')
    await esperarAte(() => comAssunto(pi).length >= 1, 8_000)
    await sleep(500)
    expect(comAssunto(pi)).toHaveLength(1)
  })

  it('alerta com segredo no objeto logado NÃO vaza para o e-mail/WhatsApp (e o stdout segue redigido pelo logger)', async () => {
    const pi = id()
    logger.error(
      { alert: 'payment_pix_credit_divergence', paymentIntentId: pi, motivo: 'amount', MerchantKey: 'MK-SEGREDO-INTEGRACAO', cardToken: 'TOKEN-SEGREDO-INTEGRACAO', cpf: '12345678909', req: { headers: { authorization: 'Bearer JWT-SEGREDO' } } },
      '[teste] divergencia para motorista@exemplo.com com cartao 4111111111111111',
    )
    await esperarAte(() => comAssunto(pi).length >= 1 && evolution.recebidas.some((r) => r.corpo.includes(pi)), 8_000)
    const tudo = JSON.stringify([comAssunto(pi), evolution.recebidas.filter((r) => r.corpo.includes(pi)).map((r) => r.corpo)])
    for (const s of ['MK-SEGREDO', 'TOKEN-SEGREDO', '12345678909', 'JWT-SEGREDO', 'motorista@exemplo.com', '4111111111111111']) expect(tudo).not.toContain(s)
  })

  it('os 9 alertas da N-7 + ocpp_message_flood + google_link_repeated_failures chegam ao dono quando emitidos pelo logger', async () => {
    const nomes = [
      'payment_void_manual_review',
      'payment_capture_retry_exhausted',
      'payment_authorization_stuck',
      'session_cost_calculation_failed',
      'payment_pix_credit_divergence',
      'ocpp_auth_ip_flood',
      'payment_gateway_credential_rejected',
      'payment_card_testing_suspected',
      'ocpp_foreign_transaction',
      'ocpp_message_flood',
      'google_link_repeated_failures',
    ]
    const marca = id()
    nomes.forEach((nome, i) => logger.error({ alert: nome, sessionId: `${marca}-n${i}` }, `[teste] ${nome}`))
    await esperarAte(() => nomes.every((_n, i) => comAssunto(`${marca}-n${i}`).length >= 1), 10_000)
    nomes.forEach((nome, i) => expect(comAssunto(`${marca}-n${i}`)[0].bruto, nome).toContain(nome))
  })

  it('call sites REAIS: alertarSessao (watchdog) dispara o aviso pelo mesmo hook', async () => {
    const sessionId = `ses_${randomUUID()}`
    alertarSessao('session_stop_not_obeyed', { sessionId, chargePointId: 'cp_real' }, 'o carregador nao obedeceu o stop')
    await esperarAte(() => comAssunto(sessionId).length >= 1, 8_000)
    expect(comAssunto(sessionId)[0].bruto).toContain('[CRITICO] session_stop_not_obeyed')
    expect(comAssunto(sessionId)[0].bruto).toContain('Servico: processo')
  })

  it('NÃO bloqueia o caminho de quem logou: com SMTP e WhatsApp que nunca respondem, 200 logger.error({alert}) levam milissegundos', async () => {
    // troca o comportamento do WhatsApp para "nunca responde"
    evolution.responder(() => {})
    const t0 = performance.now()
    for (let i = 0; i < 200; i++) logger.error({ alert: 'payment_gateway_credential_rejected', paymentIntentId: id() }, '[teste] rajada')
    const gasto = performance.now() - t0
    // O custo real é o do próprio pino-pretty (stdout); o limite abaixo é generoso, mas MUITO menor que esperar um único envio (5-12 s).
    expect(gasto).toBeLessThan(1_500)
    evolution.responder((_r, res) => res.writeHead(201).end('{}'))
  })
})
