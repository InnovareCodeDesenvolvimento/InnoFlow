/**
 * Seed de DADO SINTÉTICO para o módulo de retaguarda (dashboard/financeiro/
 * relatórios) — 2026-09-16. Ver `.claude/agent-memory/nova/
 * decisoes-retaguarda-relatorios.md` para o desenho completo.
 *
 * Separado do `seed.ts` base de propósito — o base é fixture mínima para
 * dev/OCPP; este script gera VOLUME (milhares de sessões) para os
 * relatórios terem número real por trás, sem existir ainda uma sessão de
 * recarga real rodando (Fase 4/5 pendentes). Quando a Fase 4/5 existir, o
 * dado sintético é só substituído/complementado por produção de verdade —
 * mesmas tabelas, mesmo código de cálculo (`calcularCustoSessao`).
 *
 * Uso:
 *   npm run db:seed:demo            — gera o dado sintético (idempotente:
 *                                      usa `skipDuplicates`, seguro rodar
 *                                      de novo sem `--reset` antes)
 *   npm run db:seed:demo -- --reset — apaga TODO dado com prefixo "demo-"
 *                                      (não toca no seed base) e sai, sem
 *                                      regenerar. Rode de novo sem a flag
 *                                      para repovoar.
 *
 * As 8 regras não-negociáveis deste script (mandato do Cronos/Atlas):
 *   1. Determinístico — PRNG com semente fixa (mulberry32), nunca
 *      `Math.random()`. Mesma semente + mesmo "agora" = mesmo dado exato.
 *   2. Todo id gerado tem prefixo "demo-" — `--reset` apaga só isso.
 *   3. Recusa rodar em NODE_ENV=production sem ALLOW_DEMO_SEED=true.
 *   4. Ancorado no "agora" real da execução — sempre 60 dias pra trás a
 *      partir de `new Date()`, a demo nunca "envelhece".
 *   5. Custo SEMPRE via `core/tarifacao/calcularCustoSessao` — nunca
 *      calculado "na mão" aqui.
 *   6. MeterSample só dos últimos 3 dias + sessões ativas agora, 1
 *      amostra/60s — 60 dias completos seriam dezenas de milhões de linhas
 *      e o relatório nunca lê MeterSample mesmo (ver regra 1 da memória de
 *      retaguarda do Cronos).
 *   7. WalletEntry inserida em ordem cronológica por carteira —
 *      `balanceAfterCents` sai certo já no INSERT porque o saldo é
 *      acumulado em memória (Map) andando por uma linha do tempo global
 *      ordenada, nunca corrigido depois (o trigger de append-only bloqueia
 *      UPDATE de verdade).
 *   8. meterStartWh monotônico por conector — sessões são atribuídas a
 *      conectores caminhando em ordem cronológica global, nunca duas
 *      sessões no mesmo conector se sobrepõem no tempo.
 */

import { PrismaClient, type Prisma } from '@prisma/client'
import { calcularCustoSessao, serializeTariffSnapshot, type TariffSnapshot } from '../src/core/tarifacao/calcularCustoSessao'

const prisma = new PrismaClient()

// ============================================================
// Regra 3 — proteção contra rodar em produção sem intenção explícita
// ============================================================
if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_SEED !== 'true') {
  console.error(
    '[seed-demo] Recusando rodar com NODE_ENV=production sem ALLOW_DEMO_SEED=true — ' +
      'este script grava milhares de linhas de dado SINTÉTICO, não é para produção real com clientes.',
  )
  process.exit(1)
}

const RESET = process.argv.includes('--reset')

// ============================================================
// Regra 1 — PRNG determinístico (mulberry32). Nunca Math.random() abaixo.
// ============================================================
const SEED = 0x1e57da7a

function mulberry32(seed: number) {
  let s = seed
  return function rng(): number {
    s |= 0
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rng = mulberry32(SEED)
const randFloat = (): number => rng()
const randInt = (min: number, max: number): number => Math.floor(rng() * (max - min + 1)) + min
const randBool = (pTrue: number): boolean => rng() < pTrue
function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]
}
/** Sorteia um índice em `weights` proporcional ao peso de cada posição. */
function weightedIndex(weights: readonly number[]): number {
  const total = weights.reduce((a, b) => a + b, 0)
  let r = randFloat() * total
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i]
    if (r <= 0) return i
  }
  return weights.length - 1
}

// ============================================================
// Regra 2 — fábricas de id com prefixo "demo-"
// ============================================================
function idFactory(prefix: string): () => string {
  let n = 0
  return () => `demo-${prefix}-${String(++n).padStart(6, '0')}`
}
const nextOperatorId = idFactory('operator')
const nextSiteId = idFactory('site')
const nextChargePointId = idFactory('cp')
const nextConnectorId = idFactory('connector')
const nextTariffId = idFactory('tariff')
const nextTariffWindowId = idFactory('tariff-window')
const nextTariffAssignmentId = idFactory('tariff-assignment')
const nextUserId = idFactory('driver')
const nextAuthTokenId = idFactory('auth-token')
const nextWalletId = idFactory('wallet')
const nextPaymentMethodId = idFactory('payment-method')
const nextSessionId = idFactory('session')
const nextPaymentIntentId = idFactory('payment-intent')
const nextWalletEntryId = idFactory('wallet-entry')
const nextDebtId = idFactory('debt')
const nextWebhookEventId = idFactory('webhook-event')
const nextMeterSampleId = idFactory('meter-sample')

// ============================================================
// Regra 4 — ancorado no "agora" da execução
// ============================================================
const NOW = new Date()
const DAY_MS = 86_400_000
const WINDOW_DAYS = 60
const WINDOW_START = new Date(NOW.getTime() - WINDOW_DAYS * DAY_MS)
const SHORT_WINDOW_DAYS = 10
const SHORT_WINDOW_START = new Date(NOW.getTime() - SHORT_WINDOW_DAYS * DAY_MS)
const RECENT_DAYS = 3
const RECENT_START = new Date(NOW.getTime() - RECENT_DAYS * DAY_MS)
// Deixa as últimas horas livres para o pool de sessões "ativas agora" (fase
// separada) não colidir com o fim da geração histórica.
const HISTORICAL_WINDOW_END = new Date(NOW.getTime() - 3 * 3_600_000)

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

async function batchCreateMany<T>(label: string, rows: T[], create: (data: T[]) => Promise<{ count: number }>): Promise<void> {
  if (rows.length === 0) return
  let total = 0
  for (const part of chunk(rows, 500)) {
    const res = await create(part)
    total += res.count
  }
  console.log(`[seed-demo] ${label}: ${total} linhas inseridas`)
}

