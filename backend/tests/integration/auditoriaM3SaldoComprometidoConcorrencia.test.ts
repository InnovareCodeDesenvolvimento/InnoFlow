import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { env } from '../../src/lib/env'
import { handleStartTransaction } from '../../src/ocpp/handlers/startTransaction'
import { handleAuthorize } from '../../src/ocpp/handlers/authorize'
import { handleMeterValues } from '../../src/ocpp/handlers/meterValues'
import { handleStopTransaction } from '../../src/ocpp/handlers/stopTransaction'
import { checkAuthorization } from '../../src/ocpp/authorizationCheck'
import { chamarHandler, criarCenario, criarSessao, minutosAtras, type Cenario } from './helpers/sessaoTravadaFixture'
import { makeIdTag, uniqueSuffix, waitFor } from './helpers/fixtures'

/**
 * Órion, M3 — saldo comprometido (D7) contornável. (1) check-then-act sem lock de carteira: duas inicializações simultâneas (RFID em dois carregadores,
 * RemoteStart + RFID) passavam no MESMO saldo; (2) o "comprometido" só somava STOP_UNCONFIRMED — sessão WALLET aberta não comprometia nada; (3)
 * `provisionalCostCents` congelava na marcação. Reserva por sessão aberta = teto de reserva (piso 5.000 centavos nestas fixtures: sem potência no conector).
 */
