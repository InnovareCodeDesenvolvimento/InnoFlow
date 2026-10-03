import { randomUUID } from 'node:crypto'
import type { ChargingSessionStatus, Prisma, StopUnconfirmedReason } from '@prisma/client'
import type { IHandlersOption } from 'ocpp-rpc'
import { prisma } from '../../../src/lib/prisma'
import { createRedisConnection } from '../../../src/lib/redis'
import { issueToken } from '../../../src/lib/jwt'
import { encryptPaymentSecret } from '../../../src/lib/crypto/paymentSecrets'
import { getPagamentoPort } from '../../../src/services/pagamentos/pagamentoPortInstance'
import type { OcppHandlerCtx } from '../../../src/ocpp/context'
import { createTenant, makeIdTag, type TestTenant } from './fixtures'

/**
 * Fixtures da F5.9 (sessão travada). Montam sessões DIRETO no banco em qualquer estado (aberta, STOP_UNCONFIRMED...) com amostras de
 * medidor e, para CARD, uma pré-autorização AUTHORIZED de verdade no `FakeAdapter`. Tarifa: R$ 1,00/kWh sem taxa nem mínimo (1 kWh = 100
 * centavos), igual a `ledgerConciliation.test.ts` — as contas ficam legíveis.
 *
 * As suítes rodam em paralelo no MESMO Postgres: tudo leva o `suffix` do arquivo e o teste só afirma sobre os ids que criou.
 */

export const minutosAtras = (m: number, base: Date = new Date()) => new Date(base.getTime() - m * 60_000)

export function chamarHandler<T>(handler: (args: IHandlersOption, ctx: OcppHandlerCtx) => Promise<T>, ctx: OcppHandlerCtx, params: unknown, messageId: string = randomUUID()): Promise<T> {
  return handler({ messageId, params, method: 'X', signal: new AbortController().signal } as unknown as IHandlersOption, ctx)
}

export const TARIFF_SNAPSHOT: Prisma.InputJsonValue = {
  id: 'tariff-snapshot',
  model: 'PER_KWH',
  pricePerKwh: '1.00',
  pricePerMinute: null,
  sessionFeeCents: null,
  minChargeCents: null,
  idleFeePerMinute: 0,
  idleGracePeriodSeconds: 0,
  windows: [],
}

/** Tarifa com taxa fixa de 200 centavos — para provar a política D2 `MIN_FEE` (cobra a taxa mesmo sem energia). */
export const TARIFF_SNAPSHOT_COM_TAXA: Prisma.InputJsonValue = { ...(TARIFF_SNAPSHOT as Record<string, unknown>), sessionFeeCents: 200 } as Prisma.InputJsonValue

export interface Cenario {
  tenant: TestTenant
  ctx: OcppHandlerCtx
  suffix: string
  label: string
  connectorCounter: { n: number }
}

/** Todo cenário criado neste processo de teste — o `afterAll` usa para resolver capturas pendentes (ver `resolverCapturasPendentes`). */
export const cenariosCriados: Cenario[] = []

export async function criarCenario(suffix: string, label: string): Promise<Cenario> {
  const tenant = await createTenant({ suffix, label })
  await prisma.chargePoint.update({ where: { id: tenant.chargePointId }, data: { active: true, lastSeenAt: new Date() } })
  await prisma.tariffAssignment.create({ data: { operatorId: tenant.operatorId, tariffId: tenant.tariffId, scope: 'OPERATOR' } })
  const cenario: Cenario = {
    tenant,
    ctx: { chargePointId: tenant.chargePointId, operatorId: tenant.operatorId, ocppIdentity: tenant.ocppIdentity },
    suffix,
    label,
    connectorCounter: { n: 1 }, // o 1 já existe (createTenant)
  }
  cenariosCriados.push(cenario)
  return cenario
}

export interface OpcoesSessao {
  mode: 'WALLET' | 'CARD'
  status?: ChargingSessionStatus
  /** Saldo inicial da carteira (WALLET). */
  saldoCents?: number
  /** Valor pré-autorizado (CARD). Default 5000. */
  autorizadoCents?: number
  meterStartWh?: number
  /** Leituras cumulativas de `Energy.Active.Import.Register` (Wh), uma por minuto a partir do início. */
  amostrasWh?: number[]
  /** `startedAt` (relógio do carregador) e `createdAt` (servidor) = agora - isto. */
  iniciouHaMin?: number
  /** `lastActivityAt` = agora - isto (omitido => agora). `null` => nulo. */
  atividadeHaMin?: number | null
  lastMeterValuesHaMin?: number | null
  /** Para status STOP_UNCONFIRMED. */
  naoConfirmada?: { motivo: StopUnconfirmedReason; haMin: number }
  stopRequestedHaMin?: number
  stopAttempts?: number
  tariffSnapshot?: Prisma.InputJsonValue
  /** `authorizedAt` do hold (CARD). Default = início da sessão. */
  autorizadoHaMin?: number
  /** Reaproveita o motorista/carteira/idTag de uma sessão anterior (duas sessões do MESMO motorista — D7). `saldoCents` é ignorado. */
  motorista?: { driver: { id: string; name: string }; wallet: { id: string }; authToken: { id: string } }
}

