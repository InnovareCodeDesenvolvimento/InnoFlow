/**
 * N-7 — o notificador dos alertas ao dono, ponta a ponta com SMTP falso (smtp-server local) e HTTP falso (webhook/Evolution). Sem Redis: dedupe em
 * memória com relógio injetado (o Redis tem teste próprio: `notificadorAlertasRedis.test.ts`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MemoriaDedupeStore } from '../../src/core/alertas/dedupe'
import { criarCanalEmail, criarCanalWhatsapp, type CanalDeAlerta } from '../../src/lib/alertas/canais'
import { lerConfigAlertas } from '../../src/lib/alertas/config'
import { Notificador, type EventoBruto } from '../../src/lib/alertas/notificador'
import { esperarAte, iniciarHttpFalso, iniciarSmtpFalso, type HttpFalso, type SmtpFalso } from './helpers/servidoresFalsos'

let smtp: SmtpFalso
let http: HttpFalso
let outroHttp: HttpFalso

beforeAll(async () => {
  smtp = await iniciarSmtpFalso()
  http = await iniciarHttpFalso()
  outroHttp = await iniciarHttpFalso()
})
afterAll(async () => {
  await smtp.fechar()
  await http.fechar()
  await outroHttp.fechar()
})

type Logs = Array<{ nivel: string; dados: Record<string, unknown>; mensagem: string }>

function montar(extraEnv: Record<string, string> = {}, relogio = { t: Date.parse('2026-10-05T12:00:00Z') }) {
  const env = {
    NODE_ENV: 'test',
    ALERT_EMAIL_TO: 'dono@exemplo.com.br, socio@exemplo.com.br',
    ALERT_SMTP_HOST: '127.0.0.1',
    ALERT_SMTP_PORT: String(smtp.porta),
    ALERT_EMAIL_FROM: 'InnoFlow <alertas@exemplo.com.br>',
    ALERT_WHATSAPP_PROVIDER: 'evolution',
    ALERT_EVOLUTION_BASE_URL: http.base,
    ALERT_EVOLUTION_INSTANCE: 'minha-instancia',
    ALERT_EVOLUTION_APIKEY: 'CHAVE-EVOLUTION-SECRETA-123',
    ALERT_WHATSAPP_TO: '5511999999999,+55 (21) 98888-7777',
    ...extraEnv,
  }
  const config = lerConfigAlertas(env, '/app/dist/entrypoints/worker.js')
  const logs: Logs = []
  const canais: CanalDeAlerta[] = []
  if (config.email) canais.push(criarCanalEmail(config.email))
  if (config.whatsapp) canais.push(criarCanalWhatsapp(config.whatsapp))
  const store = new MemoriaDedupeStore(() => relogio.t)
  const n = new Notificador({ config, canais, store, log: (nivel, dados, mensagem) => logs.push({ nivel, dados, mensagem }), agora: () => relogio.t })
  return { n, config, logs, relogio }
}

function ev(alerta: string, dados: Record<string, unknown> = {}, nivelPino = 50, mensagem = 'algo aconteceu'): EventoBruto {
  return { alerta, nivelPino, mensagem, dados: { alert: alerta, ...dados } }
}

const limpar = () => {
  smtp.recebidos.length = 0
  http.recebidas.length = 0
  outroHttp.recebidas.length = 0
  http.responder((_r, res) => res.writeHead(201).end('{}'))
}

describe('canais e severidade', () => {
  it('CRITICO sai por e-mail E WhatsApp (Evolution v2: um POST por número, header apikey, corpo {number,text})', async () => {
    limpar()
    const { n } = montar()
    expect(n.notificar(ev('payment_void_manual_review', { paymentIntentId: 'pi_abc123', paymentId: 'pay_1', returnCode: '57' }))).toBe('enfileirado')
    await n.aguardarOcioso()

    expect(smtp.recebidos).toHaveLength(1)
    const mail = smtp.recebidos[0]
    expect(mail.para.sort()).toEqual(['dono@exemplo.com.br', 'socio@exemplo.com.br'])
    expect(mail.de).toBe('alertas@exemplo.com.br')
    expect(mail.bruto).toContain('Subject: [InnoFlow][CRITICO] payment_void_manual_review (test)')
    expect(mail.bruto).toContain('Alerta: payment_void_manual_review')
    expect(mail.bruto).toContain('Servico: worker')
    expect(mail.bruto).toContain('Hora: 2026-10-05T12:00:00.000Z')
    expect(mail.bruto).toContain('paymentIntentId: pi_abc123')
    expect(mail.bruto).toContain('O que fazer: Conferir a venda no Site Cielo')

    expect(http.recebidas).toHaveLength(2)
    expect(http.recebidas.map((r) => (r.json as { number: string }).number).sort()).toEqual(['5511999999999', '5521988887777'])
    for (const r of http.recebidas) {
      expect(r.metodo).toBe('POST')
      expect(r.url).toBe('/message/sendText/minha-instancia')
      expect(r.cabecalhos.apikey).toBe('CHAVE-EVOLUTION-SECRETA-123')
      expect(r.cabecalhos.authorization).toBeUndefined()
      const corpo = r.json as { number: string; text: string }
      expect(Object.keys(corpo).sort()).toEqual(['number', 'text'])
      expect(corpo.text).toContain('[InnoFlow][CRITICO] payment_void_manual_review')
      expect(corpo.text).toContain('paymentIntentId=pi_abc123')
    }
  })

  it('Evolution v1 usa {number, textMessage:{text}}', async () => {
    limpar()
    const { n } = montar({ ALERT_EVOLUTION_API_VERSION: '1', ALERT_WHATSAPP_TO: '5511999999999' })
    n.notificar(ev('payment_capture_retry_exhausted', { paymentIntentId: 'pi_1' }))
    await n.aguardarOcioso()
    expect(http.recebidas).toHaveLength(1)
    const corpo = http.recebidas[0].json as { number: string; textMessage: { text: string } }
    expect(corpo.number).toBe('5511999999999')
    expect(corpo.textMessage.text).toContain('payment_capture_retry_exhausted')
    expect((corpo as unknown as Record<string, unknown>).text).toBeUndefined()
  })

  it('IMPORTANTE sai só por e-mail (WhatsApp tem mínimo CRITICO por padrão); INFO não sai por nenhum', async () => {
    limpar()
    const { n } = montar()
    expect(n.notificar(ev('ocpp_message_flood', { chargePointId: 'cp_1', maxMessages: 1000 }))).toBe('enfileirado')
    expect(n.notificar(ev('login_account_locked', {}, 40))).toBe('ignorado_severidade')
    await n.aguardarOcioso()
    expect(smtp.recebidos).toHaveLength(1)
    expect(smtp.recebidos[0].bruto).toContain('Subject: [InnoFlow][IMPORTANTE] ocpp_message_flood (test)')
    expect(http.recebidas).toHaveLength(0)
  })

  it('alerta SEM classificação vale IMPORTANTE (e-mail)', async () => {
    limpar()
    const { n } = montar()
    n.notificar(ev('alerta_novo_sem_classificacao'))
    await n.aguardarOcioso()
    expect(smtp.recebidos).toHaveLength(1)
    expect(smtp.recebidos[0].bruto).toContain('[IMPORTANTE] alerta_novo_sem_classificacao')
  })

  it('ALERT_MIN_SEVERITY=CRITICO suprime até o e-mail de IMPORTANTE; ALERT_WHATSAPP_MIN_SEVERITY=IMPORTANTE leva IMPORTANTE ao WhatsApp', async () => {
    limpar()
    const a = montar({ ALERT_MIN_SEVERITY: 'CRITICO' })
    expect(a.n.notificar(ev('ocpp_message_flood'))).toBe('ignorado_severidade')
    const b = montar({ ALERT_WHATSAPP_MIN_SEVERITY: 'IMPORTANTE' })
    b.n.notificar(ev('ocpp_message_flood', { chargePointId: 'cp_9' }))
    await b.n.aguardarOcioso()
    expect(smtp.recebidos).toHaveLength(1)
    expect(http.recebidas).toHaveLength(2)
  })

  it('sem canal configurado não faz nada (e não dá erro)', () => {
    const { n } = montar({ ALERT_EMAIL_TO: '', ALERT_SMTP_HOST: '', ALERT_WHATSAPP_PROVIDER: '', ALERT_EVOLUTION_BASE_URL: '' })
    expect(n.notificar(ev('payment_void_manual_review'))).toBe('sem_canal')
  })

  it('adaptador genérico: Authorization Bearer e corpo {to,text,severity,alert,service,at}', async () => {
    limpar()
    const { n } = montar({
      ALERT_WHATSAPP_PROVIDER: 'generic',
      ALERT_WHATSAPP_WEBHOOK_URL: `${http.base}/hook`,
      ALERT_WHATSAPP_WEBHOOK_TOKEN: 'TOKEN-GENERICO-XYZ',
      ALERT_WHATSAPP_TO: '5511999999999',
    })
    n.notificar(ev('session_stop_not_obeyed', { sessionId: 'ses_1' }))
    await n.aguardarOcioso()
    expect(http.recebidas).toHaveLength(1)
    const r = http.recebidas[0]
    expect(r.url).toBe('/hook')
    expect(r.cabecalhos.authorization).toBe('Bearer TOKEN-GENERICO-XYZ')
    const corpo = r.json as Record<string, string>
    expect(Object.keys(corpo).sort()).toEqual(['alert', 'at', 'service', 'severity', 'text', 'to'])
    expect(corpo).toMatchObject({ to: '5511999999999', severity: 'CRITICO', alert: 'session_stop_not_obeyed', service: 'worker', at: '2026-10-05T12:00:00.000Z' })
  })
})

describe('dedupe e teto por hora', () => {
  it('a mesma ocorrência avisa 1x por janela; outro contexto é outro aviso', async () => {
    limpar()
    const { n } = montar({ ALERT_DEDUPE_MINUTES: '30', ALERT_WHATSAPP_PROVIDER: '', ALERT_EVOLUTION_BASE_URL: '' })
    for (let i = 0; i < 5; i++) n.notificar(ev('payment_void_manual_review', { paymentIntentId: 'pi_A' }))
    n.notificar(ev('payment_void_manual_review', { paymentIntentId: 'pi_B' }))
    await n.aguardarOcioso()
    expect(smtp.recebidos).toHaveLength(2) // pi_A (1 de 5) + pi_B
    expect(smtp.recebidos.filter((m) => m.bruto.includes('pi_A'))).toHaveLength(1)
  })

  it('repetição EXATA: 4 supressões entram como "Ocorreu mais 4 vez(es)" no próximo aviso', async () => {
    limpar()
    const { n, relogio } = montar({ ALERT_DEDUPE_MINUTES: '30', ALERT_WHATSAPP_PROVIDER: '', ALERT_EVOLUTION_BASE_URL: '' })
    for (let i = 0; i < 5; i++) n.notificar(ev('payment_capture_retry_exhausted', { paymentIntentId: 'pi_X', ageMinutes: 100 + i }))
    await n.aguardarOcioso()
    expect(smtp.recebidos).toHaveLength(1)
    expect(smtp.recebidos[0].bruto).not.toContain('Ocorreu mais')

    relogio.t += 31 * 60_000
    n.notificar(ev('payment_capture_retry_exhausted', { paymentIntentId: 'pi_X', ageMinutes: 999 }))
    await n.aguardarOcioso()
    expect(smtp.recebidos).toHaveLength(2)
    expect(smtp.recebidos[1].bruto).toContain('Ocorreu mais 4 vez(es) desde o ultimo aviso')
  })

  it('teto por hora: ao estourar manda UM aviso de tempestade e silencia o resto da hora; a hora seguinte volta ao normal', async () => {
    limpar()
    const { n, relogio } = montar({ ALERT_MAX_PER_HOUR: '3', ALERT_WHATSAPP_PROVIDER: '', ALERT_EVOLUTION_BASE_URL: '' })
    for (let i = 0; i < 10; i++) n.notificar(ev('ocpp_message_flood', { chargePointId: `cp_${i}` }))
    await n.aguardarOcioso()
    expect(smtp.recebidos).toHaveLength(4) // 3 normais + 1 tempestade
    const tempestades = smtp.recebidos.filter((m) => m.bruto.includes('tempestade_de_alertas'))
    expect(tempestades).toHaveLength(1)
    expect(tempestades[0].bruto).toContain('Mais de 3 avisos na ultima hora')

    relogio.t += 61 * 60_000
    n.notificar(ev('ocpp_message_flood', { chargePointId: 'cp_novo' }))
    await n.aguardarOcioso()
    expect(smtp.recebidos).toHaveLength(5)
    expect(smtp.recebidos[4].bruto).toContain('cp_novo')
  })

  it('o teto de IMPORTANTE não engole um CRITICO (contadores separados)', async () => {
    limpar()
    const { n } = montar({ ALERT_MAX_PER_HOUR: '2', ALERT_WHATSAPP_PROVIDER: '', ALERT_EVOLUTION_BASE_URL: '' })
    for (let i = 0; i < 6; i++) n.notificar(ev('ocpp_message_flood', { chargePointId: `cp_${i}` }))
    n.notificar(ev('payment_void_manual_review', { paymentIntentId: 'pi_critico' }))
    await n.aguardarOcioso()
    expect(smtp.recebidos.some((m) => m.bruto.includes('[CRITICO] payment_void_manual_review'))).toBe(true)
  })
})

describe('isolamento de falha', () => {
  it('notificar() é síncrono e NÃO espera o canal: 1000 chamadas com um canal que nunca responde voltam em milissegundos', async () => {
    const canalPendurado: CanalDeAlerta = { nome: 'email', minSeveridade: 'INFO', enviar: () => new Promise<void>(() => {}) }
    const { config } = montar()
    const n = new Notificador({ config, canais: [canalPendurado], store: new MemoriaDedupeStore(), log: () => {}, prazoDeEnvioMs: 200 })
    const t0 = performance.now()
    const destinos = new Set<string>()
    for (let i = 0; i < 1000; i++) destinos.add(n.notificar(ev('ocpp_message_flood', { chargePointId: `cp_${i}` })))
    const gasto = performance.now() - t0
    expect(gasto).toBeLessThan(250) // folga enorme p/ CI lento; a prova é "não espera os 200 ms do prazo nem o canal"
    expect(destinos).toEqual(new Set(['enfileirado', 'fila_cheia'])) // fila LIMITADA: o excesso é descartado, não acumulado
    await n.aguardarOcioso(3_000)
  })

  it('no máximo 2 envios em paralelo e a fila limitada descarta o excesso (com 1 log, não 1 por alerta)', async () => {
    let emVoo = 0
    let pico = 0
    const canal: CanalDeAlerta = {
      nome: 'email',
      minSeveridade: 'INFO',
      enviar: async () => {
        emVoo++
        pico = Math.max(pico, emVoo)
        await new Promise((r) => setTimeout(r, 5))
        emVoo--
      },
    }
    const { config } = montar()
    const logs: Logs = []
    const n = new Notificador({ config, canais: [canal], store: new MemoriaDedupeStore(), log: (nivel, dados, mensagem) => logs.push({ nivel, dados, mensagem }) })
    let descartados = 0
    for (let i = 0; i < 300; i++) if (n.notificar(ev('ocpp_message_flood', { chargePointId: `cp_${i}` })) === 'fila_cheia') descartados++
    await n.aguardarOcioso(10_000)
    expect(pico).toBeLessThanOrEqual(2)
    expect(descartados).toBeGreaterThan(200)
    expect(logs.filter((l) => l.dados.notifier === 'fila_cheia')).toHaveLength(1)
  })

  it('canal que lança, store que lança e log que lança: nunca propaga, nunca derruba', async () => {
    const quebrado: CanalDeAlerta = { nome: 'email', minSeveridade: 'INFO', enviar: async () => { throw new Error('senha=SEGREDO-DO-SMTP estourou') } }
    const { config } = montar()
    const logs: Logs = []
    const n = new Notificador({ config, canais: [quebrado], store: new MemoriaDedupeStore(), log: (nivel, dados, mensagem) => logs.push({ nivel, dados, mensagem }) })
    expect(() => n.notificar(ev('payment_void_manual_review', { paymentIntentId: 'pi_1' }))).not.toThrow()
    await n.aguardarOcioso()
    expect(logs).toHaveLength(1)
    expect(logs[0].dados).toMatchObject({ notifier: 'canal_falhou', canal: 'email', motivo: 'Error' })
    expect(JSON.stringify(logs)).not.toContain('SEGREDO-DO-SMTP') // a mensagem crua da exceção NÃO vai para o log

    const storeQuebrado = { registrarOcorrencia: async () => { throw new Error('boom') }, reservarVagaPorHora: async () => { throw new Error('boom') } }
    const n2 = new Notificador({ config, canais: [quebrado], store: storeQuebrado, log: () => { throw new Error('log quebrado') } })
    expect(() => n2.notificar(ev('payment_void_manual_review', { paymentIntentId: 'pi_2' }))).not.toThrow()
    await n2.aguardarOcioso()

    // contexto hostil: getter que lança, referência circular, objetos gigantes
    const circular: Record<string, unknown> = { alert: 'payment_void_manual_review' }
    circular.self = circular
    Object.defineProperty(circular, 'paymentIntentId', { enumerable: true, get() { throw new Error('getter') } })
    expect(() => n2.notificar({ alerta: 'payment_void_manual_review', nivelPino: 50, mensagem: { nao: 'string' }, dados: circular })).not.toThrow()
    await n2.aguardarOcioso()
  })

  it('NUNCA gera laço: o log de falha do notificador não tem o campo `alert`', async () => {
    limpar()
    http.responder((_r, res) => res.writeHead(500).end('{"erro":"x"}'))
    const { n, logs } = montar({ ALERT_EMAIL_TO: '', ALERT_SMTP_HOST: '' })
    n.notificar(ev('payment_void_manual_review', { paymentIntentId: 'pi_loop' }))
    await n.aguardarOcioso()
    expect(logs.length).toBeGreaterThan(0)
    for (const l of logs) {
      expect(Object.prototype.hasOwnProperty.call(l.dados, 'alert')).toBe(false)
      expect(l.dados.notifier).toBeDefined()
    }
    expect(logs[0].dados).toMatchObject({ canal: 'whatsapp', motivo: 'http 500', alertaDeOrigem: 'payment_void_manual_review' })
  })

  it('WhatsApp: um número que falha não esconde o aviso dos outros; todos falhando = canal falhou', async () => {
    limpar()
    let n = 0
    http.responder((_r, res) => res.writeHead(n++ === 0 ? 400 : 201).end('{}'))
    const { n: nt, logs } = montar({ ALERT_EMAIL_TO: '', ALERT_SMTP_HOST: '' })
    nt.notificar(ev('payment_void_manual_review', { paymentIntentId: 'pi_1' }))
    await nt.aguardarOcioso()
    expect(http.recebidas).toHaveLength(2)
    expect(logs).toHaveLength(0) // 1 de 2 entregou: canal ok
  })

  it('NÃO segue redirect (a apikey não pode ir para outro host)', async () => {
    limpar()
    http.responder((_r, res) => res.writeHead(302, { location: `${outroHttp.base}/roubado` }).end())
    const { n, logs } = montar({ ALERT_EMAIL_TO: '', ALERT_SMTP_HOST: '', ALERT_WHATSAPP_TO: '5511999999999' })
    n.notificar(ev('payment_void_manual_review', { paymentIntentId: 'pi_redir' }))
    await n.aguardarOcioso()
    expect(http.recebidas).toHaveLength(1)
    expect(outroHttp.recebidas).toHaveLength(0)
    expect(logs[0].dados.motivo).toContain('redirect 302')
  })

  it('timeout de 5 s no WhatsApp (servidor que não responde): falha o canal com motivo, sem pendurar', async () => {
    limpar()
    http.responder(() => {
      /* nunca responde */
    })
    const { n, logs } = montar({ ALERT_EMAIL_TO: '', ALERT_SMTP_HOST: '', ALERT_WHATSAPP_TO: '5511999999999' })
    const t0 = Date.now()
    n.notificar(ev('payment_void_manual_review', { paymentIntentId: 'pi_timeout' }))
    await n.aguardarOcioso(15_000)
    const gasto = Date.now() - t0
    expect(gasto).toBeGreaterThanOrEqual(4_500)
    expect(gasto).toBeLessThan(9_000)
    expect(logs[0].dados.motivo).toContain('sem resposta em 5000ms')
  }, 20_000)

  it('SMTP recusando a autenticação: falha o canal e a senha NÃO aparece em log nem na mensagem', async () => {
    const smtpAuth = await iniciarSmtpFalso({ usuario: 'alertas', senha: 'SENHA-CORRETA' })
    try {
      const { n, logs } = montar({ ALERT_SMTP_PORT: String(smtpAuth.porta), ALERT_SMTP_USER: 'alertas', ALERT_SMTP_PASS: 'SENHA-ERRADA-777', ALERT_WHATSAPP_PROVIDER: '', ALERT_EVOLUTION_BASE_URL: '' })
      n.notificar(ev('payment_void_manual_review', { paymentIntentId: 'pi_auth' }))
      await n.aguardarOcioso(10_000)
      expect(smtpAuth.recebidos).toHaveLength(0)
      expect(logs).toHaveLength(1)
      expect(logs[0].dados).toMatchObject({ notifier: 'canal_falhou', canal: 'email' })
      expect(String(logs[0].dados.motivo)).toMatch(/^smtp EAUTH/)
      expect(JSON.stringify(logs)).not.toContain('SENHA-ERRADA-777')

      // e com a senha certa o e-mail chega
      const ok = montar({ ALERT_SMTP_PORT: String(smtpAuth.porta), ALERT_SMTP_USER: 'alertas', ALERT_SMTP_PASS: 'SENHA-CORRETA', ALERT_WHATSAPP_PROVIDER: '', ALERT_EVOLUTION_BASE_URL: '' })
      ok.n.notificar(ev('payment_void_manual_review', { paymentIntentId: 'pi_auth_ok' }))
      await ok.n.aguardarOcioso(10_000)
      expect(smtpAuth.recebidos).toHaveLength(1)
    } finally {
      await smtpAuth.fechar()
    }
  })

  it('SMTP fora do ar (porta fechada): falha curta, sem pendurar', async () => {
    const { n, logs } = montar({ ALERT_SMTP_PORT: '1', ALERT_WHATSAPP_PROVIDER: '', ALERT_EVOLUTION_BASE_URL: '' })
    const t0 = Date.now()
    n.notificar(ev('payment_void_manual_review', { paymentIntentId: 'pi_smtp_off' }))
    await n.aguardarOcioso(15_000)
    expect(Date.now() - t0).toBeLessThan(9_000)
    expect(logs[0].dados).toMatchObject({ notifier: 'canal_falhou', canal: 'email' })
  }, 20_000)
})

