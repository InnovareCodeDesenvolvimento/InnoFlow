import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { env } from '../../src/lib/env'
import { handleAuthorize } from '../../src/ocpp/handlers/authorize'
import { handleStartTransaction } from '../../src/ocpp/handlers/startTransaction'
import { handleStopTransaction } from '../../src/ocpp/handlers/stopTransaction'
import { chamarHandler, criarCenario, criarSessao, type Cenario } from './helpers/sessaoTravadaFixture'
import { makeIdTag, uniqueSuffix } from './helpers/fixtures'

/**
 * F5.9d (Íris) — duas coisas que as suítes do Vega não olham:
 *
 * 1) AUTHORIZE DO IDTAG QUE JÁ TEM SESSÃO ABERTA (tap-to-stop com RFID). O M3 passou a descontar do saldo disponível o TETO DE RESERVA das sessões WALLET
 *    abertas — inclusive a PRÓPRIA sessão do idTag que está perguntando. Quem encosta o cartão no poste para PARAR a recarga dispara um `Authorize` do
 *    mesmo idTag; com saldo entre o mínimo e (mínimo + reserva) ele passa a levar `Blocked(INSUFFICIENT_BALANCE)` — o poste recusa o stop local. Antes
 *    do M3 o mesmo saldo dava `Accepted`. `auditoriaM3SaldoComprometidoConcorrencia.test.ts` até afirma o `Blocked` (com o MESMO idTag da sessão aberta),
 *    o que confirma que é o comportamento atual, não um acidente do meu teste. Marcado `it.fails`: quando o Authorize ignorar a sessão do próprio idTag,
 *    o teste passa a "falhar como esperado" e o marcador sai.
 *
 * 2) D7 NAS DUAS CHAVES NO CAMINHO DO POSTE: a chave `SESSION_ALLOW_START_WHILE_UNCONFIRMED` valia no Authorize e na API; o StartTransaction (agora com a
 *    reconferência sob o lock da carteira) também tem de obedecê-la — Authorize pulado, ou sessão que entrou em confirmação DEPOIS do Authorize.
 */