export async function criarSessao(c: Cenario, opts: OpcoesSessao) {
  const rotulo = `${c.label}-${++c.connectorCounter.n}`
  const connector = await prisma.connector.create({ data: { operatorId: c.tenant.operatorId, chargePointId: c.tenant.chargePointId, connectorId: c.connectorCounter.n, type: 'AC_TYPE2' } })
  const driver = opts.motorista?.driver ?? (await prisma.user.create({ data: { role: 'DRIVER', name: `Motorista ${rotulo} ${c.suffix}`, email: `driver-${rotulo}-${c.suffix}@example.com` } }))
  const authToken = opts.motorista?.authToken ?? (await prisma.authToken.create({ data: { idTag: makeIdTag(), type: opts.mode === 'CARD' ? 'VIRTUAL' : 'RFID', userId: driver.id } }))
  const wallet = opts.motorista?.wallet ?? (await prisma.wallet.create({ data: { userId: driver.id } }))
  if (!opts.motorista && opts.mode === 'WALLET' && (opts.saldoCents ?? 0) > 0) {
    await prisma.walletEntry.create({ data: { walletId: wallet.id, type: 'ADJUSTMENT_CREDIT', amountCents: opts.saldoCents!, balanceAfterCents: opts.saldoCents!, referenceType: 'MANUAL', description: `saldo de teste ${c.suffix}` } })
  }

  const agora = new Date()
  const iniciouHaMin = opts.iniciouHaMin ?? 30
  const inicio = minutosAtras(iniciouHaMin, agora)
  const status = opts.status ?? 'CHARGING'
  const meterStartWh = opts.meterStartWh ?? 1_000

  const session = await prisma.chargingSession.create({
    data: {
      operatorId: c.tenant.operatorId,
      siteId: c.tenant.siteId,
      chargePointId: c.tenant.chargePointId,
      connectorId: connector.id,
      authTokenId: authToken.id,
      userId: driver.id,
      status,
      paymentMode: opts.mode,
      meterStartWh,
      startedAt: inicio,
      createdAt: inicio, // o watchdog mede a idade pelo relógio do servidor (createdAt)
      tariffId: c.tenant.tariffId,
      tariffSnapshot: opts.tariffSnapshot ?? TARIFF_SNAPSHOT,
      lastActivityAt: opts.atividadeHaMin === null ? null : minutosAtras(opts.atividadeHaMin ?? 0, agora),
      lastMeterValuesAt: opts.lastMeterValuesHaMin === undefined || opts.lastMeterValuesHaMin === null ? null : minutosAtras(opts.lastMeterValuesHaMin, agora),
      stopRequestedAt: opts.stopRequestedHaMin === undefined ? null : minutosAtras(opts.stopRequestedHaMin, agora),
      stopRequestedBy: opts.stopRequestedHaMin === undefined ? null : 'DRIVER',
      stopAttempts: opts.stopAttempts ?? (opts.stopRequestedHaMin === undefined ? 0 : 1),
      unconfirmedAt: opts.naoConfirmada ? minutosAtras(opts.naoConfirmada.haMin, agora) : null,
      unconfirmedReason: opts.naoConfirmada?.motivo ?? null,
    },
  })

  for (const [i, wh] of (opts.amostrasWh ?? []).entries()) {
    await prisma.meterSample.create({
      data: { sessionId: session.id, chargePointId: c.tenant.chargePointId, operatorId: c.tenant.operatorId, ts: new Date(inicio.getTime() + (i + 1) * 60_000), measurand: 'Energy.Active.Import.Register', value: wh, unit: 'Wh', context: 'Sample.Periodic' },
    })
  }

  let intent: { id: string } | null = null
  if (opts.mode === 'CARD') {
    const pagamentoPort = await getPagamentoPort()
    const autorizadoCents = opts.autorizadoCents ?? 5_000
    const paymentMethod = await prisma.paymentMethod.create({
      data: { userId: driver.id, type: 'CREDIT_CARD', cieloCardTokenCiphertext: encryptPaymentSecret(`test-card-token-${rotulo}-${c.suffix}`), brand: 'Visa', last4: '4242', isDefault: true },
    })
    const autorizacao = await pagamentoPort.autorizar({ merchantOrderId: `f59-${rotulo}-${c.suffix}`, amountRequestedCents: autorizadoCents, cartao: { cardToken: `test-card-token-${rotulo}` }, cliente: { name: driver.name } })
    intent = await prisma.paymentIntent.create({
      data: {
        purpose: 'SESSION_CARD_CAPTURE',
        provider: 'CIELO_CARD',
        userId: driver.id,
        paymentMethodId: paymentMethod.id,
        authTokenId: authToken.id,
        chargingSessionId: session.id,
        status: 'AUTHORIZED',
        cieloPaymentId: autorizacao.providerPaymentId,
        returnCode: autorizacao.returnCode,
        amountRequestedCents: autorizadoCents,
        amountAuthorizedCents: autorizacao.amountAuthorizedCents,
        authorizedAt: minutosAtras(opts.autorizadoHaMin ?? iniciouHaMin, agora),
      },
    })
  }

  return { session, driver, wallet, connector, authToken, intent, inicio }
}

