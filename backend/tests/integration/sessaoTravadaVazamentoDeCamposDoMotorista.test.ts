import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { cenariosCriados, criarCenario, criarSessao, resolverCapturasPendentes, tokenDoMotorista, type Cenario } from './helpers/sessaoTravadaFixture'
import { createUser, settle, uniqueSuffix, waitFor } from './helpers/fixtures'

/**
 * F5.9d (Íris) — o JSON do MOTORISTA nunca carrega o que é do operador/admin, em NENHUM endpoint que o motorista alcança — e a diferença
 * ADMIN x OPERATOR no detalhe. O teste do Vega olha o detalhe de uma sessão; aqui a sessão está TODA preenchida (stop tardio, não cobrado, pedido
 * de parada, tentativas, custo provisório) com VALORES SENTINELA que não existem em outro lugar — assim o teste pega o dado mesmo se vazar com
 * OUTRO nome de chave (a busca é pelo valor, além do nome).
 * Endpoints do motorista cobertos: /sessions/active, /sessions (lista), /sessions/:id (aberta, em confirmação e encerrada pelo servidor), /wallet.
 */
describe('F5.9d — vazamento de campos do operador no JSON do motorista; ADMIN x OPERATOR no detalhe (Postgres + Redis reais)', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  let cen: Cenario
  let outro: Cenario
  let admin: Awaited<ReturnType<typeof createUser>>

  // sentinelas: números de 7 dígitos que não aparecem em id/horário/custo de nenhuma resposta
  const SENT_LATE_WH = 7_654_321
  const SENT_UNBILLED = 8_765_432
  const SENT_PROVISIONAL = 9_876_543

  const CHAVES_PROIBIDAS = /lateStop|unbilled|provisional|stopRequested|stopAttempts|stop_requested|late_stop|unbilledCost|provisionalCost/i

  beforeAll(async () => {
    cen = await criarCenario(suffix, 'vaza')
    outro = await criarCenario(`${suffix}o`, 'vaza-outro')
    admin = await createUser({ role: 'ADMIN', label: 'admin-vaza', suffix })
  })
  afterAll(async () => {
    await resolverCapturasPendentes(cenariosCriados)
    await prisma.$disconnect()
    redis.disconnect()
  })

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` })

  async function sessaoCompleta() {
    // encerrada PELO SERVIDOR com stop tardio registrado, pedido de parada humano e custo provisório gravado
    const s = await criarSessao(cen, { mode: 'WALLET', status: 'STOPPED', saldoCents: 10_000, meterStartWh: 1_000, amostrasWh: [2_000], iniciouHaMin: 90 })
    await prisma.chargingSession.update({
      where: { id: s.session.id },
      data: {
        stoppedAt: new Date(Date.now() - 20 * 60_000),
        meterStopWh: 2_000,
        energyDeliveredWh: 1_000,
        totalCostCents: 100,
        energyCostCents: 100,
        closureSource: 'SERVER',
        meterStopSource: 'LAST_METER_SAMPLE',
        unconfirmedReason: 'CHARGER_UNREACHABLE',
        lateStopMeterWh: SENT_LATE_WH,
        lateStopAt: new Date(Date.now() - 10 * 60_000),
        lateStopReceivedAt: new Date(Date.now() - 5 * 60_000),
        unbilledCostCents: SENT_UNBILLED,
        provisionalCostCents: SENT_PROVISIONAL,
        stopRequestedAt: new Date(Date.now() - 30 * 60_000),
        stopRequestedBy: 'WATCHDOG',
        stopAttempts: 3,
      },
    })
    return s
  }

  it('o motorista NUNCA recebe lateStop / unbilled / provisional / stopRequested* / stopAttempts — nem como chave, nem como valor — em sessão ENCERRADA, EM CONFIRMAÇÃO e ABERTA, em todos os endpoints dele', async () => {
    const encerrada = await sessaoCompleta()
    // o MESMO motorista tem uma sessão em confirmação e uma FAULTED (aberta), cada uma com o provisório/pedido de parada sentinela
    const motorista = { driver: encerrada.driver, wallet: encerrada.wallet, authToken: encerrada.authToken }
    const confirmacao = await criarSessao(cen, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', naoConfirmada: { motivo: 'STOP_REJECTED', haMin: 2 }, motorista, amostrasWh: [1_500], stopRequestedHaMin: 3, stopAttempts: 2 })
    await prisma.chargingSession.update({ where: { id: confirmacao.session.id }, data: { provisionalCostCents: SENT_PROVISIONAL } })
    const aberta = await criarSessao(cen, { mode: 'WALLET', status: 'FAULTED', motorista, stopRequestedHaMin: 1, stopAttempts: 1 })
    const token = tokenDoMotorista(encerrada.driver.id)

    const respostas: Array<{ rota: string; corpo: string }> = []
    for (const rota of [
      '/api/me/sessions/active',
      '/api/me/sessions?pageSize=50',
      `/api/me/sessions/${encerrada.session.id}`,
      `/api/me/sessions/${confirmacao.session.id}`,
      `/api/me/sessions/${aberta.session.id}`,
      '/api/me/wallet',
    ]) {
      const res = await request(app).get(rota).set(auth(token))
      expect(res.status, rota).toBe(200)
      respostas.push({ rota, corpo: JSON.stringify(res.body) })
    }

    for (const { rota, corpo } of respostas) {
      expect(corpo, `${rota}: nome de chave proibido`).not.toMatch(CHAVES_PROIBIDAS)
      for (const sentinela of [SENT_LATE_WH, SENT_UNBILLED, SENT_PROVISIONAL]) {
        expect(corpo.includes(String(sentinela)), `${rota}: o valor sentinela ${sentinela} vazou (com outro nome de chave?)`).toBe(false)
      }
    }
    // controle: o endpoint devolveu de verdade as sessões (não é "passou porque veio vazio")
    expect(respostas[2]!.corpo).toContain(encerrada.session.id)
    expect(respostas[3]!.corpo).toContain('STOP_UNCONFIRMED')
    expect(respostas[0]!.corpo).toContain(aberta.session.id)
  })

  it('o evento SSE do motorista (session.updated) carrega só ids técnicos — nenhum campo de dinheiro/stop', async () => {
    // contrato do payload, lido do emissor real: nenhum campo além dos ids
    const { emitSessionUpdated } = await import('../../src/realtime/emit')
    const { subscribeChannels, userChannel } = await import('../../src/realtime/bus')
    const s = await criarSessao(cen, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', naoConfirmada: { motivo: 'STOP_REJECTED', haMin: 1 } })
    const recebidos: string[] = []
    const cancelar = subscribeChannels([userChannel(s.driver.id)], (_evento, bruto) => recebidos.push(bruto))
    try {
      await settle(400) // a assinatura no Redis é assíncrona: publicar antes dela perde o evento
      await emitSessionUpdated({ operatorId: cen.tenant.operatorId, userId: s.driver.id, sessionId: s.session.id, chargePointId: cen.tenant.chargePointId })
      await waitFor(async () => recebidos.length > 0, { timeoutMs: 8_000, what: 'session.updated no canal do motorista' })
      for (const corpo of recebidos) {
        expect(corpo).not.toMatch(CHAVES_PROIBIDAS)
        expect(corpo).not.toMatch(/Cents|Wh/)
      }
    } finally {
      cancelar()
    }
  })

  it('ADMIN vê lateStop (com o desvio financeiro); OPERATOR do dono vê o resto (closure, stopRequested*, stopAttempts) mas lateStop = null; OPERATOR de OUTRO tenant leva 404', async () => {
    const s = await sessaoCompleta()
    const op = tokenOperador(cen)
    const opOutro = tokenOperador(outro)

    const comoAdmin = await request(app).get(`/api/admin/reports/sessions/${s.session.id}`).set(auth(admin.token))
    expect(comoAdmin.status).toBe(200)
    expect(comoAdmin.body.lateStop).toMatchObject({ meterStopWh: SENT_LATE_WH, unbilledCostCents: SENT_UNBILLED })

    const comoOperador = await request(app).get(`/api/admin/reports/sessions/${s.session.id}`).set(auth(op))
    expect(comoOperador.status).toBe(200)
    expect(comoOperador.body.lateStop).toBeNull()
    expect(JSON.stringify(comoOperador.body).includes(String(SENT_UNBILLED)), 'o desvio financeiro (valor) não pode aparecer para OPERATOR em outra chave').toBe(false)
    expect(JSON.stringify(comoOperador.body).includes(String(SENT_LATE_WH))).toBe(false)
    expect(comoOperador.body).toMatchObject({ stopRequestedBy: 'WATCHDOG', stopAttempts: 3 })
    expect(comoOperador.body.closure).toMatchObject({ source: 'SERVER' })
    // o mesmo vale para a LISTA do operador: nenhuma chave de stop tardio
    const lista = await request(app).get('/api/admin/reports/sessions').query({ period: '7d', pageSize: 100 }).set(auth(op))
    expect(lista.status).toBe(200)
    expect(JSON.stringify(lista.body)).not.toMatch(/lateStop|unbilled/i)

    const deOutro = await request(app).get(`/api/admin/reports/sessions/${s.session.id}`).set(auth(opOutro))
    expect(deOutro.status).toBe(404)
  })
})

function tokenOperador(c: Cenario): string {
  return c.tenant.staff.token
}