describe('F5.9d — Authorize do idTag com sessão própria aberta e D7 no StartTransaction (Postgres + Redis reais)', () => {
  const suffix = uniqueSuffix()
  let cen: Cenario
  const MIN = env.WALLET_MIN_START_BALANCE_CENTS
  const RESERVA = env.RESERVA_PISO_CENTS
  let numero = 80

  beforeAll(async () => {
    cen = await criarCenario(suffix, 'auth-d7')
  })
  afterAll(async () => {
    ;(env as { SESSION_ALLOW_START_WHILE_UNCONFIRMED: boolean }).SESSION_ALLOW_START_WHILE_UNCONFIRMED = true
    await prisma.$disconnect()
    redis.disconnect()
  })

  async function motorista(label: string, saldoCents: number) {
    const driver = await prisma.user.create({ data: { role: 'DRIVER', name: `Mot ${label} ${suffix}`, email: `ad7-${label}-${suffix}@example.com` } })
    const wallet = await prisma.wallet.create({ data: { userId: driver.id } })
    await prisma.walletEntry.create({ data: { walletId: wallet.id, type: 'ADJUSTMENT_CREDIT', amountCents: saldoCents, balanceAfterCents: saldoCents, referenceType: 'MANUAL', description: 'saldo de teste' } })
    const authToken = await prisma.authToken.create({ data: { idTag: makeIdTag(), type: 'RFID', userId: driver.id } })
    return { driver, wallet, authToken }
  }
  const conectorLivre = (n: number) => prisma.connector.create({ data: { operatorId: cen.tenant.operatorId, chargePointId: cen.tenant.chargePointId, connectorId: n, type: 'AC_TYPE2' } })
  const authorize = (idTag: string) => chamarHandler(handleAuthorize, cen.ctx, { idTag })
  const start = (connectorId: number, idTag: string) => chamarHandler(handleStartTransaction, cen.ctx, { connectorId, idTag, meterStart: 0, timestamp: new Date().toISOString() })

  describe('Authorize do idTag da PRÓPRIA sessão aberta (encostar o cartão para parar)', () => {
    it('controle: com saldo de sobra (mínimo + reserva + folga) o Authorize da própria sessão aberta é Accepted', async () => {
      const m = await motorista('tap-rico', MIN + RESERVA + 1_000)
      await criarSessao(cen, { mode: 'WALLET', motorista: { driver: m.driver, wallet: m.wallet, authToken: m.authToken } })
      expect((await authorize(m.authToken.idTag)).idTagInfo.status).toBe('Accepted')
    })

    it.fails('com saldo entre o mínimo e (mínimo + reserva), o Authorize do MESMO idTag que está carregando deveria ser Accepted (parar a recarga); hoje é Blocked/INSUFFICIENT_BALANCE', async () => {
      const m = await motorista('tap-justo', MIN + RESERVA - 1_000) // 6.000: cobre o início (>= 2.000) mas não "início + reserva da própria sessão"
      const s = await criarSessao(cen, { mode: 'WALLET', motorista: { driver: m.driver, wallet: m.wallet, authToken: m.authToken } })
      // pré-condição: a própria sessão está aberta e é daquele idTag
      expect((await prisma.chargingSession.findUniqueOrThrow({ where: { id: s.session.id } })).authTokenId).toBe(m.authToken.id)
      expect((await authorize(m.authToken.idTag)).idTagInfo.status).toBe('Accepted')
    })
  })

  describe('D7 — StartTransaction (idTag) com sessão do motorista em STOP_UNCONFIRMED', () => {
    const naoConf = { motivo: 'CHARGER_UNREACHABLE' as const, haMin: 3 }

    it('chave = false: StartTransaction é Blocked mesmo com saldo de sobra e a sessão pendente NÃO ganha irmã', async () => {
      ;(env as { SESSION_ALLOW_START_WHILE_UNCONFIRMED: boolean }).SESSION_ALLOW_START_WHILE_UNCONFIRMED = false
      try {
        const m = await motorista('d7-falso', 500_000)
        await criarSessao(cen, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', naoConfirmada: naoConf, motorista: { driver: m.driver, wallet: m.wallet, authToken: m.authToken }, amostrasWh: [1_000] })
        const c = await conectorLivre(++numero)
        const r = await start(c.connectorId, m.authToken.idTag)
        expect(r).toMatchObject({ transactionId: 0, idTagInfo: { status: 'Blocked' } })
        expect(await prisma.chargingSession.count({ where: { userId: m.driver.id } })).toBe(1)
      } finally {
        ;(env as { SESSION_ALLOW_START_WHILE_UNCONFIRMED: boolean }).SESSION_ALLOW_START_WHILE_UNCONFIRMED = true
      }
    })

    it('chave = true: StartTransaction inicia se (saldo - provisório) cobre o mínimo, e BLOQUEIA se o provisório consome o que sobrava', async () => {
      const ok = await motorista('d7-ok', 100_000)
      await criarSessao(cen, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', naoConfirmada: naoConf, motorista: { driver: ok.driver, wallet: ok.wallet, authToken: ok.authToken }, amostrasWh: [1_000], meterStartWh: 0 })
      const c1 = await conectorLivre(++numero)
      expect((await start(c1.connectorId, ok.authToken.idTag)).idTagInfo.status).toBe('Accepted')

      const sem = await motorista('d7-sem', MIN + 500)
      const pend = await criarSessao(cen, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', naoConfirmada: naoConf, motorista: { driver: sem.driver, wallet: sem.wallet, authToken: sem.authToken }, amostrasWh: [1_000], meterStartWh: 0 })
      await prisma.chargingSession.update({ where: { id: pend.session.id }, data: { provisionalCostCents: 1_000 } }) // 2.500 - 1.000 = 1.500 < 2.000
      const c2 = await conectorLivre(++numero)
      expect(await start(c2.connectorId, sem.authToken.idTag)).toMatchObject({ transactionId: 0, idTagInfo: { status: 'Blocked' } })
    })

    it('DUAS inicializações simultâneas (RFID em dois conectores) sobre o saldo que a sessão pendente deixou: no máximo UMA passa, 8 rodadas', async () => {
      for (let rodada = 0; rodada < 8; rodada++) {
        // saldo 8.000, provisório 1.500 => disponível 6.500 (>= 2.000, passa o 1º); depois da reserva da 1ª (5.000) sobram 1.500 < 2.000 => a 2ª é barrada
        const m = await motorista(`d7-sim-${rodada}`, 8_000)
        const t2 = await prisma.authToken.create({ data: { idTag: makeIdTag(), type: 'RFID', userId: m.driver.id } })
        const pend = await criarSessao(cen, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', naoConfirmada: naoConf, motorista: { driver: m.driver, wallet: m.wallet, authToken: m.authToken }, amostrasWh: [1_000], meterStartWh: 0 })
        await prisma.chargingSession.update({ where: { id: pend.session.id }, data: { provisionalCostCents: 1_500 } })
        const cA = await conectorLivre(++numero)
        const cB = await conectorLivre(++numero)
        const [ra, rb] = await Promise.all([start(cA.connectorId, m.authToken.idTag), start(cB.connectorId, t2.idTag)])
        const aceitas = [ra, rb].filter((r) => r.idTagInfo.status === 'Accepted')
        expect(aceitas, `rodada ${rodada}: ${JSON.stringify([ra, rb])}`).toHaveLength(1)
        const abertas = await prisma.chargingSession.count({ where: { userId: m.driver.id, status: { in: ['STARTED', 'CHARGING', 'FINISHING', 'FAULTED'] } } })
        expect(abertas, `rodada ${rodada}: UMA sessão nova aberta`).toBe(1)
      }
    })
  })
  describe('lock da carteira no StartTransaction x fechamento da sessão anterior do MESMO motorista (sem deadlock)', () => {
    it('Start de uma 2ª sessão e Stop da 1ª ao mesmo tempo, 25 rodadas, atrasos determinísticos de 0 a 30 ms: nenhum erro/deadlock, o Stop sempre fecha e debita UMA vez, o Start é Accepted (saldo de sobra)', async () => {
      for (let rodada = 0; rodada < 25; rodada++) {
        const m = await motorista(`lock-${rodada}`, 100_000)
        const t2 = await prisma.authToken.create({ data: { idTag: makeIdTag(), type: 'RFID', userId: m.driver.id } })
        const a = await criarSessao(cen, { mode: 'WALLET', meterStartWh: 0, motorista: { driver: m.driver, wallet: m.wallet, authToken: m.authToken } })
        const c2 = await conectorLivre(++numero)
        const atraso = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) // atrasos determinísticos (espalhados por rodada), não sorteados
        const [rStop, rStart] = await Promise.all([
          atraso((rodada * 7) % 31).then(() => chamarHandler(handleStopTransaction, cen.ctx, { transactionId: a.session.ocppTransactionId, meterStop: 3_000, timestamp: new Date().toISOString() })),
          atraso((rodada * 13) % 31).then(() => start(c2.connectorId, t2.idTag)),
        ])
        expect(rStop.idTagInfo.status, `rodada ${rodada}`).toBe('Accepted')
        expect(rStart.idTagInfo.status, `rodada ${rodada}`).toBe('Accepted')
        const sa = await prisma.chargingSession.findUniqueOrThrow({ where: { id: a.session.id } })
        expect(sa.status).toBe('STOPPED')
        expect(sa.totalCostCents).toBe(300)
        expect(await prisma.walletEntry.count({ where: { walletId: m.wallet.id, type: 'CHARGE_DEBIT', referenceId: a.session.id } })).toBe(1)
        expect(await prisma.chargingSession.count({ where: { userId: m.driver.id, status: { in: ['STARTED', 'CHARGING', 'FINISHING', 'FAULTED'] } } })).toBe(1)
      }
    })
  })
})