/** Token JWT de um motorista criado por `criarSessao`. */
export function tokenDoMotorista(driverId: string): string {
  return issueToken({ id: driverId, role: 'DRIVER', operatorId: null })
}

export async function saldo(walletId: string): Promise<number> {
  return (await prisma.walletEntry.findFirst({ where: { walletId }, orderBy: { createdAt: 'desc' }, select: { balanceAfterCents: true } }))?.balanceAfterCents ?? 0
}

export async function debitosDaSessao(sessionId: string) {
  return prisma.walletEntry.findMany({ where: { type: 'CHARGE_DEBIT', referenceType: 'CHARGING_SESSION', referenceId: sessionId } })
}

export interface ComandoRecebido {
  method: string
  params: Record<string, unknown>
}

export type RespostaGateway = 'Accepted' | 'Rejected' | 'NotImplemented' | 'silencio' | 'erro'

/**
 * Gateway OCPP de mentira (sem WebSocket): assina `ocpp:cmd:<chargePointId>` e responde pelo barramento real. `respostas` diz o que fazer
 * por método (default `Accepted`). `silencio` não responde (o sendCommand estoura timeout); `erro` responde `ok:false`.
 */
export async function comFakeGateway<T>(chargePointId: string, respostas: Partial<Record<string, RespostaGateway>>, fn: (recebidos: ComandoRecebido[]) => Promise<T>): Promise<T> {
  const subscriber = createRedisConnection()
  const publisher = createRedisConnection()
  const channel = `ocpp:cmd:${chargePointId}`
  const recebidos: ComandoRecebido[] = []
  await subscriber.subscribe(channel)
  subscriber.on('message', (ch, message) => {
    if (ch !== channel) return
    try {
      const payload = JSON.parse(message) as { correlationId: string; method: string; params: Record<string, unknown> }
      recebidos.push({ method: payload.method, params: payload.params })
      const resposta = respostas[payload.method] ?? 'Accepted'
      if (resposta === 'silencio') return
      const corpo = resposta === 'erro' ? { correlationId: payload.correlationId, ok: false, error: 'falha simulada no carregador' } : { correlationId: payload.correlationId, ok: true, result: { status: resposta } }
      publisher.publish(`ocpp:reply:${payload.correlationId}`, JSON.stringify(corpo)).catch(() => {})
    } catch {
      // mensagem malformada — ignora
    }
  })
  try {
    return await fn(recebidos)
  } finally {
    subscriber.disconnect()
    publisher.disconnect()
  }
}

/**
 * HERMETICIDADE (achado na F5.9b1): o varredor de captura (`reenfileirarCapturasPendentes`) olha TODO `CAPTURE_PENDING` velho do banco
 * COMPARTILHADO. Intent deixado em CAPTURE_PENDING por uma suíte (aqui, sessões CARD encerradas pelo servidor) vira "intent velho" na rodada
 * seguinte e passa a ser reenfileirado pelo teste de OUTRA suíte (`capturaVarredorCooldownEAdiamentoLimpo` contou 49 -> 51 -> 90 chamadas à
 * medida que as rodadas acumulavam lixo). Chame no `afterAll`: captura de verdade (FakeAdapter) o que ficou pendente nos operadores do cenário.
 */
export async function resolverCapturasPendentes(cenarios: readonly Cenario[]): Promise<void> {
  const { capturarSessaoCartao } = await import('../../../src/services/pagamentos/capturarSessaoCartao')
  const port = await getPagamentoPort()
  const pendentes = await prisma.paymentIntent.findMany({
    where: { purpose: 'SESSION_CARD_CAPTURE', status: 'CAPTURE_PENDING', chargingSession: { operatorId: { in: cenarios.map((c) => c.tenant.operatorId) } } },
    select: { id: true },
  })
  for (const { id } of pendentes) await capturarSessaoCartao(id, port).catch(() => {})
}