// ============================================================
// Reset — apaga tudo com prefixo "demo-", em ordem segura de FK
// ============================================================
async function resetDemoData(): Promise<void> {
  console.log('[seed-demo] --reset: apagando todo dado com prefixo "demo-"...')

  await prisma.webhookEvent.deleteMany({ where: { id: { startsWith: 'demo-' } } })
  await prisma.debt.deleteMany({ where: { id: { startsWith: 'demo-' } } })
  await prisma.paymentIntent.deleteMany({ where: { id: { startsWith: 'demo-' } } })
  await prisma.meterSample.deleteMany({ where: { id: { startsWith: 'demo-' } } })
  await prisma.chargingSession.deleteMany({ where: { id: { startsWith: 'demo-' } } })

  // WalletEntry é append-only por trigger (bloqueia DELETE de verdade — ver
  // schema-innoelektron.md). Este bypass SÓ existe aqui, na ferramenta de
  // reset do dado sintético — nenhum caminho de produção desliga esta
  // trigger. `finally` garante religar mesmo se o DELETE falhar no meio.
  await prisma.$executeRawUnsafe('ALTER TABLE "WalletEntry" DISABLE TRIGGER wallet_entry_no_delete')
  try {
    await prisma.walletEntry.deleteMany({ where: { id: { startsWith: 'demo-' } } })
  } finally {
    await prisma.$executeRawUnsafe('ALTER TABLE "WalletEntry" ENABLE TRIGGER wallet_entry_no_delete')
  }

  await prisma.paymentMethod.deleteMany({ where: { id: { startsWith: 'demo-' } } })
  await prisma.wallet.deleteMany({ where: { id: { startsWith: 'demo-' } } })
  await prisma.authToken.deleteMany({ where: { id: { startsWith: 'demo-' } } })
  await prisma.user.deleteMany({ where: { id: { startsWith: 'demo-' } } })
  await prisma.tariffAssignment.deleteMany({ where: { id: { startsWith: 'demo-' } } })
  await prisma.tariffWindow.deleteMany({ where: { id: { startsWith: 'demo-' } } })
  await prisma.tariff.deleteMany({ where: { id: { startsWith: 'demo-' } } })
  await prisma.connector.deleteMany({ where: { id: { startsWith: 'demo-' } } })
  await prisma.chargePoint.deleteMany({ where: { id: { startsWith: 'demo-' } } })
  await prisma.site.deleteMany({ where: { id: { startsWith: 'demo-' } } })
  await prisma.operator.deleteMany({ where: { id: { startsWith: 'demo-' } } })

  console.log('[seed-demo] reset concluído.')
}

// ============================================================
// Tipos auxiliares do gerador
// ============================================================

type ConnectorTypeLiteral = 'AC_TYPE2' | 'DC_CCS2' | 'DC_CHADEMO'

interface ConnectorInfo {
  id: string
  chargePointId: string
  siteId: string
  operatorId: string
  type: ConnectorTypeLiteral
  avgPowerKw: number
  timezone: string
}

interface DriverInfo {
  index: number
  userId: string
  walletId: string
  paymentMethodId: string
  authTokenId: string
}

type AbnormalKind = 'NORMAL' | 'FAULTED_PARTIAL' | 'EV_DISCONNECTED' | 'POWER_LOSS' | 'ZERO_ENERGY'

interface PlannedSession {
  id: string
  connector: ConnectorInfo
  driver: DriverInfo
  operatorId: string
  siteId: string
  chargePointId: string
  connectorId: string
  tariffId: string
  tariffSnapshot: TariffSnapshot
  status: 'STOPPED' | 'FAULTED'
  stopReason: string
  abnormal: AbnormalKind
  startedAt: Date
  chargingEndedAt: Date | null
  stoppedAt: Date
  energyDeliveredWh: number
  meterStartWh: number
  meterStopWh: number
  idleSeconds: number | null
  cost: ReturnType<typeof calcularCustoSessao>
  operatorWalletShare: number
}

interface TopupEvent {
  id: string
  walletId: string
  userId: string
  amountCents: number
  createdAt: Date
  outcome: 'CAPTURED' | 'EXPIRED'
}

// Peso por hora do dia (0-23) — picos 7-9h e 17-20h.
const HOUR_WEIGHTS = [1, 1, 1, 1, 1, 1, 3, 7, 8, 7, 4, 3, 3, 3, 3, 3, 4, 7, 8, 8, 7, 4, 2, 1]

