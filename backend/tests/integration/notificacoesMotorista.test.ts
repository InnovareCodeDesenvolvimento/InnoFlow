import { randomUUID } from 'node:crypto'
import { Queue } from 'bullmq'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis, createRedisConnection } from '../../src/lib/redis'
import { logger } from '../../src/lib/logger'
import { finalizarSessao } from '../../src/services/carteira/finalizarSessao'
import { ajustarCarteiraTransacional } from '../../src/services/carteira/walletLedger'
import { creditarTopupPix } from '../../src/services/pagamentos/creditarTopupPix'
import { FakeAdapter } from '../../src/services/pagamentos/fakeAdapter'
import { getPagamentoPort, resetPagamentoPortCacheParaTeste } from '../../src/services/pagamentos/pagamentoPortInstance'
import { enviarEmailTransacional } from '../../src/services/comunicacao/email'
import { resetCacheComunicacaoParaTeste } from '../../src/services/comunicacao/configComunicacao'
import { dadosPublicosDaEmpresa } from '../../src/services/legal/consentimento'
import { criarProcessadorDeNotificacoes } from '../../src/services/notificacoes/processarNotificacao'
import { aguardarNotificacoesEmVoo, enfileirarNotificacao, fecharFilaDasNotificacoes } from '../../src/services/notificacoes/enfileirarNotificacao'
import { notificarRecargaIniciadaPeloSuporte, notificarSessaoEncerrada } from '../../src/services/notificacoes/gatilhos'
import { startNotificacoesWorker } from '../../src/worker/jobs/notificacoesJob'
import { NOTIFICACOES_QUEUE_NAME } from '../../src/worker/queues'
import { jobIdDaNotificacao } from '../../src/core/notificacoes/politica'
import { createTenant, createUser, settle, uniqueSuffix, waitFor, type TestTenant } from './helpers/fixtures'
import { criarMotoristaComSenha, criarSessao, SENHA_DO_MOTORISTA, type Motorista } from './helpers/lgpdFixture'
import { criarFixtureCartao, type FixtureCartao } from './helpers/cartaoSessaoFixture'
import { capturarSessaoCartao } from '../../src/services/pagamentos/capturarSessaoCartao'
import type { EmailRecebido } from '../unit/helpers/servidoresFalsos'