describe('M3 — início de sessão sob o lock da carteira + saldo comprometido (Postgres + Redis reais)', () => {
  const suffix = uniqueSuffix()
  let A: Cenario
  let B: Cenario
  const MIN = env.WALLET_MIN_START_BALANCE_CENTS
  const RESERVA = env.RESERVA_PISO_CENTS

  beforeAll(async () => {
    A = await criarCenario(suffix, 'm3a')
    B = await criarCenario(suffix, 'm3b')
  })
  afterAll(async () => {
    await prisma.$disconnect()
    redis.disconnect()
  })

  /** Motorista com carteira de `saldoCents` e `nTokens` idTags RFID (o mesmo motorista usando cartões/app diferentes). */
  async function motorista(label: string, saldoCents: number, nTokens = 1) {
    const driver = await prisma.user.create({ data: { role: 'DRIVER', name: `Motorista ${label} ${suffix}`, email: `m3-${label}-${randomUUID().slice(0, 6)}-${suffix}@example.com` } })
    const wallet = await prisma.wallet.create({ data: { userId: driver.id } })
    await prisma.walletEntry.create({ data: { walletId: wallet.id, type: 'ADJUSTMENT_CREDIT', amountCents: saldoCents, balanceAfterCents: saldoCents, referenceType: 'MANUAL', description: 'saldo de teste' } })
    const tokens = []
    for (let i = 0; i < nTokens; i++) tokens.push(await prisma.authToken.create({ data: { idTag: makeIdTag(), type: 'RFID', userId: driver.id } }))
    return { driver, wallet, tokens }
  }
  async function conectorLivre(c: Cenario, numero: number) {
    return prisma.connector.create({ data: { operatorId: c.tenant.operatorId, chargePointId: c.tenant.chargePointId, connectorId: numero, type: 'AC_TYPE2' } })
  }
  let numeroConector = 50
  const start = (c: Cenario, connectorId: number, idTag: string) =>
    chamarHandler(handleStartTransaction, c.ctx, { connectorId, idTag, meterStart: 0, timestamp: new Date().toISOString() })

  describe('inicializações simultâneas no MESMO saldo: só UMA passa', () => {
    it('RFID do mesmo motorista em DOIS carregadores (A e B) ao mesmo tempo, 6 rodadas', async () => {
      for (let rodada = 0; rodada < 6; rodada++) {
        const m = await motorista(`dois-cp-${rodada}`, MIN + RESERVA - 1_000) // sobra para UMA reserva, não para duas
        const cA = await conectorLivre(A, ++numeroConector)
        const cB = await conectorLivre(B, ++numeroConector)
        const [ra, rb] = await Promise.all([start(A, cA.connectorId, m.tokens[0]!.idTag), start(B, cB.connectorId, m.tokens[0]!.idTag)])
        const aceitas = [ra, rb].filter((r) => r.idTagInfo.status === 'Accepted')
        expect(aceitas, `rodada ${rodada}: ${JSON.stringify([ra, rb])}`).toHaveLength(1)
        expect([ra, rb].find((r) => r.idTagInfo.status !== 'Accepted')).toMatchObject({ transactionId: 0, idTagInfo: { status: 'Blocked' } })
        expect(await prisma.chargingSession.count({ where: { userId: m.driver.id } })).toBe(1)
      }
    })

    it('app (idTag virtual) + RFID no MESMO carregador, conectores diferentes, ao mesmo tempo: só UMA passa', async () => {
      for (let rodada = 0; rodada < 4; rodada++) {
        const m = await motorista(`app-rfid-${rodada}`, MIN + RESERVA - 1_000, 2)
        const c1 = await conectorLivre(A, ++numeroConector)
        const c2 = await conectorLivre(A, ++numeroConector)
        const rs = await Promise.all([start(A, c1.connectorId, m.tokens[0]!.idTag), start(A, c2.connectorId, m.tokens[1]!.idTag)])
        expect(rs.filter((r) => r.idTagInfo.status === 'Accepted'), `rodada ${rodada}`).toHaveLength(1)
        expect(await prisma.chargingSession.count({ where: { userId: m.driver.id } })).toBe(1)
      }
    })

    it('saldo de sobra para as DUAS reservas: as duas passam (sem falso positivo)', async () => {
      const m = await motorista('rico', 100_000, 2)
      const c1 = await conectorLivre(A, ++numeroConector)
      const c2 = await conectorLivre(B, ++numeroConector)
      const rs = await Promise.all([start(A, c1.connectorId, m.tokens[0]!.idTag), start(B, c2.connectorId, m.tokens[1]!.idTag)])
      expect(rs.map((r) => r.idTagInfo.status)).toEqual(['Accepted', 'Accepted'])
    })

    it('depois que a 1ª sessão ENCERRA, a reserva é liberada e o motorista inicia de novo', async () => {
      const m = await motorista('libera', MIN + RESERVA - 1_000)
      const c1 = await conectorLivre(A, ++numeroConector)
      const c2 = await conectorLivre(A, ++numeroConector)
      const r1 = await start(A, c1.connectorId, m.tokens[0]!.idTag)
      expect(r1.idTagInfo.status).toBe('Accepted')
      expect((await start(A, c2.connectorId, m.tokens[0]!.idTag)).idTagInfo.status).toBe('Blocked')

      await chamarHandler(handleStopTransaction, A.ctx, { transactionId: r1.transactionId, meterStop: 0, timestamp: new Date().toISOString() })
      // custo 0 (energia 0, tarifa sem mínimo/taxa): saldo intacto => volta a poder iniciar
      expect((await start(A, c2.connectorId, m.tokens[0]!.idTag)).idTagInfo.status).toBe('Accepted')
    })
  })

  describe('o comprometido agora inclui sessões WALLET ABERTAS (Authorize / StartTransaction)', () => {
    // MUDANÇA DELIBERADA (regressão do M3, achada pela Íris): este teste afirmava `Blocked` para o Authorize do MESMO idTag da sessão aberta — comportamento ERRADO. Esse
    // Authorize é o tap-to-stop (encostar o cartão no poste para PARAR a recarga em firmware que exige Authorize): a reserva da PRÓPRIA sessão não pode contar contra ele.
    // O que o M3 protege continua: a reserva das abertas desconta de uma sessão NOVA (StartTransaction) e de OUTRO idTag do mesmo motorista.
    it('Authorize do idTag da PRÓPRIA sessão aberta (tap-to-stop): Accepted mesmo com saldo entre o mínimo e (mínimo + reserva) — a reserva dela não conta contra si', async () => {
      const m = await motorista('auth-propria', MIN + RESERVA - 1_000) // 6000: o saldo cobre o início (2000) mas não "início + reserva da própria sessão"
      await criarSessao(A, { mode: 'WALLET', motorista: { driver: m.driver, wallet: m.wallet, authToken: m.tokens[0]! } })
      expect((await chamarHandler(handleAuthorize, A.ctx, { idTag: m.tokens[0]!.idTag })).idTagInfo.status).toBe('Accepted')
    })

    it('Authorize de OUTRO idTag do mesmo motorista com a sessão aberta: continua descontando a reserva dela (Blocked/INSUFFICIENT_BALANCE)', async () => {
      const m = await motorista('auth-outro-token', MIN + RESERVA - 1_000, 2)
      await criarSessao(A, { mode: 'WALLET', motorista: { driver: m.driver, wallet: m.wallet, authToken: m.tokens[0]! } })
      expect((await chamarHandler(handleAuthorize, A.ctx, { idTag: m.tokens[1]!.idTag })).idTagInfo.status).toBe('Blocked')
    })

    it('StartTransaction de uma sessão NOVA (mesmo idTag, outro conector) com a primeira aberta: continua descontando a reserva — Blocked, e nenhuma sessão nova', async () => {
      const m = await motorista('start-novo', MIN + RESERVA - 1_000)
      await criarSessao(A, { mode: 'WALLET', motorista: { driver: m.driver, wallet: m.wallet, authToken: m.tokens[0]! } })
      const c = await conectorLivre(A, ++numeroConector)
      expect((await start(A, c.connectorId, m.tokens[0]!.idTag)).idTagInfo.status).toBe('Blocked')
      expect(await prisma.chargingSession.count({ where: { userId: m.driver.id } })).toBe(1)
    })

    it('checkAuthorization no modo padrão (início de sessão) segue descontando a reserva; com saldo de sobra é Accepted', async () => {
      const m = await motorista('auth-aberta', MIN + RESERVA - 1_000)
      await criarSessao(A, { mode: 'WALLET', motorista: { driver: m.driver, wallet: m.wallet, authToken: m.tokens[0]! } })
      expect((await checkAuthorization(m.tokens[0]!.idTag)).resultado).toEqual({ decision: 'Blocked', reason: 'INSUFFICIENT_BALANCE' })

      const rico = await motorista('auth-aberta-rico', MIN + RESERVA + 1_000)
      await criarSessao(A, { mode: 'WALLET', motorista: { driver: rico.driver, wallet: rico.wallet, authToken: rico.tokens[0]! } })
      expect((await checkAuthorization(rico.tokens[0]!.idTag)).resultado).toEqual({ decision: 'Accepted' })
    })
  })

  describe('o custo provisório acompanha as amostras que chegam em STOP_UNCONFIRMED', () => {
    it('MeterValues em sessão STOP_UNCONFIRMED recalcula provisionalCostCents (antes ficava congelado na marcação) e não muda o status', async () => {
      const s = await criarSessao(A, { mode: 'WALLET', status: 'STOP_UNCONFIRMED', saldoCents: 10_000, meterStartWh: 0, amostrasWh: [1_000], naoConfirmada: { motivo: 'STOP_REJECTED', haMin: 3 } })
      await prisma.chargingSession.update({ where: { id: s.session.id }, data: { provisionalCostCents: 100 } })

      await chamarHandler(handleMeterValues, A.ctx, {
        connectorId: s.connector.connectorId,
        transactionId: s.session.ocppTransactionId,
        meterValue: [{ timestamp: minutosAtras(0).toISOString(), sampledValue: [{ value: '4000', measurand: 'Energy.Active.Import.Register', unit: 'Wh' }] }],
      })
      await waitFor(async () => (await prisma.chargingSession.findUniqueOrThrow({ where: { id: s.session.id } })).provisionalCostCents === 400, { what: 'provisório recalculado' })
      expect((await prisma.chargingSession.findUniqueOrThrow({ where: { id: s.session.id } })).status).toBe('STOP_UNCONFIRMED')
    })
  })
})