function utcMidnight(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

function planDurationMinutes(type: ConnectorTypeLiteral, abnormal: AbnormalKind): number {
  if (abnormal === 'ZERO_ENERGY') return randInt(1, 3)
  const base = type === 'AC_TYPE2' ? randInt(45, 180) : randInt(15, 60)
  if (abnormal === 'FAULTED_PARTIAL' || abnormal === 'POWER_LOSS') return Math.max(3, Math.round(base * (0.2 + randFloat() * 0.4)))
  if (abnormal === 'EV_DISCONNECTED') return Math.max(3, Math.round(base * (0.3 + randFloat() * 0.5)))
  return base
}

function planEnergyWh(avgPowerKw: number, durationMin: number, abnormal: AbnormalKind): number {
  if (abnormal === 'ZERO_ENERGY') return 0
  const utilization = 0.6 + randFloat() * 0.35
  return Math.round(avgPowerKw * (durationMin / 60) * utilization * 1000)
}

function rollAbnormalKind(): AbnormalKind {
  if (!randBool(0.1)) return 'NORMAL'
  const idx = weightedIndex([0.4, 0.3, 0.1, 0.2])
  return (['FAULTED_PARTIAL', 'EV_DISCONNECTED', 'POWER_LOSS', 'ZERO_ENERGY'] as const)[idx]
}

function stopReasonFor(abnormal: AbnormalKind): string {
  switch (abnormal) {
    case 'EV_DISCONNECTED':
      return 'EV_DISCONNECTED'
    case 'POWER_LOSS':
      return 'POWER_LOSS'
    case 'FAULTED_PARTIAL':
      return pick(['HARD_RESET', 'EMERGENCY_STOP'])
    case 'ZERO_ENERGY':
      return pick(['HARD_RESET', 'OTHER'])
    default:
      return pick(['LOCAL', 'LOCAL', 'LOCAL', 'REMOTE', 'REMOTE', 'UNLOCK_COMMAND', 'OTHER'])
  }
}

function statusFor(abnormal: AbnormalKind): 'STOPPED' | 'FAULTED' {
  return abnormal === 'FAULTED_PARTIAL' || abnormal === 'POWER_LOSS' || abnormal === 'ZERO_ENERGY' ? 'FAULTED' : 'STOPPED'
}

function planIdleTailMinutes(abnormal: AbnormalKind): number {
  if (abnormal !== 'NORMAL') return 0
  if (!randBool(0.3)) return 0
  return randInt(1, 40)
}

async function main(): Promise<void> {
  if (RESET) {
    await resetDemoData()
    return
  }

  console.log(`[seed-demo] iniciando — "agora" = ${NOW.toISOString()}, semente PRNG = 0x${SEED.toString(16)}`)

  // ------------------------------------------------------------
  // Fase 1 — Operadores
  // ------------------------------------------------------------
  const baseOperator = await prisma.operator.findUnique({ where: { cnpj: '12345678000199' } })
  if (!baseOperator) {
    throw new Error(
      '[seed-demo] Operador base (cnpj 12345678000199) não encontrado — rode "npm run db:seed" (seed.ts) antes do seed de demo.',
    )
  }

  const operatorEletroVia = await prisma.operator.create({
    data: {
      id: nextOperatorId(),
      name: 'EletroVia Mobilidade',
      legalName: 'EletroVia Mobilidade Elétrica Ltda.',
      cnpj: '23456789000188',
      email: 'contato@eletrovia.example.com',
      phone: '+55 11 98888-0000',
    },
  })

  const operatorRotaOeste = await prisma.operator.create({
    data: {
      id: nextOperatorId(),
      name: 'Rota Oeste Elétrica',
      legalName: 'Rota Oeste Elétrica Recarga Ltda.',
      cnpj: '34567890000177',
      email: 'contato@rotaoeste.example.com',
      phone: '+55 65 97777-0000',
    },
  })

  console.log(`[seed-demo] operadores: ${baseOperator.name} (existente/alto volume), ${operatorEletroVia.name} (médio), ${operatorRotaOeste.name} (curto, ~10 dias)`)

  // ------------------------------------------------------------
  // Fase 2 — Tarifas (+ janelas ponta/fora-ponta)
  // ------------------------------------------------------------
  // Reaproveita a tarifa do seed base para o site matriz (idle fee > 0, já
  // cobre esse requisito). Busca por operatorId+name (chave natural do
  // seed), não mais por id fixo — seed.ts parou de gravar ids legíveis
  // (ver bug `.cuid()` registrado em memória), o cuid real varia a cada
  // carga do banco.
  const baseTariff = await prisma.tariff.findFirstOrThrow({ where: { operatorId: baseOperator.id, name: 'Padrão CCS2' } })
  const baseTariffSnapshot = serializeTariffSnapshot(baseTariff, [])

  // Ibirapuera (Operador A): HYBRID com janela ponta/fora-ponta, idle = 0.
  const tariffIbirapuera = await prisma.tariff.create({
    data: {
      id: nextTariffId(),
      operatorId: baseOperator.id,
      name: 'Shopping Ibirapuera — ponta/fora-ponta',
      model: 'HYBRID',
      pricePerKwh: '0.75',
      idleFeePerMinute: 0,
      idleGracePeriodSeconds: 0,
      minChargeCents: 300,
      currency: 'BRL',
    },
  })
  const windowIbirapueraPonta = await prisma.tariffWindow.create({
    data: {
      id: nextTariffWindowId(),
      tariffId: tariffIbirapuera.id,
      label: 'PONTA',
      daysOfWeek: [1, 2, 3, 4, 5],
      startMinute: 18 * 60,
      endMinute: 21 * 60,
      pricePerKwh: '1.35',
    },
  })
  const tariffIbirapueraSnapshot = serializeTariffSnapshot(tariffIbirapuera, [windowIbirapueraPonta])

  // Congonhas (Operador A): idle fee alto (estacionamento de aeroporto).
  const tariffCongonhas = await prisma.tariff.create({
    data: {
      id: nextTariffId(),
      operatorId: baseOperator.id,
      name: 'Aeroporto de Congonhas — premium',
      model: 'PER_KWH',
      pricePerKwh: '0.95',
      idleFeePerMinute: 150,
      idleGracePeriodSeconds: 300,
      minChargeCents: 1000,
      currency: 'BRL',
    },
  })
  const tariffCongonhasSnapshot = serializeTariffSnapshot(tariffCongonhas, [])

  // Rodovia Anhanguera (Operador A): markup de rodovia, idle = 0.
  const tariffAnhanguera = await prisma.tariff.create({
    data: {
      id: nextTariffId(),
      operatorId: baseOperator.id,
      name: 'Rodovia Anhanguera Km 45 — carga rápida',
      model: 'PER_KWH',
      pricePerKwh: '1.10',
      idleFeePerMinute: 0,
      idleGracePeriodSeconds: 0,
      currency: 'BRL',
    },
  })
  const tariffAnhangueraSnapshot = serializeTariffSnapshot(tariffAnhanguera, [])

  // EletroVia (Operador B): uma tarifa compartilhada pelos 2 sites.
  const tariffEletroVia = await prisma.tariff.create({
    data: {
      id: nextTariffId(),
      operatorId: operatorEletroVia.id,
      name: 'EletroVia — padrão',
      model: 'PER_KWH',
      pricePerKwh: '0.70',
      idleFeePerMinute: 80,
      idleGracePeriodSeconds: 600,
      currency: 'BRL',
    },
  })
  const tariffEletroViaSnapshot = serializeTariffSnapshot(tariffEletroVia, [])

  // Rota Oeste (Operador C, Cuiabá): tarifa simples.
  const tariffRotaOeste = await prisma.tariff.create({
    data: {
      id: nextTariffId(),
      operatorId: operatorRotaOeste.id,
      name: 'Rota Oeste — padrão',
      model: 'PER_KWH',
      pricePerKwh: '0.82',
      idleFeePerMinute: 0,
      idleGracePeriodSeconds: 0,
      currency: 'BRL',
    },
  })
  const tariffRotaOesteSnapshot = serializeTariffSnapshot(tariffRotaOeste, [])

  // ------------------------------------------------------------
  // Fase 3 — Sites
  // ------------------------------------------------------------
  // Idem baseTariff acima — busca por operatorId+name, não por id fixo.
  const baseSite = await prisma.site.findFirstOrThrow({ where: { operatorId: baseOperator.id, name: 'InnoElektron — Estação Matriz' } })

  const siteIbirapuera = await prisma.site.create({
    data: {
      id: nextSiteId(),
      operatorId: baseOperator.id,
      name: 'InnoElektron — Shopping Ibirapuera',
      addressLine: 'Av. Ibirapuera, 3103',
      city: 'São Paulo',
      state: 'SP',
      postalCode: '04029-902',
      latitude: '-23.610',
      longitude: '-46.667',
      timezone: 'America/Sao_Paulo',
    },
  })
  const siteCongonhas = await prisma.site.create({
    data: {
      id: nextSiteId(),
      operatorId: baseOperator.id,
      name: 'InnoElektron — Aeroporto de Congonhas',
      addressLine: 'Av. Washington Luís, s/n',
      city: 'São Paulo',
      state: 'SP',
      postalCode: '04627-006',
      latitude: '-23.626',
      longitude: '-46.656',
      timezone: 'America/Sao_Paulo',
    },
  })
  const siteAnhanguera = await prisma.site.create({
    data: {
      id: nextSiteId(),
      operatorId: baseOperator.id,
      name: 'InnoElektron — Rodovia Anhanguera Km 45',
      addressLine: 'Rodovia Anhanguera, Km 45',
      city: 'Cajamar',
      state: 'SP',
      postalCode: '07750-000',
      latitude: '-23.320',
      longitude: '-46.880',
      timezone: 'America/Sao_Paulo',
    },
  })
  const siteTiete = await prisma.site.create({
    data: {
      id: nextSiteId(),
      operatorId: operatorEletroVia.id,
      name: 'EletroVia — Terminal Tietê',
      addressLine: 'Av. Cruzeiro do Sul, 1800',
      city: 'São Paulo',
      state: 'SP',
      postalCode: '02030-000',
      latitude: '-23.516',
      longitude: '-46.626',
      timezone: 'America/Sao_Paulo',
    },
  })
  const siteBarraFunda = await prisma.site.create({
    data: {
      id: nextSiteId(),
      operatorId: operatorEletroVia.id,
      name: 'EletroVia — Barra Funda',
      addressLine: 'Av. Marquês de São Vicente, 1800',
      city: 'São Paulo',
      state: 'SP',
      postalCode: '01139-000',
      latitude: '-23.527',
      longitude: '-46.667',
      timezone: 'America/Sao_Paulo',
    },
  })
  // Fora de São Paulo, fuso diferente — testa que o agrupamento por dia
  // respeita o fuso do site, não UTC.
  const siteCuiaba = await prisma.site.create({
    data: {
      id: nextSiteId(),
      operatorId: operatorRotaOeste.id,
      name: 'Rota Oeste — Shopping Pantanal',
      addressLine: 'Av. Miguel Sutil, 8000',
      city: 'Cuiabá',
      state: 'MT',
      postalCode: '78048-800',
      latitude: '-15.596',
      longitude: '-56.097',
      timezone: 'America/Cuiaba',
    },
  })

  // ------------------------------------------------------------
  // Fase 4 — ChargePoints + Connectors
  // ------------------------------------------------------------
  const CONNECTOR_AVG_POWER_KW: Record<ConnectorTypeLiteral, number> = {
    AC_TYPE2: 6,
    DC_CCS2: 40,
    DC_CHADEMO: 32,
  }
  const CONNECTOR_MAX_POWER_KW: Record<ConnectorTypeLiteral, string> = {
    AC_TYPE2: '22.00',
    DC_CCS2: '60.00',
    DC_CHADEMO: '50.00',
  }

  const allConnectors: ConnectorInfo[] = []
  const meterCounter = new Map<string, number>()

  async function createChargePointsForSite(params: {
    siteId: string
    operatorId: string
    timezone: string
    slug: string
    count: number
    profile: 'urban_mixed' | 'highway_fast'
    forceChademoOnLastConnector?: boolean
    fastDc?: boolean
  }): Promise<void> {
    for (let i = 1; i <= params.count; i++) {
      const cp = await prisma.chargePoint.create({
        data: {
          id: nextChargePointId(),
          siteId: params.siteId,
          operatorId: params.operatorId,
          ocppIdentity: `DEMO-CP-${params.slug}-${String(i).padStart(3, '0')}`,
          vendor: pick(['ABB', 'Siemens', 'WEG', 'Efacec']),
          model: pick(['Terra 184', 'Terra AC', 'SICHARGE D', 'QC45']),
          serialNumber: `DEMO-SN-${params.slug}-${i}`,
          basicAuthSecretHash: 'demo-placeholder-hash-not-a-real-hash',
          lastSeenAt: NOW,
        },
      })

      const isLastCp = i === params.count
      for (let c = 1; c <= 2; c++) {
        let type: ConnectorTypeLiteral
        if (params.forceChademoOnLastConnector && isLastCp && c === 2) {
          type = 'DC_CHADEMO'
        } else if (params.profile === 'highway_fast') {
          type = 'DC_CCS2'
        } else {
          const weights = c === 1 ? [0.4, 0.6] : [0.3, 0.7]
          type = (['AC_TYPE2', 'DC_CCS2'] as const)[weightedIndex(weights)]
        }

        const connector = await prisma.connector.create({
          data: {
            id: nextConnectorId(),
            chargePointId: cp.id,
            operatorId: params.operatorId,
            connectorId: c,
            type,
            maxPowerKw: params.fastDc && type === 'DC_CCS2' ? '150.00' : CONNECTOR_MAX_POWER_KW[type],
            status: 'AVAILABLE',
          },
        })

        const avgPowerKw = params.fastDc && type === 'DC_CCS2' ? 55 : CONNECTOR_AVG_POWER_KW[type]
        allConnectors.push({
          id: connector.id,
          chargePointId: cp.id,
          siteId: params.siteId,
          operatorId: params.operatorId,
          type,
          avgPowerKw,
          timezone: params.timezone,
        })
        meterCounter.set(connector.id, randInt(50_000, 3_000_000))
      }
    }
  }

  // Site matriz: reaproveita CP-INNOELEKTRON-001 (2 conectores já existem no
  // seed base) + 1 CP novo demo-.
  // Em PRODUÇÃO o seed base só cria este carregador se `SEED_CHARGEPOINT_SECRET` estiver definida
  // (Órion C1) — sem ele, o demo segue sem reaproveitá-lo em vez de falhar.
  const baseChargePoint = await prisma.chargePoint.findUnique({
    where: { ocppIdentity: 'CP-INNOELEKTRON-001' },
    include: { connectors: true },
  })
  if (!baseChargePoint) console.warn('[seed-demo] CP-INNOELEKTRON-001 não existe (seed base sem SEED_CHARGEPOINT_SECRET) — seguindo sem ele.')
  for (const connector of baseChargePoint?.connectors ?? []) {
    allConnectors.push({
      id: connector.id,
      chargePointId: baseChargePoint!.id,
      siteId: baseSite.id,
      operatorId: baseOperator.id,
      type: connector.type,
      avgPowerKw: CONNECTOR_AVG_POWER_KW[connector.type],
      timezone: baseSite.timezone,
    })
    meterCounter.set(connector.id, randInt(50_000, 3_000_000))
  }
  await createChargePointsForSite({
    siteId: baseSite.id,
    operatorId: baseOperator.id,
    timezone: baseSite.timezone,
    slug: 'MATRIZ',
    count: 1,
    profile: 'urban_mixed',
  })

  await createChargePointsForSite({
    siteId: siteIbirapuera.id,
    operatorId: baseOperator.id,
    timezone: siteIbirapuera.timezone,
    slug: 'IBIRA',
    count: 3,
    profile: 'urban_mixed',
  })
  await createChargePointsForSite({
    siteId: siteCongonhas.id,
    operatorId: baseOperator.id,
    timezone: siteCongonhas.timezone,
    slug: 'CGH',
    count: 3,
    profile: 'urban_mixed',
  })
  // O 2º CP daqui é o "CP com falha de 3 dias" (ver fase de agenda) e
  // carrega o único conector CHAdeMO da frota.
  await createChargePointsForSite({
    siteId: siteAnhanguera.id,
    operatorId: baseOperator.id,
    timezone: siteAnhanguera.timezone,
    slug: 'ANHG',
    count: 2,
    profile: 'highway_fast',
    fastDc: true,
    forceChademoOnLastConnector: true,
  })
  await createChargePointsForSite({
    siteId: siteTiete.id,
    operatorId: operatorEletroVia.id,
    timezone: siteTiete.timezone,
    slug: 'TIETE',
    count: 3,
    profile: 'urban_mixed',
  })
  await createChargePointsForSite({
    siteId: siteBarraFunda.id,
    operatorId: operatorEletroVia.id,
    timezone: siteBarraFunda.timezone,
    slug: 'BFUNDA',
    count: 2,
    profile: 'urban_mixed',
  })
  await createChargePointsForSite({
    siteId: siteCuiaba.id,
    operatorId: operatorRotaOeste.id,
    timezone: siteCuiaba.timezone,
    slug: 'CBA',
    count: 2,
    profile: 'urban_mixed',
  })

  console.log(`[seed-demo] ${allConnectors.length} conectores criados/reaproveitados em ${7} sites`)

  // O CP com a janela de falha de 3 dias é o último criado em Anhanguera —
  // localizamos pelo chargePointId do último conector daquele site.
  const anhangueraConnectors = allConnectors.filter((c) => c.siteId === siteAnhanguera.id)
  const faultyHistoricalChargePointId = anhangueraConnectors[anhangueraConnectors.length - 1].chargePointId

  // ------------------------------------------------------------
  // Fase 5 — TariffAssignment (escopo SITE, cobre todos os CPs do site)
  // ------------------------------------------------------------
  const validFrom = new Date(WINDOW_START.getTime() - 30 * DAY_MS)
  const siteTariffAssignments: Array<{ siteId: string; tariffId: string }> = [
    { siteId: siteIbirapuera.id, tariffId: tariffIbirapuera.id },
    { siteId: siteCongonhas.id, tariffId: tariffCongonhas.id },
    { siteId: siteAnhanguera.id, tariffId: tariffAnhanguera.id },
    { siteId: siteTiete.id, tariffId: tariffEletroVia.id },
    { siteId: siteBarraFunda.id, tariffId: tariffEletroVia.id },
    { siteId: siteCuiaba.id, tariffId: tariffRotaOeste.id },
  ]
  for (const { siteId, tariffId } of siteTariffAssignments) {
    const site = [siteIbirapuera, siteCongonhas, siteAnhanguera, siteTiete, siteBarraFunda, siteCuiaba].find((s) => s.id === siteId)!
    await prisma.tariffAssignment.create({
      data: {
        id: nextTariffAssignmentId(),
        tariffId,
        operatorId: site.operatorId,
        scope: 'SITE',
        siteId,
        priority: 0,
        validFrom,
      },
    })
  }

  const siteTariff = new Map<string, { tariffId: string; snapshot: TariffSnapshot }>([
    [baseSite.id, { tariffId: baseTariff.id, snapshot: baseTariffSnapshot }],
    [siteIbirapuera.id, { tariffId: tariffIbirapuera.id, snapshot: tariffIbirapueraSnapshot }],
    [siteCongonhas.id, { tariffId: tariffCongonhas.id, snapshot: tariffCongonhasSnapshot }],
    [siteAnhanguera.id, { tariffId: tariffAnhanguera.id, snapshot: tariffAnhangueraSnapshot }],
    [siteTiete.id, { tariffId: tariffEletroVia.id, snapshot: tariffEletroViaSnapshot }],
    [siteBarraFunda.id, { tariffId: tariffEletroVia.id, snapshot: tariffEletroViaSnapshot }],
    [siteCuiaba.id, { tariffId: tariffRotaOeste.id, snapshot: tariffRotaOesteSnapshot }],
  ])

  // ------------------------------------------------------------
  // Fase 6 — Motoristas (platform-wide, sem operatorId — roaming real)
  // ------------------------------------------------------------
  const DRIVER_COUNT = 120
  const FIRST_NAMES = ['Ana', 'Bruno', 'Carla', 'Diego', 'Elisa', 'Fábio', 'Gabriela', 'Hugo', 'Isabela', 'João', 'Karina', 'Lucas', 'Marina', 'Nelson', 'Olívia', 'Paulo', 'Queila', 'Rafael', 'Sofia', 'Tiago']
  const LAST_NAMES = ['Silva', 'Souza', 'Oliveira', 'Santos', 'Pereira', 'Costa', 'Rodrigues', 'Almeida', 'Nascimento', 'Carvalho']

  const driverPool: DriverInfo[] = []
  for (let i = 0; i < DRIVER_COUNT; i++) {
    const userId = nextUserId()
    const walletId = nextWalletId()
    const authTokenId = nextAuthTokenId()
    const paymentMethodId = nextPaymentMethodId()
    const name = `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`

    await prisma.user.create({
      data: {
        id: userId,
        role: 'DRIVER',
        name,
        email: `demo.driver.${String(i + 1).padStart(4, '0')}@innoelektron.example.com`,
        // Motoristas sintéticos não precisam de login funcional — sem
        // passwordHash (nullable), evita 120 hashes bcrypt à toa no seed.
        passwordHash: null,
      },
    })
    await prisma.authToken.create({
      data: { id: authTokenId, idTag: `DEMO-DRV-${String(i + 1).padStart(6, '0')}`, type: 'VIRTUAL', userId, status: 'ACCEPTED' },
    })
    await prisma.wallet.create({ data: { id: walletId, userId } })
    await prisma.paymentMethod.create({
      data: {
        id: paymentMethodId,
        userId,
        type: 'CREDIT_CARD',
        cieloCardTokenCiphertext: `demo-card-token-${i + 1}`,
        brand: pick(['Visa', 'Mastercard', 'Elo']),
        last4: String(randInt(1000, 9999)),
        isDefault: true,
      },
    })

    driverPool.push({ index: i, userId, walletId, paymentMethodId, authTokenId })
  }

  // Cauda longa: peso ~ 1/(rank^0.7) — poucos usuários pesados, muitos leves.
  const driverWeights = driverPool.map((_, i) => 1 / Math.pow(i + 1, 0.7))
  const driverCumulative: number[] = []
  {
    let sum = 0
    for (const w of driverWeights) {
      sum += w
      driverCumulative.push(sum)
    }
  }
  const driverWeightTotal = driverCumulative[driverCumulative.length - 1]
  function sampleDriver(): DriverInfo {
    const r = randFloat() * driverWeightTotal
    for (let i = 0; i < driverCumulative.length; i++) {
      if (r <= driverCumulative[i]) return driverPool[i]
    }
    return driverPool[driverPool.length - 1]
  }

  console.log(`[seed-demo] ${DRIVER_COUNT} motoristas (usuários/carteiras/tokens/cartões) criados`)

  // ------------------------------------------------------------
  // Fase 7 — Agendamento de sessões (regra 8: monotônico por conector)
  // ------------------------------------------------------------
  function dailySessionTarget(baseRate: number, isWeekend: boolean): number {
    const multiplier = isWeekend ? 1 : 1.6
    const jitter = 0.8 + randFloat() * 0.4
    return Math.max(0, Math.round(baseRate * multiplier * jitter))
  }

  function weightedDayCount(start: Date, end: Date): number {
    let sum = 0
    for (let d = utcMidnight(start); d <= utcMidnight(end); d += DAY_MS) {
      const weekday = new Date(d).getUTCDay()
      sum += weekday === 0 || weekday === 6 ? 1 : 1.6
    }
    return sum
  }

  interface Candidate {
    startedAt: Date
    abnormal: AbnormalKind
    driver: DriverInfo
  }

  function generateCandidates(params: {
    windowStart: Date
    windowEnd: Date
    totalTarget: number
    maintenanceDayOffsets: number[]
  }): Candidate[] {
    const candidates: Candidate[] = []
    const weighted = weightedDayCount(params.windowStart, params.windowEnd)
    const baseRate = params.totalTarget / Math.max(weighted, 1)

    let dayOffset = 0
    for (let d = utcMidnight(params.windowStart); d <= utcMidnight(params.windowEnd); d += DAY_MS, dayOffset++) {
      const weekday = new Date(d).getUTCDay()
      const isWeekend = weekday === 0 || weekday === 6
      const target = params.maintenanceDayOffsets.includes(dayOffset) ? 0 : dailySessionTarget(baseRate, isWeekend)

      for (let i = 0; i < target; i++) {
        const hour = weightedIndex(HOUR_WEIGHTS)
        const minute = randInt(0, 59)
        const second = randInt(0, 59)
        const startedAt = new Date(d + hour * 3_600_000 + minute * 60_000 + second * 1000)
        if (startedAt.getTime() < params.windowStart.getTime() || startedAt.getTime() > params.windowEnd.getTime()) continue
        candidates.push({ startedAt, abnormal: rollAbnormalKind(), driver: sampleDriver() })
      }
    }
    candidates.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
    return candidates
  }

  const CONNECTOR_BUFFER_MS = 5 * 60_000
  const connectorLastEnd = new Map<string, number>()

  function assignConnectorsAndSchedule(params: {
    candidates: Candidate[]
    operatorId: string
    connectors: ConnectorInfo[]
    walletShare: number
    blackout?: { chargePointId: string; start: Date; end: Date }
  }): PlannedSession[] {
    const sessions: PlannedSession[] = []

    for (const candidate of params.candidates) {
      const eligible = params.connectors.filter((c) => {
        if (!params.blackout) return true
        if (c.chargePointId !== params.blackout.chargePointId) return true
        return candidate.startedAt.getTime() < params.blackout.start.getTime() || candidate.startedAt.getTime() >= params.blackout.end.getTime()
      })
      if (eligible.length === 0) continue

      let chosen: ConnectorInfo | null = null
      for (let attempt = 0; attempt < 10; attempt++) {
        const candidateConnector = pick(eligible)
        const lastEnd = connectorLastEnd.get(candidateConnector.id) ?? -Infinity
        if (candidate.startedAt.getTime() >= lastEnd + CONNECTOR_BUFFER_MS) {
          chosen = candidateConnector
          break
        }
      }
      let startedAt = candidate.startedAt
      if (!chosen) {
        // Fallback determinístico: usa o conector menos ocupado do pool
        // elegível e empurra o início pra depois da sessão anterior nele —
        // garante que a agenda sempre fecha, sem loop infinito.
        chosen = eligible.reduce((least, c) => {
          const leastEnd = connectorLastEnd.get(least.id) ?? -Infinity
          const cEnd = connectorLastEnd.get(c.id) ?? -Infinity
          return cEnd < leastEnd ? c : least
        }, eligible[0])
        const lastEnd = connectorLastEnd.get(chosen.id) ?? -Infinity
        if (lastEnd + CONNECTOR_BUFFER_MS > startedAt.getTime()) {
          startedAt = new Date(lastEnd + CONNECTOR_BUFFER_MS)
        }
      }

      const durationMin = planDurationMinutes(chosen.type, candidate.abnormal)
      const chargeEndAt = new Date(startedAt.getTime() + durationMin * 60_000)
      const idleTailMin = planIdleTailMinutes(candidate.abnormal)
      const stoppedAt = idleTailMin > 0 ? new Date(chargeEndAt.getTime() + idleTailMin * 60_000) : chargeEndAt
      const chargingEndedAt = idleTailMin > 0 ? chargeEndAt : null

      connectorLastEnd.set(chosen.id, stoppedAt.getTime())

      const energyDeliveredWh = planEnergyWh(chosen.avgPowerKw, durationMin, candidate.abnormal)
      const meterStart = (meterCounter.get(chosen.id) ?? randInt(50_000, 3_000_000)) + randInt(0, 15)
      const meterStop = meterStart + energyDeliveredWh
      meterCounter.set(chosen.id, meterStop)

      const tariffInfo = siteTariff.get(chosen.siteId)!
      const cost =
        candidate.abnormal === 'ZERO_ENERGY'
          ? { energyCostCents: 0, timeCostCents: 0, idleFeeCents: 0, sessionFeeCents: 0, minChargeAdjustmentCents: 0, totalCostCents: 0 }
          : calcularCustoSessao(tariffInfo.snapshot, {
              energyDeliveredWh,
              startedAt,
              chargingEndedAt,
              stoppedAt,
              timezone: chosen.timezone,
            })

      let idleSeconds: number | null = null
      if (chargingEndedAt) {
        const rawIdleSeconds = Math.max(0, (stoppedAt.getTime() - chargingEndedAt.getTime()) / 1000)
        idleSeconds = Math.max(0, Math.round(rawIdleSeconds - tariffInfo.snapshot.idleGracePeriodSeconds))
      }

      sessions.push({
        id: nextSessionId(),
        connector: chosen,
        driver: candidate.driver,
        operatorId: params.operatorId,
        siteId: chosen.siteId,
        chargePointId: chosen.chargePointId,
        connectorId: chosen.id,
        tariffId: tariffInfo.tariffId,
        tariffSnapshot: tariffInfo.snapshot,
        status: statusFor(candidate.abnormal),
        stopReason: stopReasonFor(candidate.abnormal),
        abnormal: candidate.abnormal,
        startedAt,
        chargingEndedAt,
        stoppedAt,
        energyDeliveredWh,
        meterStartWh: meterStart,
        meterStopWh: meterStop,
        idleSeconds,
        cost,
        operatorWalletShare: params.walletShare,
      })
    }

    return sessions
  }

  const connectorsA = allConnectors.filter((c) => c.operatorId === baseOperator.id)
  const connectorsB = allConnectors.filter((c) => c.operatorId === operatorEletroVia.id)
  const connectorsC = allConnectors.filter((c) => c.operatorId === operatorRotaOeste.id)

  // 3 dias de falha no CP designado de Anhanguera, em algum ponto no meio
  // da janela de 60 dias (não recente, não no início).
  const blackoutStartOffsetDays = 27
  const blackoutStart = new Date(utcMidnight(WINDOW_START) + blackoutStartOffsetDays * DAY_MS)
  const blackoutEnd = new Date(blackoutStart.getTime() + 3 * DAY_MS)

  const candidatesA = generateCandidates({
    windowStart: WINDOW_START,
    windowEnd: HISTORICAL_WINDOW_END,
    totalTarget: 7200,
    maintenanceDayOffsets: [10, 34], // 2 dias de manutenção sem sessão nenhuma
  })
  const candidatesB = generateCandidates({
    windowStart: WINDOW_START,
    windowEnd: HISTORICAL_WINDOW_END,
    totalTarget: 4000,
    maintenanceDayOffsets: [18],
  })
  const candidatesC = generateCandidates({
    windowStart: SHORT_WINDOW_START,
    windowEnd: HISTORICAL_WINDOW_END,
    totalTarget: 800,
    maintenanceDayOffsets: [],
  })

  const sessionsA = assignConnectorsAndSchedule({
    candidates: candidatesA,
    operatorId: baseOperator.id,
    connectors: connectorsA,
    walletShare: 0.45,
    blackout: { chargePointId: faultyHistoricalChargePointId, start: blackoutStart, end: blackoutEnd },
  })
  const sessionsB = assignConnectorsAndSchedule({
    candidates: candidatesB,
    operatorId: operatorEletroVia.id,
    connectors: connectorsB,
    walletShare: 0.5,
  })
  const sessionsC = assignConnectorsAndSchedule({
    candidates: candidatesC,
    operatorId: operatorRotaOeste.id,
    connectors: connectorsC,
    walletShare: 0.4,
  })

  const allSessions = [...sessionsA, ...sessionsB, ...sessionsC]
  console.log(`[seed-demo] ${allSessions.length} sessões históricas planejadas (A=${sessionsA.length}, B=${sessionsB.length}, C=${sessionsC.length})`)

  // ------------------------------------------------------------
  // Fase 8 — insere ChargingSession (custo já calculado via calcularCustoSessao)
  // ------------------------------------------------------------
  const sessionRows: Prisma.ChargingSessionCreateManyInput[] = allSessions.map((s) => ({
    id: s.id,
    operatorId: s.operatorId,
    siteId: s.siteId,
    chargePointId: s.chargePointId,
    connectorId: s.connectorId,
    authTokenId: s.driver.authTokenId,
    userId: s.driver.userId,
    status: s.status,
    meterStartWh: s.meterStartWh,
    meterStopWh: s.meterStopWh,
    energyDeliveredWh: s.energyDeliveredWh,
    startedAt: s.startedAt,
    chargingEndedAt: s.chargingEndedAt,
    stoppedAt: s.stoppedAt,
    idleSeconds: s.idleSeconds,
    stopReason: s.stopReason as Prisma.ChargingSessionCreateManyInput['stopReason'],
    tariffId: s.tariffId,
    tariffSnapshot: s.tariffSnapshot as unknown as Prisma.InputJsonValue,
    energyCostCents: s.cost.energyCostCents,
    timeCostCents: s.cost.timeCostCents,
    idleFeeCents: s.cost.idleFeeCents,
    sessionFeeCents: s.cost.sessionFeeCents,
    minChargeAdjustmentCents: s.cost.minChargeAdjustmentCents,
    totalCostCents: s.cost.totalCostCents,
  }))
  await batchCreateMany('ChargingSession (histórico)', sessionRows, (data) => prisma.chargingSession.createMany({ data, skipDuplicates: true }))

  // ------------------------------------------------------------
  // Fase 9 — Pagamentos + carteira, em ordem cronológica global
  // (regra 7: balanceAfterCents certo já no INSERT)
  // ------------------------------------------------------------
  const driverSessionCounts = new Map<number, number>()
  for (const s of allSessions) driverSessionCounts.set(s.driver.index, (driverSessionCounts.get(s.driver.index) ?? 0) + 1)

  const allTopups: TopupEvent[] = []
  for (const driver of driverPool) {
    const sessionCount = driverSessionCounts.get(driver.index) ?? 0
    // Divisor calibrado empiricamente (ver harness de verificação do
    // Cronos) para o saldo acumulado sustentar ~45% das sessões pagas por
    // carteira sem ficar sem fundo (o que empurraria pagamento pra cartão
    // além do share nominal do operador) — /15 deixava a carteira "seca"
    // demais e o split real saía ~67/33 em vez de ~55/45.
    const count = Math.max(1, Math.round(sessionCount / 4))
    const windowStartForDriver = WINDOW_START
    for (let i = 0; i < count; i++) {
      const t = windowStartForDriver.getTime() + randFloat() * (HISTORICAL_WINDOW_END.getTime() - windowStartForDriver.getTime())
      const amountCents = pick([5000, 10000, 15000, 20000, 30000])
      const outcome: TopupEvent['outcome'] = randBool(0.9) ? 'CAPTURED' : 'EXPIRED'
      allTopups.push({ id: nextPaymentIntentId(), walletId: driver.walletId, userId: driver.userId, amountCents, createdAt: new Date(t), outcome })
    }
  }
  console.log(`[seed-demo] ${allTopups.length} eventos de recarga de carteira (Pix) planejados`)

  type FinancialEvent = { time: number; kind: 'session'; session: PlannedSession } | { time: number; kind: 'topup'; topup: TopupEvent }
  const timeline: FinancialEvent[] = []
  for (const s of allSessions) {
    if (s.abnormal !== 'ZERO_ENERGY') timeline.push({ time: s.stoppedAt.getTime(), kind: 'session', session: s })
  }
  for (const t of allTopups) timeline.push({ time: t.createdAt.getTime(), kind: 'topup', topup: t })
  timeline.sort((a, b) => a.time - b.time)

  const walletBalance = new Map<string, number>()
  const paymentIntentRows: Prisma.PaymentIntentCreateManyInput[] = []
  const walletEntryRows: Prisma.WalletEntryCreateManyInput[] = []
  const debtRows: Prisma.DebtCreateManyInput[] = []
  const webhookRows: Prisma.WebhookEventCreateManyInput[] = []

  for (const ev of timeline) {
    if (ev.kind === 'topup') {
      const t = ev.topup
      if (t.outcome === 'CAPTURED') {
        const capturedAt = new Date(t.createdAt.getTime() + 5_000)
        paymentIntentRows.push({
          id: t.id,
          purpose: 'WALLET_TOPUP_PIX',
          provider: 'CIELO_PIX',
          userId: t.userId,
          walletId: t.walletId,
          cieloPaymentId: `DEMO-PIX-${t.id}`,
          status: 'CAPTURED',
          amountRequestedCents: t.amountCents,
          amountCapturedCents: t.amountCents,
          pixQrCode: `00020126demo-qr-${t.id}`,
          capturedAt,
          createdAt: t.createdAt,
          updatedAt: capturedAt,
        })
        const prevBalance = walletBalance.get(t.walletId) ?? 0
        const newBalance = prevBalance + t.amountCents
        walletBalance.set(t.walletId, newBalance)
        walletEntryRows.push({
          id: nextWalletEntryId(),
          walletId: t.walletId,
          type: 'TOPUP_PIX',
          amountCents: t.amountCents,
          balanceAfterCents: newBalance,
          referenceType: 'PAYMENT_INTENT',
          referenceId: t.id,
          description: 'Recarga de carteira via Pix',
          createdAt: capturedAt,
        })
      } else {
        const pixExpiresAt = new Date(t.createdAt.getTime() + 30 * 60_000)
        paymentIntentRows.push({
          id: t.id,
          purpose: 'WALLET_TOPUP_PIX',
          provider: 'CIELO_PIX',
          userId: t.userId,
          walletId: t.walletId,
          status: 'EXPIRED',
          amountRequestedCents: t.amountCents,
          pixQrCode: `00020126demo-qr-${t.id}`,
          pixExpiresAt,
          createdAt: t.createdAt,
          updatedAt: pixExpiresAt,
        })
      }
      continue
    }

    const s = ev.session
    const totalCost = s.cost.totalCostCents
    if (totalCost <= 0) continue

    const balance = walletBalance.get(s.driver.walletId) ?? 0
    const wantsWallet = randFloat() < s.operatorWalletShare
    const payByWallet = wantsWallet && balance >= totalCost

    if (payByWallet) {
      const newBalance = balance - totalCost
      walletBalance.set(s.driver.walletId, newBalance)
      walletEntryRows.push({
        id: nextWalletEntryId(),
        walletId: s.driver.walletId,
        type: 'CHARGE_DEBIT',
        amountCents: -totalCost,
        balanceAfterCents: newBalance,
        referenceType: 'CHARGING_SESSION',
        referenceId: s.id,
        description: 'Débito por sessão de recarga',
        createdAt: s.stoppedAt,
      })
      continue
    }

    // Cartão: pré-autoriza teto de R$200, captura o valor real da sessão.
    const piId = nextPaymentIntentId()
    const outcomeIdx = weightedIndex([0.905, 0.05, 0.03, 0.015]) // CAPTURED, DENIED, FAILED->Debt, CAPTURED depois VOIDED
    const authorizedAt = new Date(s.startedAt.getTime() + 3_000)
    const capturedAt = new Date(s.stoppedAt.getTime() + 5_000)
    const cieloPaymentId = `DEMO-CIELO-${piId}`

    if (outcomeIdx === 1) {
      paymentIntentRows.push({
        id: piId,
        operatorId: s.operatorId,
        purpose: 'SESSION_CARD_CAPTURE',
        provider: 'CIELO_CARD',
        userId: s.driver.userId,
        chargingSessionId: s.id,
        paymentMethodId: s.driver.paymentMethodId,
        cieloPaymentId,
        status: 'DENIED',
        returnCode: '05',
        amountRequestedCents: 20_000,
        createdAt: authorizedAt,
        updatedAt: authorizedAt,
      })
    } else if (outcomeIdx === 2) {
      paymentIntentRows.push({
        id: piId,
        operatorId: s.operatorId,
        purpose: 'SESSION_CARD_CAPTURE',
        provider: 'CIELO_CARD',
        userId: s.driver.userId,
        chargingSessionId: s.id,
        paymentMethodId: s.driver.paymentMethodId,
        cieloPaymentId,
        status: 'FAILED',
        returnCode: '4',
        amountRequestedCents: 20_000,
        amountAuthorizedCents: 20_000,
        authorizedAt,
        createdAt: authorizedAt,
        updatedAt: capturedAt,
      })
      debtRows.push({
        id: nextDebtId(),
        userId: s.driver.userId,
        operatorId: s.operatorId,
        chargingSessionId: s.id,
        paymentIntentId: piId,
        amountCents: totalCost,
        status: 'OPEN',
        reason: 'Falha na captura do cartão após StopTransaction',
        createdAt: capturedAt,
        updatedAt: capturedAt,
      })
    } else {
      const voided = outcomeIdx === 3
      const cancelledAt = voided ? new Date(capturedAt.getTime() + 2 * DAY_MS) : null
      paymentIntentRows.push({
        id: piId,
        operatorId: s.operatorId,
        purpose: 'SESSION_CARD_CAPTURE',
        provider: 'CIELO_CARD',
        userId: s.driver.userId,
        chargingSessionId: s.id,
        paymentMethodId: s.driver.paymentMethodId,
        cieloPaymentId,
        status: voided ? 'VOIDED' : 'CAPTURED',
        returnCode: '4',
        amountRequestedCents: 20_000,
        amountAuthorizedCents: 20_000,
        amountCapturedCents: totalCost,
        authorizedAt,
        capturedAt,
        cancelledAt,
        createdAt: authorizedAt,
        updatedAt: cancelledAt ?? capturedAt,
      })
      if (voided && cancelledAt) {
        webhookRows.push({
          id: nextWebhookEventId(),
          provider: 'CIELO',
          externalId: cieloPaymentId,
          changeType: 25,
          paymentIntentId: piId,
          payload: { PaymentId: cieloPaymentId, ChangeType: 25, Note: 'Estorno solicitado pelo motorista (demo)' } as unknown as Prisma.InputJsonValue,
          receivedAt: cancelledAt,
          processedAt: cancelledAt,
        })
      }
    }
  }

  await batchCreateMany('PaymentIntent', paymentIntentRows, (data) => prisma.paymentIntent.createMany({ data, skipDuplicates: true }))
  await batchCreateMany('WalletEntry', walletEntryRows, (data) => prisma.walletEntry.createMany({ data, skipDuplicates: true }))
  await batchCreateMany('Debt', debtRows, (data) => prisma.debt.createMany({ data, skipDuplicates: true }))
  await batchCreateMany('WebhookEvent', webhookRows, (data) => prisma.webhookEvent.createMany({ data, skipDuplicates: true }))

  // ------------------------------------------------------------
  // Fase 10 — Sessões ATIVAS agora + charge points offline/faulted
  // ------------------------------------------------------------
  const ACTIVE_COUNT = 6
  const usedConnectorIds = new Set<string>()
  const activeConnectors: ConnectorInfo[] = []
  while (activeConnectors.length < ACTIVE_COUNT) {
    const c = pick(allConnectors)
    if (usedConnectorIds.has(c.id)) continue
    usedConnectorIds.add(c.id)
    activeConnectors.push(c)
  }

  const activeSessionRows: Prisma.ChargingSessionCreateManyInput[] = []
  const activeSessionsForSamples: Array<{ id: string; chargePointId: string; operatorId: string; meterStartWh: number; startedAt: Date }> = []

  for (const connector of activeConnectors) {
    const minutesAgo = randInt(5, 90)
    const startedAt = new Date(NOW.getTime() - minutesAgo * 60_000)
    const statusIdx = weightedIndex([0.15, 0.7, 0.15])
    const status = (['STARTED', 'CHARGING', 'FINISHING'] as const)[statusIdx]
    const driver = sampleDriver()
    const tariffInfo = siteTariff.get(connector.siteId)!

    const meterStart = (meterCounter.get(connector.id) ?? randInt(50_000, 3_000_000)) + randInt(0, 15)
    meterCounter.set(connector.id, meterStart)

    const chargingEndedAt = status === 'FINISHING' ? new Date(NOW.getTime() - randInt(1, 10) * 60_000) : null
    const lastSampleAt = new Date(NOW.getTime() - randInt(10, 50) * 1000)
    const lastPowerW = status === 'FINISHING' ? 0 : Math.round(connector.avgPowerKw * 1000 * (0.8 + randFloat() * 0.3))
    const lastSoc = randInt(15, 90)

    const sessionId = nextSessionId()
    activeSessionRows.push({
      id: sessionId,
      operatorId: connector.operatorId,
      siteId: connector.siteId,
      chargePointId: connector.chargePointId,
      connectorId: connector.id,
      authTokenId: driver.authTokenId,
      userId: driver.userId,
      status,
      meterStartWh: meterStart,
      startedAt,
      chargingEndedAt,
      tariffId: tariffInfo.tariffId,
      tariffSnapshot: tariffInfo.snapshot as unknown as Prisma.InputJsonValue,
      lastSampleAt,
      lastPowerW,
      lastSoc,
    })
    activeSessionsForSamples.push({ id: sessionId, chargePointId: connector.chargePointId, operatorId: connector.operatorId, meterStartWh: meterStart, startedAt })

    await prisma.connector.update({
      where: { id: connector.id },
      data: { status: status === 'FINISHING' ? 'FINISHING' : 'CHARGING', statusUpdatedAt: new Date(NOW.getTime() - randInt(1, 5) * 60_000) },
    })
    await prisma.chargePoint.update({ where: { id: connector.chargePointId }, data: { lastSeenAt: new Date(NOW.getTime() - randInt(5, 60) * 1000) } })
  }
  await batchCreateMany('ChargingSession (ativas agora)', activeSessionRows, (data) => prisma.chargingSession.createMany({ data, skipDuplicates: true }))

  // 2-3 charge points offline (lastSeenAt antigo) — fora do conjunto ativo.
  const offlinePool = allConnectors.filter((c) => !usedConnectorIds.has(c.id) && c.chargePointId !== faultyHistoricalChargePointId)
  const offlineChargePointIds = new Set<string>()
  while (offlineChargePointIds.size < 3 && offlinePool.length > 0) {
    const c = pick(offlinePool)
    offlineChargePointIds.add(c.chargePointId)
  }
  for (const cpId of offlineChargePointIds) {
    await prisma.chargePoint.update({ where: { id: cpId }, data: { lastSeenAt: new Date(NOW.getTime() - randInt(2, 5) * DAY_MS) } })
  }

  // 1 charge point com conector FAULTED agora (online, mas com defeito).
  const faultyNowPool = allConnectors.filter((c) => !usedConnectorIds.has(c.id) && !offlineChargePointIds.has(c.chargePointId) && c.chargePointId !== faultyHistoricalChargePointId)
  if (faultyNowPool.length > 0) {
    const faultyConnector = pick(faultyNowPool)
    await prisma.connector.update({
      where: { id: faultyConnector.id },
      data: { status: 'FAULTED', errorCode: 'GroundFailure', statusUpdatedAt: new Date(NOW.getTime() - randInt(5, 40) * 60_000) },
    })
    await prisma.chargePoint.update({ where: { id: faultyConnector.chargePointId }, data: { lastSeenAt: new Date(NOW.getTime() - randInt(1, 10) * 60_000) } })
  }

  console.log(`[seed-demo] ${ACTIVE_COUNT} sessões ativas agora, ${offlineChargePointIds.size} charge points offline, 1 conector faultado agora`)

  // ------------------------------------------------------------
  // Fase 11 — MeterSample: só últimos 3 dias + sessões ativas (regra 6)
  // ------------------------------------------------------------
  function buildMeterSamples(session: { id: string; chargePointId: string; operatorId: string; meterStartWh: number; meterStopWh: number | null; startedAt: Date; sampleUntil: Date }): Prisma.MeterSampleCreateManyInput[] {
    const rows: Prisma.MeterSampleCreateManyInput[] = []
    const startMs = session.startedAt.getTime()
    const endMs = session.sampleUntil.getTime()
    if (endMs <= startMs) return rows
    const totalMs = endMs - startMs
    const meterStart = session.meterStartWh
    const meterEnd = session.meterStopWh ?? session.meterStartWh
    for (let t = startMs; t <= endMs; t += 60_000) {
      const frac = totalMs > 0 ? (t - startMs) / totalMs : 0
      const value = meterStart + (meterEnd - meterStart) * frac
      rows.push({
        id: nextMeterSampleId(),
        sessionId: session.id,
        chargePointId: session.chargePointId,
        operatorId: session.operatorId,
        ts: new Date(t),
        measurand: 'Energy.Active.Import.Register',
        value: value.toFixed(4),
        unit: 'Wh',
        context: 'Sample.Periodic',
      })
    }
    return rows
  }

  const meterSampleRows: Prisma.MeterSampleCreateManyInput[] = []
  for (const s of allSessions) {
    if (s.startedAt.getTime() < RECENT_START.getTime()) continue
    meterSampleRows.push(
      ...buildMeterSamples({
        id: s.id,
        chargePointId: s.chargePointId,
        operatorId: s.operatorId,
        meterStartWh: s.meterStartWh,
        meterStopWh: s.meterStopWh,
        startedAt: s.startedAt,
        sampleUntil: s.chargingEndedAt ?? s.stoppedAt,
      }),
    )
  }
  for (const s of activeSessionsForSamples) {
    meterSampleRows.push(...buildMeterSamples({ ...s, meterStopWh: null, sampleUntil: NOW }))
  }
  await batchCreateMany('MeterSample (últimos 3 dias + ativas)', meterSampleRows, (data) => prisma.meterSample.createMany({ data, skipDuplicates: true }))

  // ------------------------------------------------------------
  // Resumo final
  // ------------------------------------------------------------
  console.log('[seed-demo] concluído.')
  console.log(`[seed-demo]   sessões históricas: ${allSessions.length}`)
  console.log(`[seed-demo]   sessões ativas agora: ${ACTIVE_COUNT}`)
  console.log(`[seed-demo]   pagamentos (PaymentIntent): ${paymentIntentRows.length}`)
  console.log(`[seed-demo]   lançamentos de carteira (WalletEntry): ${walletEntryRows.length}`)
  console.log(`[seed-demo]   dívidas abertas (Debt): ${debtRows.length}`)
  console.log(`[seed-demo]   estornos (WebhookEvent changeType 25): ${webhookRows.length}`)
  console.log(`[seed-demo]   amostras de medidor (MeterSample): ${meterSampleRows.length}`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