// Só o ENVIO do comando OCPP é trocado (não há gateway real aqui): a rota do remote-start do ADMIN, a fila, o worker, o banco e o SMTP são os reais.
vi.mock('../../src/ocpp/commands', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../src/ocpp/commands')>()), sendCommand: vi.fn(async () => ({ status: 'Accepted' })) }))

/**
 * L1.6 — notificações por e-mail ao motorista, PONTA A PONTA: fato (finalizarSessao, Pix creditado, rotas de auth...) -> fila BullMQ `notificacoes` (Redis REAL) -> worker REAL ->
 * `NotificationLog` (Postgres REAL, banco próprio) -> SMTP FALSO (smtp-server local). O e-mail de verdade NÃO é provado aqui (nenhum provedor/SPF/DKIM).
 * Banco próprio: o SMTP e a empresa vêm de env e a config de comunicação é singleton; as outras suítes não podem enxergar isto.
 */
const infra = await vi.hoisted(async () => {
  const { iniciarSmtpFalso } = await import('../unit/helpers/servidoresFalsos')
  const { criarBancoProprio } = await import('./helpers/bancoProprio')
  for (const k of Object.keys(process.env)) if (k.startsWith('ALERT_') || k.startsWith('COMMUNICATION_')) delete process.env[k]
  const smtp = await iniciarSmtpFalso()
  const morto = await iniciarSmtpFalso()
  const portaMorta = morto.porta
  await morto.fechar() // porta que ninguém atende: conexão recusada = "SMTP fora"
  Object.assign(process.env, {
    ALERT_SMTP_HOST: '127.0.0.1',
    ALERT_SMTP_PORT: String(smtp.porta),
    ALERT_EMAIL_FROM: 'InnoFlow <nao-responda@exemplo.com.br>',
    PUBLIC_APP_URL: 'https://app.innoflow.test',
    LEGAL_COMPANY_NAME: 'InnoFlow Teste Ltda',
    LEGAL_COMPANY_CNPJ: '11.222.333/0001-81',
    LEGAL_SUPPORT_EMAIL: 'suporte@innoflow.test',
  })
  const banco = await criarBancoProprio('notif')
  return { smtp, portaMorta, banco }
})
const { smtp } = infra

const logsTodos: string[] = []
const alertasEmitidos: Array<Record<string, unknown>> = []
const dump = (v: unknown): string => JSON.stringify(v, (_k, x) => (x instanceof Error ? { name: x.name, message: x.message, stack: x.stack } : x))

describe('notificações ao motorista (L1.6) — Postgres + Redis + worker BullMQ reais, SMTP falso', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  let tenant: TestTenant
  let fila: Queue
  let worker: ReturnType<typeof startNotificacoesWorker>
  let fake: FakeAdapter
  let fxCartao: FixtureCartao
  const emailsDosMotoristas = new Set<string>()

  const processador = criarProcessadorDeNotificacoes({
    prisma,
    redis,
    enviar: (msg) => enviarEmailTransacional(msg),
    baseUrl: () => 'https://app.innoflow.test',
    empresa: dadosPublicosDaEmpresa,
    log: logger,
  })

  beforeAll(async () => {
    for (const nivel of ['info', 'warn', 'error', 'debug'] as const) {
      const original = logger[nivel].bind(logger) as (...a: unknown[]) => void
      vi.spyOn(logger, nivel).mockImplementation(((...args: unknown[]) => {
        logsTodos.push(dump(args))
        const a0 = args[0] as Record<string, unknown> | undefined
        if (a0 && typeof a0 === 'object' && typeof a0.alert === 'string') alertasEmitidos.push(a0)
        original(...args)
      }) as never)
    }
    tenant = await createTenant({ suffix, label: 'notif' })
    await prisma.chargePoint.update({ where: { id: tenant.chargePointId }, data: { lastSeenAt: new Date() } })
    await prisma.tariffAssignment.create({ data: { operatorId: tenant.operatorId, tariffId: tenant.tariffId, scope: 'OPERATOR' } })
    fila = new Queue(NOTIFICACOES_QUEUE_NAME, { connection: createRedisConnection() })
    worker = startNotificacoesWorker()
    resetPagamentoPortCacheParaTeste()
    fake = (await getPagamentoPort()) as FakeAdapter
    expect(fake).toBeInstanceOf(FakeAdapter)
    fxCartao = await criarFixtureCartao(app, suffix, 'ncard')
  }, 120_000)

  afterAll(async () => {
    fake.definirModoCaptura('NORMAL')
    vi.restoreAllMocks()
    await worker.close()
    await fila.close()
    await fecharFilaDasNotificacoes()
    await prisma.$disconnect()
    redis.disconnect()
    await smtp.fechar()
    await infra.banco.descartar()
  }, 60_000)

  // ---- ajudantes -------------------------------------------------------------------------------------------------------------------

  const smtpOk = () => {
    process.env.ALERT_SMTP_PORT = String(smtp.porta)
    resetCacheComunicacaoParaTeste()
  }
  const smtpFora = () => {
    process.env.ALERT_SMTP_PORT = String(infra.portaMorta)
    resetCacheComunicacaoParaTeste()
  }

  async function motorista(label: string, saldoCents = 10_000): Promise<Motorista> {
    const m = await criarMotoristaComSenha(`${suffix}-${randomUUID().slice(0, 4)}`, `notif-${label}`, { saldoCents })
    emailsDosMotoristas.add(m.email)
    return m
  }
  const emailsPara = (email: string, trecho?: string): EmailRecebido[] => smtp.recebidos.filter((r) => r.para.includes(email) && (!trecho || r.legivel.includes(trecho)))
  async function esperarEmail(email: string, trecho: string, quantos = 1): Promise<EmailRecebido[]> {
    return waitFor(async () => {
      const achados = emailsPara(email, trecho)
      return achados.length >= quantos ? achados : null
    }, { timeoutMs: 15_000, what: `e-mail para ${email} com "${trecho}"` })
  }
  const linhas = (userId: string) => prisma.notificationLog.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } })
  const linhaDo = (userId: string, type: string, entityId: string) => prisma.notificationLog.findFirst({ where: { userId, type: type as never, entityId } })

  async function fechar(m: Motorista, wh: number): Promise<string> {
    const s = await criarSessao(tenant, m.id, 'STARTED')
    const r = await finalizarSessao(s.id, { meterStopWh: wh, timestamp: new Date(), stopReason: 'LOCAL' })
    expect(r.finalizada).toBe(true)
    await aguardarNotificacoesEmVoo()
    return s.id
  }
  async function saldo(walletId: string): Promise<number> {
    return (await prisma.walletEntry.findFirst({ where: { walletId }, orderBy: { createdAt: 'desc' }, select: { balanceAfterCents: true } }))?.balanceAfterCents ?? 0
  }
  /** Espera a fila esvaziar (nada esperando/ativo/atrasado) — para afirmar AUSÊNCIA de e-mail só depois de o worker já ter passado. */
  async function filaVazia(): Promise<void> {
    await waitFor(async () => {
      const c = await fila.getJobCounts('waiting', 'active', 'delayed', 'prioritized')
      return c.waiting + c.active + c.delayed + c.prioritized === 0 ? true : null
    }, { timeoutMs: 15_000, what: 'fila de notificações esvaziar' })
  }
  async function dumpRedisDaFila(): Promise<string> {
    const chaves = await redis.keys('bull:notificacoes:*')
    const partes: string[] = []
    for (const k of chaves) {
      const tipo = await redis.type(k)
      if (tipo === 'string') partes.push(`${k}=${await redis.get(k)}`)
      else if (tipo === 'hash') partes.push(`${k}=${dump(await redis.hgetall(k))}`)
      else if (tipo === 'list') partes.push(`${k}=${dump(await redis.lrange(k, 0, -1))}`)
      else if (tipo === 'zset') partes.push(`${k}=${dump(await redis.zrange(k, 0, -1))}`)
      else if (tipo === 'set') partes.push(`${k}=${dump(await redis.smembers(k))}`)
    }
    return partes.join('\n')
  }
  const patch = (m: Motorista, corpo: Record<string, unknown>) => request(app).patch('/api/me/notification-preferences').set(m.auth).send(corpo)
  const get = (m: Motorista) => request(app).get('/api/me/notification-preferences').set(m.auth)

  // ---- aceite 1: recibo, 1 e-mail mesmo com o job reprocessado 3x ------------------------------------------------------------------

  describe('aceite do plano: sessão encerrada => EXATAMENTE 1 e-mail, mesmo com o job reprocessado 3x', () => {
    it('recibo com valor em reais, link do recibo, rodapé com a empresa (LEGAL_*) e link de gerenciar notificações', async () => {
      smtpOk()
      const m = await motorista('recibo')
      const sessionId = await fechar(m, 10_000) // 10 kWh x R$ 1,00

      const [recibo] = await esperarEmail(m.email, 'Recarga concluída')
      expect(recibo.legivel).toContain('R$ 10,00')
      expect(recibo.legivel).toContain('10,00 kWh')
      expect(recibo.legivel).toContain(`https://app.innoflow.test/app/sessoes/${sessionId}`)
      expect(recibo.legivel).toContain('InnoFlow Teste Ltda')
      expect(recibo.legivel).toContain('CNPJ 11.222.333/0001-81')
      expect(recibo.legivel).toContain('Gerenciar notificações: https://app.innoflow.test/app/perfil')
      expect(recibo.bruto).toMatch(/Content-Type: text\/html/i) // html + texto
      expect(recibo.legivel).not.toMatch(/<img/i) // sem pixel de rastreio
      expect(recibo.para).toEqual([m.email])

      const linha = await linhaDo(m.id, 'SESSION_COMPLETED', sessionId)
      expect(linha).toMatchObject({ status: 'SENT', channel: 'EMAIL', attempts: 1, statusReason: null })
      expect(linha?.sentAt).toBeInstanceOf(Date)
    })

    it('job reprocessado 3x (direto) + 3 reenfileiramentos pelo BullMQ + 6 processamentos CONCORRENTES do mesmo fato => 1 e-mail só', async () => {
      smtpOk()
      const m = await motorista('reprocesso')
      const sessionId = await fechar(m, 10_000)
      await esperarEmail(m.email, 'Recarga concluída')
      const dados = { tipo: 'SESSION_COMPLETED' as const, userId: m.id, entityId: sessionId }

      for (let i = 0; i < 3; i++) expect(await processador.processar(dados)).toEqual({ status: 'JA_TRATADA', estado: 'SENT' })
      for (let i = 0; i < 3; i++) expect(await enfileirarNotificacao(dados)).toBe('ENFILEIRADO')
      await filaVazia()
      await settle(600)
      expect(emailsPara(m.email, 'Recarga concluída')).toHaveLength(1)

      // concorrência: um fato NOVO processado por 6 executores ao mesmo tempo
      const outra = await criarSessao(tenant, m.id, 'STOPPED', { totalCostCents: 700 })
      const novo = { tipo: 'SESSION_COMPLETED' as const, userId: m.id, entityId: outra.id }
      const resultados = await Promise.all(Array.from({ length: 6 }, () => processador.processar(novo)))
      expect(resultados.filter((r) => r.status === 'ENVIADA')).toHaveLength(1)
      for (const r of resultados) expect(['ENVIADA', 'JA_TRATADA', 'REPETIR']).toContain(r.status)
      expect(await processador.processar(novo)).toEqual({ status: 'JA_TRATADA', estado: 'SENT' })
      expect(emailsPara(m.email, 'R$ 7,00')).toHaveLength(1)
      expect(await prisma.notificationLog.count({ where: { userId: m.id, type: 'SESSION_COMPLETED', entityId: outra.id } })).toBe(1)
    })
  })

  // ---- aceite 2: SMTP fora -------------------------------------------------------------------------------------------------------------

  describe('aceite do plano: SMTP fora => a sessão fecha e cobra normal, o job reentra e alerta ao esgotar', () => {
    it('SMTP recusando: sessão STOPPED + débito gravado; aviso fica PENDING com CÓDIGO; ao voltar, o job reentra e sai UM e-mail', async () => {
      smtpFora()
      const m = await motorista('smtp-fora')
      const antes = smtp.recebidos.length
      const sessionId = await fechar(m, 10_000)

      // o fechamento e a cobrança NÃO dependem do e-mail
      expect((await prisma.chargingSession.findUniqueOrThrow({ where: { id: sessionId } })).status).toBe('STOPPED')
      expect(await prisma.walletEntry.count({ where: { walletId: m.walletId, type: 'CHARGE_DEBIT', referenceId: sessionId } })).toBe(1)
      expect(await saldo(m.walletId)).toBe(9_000)

      // 1ª tentativa falhou: linha PENDING com código (nunca a mensagem do SMTP), job ATRASADO para tentar de novo
      const linha = await waitFor(async () => {
        const l = await linhaDo(m.id, 'SESSION_COMPLETED', sessionId)
        return l && l.attempts >= 1 && l.statusReason ? l : null
      }, { timeoutMs: 15_000, what: 'primeira tentativa falha' })
      expect(linha.status).toBe('PENDING')
      expect(linha.statusReason).toMatch(/^SMTP_[A-Z_]+$/)
      expect(linha.statusReason).not.toMatch(/[@\s]/)
      expect(smtp.recebidos.length).toBe(antes)

      const jobId = jobIdDaNotificacao('SESSION_COMPLETED', sessionId)
      const job = await waitFor(async () => {
        const j = await fila.getJob(jobId)
        return j && (await j.getState()) === 'delayed' ? j : null
      }, { timeoutMs: 10_000, what: 'job atrasado para o retry' })

      // o SMTP volta; o job reentra (promove o atraso do backoff) e sai UM e-mail
      smtpOk()
      await job.promote()
      await esperarEmail(m.email, 'Recarga concluída')
      const final = await waitFor(async () => {
        const l = await linhaDo(m.id, 'SESSION_COMPLETED', sessionId)
        return l?.status === 'SENT' ? l : null
      })
      expect(final.attempts).toBe(2)
      await settle(400)
      expect(emailsPara(m.email, 'Recarga concluída')).toHaveLength(1)
    }, 60_000)

    it('esgotou as tentativas: linha FAILED com o código, ALERTA communication_notification_failed (sem ids nem e-mail) e nenhum e-mail', async () => {
      smtpFora()
      const m = await motorista('esgota')
      const s = await criarSessao(tenant, m.id, 'STOPPED', { totalCostCents: 900 })
      await prisma.debt.create({ data: { userId: m.id, chargingSessionId: s.id, amountCents: 900, status: 'OPEN', reason: 'INSUFFICIENT_WALLET_BALANCE' } })
      alertasEmitidos.length = 0
      const antes = smtp.recebidos.length

      const r = await enfileirarNotificacao({ tipo: 'SESSION_PAYMENT_FAILED', userId: m.id, entityId: s.id }, { opcoesDoJob: { attempts: 2, backoffMs: 50 } })
      expect(r).toBe('ENFILEIRADO')

      const linha = await waitFor(async () => {
        const l = await linhaDo(m.id, 'SESSION_PAYMENT_FAILED', s.id)
        return l?.status === 'FAILED' ? l : null
      }, { timeoutMs: 20_000, what: 'linha FAILED' })
      expect(linha.statusReason).toMatch(/^SMTP_[A-Z_]+$/)
      expect(linha.attempts).toBe(2)
      expect(smtp.recebidos.length).toBe(antes)

      const alerta = await waitFor(async () => alertasEmitidos.find((a) => a.alert === 'communication_notification_failed') ?? null, { timeoutMs: 10_000, what: 'alerta de falha' })
      expect(alerta).toMatchObject({ escopo: 'SESSION_PAYMENT_FAILED', motivo: linha.statusReason, tentativas: 2 })
      expect(dump(alerta)).not.toContain(m.id)
      expect(dump(alerta)).not.toContain(s.id)
      expect(dump(alerta)).not.toContain(m.email)
      smtpOk()
    }, 60_000)
  })

  // ---- aceite 3: saldo baixo só no cruzamento ----------------------------------------------------------------------------------------

  describe('aceite do plano: saldo baixo só no CRUZAMENTO do limiar', () => {
    it('R$ 25 -> R$ 15 com limiar R$ 20 => 1 aviso; R$ 15 -> R$ 10 => nenhum aviso novo', async () => {
      smtpOk()
      const m = await motorista('saldo', 2_500)
      await fechar(m, 10_000) // R$ 10,00 => saldo R$ 15,00
      expect(await saldo(m.walletId)).toBe(1_500)
      const [aviso] = await esperarEmail(m.email, 'Seu saldo está baixo')
      expect(aviso.legivel).toContain('R$ 15,00')
      expect(aviso.legivel).toContain('R$ 20,00')

      await fechar(m, 5_000) // R$ 5,00 => saldo R$ 10,00
      expect(await saldo(m.walletId)).toBe(1_000)
      await esperarEmail(m.email, 'Recarga concluída', 2) // os dois recibos chegaram
      await filaVazia()
      await settle(500)
      expect(emailsPara(m.email, 'Seu saldo está baixo')).toHaveLength(1)
      expect((await linhas(m.id)).filter((l) => l.type === 'LOW_BALANCE')).toHaveLength(1)
    })

    it('o limiar da pessoa manda; saldo baixo desligado não gera nem linha; débito manual do ADMIN que cruza também avisa', async () => {
      smtpOk()
      const desligado = await motorista('saldo-off', 2_500)
      expect((await patch(desligado, { lowBalanceEnabled: false })).status).toBe(200)
      await fechar(desligado, 10_000)
      await esperarEmail(desligado.email, 'Recarga concluída')
      await filaVazia()
      expect(emailsPara(desligado.email, 'Seu saldo está baixo')).toHaveLength(0)
      expect((await linhas(desligado.id)).filter((l) => l.type === 'LOW_BALANCE')).toHaveLength(0)

      const limiarBaixo = await motorista('saldo-limiar', 2_500)
      expect((await patch(limiarBaixo, { lowBalanceThresholdCents: 1_000 })).status).toBe(200)
      await fechar(limiarBaixo, 10_000) // 25 -> 15: não cruza R$ 10
      await esperarEmail(limiarBaixo.email, 'Recarga concluída')
      await filaVazia()
      expect(emailsPara(limiarBaixo.email, 'Seu saldo está baixo')).toHaveLength(0)

      const admin = await prisma.user.create({ data: { role: 'ADMIN', name: 'Admin L16', email: `admin-l16-${suffix}-${randomUUID().slice(0, 4)}@example.com`, passwordHash: 'x' } })
      await ajustarCarteiraTransacional({
        userId: limiarBaixo.id,
        amountCents: -1_000, // 15 -> 5: cruza R$ 10
        description: 'ajuste de teste',
        createdByUserId: admin.id,
        actor: { userId: admin.id, role: 'ADMIN', email: admin.email, name: admin.name, operatorId: null },
        request: { method: 'POST', path: '/x', ipAddress: null, userAgent: null, requestId: null },
      })
      await aguardarNotificacoesEmVoo()
      const [manual] = await esperarEmail(limiarBaixo.email, 'Seu saldo está baixo')
      expect(manual.legivel).toContain('R$ 5,00')
      expect(manual.legivel).toContain('R$ 10,00')
    })
  })

  // ---- aceite 4: preferências ------------------------------------------------------------------------------------------------------------

  describe('aceite do plano: recibo desligado => nenhum recibo, mas a falha de cobrança chega', () => {
    it('recibo OFF: sessão paga não manda e-mail (linha SKIPPED/PREFERENCE_OFF); a sessão que vira dívida manda a COBRANÇA PENDENTE', async () => {
      smtpOk()
      const m = await motorista('recibo-off', 600)
      expect((await patch(m, { sessionReceiptEmail: false })).status).toBe(200)

      const pago = await fechar(m, 5_000) // R$ 5,00 de R$ 6,00: sem dívida
      await filaVazia()
      await waitFor(async () => (await linhaDo(m.id, 'SESSION_COMPLETED', pago))?.status === 'SKIPPED')
      expect(await linhaDo(m.id, 'SESSION_COMPLETED', pago)).toMatchObject({ status: 'SKIPPED', statusReason: 'PREFERENCE_OFF', sentAt: null })
      expect(emailsPara(m.email)).toHaveLength(0)

      const comDivida = await fechar(m, 10_000) // R$ 10,00 com R$ 1,00 de saldo: R$ 9,00 de dívida
      expect(await prisma.debt.aggregate({ where: { userId: m.id, chargingSessionId: comDivida }, _sum: { amountCents: true } })).toMatchObject({ _sum: { amountCents: 900 } })
      const [falha] = await esperarEmail(m.email, 'Não conseguimos cobrar a sua recarga')
      expect(falha.legivel).toContain('R$ 9,00')
      expect(falha.legivel).toContain('https://app.innoflow.test/app/carteira/adicionar')
      await filaVazia()
      await settle(400)
      expect(emailsPara(m.email)).toHaveLength(1) // nenhum recibo (nem o da sessão com dívida)
      expect(await linhaDo(m.id, 'SESSION_PAYMENT_FAILED', comDivida)).toMatchObject({ status: 'SENT' })
    })

    it('segurança e cobrança NÃO são desligáveis: a API recusa qualquer campo fora do contrato (400) e nada é gravado; com tudo OFF a senha alterada AINDA chega', async () => {
      smtpOk()
      const m = await motorista('sempre')
      for (const campo of ['passwordChanged', 'sessionPaymentFailed', 'accountDeleted', 'securityEmail', 'billingEmail', 'type', 'userId', 'topupCredited']) {
        const res = await patch(m, { [campo]: false })
        expect(res.status, `${campo}: ${dump(res.body)}`).toBe(400)
        expect(res.body.code).toBe('VALIDATION_ERROR')
      }
      // junto de uma chave VÁLIDA, o campo estranho também derruba tudo (não é ignorado em silêncio) e nada é gravado
      for (const campo of ['passwordChanged', 'sessionPaymentFailed', 'accountDeleted']) {
        const misto = await patch(m, { lowBalanceEnabled: false, [campo]: false })
        expect(misto.status, campo).toBe(400)
      }
      expect(await prisma.notificationPreference.count({ where: { userId: m.id } })).toBe(0) // nenhuma gravação
      expect((await patch(m, { sessionReceiptEmail: false, lowBalanceEnabled: false })).status).toBe(200)

      const troca = (de: string, para: string) => request(app).post('/api/auth/password').set(m.auth).send({ currentPassword: de, newPassword: para })
      const r1 = await troca(SENHA_DO_MOTORISTA, 'Senha-Nova-456')
      expect(r1.status, dump(r1.body)).toBe(200)
      const [alterada] = await esperarEmail(m.email, 'Sua senha foi alterada')
      expect(alterada.legivel).toContain('desconectado de todos os aparelhos')
      expect(alterada.legivel).toContain('https://app.innoflow.test/esqueci-senha')
      expect(alterada.legivel).not.toContain('Senha-Nova-456')
      expect(alterada.legivel).not.toContain(SENHA_DO_MOTORISTA)

      // cada troca é um fato novo: a 2ª manda o 2º aviso (e não duplica o 1º)
      const token2 = (await request(app).post('/api/auth/login').send({ email: m.email, password: 'Senha-Nova-456' })).body.token as string
      const r2 = await request(app).post('/api/auth/password').set({ Authorization: `Bearer ${token2}` }).send({ currentPassword: 'Senha-Nova-456', newPassword: 'Senha-Outra-789' })
      expect(r2.status, dump(r2.body)).toBe(200)
      await esperarEmail(m.email, 'Sua senha foi alterada', 2)
      await filaVazia()
      await settle(400)
      expect(emailsPara(m.email, 'Sua senha foi alterada')).toHaveLength(2)
      expect((await linhas(m.id)).filter((l) => l.type === 'PASSWORD_CHANGED' && l.status === 'SENT')).toHaveLength(2)
    })
  })

  describe('GET/PATCH /api/me/notification-preferences', () => {
    it('GET devolve os padrões do plano (sem linha no banco); PATCH parcial cria a linha e preserva o resto', async () => {
      const m = await motorista('prefs')
      const padrao = await get(m)
      expect(padrao.status).toBe(200)
      expect(padrao.body).toEqual({ sessionReceiptEmail: true, lowBalanceEnabled: true, lowBalanceThresholdCents: 2000 })
      expect(await prisma.notificationPreference.count({ where: { userId: m.id } })).toBe(0)

      const p1 = await patch(m, { lowBalanceThresholdCents: 5_000 })
      expect(p1.status).toBe(200)
      expect(p1.body).toEqual({ sessionReceiptEmail: true, lowBalanceEnabled: true, lowBalanceThresholdCents: 5_000 })
      const p2 = await patch(m, { sessionReceiptEmail: false })
      expect(p2.body).toEqual({ sessionReceiptEmail: false, lowBalanceEnabled: true, lowBalanceThresholdCents: 5_000 })
      expect((await get(m)).body).toEqual(p2.body)
    })

    it('validação: limiar fora de 500..50000, fracionário, texto, corpo vazio e campo desconhecido => 400 VALIDATION_ERROR', async () => {
      const m = await motorista('prefs-val')
      for (const corpo of [{ lowBalanceThresholdCents: 499 }, { lowBalanceThresholdCents: 50_001 }, { lowBalanceThresholdCents: 1000.5 }, { lowBalanceThresholdCents: '2000' }, { lowBalanceEnabled: 'sim' }, {}, { lowBalanceThresholdCents: 2000, extra: 1 }]) {
        const res = await patch(m, corpo)
        expect(res.status, dump(corpo)).toBe(400)
        expect(res.body.code).toBe('VALIDATION_ERROR')
      }
      for (const ok of [500, 50_000]) expect((await patch(m, { lowBalanceThresholdCents: ok })).body.lowBalanceThresholdCents).toBe(ok)
    })

    it('IDOR/autorização: sem token 401; ADMIN e OPERATOR 403; o motorista só mexe nas PRÓPRIAS preferências (userId no corpo é recusado)', async () => {
      const a = await motorista('idor-a')
      const b = await motorista('idor-b')
      expect((await request(app).get('/api/me/notification-preferences')).status).toBe(401)
      expect((await request(app).patch('/api/me/notification-preferences').send({ lowBalanceEnabled: false })).status).toBe(401)
      const admin = await prisma.user.create({ data: { role: 'ADMIN', name: 'Adm', email: `adm-prefs-${suffix}-${randomUUID().slice(0, 4)}@example.com`, passwordHash: 'x' } })
      const { issueToken } = await import('../../src/lib/jwt')
      const tokenAdmin = issueToken({ id: admin.id, role: 'ADMIN', operatorId: null })
      expect((await request(app).get('/api/me/notification-preferences').set({ Authorization: `Bearer ${tokenAdmin}` })).status).toBe(403)
      expect((await request(app).patch('/api/me/notification-preferences').set({ Authorization: `Bearer ${tenant.staff.token}` }).send({ lowBalanceEnabled: false })).status).toBe(403)

      expect((await patch(a, { lowBalanceEnabled: false, lowBalanceThresholdCents: 7_000 })).status).toBe(200)
      const tentativa = await patch(a, { userId: b.id, lowBalanceEnabled: true })
      expect(tentativa.status).toBe(400)
      expect(await prisma.notificationPreference.count({ where: { userId: b.id } })).toBe(0)
      expect((await get(b)).body).toEqual({ sessionReceiptEmail: true, lowBalanceEnabled: true, lowBalanceThresholdCents: 2000 })
      expect((await get(a)).body).toEqual({ sessionReceiptEmail: true, lowBalanceEnabled: false, lowBalanceThresholdCents: 7_000 })
    })

    it('duas PRIMEIRAS gravações simultâneas não dão 500 (a perdedora refaz como UPDATE)', async () => {
      const m = await motorista('prefs-corrida')
      const res = await Promise.all([patch(m, { lowBalanceEnabled: false }), patch(m, { sessionReceiptEmail: false }), patch(m, { lowBalanceThresholdCents: 3_000 })])
      expect(res.map((r) => r.status)).toEqual([200, 200, 200])
      expect(await prisma.notificationPreference.count({ where: { userId: m.id } })).toBe(1)
    })
  })

  // ---- demais eventos --------------------------------------------------------------------------------------------------------------

  describe('demais eventos', () => {
    it('sessão que vira DÍVIDA (recibo e saldo baixo LIGADOS): manda SÓ a cobrança pendente — nem recibo ("pago com a carteira" seria mentira) nem saldo baixo (o saldo zerou por causa dela)', async () => {
      smtpOk()
      const m = await motorista('divida', 3_000) // saldo R$ 30,00 acima do limiar de R$ 20,00
      const sessionId = await fechar(m, 40_000) // R$ 40,00: debita R$ 30,00 e sobra R$ 10,00 de dívida
      expect(await saldo(m.walletId)).toBe(0)
      const [falha] = await esperarEmail(m.email, 'Não conseguimos cobrar a sua recarga')
      expect(falha.legivel).toContain('R$ 10,00')
      await filaVazia()
      await settle(500)
      expect(emailsPara(m.email)).toHaveLength(1)
      expect((await linhas(m.id)).map((l) => l.type)).toEqual(['SESSION_PAYMENT_FAILED'])
      expect(await linhaDo(m.id, 'SESSION_PAYMENT_FAILED', sessionId)).toMatchObject({ status: 'SENT' })
    })

    it('Pix creditado: 1 comprovante (webhook/polling/varredor repetidos NÃO duplicam)', async () => {
      smtpOk()
      const m = await motorista('pix', 0)
      const res = await request(app).post('/api/me/wallet/topups').set(m.auth).send({ amountCents: 3_000 })
      expect(res.status, dump(res.body)).toBe(201)
      const intent = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: res.body.id } })
      fake.marcarPixComoPago(intent.cieloPaymentId!)
      expect(await creditarTopupPix(intent.id, fake)).not.toBeNull()
      expect(await creditarTopupPix(intent.id, fake)).toBeNull() // 2ª chamada: já creditado
      expect(await creditarTopupPix(intent.id, fake)).toBeNull()
      await aguardarNotificacoesEmVoo()
      const [pix] = await esperarEmail(m.email, 'Saldo adicionado à sua carteira')
      expect(pix.legivel).toContain('R$ 30,00 foram creditados')
      expect(pix.legivel).toContain('Saldo atual: R$ 30,00')
      await filaVazia()
      await settle(400)
      expect(emailsPara(m.email, 'Saldo adicionado')).toHaveLength(1)
    })

    it('recarga iniciada pelo suporte: cita o posto e o operador, e a recusa do carregador não cobra', async () => {
      smtpOk()
      const m = await motorista('suporte')
      const correlationId = randomUUID()
      notificarRecargaIniciadaPeloSuporte({ userId: m.id, correlationId, chargePointId: tenant.chargePointId })
      notificarRecargaIniciadaPeloSuporte({ userId: m.id, correlationId, chargePointId: tenant.chargePointId }) // mesma ordem repetida
      await aguardarNotificacoesEmVoo()
      const [e] = await esperarEmail(m.email, 'Uma recarga foi iniciada na sua conta pelo suporte')
      expect(e.legivel).toContain(`Site notif ${suffix}`)
      expect(e.legivel).toContain(`Operador notif ${suffix}`)
      expect(e.legivel).toContain('nada é cobrado')
      await filaVazia()
      await settle(400)
      expect(emailsPara(m.email, 'pelo suporte')).toHaveLength(1)
    })

    it('recarga iniciada pelo suporte PELA ROTA do admin (POST .../commands/remote-start): 202 e o motorista recebe o aviso, UMA vez', async () => {
      smtpOk()
      const m = await motorista('suporte-rota', 5_000)
      const admin = await createUser({ role: 'ADMIN', label: 'admin-rs', suffix: `${suffix}-${randomUUID().slice(0, 4)}` })
      const res = await request(app).post(`/api/admin/charge-points/${tenant.chargePointId}/commands/remote-start`).set({ Authorization: `Bearer ${admin.token}` }).send({ connectorId: 1, userId: m.id, reason: 'Cliente sem bateria no celular, recarga assistida' })
      expect(res.status, dump(res.body)).toBe(202)
      const [e] = await esperarEmail(m.email, 'pelo suporte')
      expect(e.legivel).toContain(`Site notif ${suffix}`)
      await filaVazia()
      await settle(300)
      expect(emailsPara(m.email, 'pelo suporte')).toHaveLength(1)
      expect(await linhaDo(m.id, 'REMOTE_START_BY_SUPPORT', res.body.correlationId)).toMatchObject({ status: 'SENT' })
    })

    it('sessão encerrada pelo SERVIDOR manda o aviso próprio (e não o recibo); sessão de custo zero não manda recibo', async () => {
      smtpOk()
      const m = await motorista('servidor')
      const s = await criarSessao(tenant, m.id, 'STARTED')
      const r = await finalizarSessao(s.id, { meterStopWh: 10_000, timestamp: new Date(), stopReason: 'OTHER', closureSource: 'SERVER', meterStopSource: 'LAST_METER_SAMPLE' })
      expect(r.finalizada).toBe(true)
      await aguardarNotificacoesEmVoo()
      const [e] = await esperarEmail(m.email, 'Sua recarga foi encerrada pelo sistema')
      expect(e.legivel).toContain('R$ 10,00')
      expect(emailsPara(m.email, 'Recarga concluída')).toHaveLength(0)

      const zero = await motorista('zero')
      await fechar(zero, 0) // nenhuma energia: nenhum valor
      await filaVazia()
      await settle(300)
      expect(emailsPara(zero.email)).toHaveLength(0)
      expect(await linhas(zero.id)).toHaveLength(0)
    })

    it('conta excluída: o aviso sai para o endereço de ANTES; o e-mail só existe no payload do job e NÃO fica em repouso (banco, Redis, log) depois de concluir', async () => {
      smtpOk()
      const m = await motorista('excluir', 0)
      const res = await request(app).post('/api/me/account/deletion').set(m.auth).send({ confirmation: 'EXCLUIR', currentPassword: SENHA_DO_MOTORISTA })
      expect(res.status, dump(res.body)).toBe(200)
      const [e] = await esperarEmail(m.email, 'Sua conta foi excluída')
      expect(e.legivel).toContain('anonimizados')
      expect(e.legivel).not.toContain('/app/perfil') // a conta não existe mais

      const pedido = await prisma.accountDeletionRequest.findFirstOrThrow({ where: { userId: m.id } })
      const linha = await waitFor(async () => {
        const l = await linhaDo(m.id, 'ACCOUNT_DELETED', pedido.id)
        return l?.status === 'SENT' ? l : null
      })
      expect(linha.entityId).toBe(pedido.id)
      await filaVazia()
      await settle(300)
      expect(dump(await linhas(m.id))).not.toContain(m.email)
      const redisDump = await dumpRedisDaFila()
      expect(redisDump).not.toContain(m.email)
      expect(await fila.getJob(jobIdDaNotificacao('ACCOUNT_DELETED', pedido.id))).toBeUndefined()
      expect(logsTodos.join('\n')).not.toContain(m.email)
    })

    it('conta excluída + SMTP fora até ESGOTAR: o endereço é apagado do payload do job (não fica 1 dia no Redis)', async () => {
      smtpFora()
      const m = await motorista('excluir-falha', 0)
      const requestId = `del-${randomUUID()}`
      const r = await enfileirarNotificacao({ tipo: 'ACCOUNT_DELETED', userId: m.id, entityId: requestId, destinatario: { email: m.email, nome: 'Fulana' } }, { opcoesDoJob: { attempts: 2, backoffMs: 50 } })
      expect(r).toBe('ENFILEIRADO')
      await waitFor(async () => (await linhaDo(m.id, 'ACCOUNT_DELETED', requestId))?.status === 'FAILED', { timeoutMs: 20_000, what: 'FAILED' })
      await waitFor(async () => {
        const j = await fila.getJob(jobIdDaNotificacao('ACCOUNT_DELETED', requestId))
        return j && j.data.destinatario === undefined ? true : null
      }, { timeoutMs: 10_000, what: 'payload sem o endereço' })
      expect(await dumpRedisDaFila()).not.toContain(m.email)
      smtpOk()
    }, 60_000)
  })

  // ---- cartão -----------------------------------------------------------------------------------------------------------------------

  describe('sessão paga com CARTÃO', () => {
    async function donoDoIntent(intentId: string) {
      const intent = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intentId }, select: { userId: true } })
      const u = await prisma.user.findUniqueOrThrow({ where: { id: intent.userId }, select: { id: true, email: true } })
      emailsDosMotoristas.add(u.email)
      return u
    }

    it('captura NEGADA: recibo no fechamento (cartão) + UMA cobrança pendente depois (R$ 3,00); a captura repetida não manda a 2ª', async () => {
      smtpOk()
      const { intent } = await fxCartao.sessaoParada('negada')
      const dono = await donoDoIntent(intent.id)
      await aguardarNotificacoesEmVoo()
      const [recibo] = await esperarEmail(dono.email, 'Recarga concluída')
      expect(recibo.legivel).toContain('Pago com: cartão')
      expect(recibo.legivel).toContain('R$ 3,00')

      fake.definirModoCaptura('NEGADA')
      try {
        expect(await capturarSessaoCartao(intent.id, fake)).toMatchObject({ status: 'FAILED', shortfallCents: 300 })
        expect(await capturarSessaoCartao(intent.id, fake)).toBeNull() // já processado
        expect(await capturarSessaoCartao(intent.id, fake)).toBeNull()
      } finally {
        fake.definirModoCaptura('NORMAL')
      }
      await aguardarNotificacoesEmVoo()
      const [falha] = await esperarEmail(dono.email, 'Não conseguimos cobrar a sua recarga')
      expect(falha.legivel).toContain('R$ 3,00 pendentes')
      await filaVazia()
      await settle(500)
      expect(emailsPara(dono.email, 'Não conseguimos cobrar')).toHaveLength(1)
      expect(emailsPara(dono.email)).toHaveLength(2) // recibo + cobrança, nada mais
      expect((await linhas(dono.id)).map((l) => `${l.type}:${l.status}`).sort()).toEqual(['SESSION_COMPLETED:SENT', 'SESSION_PAYMENT_FAILED:SENT'])
    })

    it('captura que DÁ CERTO: só o recibo — nenhuma cobrança pendente', async () => {
      smtpOk()
      const { intent } = await fxCartao.sessaoParada('ok')
      const dono = await donoDoIntent(intent.id)
      expect(await capturarSessaoCartao(intent.id, fake)).toMatchObject({ status: 'CAPTURED', shortfallCents: 0, debtId: null })
      await aguardarNotificacoesEmVoo()
      await esperarEmail(dono.email, 'Recarga concluída')
      await filaVazia()
      await settle(500)
      expect(emailsPara(dono.email)).toHaveLength(1)
      expect(emailsPara(dono.email, 'Não conseguimos cobrar')).toHaveLength(0)
    })
  })

  // ---- produtor resiliente -----------------------------------------------------------------------------------------------------------

  describe('produtor: nunca derruba nem atrasa quem chama', () => {
    it('Redis/fila PENDURADO: devolve FALHOU no prazo, sem lançar; o gatilho devolve na hora (síncrono) e não propaga erro', async () => {
      const queuePendurada = { add: () => new Promise<never>(() => undefined) } as unknown as Queue
      const t0 = Date.now()
      expect(await enfileirarNotificacao({ tipo: 'SESSION_COMPLETED', userId: 'u', entityId: 'e' }, { queue: queuePendurada, prazoMs: 150 })).toBe('FALHOU')
      expect(Date.now() - t0).toBeLessThan(2_000)

      const t1 = Date.now()
      const retorno = notificarSessaoEncerrada({ sessionId: 's', userId: 'u', closureSource: 'CHARGER', totalCostCents: 100 }, { queue: queuePendurada, prazoMs: 150 })
      expect(retorno).toBeUndefined()
      expect(Date.now() - t1).toBeLessThan(50) // não esperou nada
      await aguardarNotificacoesEmVoo()
    })

    it('fila que LANÇA: FALHOU, sem exceção; pedido inválido (tipo/entidade/destinatário) é RECUSADO sem tocar na fila', async () => {
      const queueQueLanca = { add: () => Promise.reject(new Error('ECONNREFUSED 10.0.0.1:6379 senha=segredo')) } as unknown as Queue
      expect(await enfileirarNotificacao({ tipo: 'LOW_BALANCE', userId: 'u', entityId: 'e' }, { queue: queueQueLanca })).toBe('FALHOU')
      const add = vi.fn()
      const q = { add } as unknown as Queue
      expect(await enfileirarNotificacao({ tipo: 'NAO_EXISTE' as never, userId: 'u', entityId: 'e' }, { queue: q })).toBe('RECUSADO')
      expect(await enfileirarNotificacao({ tipo: 'LOW_BALANCE', userId: 'u', entityId: '' }, { queue: q })).toBe('RECUSADO')
      expect(await enfileirarNotificacao({ tipo: 'LOW_BALANCE', userId: 'u', entityId: 'x'.repeat(129) }, { queue: q })).toBe('RECUSADO')
      expect(await enfileirarNotificacao({ tipo: 'ACCOUNT_DELETED', userId: 'u', entityId: 'e' }, { queue: q })).toBe('RECUSADO') // sem destinatário
      expect(add).not.toHaveBeenCalled()
    })
  })

  // ---- logs ---------------------------------------------------------------------------------------------------------------------------

  describe('segredo/token/e-mail ausentes dos logs', () => {
    it('nenhum e-mail de motorista, senha ou token aparece nos logs das notificações; só ids opacos e códigos', () => {
      const todos = logsTodos.join('\n')
      const doModulo = logsTodos.filter((l) => /notificacoes|notification_/i.test(l)).join('\n')
      expect(doModulo.length).toBeGreaterThan(0) // houve log (o teste não passa por vazio)
      for (const email of emailsDosMotoristas) expect(doModulo, `e-mail ${email} nos logs das notificações`).not.toContain(email)
      for (const proibido of [SENHA_DO_MOTORISTA, 'Senha-Nova-456', 'Senha-Outra-789']) expect(todos).not.toContain(proibido)
      expect(doModulo).not.toMatch(/senha=segredo|10\.0\.0\.1/) // a mensagem crua do erro da fila não vaza
    })
  })
})