describe('conteúdo seguro (nada sensível sai)', () => {
  const SEGREDOS = {
    cartao: '4111111111111111',
    cartaoComEspaco: '4111 1111 1111 1111',
    jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.assinaturaassinaturaassinatura',
    bearer: 'Bearer abcdef0123456789abcdef0123456789',
    merchantKey: 'MERCHANTKEY-SECRETA-9988',
    token: 'tok_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    email: 'motorista.secreto@gmail.com',
    cpf: '12345678909',
    senha: 'minha-senha-do-admin',
    webhook: 'segredo-do-webhook-em-claro',
    qr: '00020126580014br.gov.bcb.pix0136chave-pix-copia-e-cola',
  }

  it('um alerta com segredos no contexto e na mensagem NÃO vaza para o e-mail nem para o WhatsApp; os ids permitidos continuam', async () => {
    limpar()
    const { n } = montar()
    n.notificar({
      alerta: 'payment_void_manual_review',
      nivelPino: 50,
      mensagem: `REVISAO MANUAL do cartao ${SEGREDOS.cartao} do usuario ${SEGREDOS.email} com ${SEGREDOS.bearer} e ${SEGREDOS.jwt}`,
      dados: {
        alert: 'payment_void_manual_review',
        // permitidos
        paymentIntentId: 'cmuv8eu580b0801lfmmppmx09',
        paymentId: 'a1b2c3d4-0000-4000-8000-000000000001',
        returnCode: '57',
        captureAmountCents: 1234,
        // sensíveis por NOME (fora da allowlist)
        CardNumber: SEGREDOS.cartao,
        cardToken: SEGREDOS.token,
        MerchantKey: SEGREDOS.merchantKey,
        merchantKey: SEGREDOS.merchantKey,
        password: SEGREDOS.senha,
        currentPassword: SEGREDOS.senha,
        authorization: SEGREDOS.bearer,
        webhookHeaderSecret: SEGREDOS.webhook,
        cpf: SEGREDOS.cpf,
        pixQrCode: SEGREDOS.qr,
        email: SEGREDOS.email,
        req: { headers: { authorization: SEGREDOS.bearer, cookie: 'sid=1' } },
        err: new Error(`falhou com ${SEGREDOS.merchantKey}`),
        params: { body: { CardNumber: SEGREDOS.cartao } },
        // nome PERMITIDO, valor perigoso: o filtro de valor derruba
        motivo: SEGREDOS.email,
        escopo: SEGREDOS.cartaoComEspaco,
        operacao: SEGREDOS.jwt,
        statusBruto: SEGREDOS.token,
        userId: SEGREDOS.bearer,
        codigos: [SEGREDOS.cartao, 'COD_OK_1'],
      },
    })
    await n.aguardarOcioso()

    const tudo = JSON.stringify({ smtp: smtp.recebidos, http: http.recebidas.map((r) => r.corpo) })
    for (const [nome, valor] of Object.entries(SEGREDOS)) expect(tudo, `vazou ${nome}`).not.toContain(valor)
    // pedaços característicos também (o corpo não pode conter nem um fragmento reconhecível)
    for (const frag of ['4111', 'MERCHANTKEY', 'tok_live', 'eyJhbGci', 'motorista.secreto', 'segredo-do-webhook', 'chave-pix', 'Bearer', 'cookie', 'sid=1']) {
      expect(tudo, `vazou fragmento ${frag}`).not.toContain(frag)
    }
    // o que é seguro e útil continua
    expect(smtp.recebidos[0].bruto).toContain('paymentIntentId: cmuv8eu580b0801lfmmppmx09')
    expect(smtp.recebidos[0].bruto).toContain('returnCode: 57')
    expect(smtp.recebidos[0].bruto).toContain('captureAmountCents: 1234')
    expect(smtp.recebidos[0].bruto).toContain('codigos: COD_OK_1')
    expect(smtp.recebidos[0].bruto).toContain('REVISAO MANUAL do cartao')
  })

  it('o nome do alerta nunca injeta cabeçalho/linha no assunto', async () => {
    limpar()
    const { n } = montar({ ALERT_WHATSAPP_PROVIDER: '', ALERT_EVOLUTION_BASE_URL: '' })
    n.notificar({ alerta: 'ocpp_x\r\nBcc: atacante@mal.com', nivelPino: 50, mensagem: 'x', dados: {} })
    await n.aguardarOcioso()
    expect(smtp.recebidos).toHaveLength(1)
    expect(smtp.recebidos[0].bruto).not.toMatch(/^Bcc:/im)
    expect(smtp.recebidos[0].para).toEqual(['dono@exemplo.com.br', 'socio@exemplo.com.br'])
  })
})

describe('esperarAte (sanidade do helper)', () => {
  it('estoura quando a condição nunca vale', async () => {
    await expect(esperarAte(() => false, 50)).rejects.toThrow()
  })
})
