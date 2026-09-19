/**
 * PROVA LOCAL de ponta a ponta do mapa "eletropostos perto de mim" em tempo
 * real (Íris, 2026-09-19) — MEDE, com timestamps em ms, quanto tempo leva
 * entre "o carregador muda de estado" e "o motorista que está só olhando o
 * mapa fica sabendo" (SSE público `ui:ev:stations` e `GET /api/sites`).
 *
 * SÓ LOCAL: este script CRIA contas de motorista (`/api/auth/register`), faz
 * login de ADMIN do seed e credita saldo. Por segurança ele RECUSA rodar se a
 * URL da API não for localhost/127.0.0.1. Para provar contra outro ambiente,
 * rode `scripts/simulate-charger.ts` com as SUAS credenciais e olhe o app.
 *
 * Pré-requisitos (tudo local e descartável): Postgres + Redis, `prisma migrate
 * deploy` + `npm run db:seed`, a API (`npm run dev:api`, porta 3000) e o
 * gateway OCPP (`npm run dev:ocpp`, porta 9000) de pé.
 *
 *   cd backend
 *   OCPP_PASSWORD=changeme-basic-auth-secret npx tsx scripts/verify-realtime-stations.ts \
 *     --iterations 5 --immediate 3 --silent-drop 1 --out timeline.json
 *
 * Variáveis/opções (padrões = seed local):
 *   API_URL (http://localhost:3000)  OCPP_URL (ws://localhost:9000/ocpp)  OCPP_IDENTITY (CP-INNOELEKTRON-001)
 *   OCPP_PASSWORD (obrigatória)      ADMIN_EMAIL / ADMIN_PASSWORD (admin do seed local)
 *   --iterations N   cenários completos "calmos" (espera > janela de 2s do throttle antes de iniciar)  (padrão 5)
 *   --immediate N    cenários em que o Iniciar vem logo após o carregador conectar (mostra o throttle) (padrão 3)
 *   --drop-in-charge N  carregador perde o socket NO MEIO da recarga, volta, e a recarga é parada pelo app (padrão 1)
 *   --silent-drop N  quedas "silenciosas" (rede cortada, sem FIN) atrás de um proxy TCP que congela     (padrão 1)
 *   --out <arquivo>  grava as medições brutas em JSON
 *
 * Personagens: A = motorista que inicia a recarga; B = motorista OBSERVADOR
 * (SSE `GET /api/me/events` aberto + polling de `GET /api/sites`).
 */
import net from 'node:net'
import { writeFileSync } from 'node:fs'
import { ChargerSimulator, wallNow, type SimulatorEvent } from './simulate-charger'

// ------------------------------------------------------------------ config

const API_URL = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const OCPP_URL = process.env.OCPP_URL ?? 'ws://localhost:9000/ocpp'
const IDENTITY = process.env.OCPP_IDENTITY ?? 'CP-INNOELEKTRON-001'
const OCPP_PASSWORD = process.env.OCPP_PASSWORD ?? ''
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@innoelektron.example.com'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'admin123456'
const POLL_INTERVAL_MS = 300 // `publicRateLimit` = 300 req/min/IP; 300 ms = 200/min

function assertLocalOnly(): void {
  const host = new URL(API_URL).hostname
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
    console.error(`RECUSADO: API_URL=${API_URL} não é local. Este script cria contas e credita saldo — só roda em localhost.`)
    process.exit(2)
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function until(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timeout (${timeoutMs}ms) esperando: ${what}`)
    await sleep(10)
  }
}

// -------------------------------------------------------------------- HTTP

interface HttpResult {
  status: number
  body: any // eslint-disable-line @typescript-eslint/no-explicit-any
  sentAt: number
  receivedAt: number
}

async function http(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<HttpResult> {
  const sentAt = wallNow()
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
  const receivedAt = wallNow()
  const text = await res.text()
  let body: unknown = text
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    /* corpo não-JSON */
  }
  return { status: res.status, body, sentAt, receivedAt }
}

// --------------------------------------------------------------------- SSE

interface SseEvent {
  at: number
  type: string
  data: Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
}

class SseClient {
  readonly events: SseEvent[] = []
  private controller = new AbortController()
  private opened = false
  private readonly done: Promise<void>

  constructor(
    readonly label: string,
    url: string,
    token: string,
  ) {
    this.done = this.run(url, token).catch(() => undefined)
  }

  private async run(url: string, token: string): Promise<void> {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' }, signal: this.controller.signal })
    if (res.status !== 200 || !res.body) throw new Error(`SSE ${this.label}: HTTP ${res.status}`)
    this.opened = true
    const decoder = new TextDecoder()
    let buffer = ''
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      const at = wallNow()
      buffer += decoder.decode(chunk, { stream: true })
      let idx: number
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        let type = ''
        let data = ''
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) type = line.slice(6).trim()
          else if (line.startsWith('data:')) data += line.slice(5).trim()
        }
        if (type && data) this.events.push({ at, type, data: JSON.parse(data) })
      }
    }
  }

  async ready(): Promise<void> {
    await until(() => this.opened, 5_000, `SSE ${this.label} abrir`)
  }

  find(pred: (e: SseEvent) => boolean, after = 0): SseEvent | undefined {
    return this.events.find((e) => e.at >= after && pred(e))
  }

  async waitFor(pred: (e: SseEvent) => boolean, after: number, timeoutMs: number, what: string): Promise<SseEvent> {
    await until(() => !!this.find(pred, after), timeoutMs, `${this.label}: ${what}`)
    return this.find(pred, after)!
  }

  close(): void {
    this.controller.abort()
  }
  async closed(): Promise<void> {
    await this.done
  }
}

// ------------------------------------------------------------- polling /sites

interface SiteSample {
  at: number
  online: boolean
  free: number
  total: number
  connectors: { connectorId: number; isFree: boolean; status: string }[]
  raw: string
}

class SitesPoller {
  readonly samples: SiteSample[] = []
  private timer?: NodeJS.Timeout
  private running = false

  start(): void {
    if (this.timer) return
    const tick = async () => {
      if (this.running) return
      this.running = true
      try {
        const r = await fetchSite()
        if (r) this.samples.push(r)
      } finally {
        this.running = false
      }
    }
    void tick()
    this.timer = setInterval(() => void tick(), POLL_INTERVAL_MS)
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }
  first(pred: (s: SiteSample) => boolean, after: number): SiteSample | undefined {
    return this.samples.find((s) => s.at >= after && pred(s))
  }
  async waitFor(pred: (s: SiteSample) => boolean, after: number, timeoutMs: number, what: string): Promise<SiteSample> {
    await until(() => !!this.first(pred, after), timeoutMs, `/api/sites: ${what}`)
    return this.first(pred, after)!
  }
}

async function fetchSite(): Promise<SiteSample | undefined> {
  const r = await http('GET', '/api/sites?pageSize=100')
  const receivedAt = r.receivedAt
  if (r.status !== 200) throw new Error(`GET /api/sites -> ${r.status} ${JSON.stringify(r.body)}`)
  for (const site of r.body.items as any[]) { // eslint-disable-line @typescript-eslint/no-explicit-any
    const cp = site.chargePoints.find((c: any) => c.ocppIdentity === IDENTITY) // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!cp) continue
    const connectors = cp.connectors.map((c: any) => ({ connectorId: c.connectorId, isFree: c.isFree, status: c.status })) // eslint-disable-line @typescript-eslint/no-explicit-any
    return {
      // `at` = instante em que a RESPOSTA chegou (o estado é anterior a isto por até ~metade do RTT).
      at: receivedAt,
      online: cp.online,
      free: site.connectorSummary.free,
      total: site.connectorSummary.total,
      connectors,
      raw: JSON.stringify(site),
    }
  }
  return undefined
}

// ---------------------------------------------------- proxy TCP "congelável"

/** Encaminha TCP para o gateway; `freeze()` para de repassar nos dois sentidos SEM fechar nada (rede cortada / cabo puxado: nenhum FIN/RST chega ao servidor). */
class FreezableProxy {
  private server?: net.Server
  private frozen = false
  private readonly sockets = new Set<net.Socket>()

  async listen(port: number, targetHost: string, targetPort: number): Promise<void> {
    this.server = net.createServer((client) => {
      const upstream = net.connect(targetPort, targetHost)
      this.sockets.add(client).add(upstream)
      client.on('data', (d) => !this.frozen && upstream.write(d))
      upstream.on('data', (d) => !this.frozen && client.write(d))
      const closeBoth = () => {
        client.destroy()
        upstream.destroy()
      }
      client.on('close', closeBoth).on('error', closeBoth)
      upstream.on('close', closeBoth).on('error', closeBoth)
    })
    await new Promise<void>((resolve) => this.server!.listen(port, '127.0.0.1', resolve))
  }
  freeze(): void {
    this.frozen = true
  }
  async shutdown(): Promise<void> {
    for (const s of this.sockets) s.destroy()
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()))
  }
}

// ------------------------------------------------------------------ resultados

type Metrics = Record<string, number>
interface IterationResult {
  kind: string
  metrics: Metrics
  anomalies: string[]
  checks: Record<string, boolean>
  timeline: { label: string; tMs: number }[]
}

const results: IterationResult[] = []

function stats(values: number[]): { n: number; min: number; median: number; max: number } | undefined {
  if (values.length === 0) return undefined
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
  return { n: s.length, min: s[0], median: mid, max: s[s.length - 1] }
}

// ------------------------------------------------------------------- setup

interface Driver {
  id: string
  token: string
  email: string
}

async function registerDriver(label: string): Promise<Driver> {
  const email = `realtime-${label}-${Date.now().toString(36)}@example.test`
  const r = await http('POST', '/api/auth/register', { body: { name: `Motorista ${label} (teste local)`, email, password: `SenhaLocal-${Math.random().toString(36).slice(2, 10)}` } })
  if (r.status !== 201) throw new Error(`register ${label}: ${r.status} ${JSON.stringify(r.body)}`)
  return { id: r.body.user.id, token: r.body.token, email }
}

async function adminToken(): Promise<string> {
  const r = await http('POST', '/api/auth/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
  if (r.status !== 200) throw new Error(`login admin: ${r.status} ${JSON.stringify(r.body)}`)
  return r.body.token
}

async function walletBalance(d: Driver): Promise<number> {
  const r = await http('GET', '/api/me/wallet?pageSize=1', { token: d.token })
  if (r.status !== 200) throw new Error(`wallet: ${r.status} ${JSON.stringify(r.body)}`)
  return r.body.balanceCents
}

async function ensureBalance(admin: string, d: Driver, minCents: number): Promise<void> {
  const bal = await walletBalance(d)
  if (bal >= minCents) return
  const r = await http('POST', `/api/admin/drivers/${d.id}/wallet/entries`, { token: admin, body: { amountCents: 5000, description: 'crédito de teste local (realtime)' } })
  if (r.status !== 201) throw new Error(`crédito: ${r.status} ${JSON.stringify(r.body)}`)
}

// -------------------------------------------------------------- cenário principal

interface Ctx {
  a: Driver
  b: Driver
  admin: string
}

const PUBLIC_KEYS = new Set(['type', 'occurredAt', 'chargePointId', 'connectorId', 'status'])
const PRIVATE_TYPES = new Set(['wallet.updated', 'session.metrics', 'session.started', 'session.stopped'])

async function runCycle(ctx: Ctx, kind: 'calmo' | 'imediato', index: number): Promise<IterationResult> {
  const anomalies: string[] = []
  const checks: Record<string, boolean> = {}
  const timeline: { label: string; tMs: number }[] = []
  const metrics: Metrics = {}
  const mark = (label: string, t: number) => timeline.push({ label, tMs: t })

  await ensureBalance(ctx.admin, ctx.a, 2500)
  const balanceBefore = await walletBalance(ctx.a)

  const poller = new SitesPoller()
  const sseB = new SseClient('B', `${API_URL}/api/me/events`, ctx.b.token)
  const sseA = new SseClient('A', `${API_URL}/api/me/events`, ctx.a.token)
  await Promise.all([sseB.ready(), sseA.ready()])
  const sim = new ChargerSimulator({ url: OCPP_URL, identity: IDENTITY, password: OCPP_PASSWORD, connectors: 2, meterIntervalMs: 2_000, startDelayMs: 250 })
  const simEvents: SimulatorEvent[] = []
  sim.on('evt', (e: SimulatorEvent) => simEvents.push(e))
  const simFind = (name: string, pred: (e: SimulatorEvent) => boolean = () => true, after = 0) => simEvents.find((e) => e.name === name && e.at >= after && pred(e))

  try {
    poller.start()
    await sleep(700) // linha de base: estado anterior ao carregador conectar (offline/parado)

    // ---- 1. conecta ---------------------------------------------------
    const tConnect = wallNow()
    await sim.connect()
    const tBooted = wallNow()
    const s2 = await poller.waitFor((s) => s.online && s.free === 2, tConnect, 10_000, 'online com 2/2 livres')
    metrics['1_conecta_ate_2de2_livres_ms'] = s2.at - tConnect
    metrics['1_boot_concluido_ms'] = tBooted - tConnect
    mark('conectou (handshake iniciado)', 0)

    if (kind === 'calmo') await sleep(5_000) // > 2 janelas do throttle de 2s desde as mensagens do Boot (cenário típico: o motorista chega depois)

    // ---- 2. A inicia a recarga -----------------------------------------
    const tStart = wallNow()
    const start = await http('POST', '/api/me/sessions/start', { token: ctx.a.token, body: { ocppIdentity: IDENTITY, connectorId: 1 } })
    if (start.status !== 202) throw new Error(`start -> ${start.status} ${JSON.stringify(start.body)}`)
    metrics['2_post_start_202_ms'] = start.receivedAt - tStart

    // Primeiro evento que diz "conector 1 NÃO está mais livre" (PREPARING ou CHARGING — o throttle pode engolir o PREPARING, ver anomalias).
    const eBOccupied = await sseB.waitFor((e) => e.type === 'chargepoint.status' && e.data.connectorId === 1 && e.data.status !== 'AVAILABLE', tStart, 10_000, 'chargepoint.status do conector 1 deixando AVAILABLE')
    const eBCharge = await sseB.waitFor((e) => e.type === 'chargepoint.status' && e.data.connectorId === 1 && e.data.status === 'CHARGING', tStart, 10_000, 'chargepoint.status CHARGING')
    const remoteStart = simFind('remote-start-received', () => true, tStart)!
    const prepSent = simFind('status-sent', (e) => e.connectorId === 1 && e.status === 'Preparing', tStart)!
    const chargingSent = simFind('status-sent', (e) => e.connectorId === 1 && e.status === 'Charging', tStart)!

    metrics['3_a_comando_chega_no_carregador_ms'] = (remoteStart.receivedAt as number) - tStart
    metrics['4a_B_sse_ocupado_desde_iniciar_ms'] = eBOccupied.at - tStart
    metrics['4b_B_sse_ocupado_desde_carregador_avisar_Preparing_ms'] = eBOccupied.at - (prepSent.sentAt as number)
    metrics['4c_B_sse_CHARGING_desde_carregador_avisar_Charging_ms'] = eBCharge.at - (chargingSent.sentAt as number)
    metrics['4d_atraso_do_throttle_no_1o_evento_de_ocupacao_ms'] = eBOccupied.at - Date.parse(eBOccupied.data.occurredAt as string)
    metrics['4e_atraso_do_throttle_no_evento_CHARGING_ms'] = eBCharge.at - Date.parse(eBCharge.data.occurredAt as string)
    // Só no cenário calmo é obrigatório: no imediato o throttle de 2s coalesce Preparing+Charging por desenho (vira anomalia informativa abaixo).
    if (kind === 'calmo') checks['PREPARING_chegou_ao_SSE_publico'] = sseB.events.some((e) => e.type === 'chargepoint.status' && e.data.connectorId === 1 && e.data.status === 'PREPARING' && e.at >= tStart)

    // (b) /api/sites: 1 de 2 livres e o conector 1 NÃO livre
    const oneOfTwo = await poller.waitFor((s) => s.online && s.free === 1 && s.connectors.some((c) => c.connectorId === 1 && !c.isFree) && s.connectors.some((c) => c.connectorId === 2 && c.isFree), tStart, 10_000, '1 de 2 livres (conector 1 ocupado)')
    metrics['5a_sites_1de2_livres_desde_iniciar_ms'] = oneOfTwo.at - tStart
    metrics['5b_sites_1de2_livres_desde_carregador_avisar_ms'] = oneOfTwo.at - (prepSent.sentAt as number)

    // (b2) o que o app faz: ao receber o SSE, refaz o fetch — quanto custa e o que ele vê
    const tRefetch = wallNow()
    const refetched = await fetchSite()
    metrics['5c_refetch_apos_sse_custo_ms'] = wallNow() - tRefetch
    checks['refetch_apos_sse_ja_mostra_1de2'] = !!refetched && refetched.free === 1 && refetched.connectors.some((c) => c.connectorId === 1 && !c.isFree)

    // (c) A: session.started + session.metrics
    const eAStarted = await sseA.waitFor((e) => e.type === 'session.started', tStart, 10_000, 'session.started')
    const eAMetrics1 = await sseA.waitFor((e) => e.type === 'session.metrics', tStart, 15_000, 'session.metrics')
    const firstMeterSent = simFind('meter-values-sent', () => true, tStart)!
    metrics['6a_A_session_started_desde_iniciar_ms'] = eAStarted.at - tStart
    metrics['6b_A_primeiro_session_metrics_desde_MeterValues_ms'] = eAMetrics1.at - (firstMeterSent.sentAt as number)
    metrics['6c_A_primeiro_session_metrics_desde_iniciar_ms'] = eAMetrics1.at - tStart

    // deixa rodar ~7s para ver a cadência de session.metrics (coalescência de 5s) e MeterValues a cada 2s
    await sleep(7_000)
    const metricsEvents = sseA.events.filter((e) => e.type === 'session.metrics' && e.at >= tStart)
    metrics['6d_A_session_metrics_recebidos_em_7s'] = metricsEvents.length
    if (metricsEvents.length >= 2) metrics['6e_A_intervalo_entre_session_metrics_ms'] = metricsEvents[1].at - metricsEvents[0].at

    // ---- 3. A para -----------------------------------------------------
    const sessionId = eAStarted.data.sessionId as string
    const tStop = wallNow()
    const stop = await http('POST', `/api/me/sessions/${sessionId}/stop`, { token: ctx.a.token })
    if (stop.status !== 202) throw new Error(`stop -> ${stop.status} ${JSON.stringify(stop.body)}`)
    metrics['7_post_stop_202_ms'] = stop.receivedAt - tStop

    const eBAvailable = await sseB.waitFor((e) => e.type === 'chargepoint.status' && e.data.connectorId === 1 && e.data.status === 'AVAILABLE', tStop, 15_000, 'chargepoint.status AVAILABLE (fim)')
    const availableSent = simFind('status-sent', (e) => e.connectorId === 1 && e.status === 'Available', tStop)!
    const stopSent = simFind('stop-transaction-sent', () => true, tStop)!
    const twoOfTwo = await poller.waitFor((s) => s.online && s.free === 2, tStop, 15_000, 'volta a 2 de 2 livres')
    const eAStopped = await sseA.waitFor((e) => e.type === 'session.stopped', tStop, 15_000, 'session.stopped')
    const eAWallet = await sseA.waitFor((e) => e.type === 'wallet.updated', tStop, 15_000, 'wallet.updated')

    metrics['8a_stop_ate_carregador_receber_ms'] = (simFind('remote-stop-received', () => true, tStop)!.receivedAt as number) - tStop
    metrics['8b_B_sse_AVAILABLE_desde_parar_ms'] = eBAvailable.at - tStop
    metrics['8c_B_sse_AVAILABLE_desde_carregador_avisar_ms'] = eBAvailable.at - (availableSent.sentAt as number)
    metrics['8d_sites_2de2_desde_parar_ms'] = twoOfTwo.at - tStop
    metrics['8e_A_session_stopped_desde_StopTransaction_ms'] = eAStopped.at - (stopSent.sentAt as number)
    metrics['8f_A_wallet_updated_desde_StopTransaction_ms'] = eAWallet.at - (stopSent.sentAt as number)

    // dinheiro: mínimo da tarifa do seed = 500 centavos
    const balanceAfterEvent = eAWallet.data.balanceCents as number
    checks['wallet_updated_debito_correto(saldo-500)'] = balanceAfterEvent === balanceBefore - 500
    const walletNow = await walletBalance(ctx.a)
    checks['get_wallet_bate_com_o_evento'] = walletNow === balanceAfterEvent
    const receipt = await http('GET', `/api/me/sessions/${sessionId}`, { token: ctx.a.token })
    checks['recibo_total_500_e_STOPPED'] = receipt.status === 200 && receipt.body.totalCostCents === 500 && receipt.body.status === 'STOPPED'
    metrics['debito_centavos'] = balanceBefore - walletNow

    // ---- privacidade e formato ----------------------------------------
    await sleep(500)
    const bEvents = sseB.events
    checks['B_nao_recebeu_evento_privado_de_A'] = !bEvents.some((e) => PRIVATE_TYPES.has(e.type))
    const publicEvents = bEvents.filter((e) => e.type === 'chargepoint.status')
    checks['payload_publico_so_tem_chargePointId_connectorId_status'] = publicEvents.length > 0 && publicEvents.every((e) => Object.keys(e.data).every((k) => PUBLIC_KEYS.has(k)))
    checks['B_so_recebeu_tipo_chargepoint.status'] = bEvents.every((e) => e.type === 'chargepoint.status')
    checks['A_recebeu_os_proprios_eventos_privados'] = ['session.started', 'session.metrics', 'session.stopped', 'wallet.updated'].every((t) => sseA.events.some((e) => e.type === t))
    checks['nenhum_evento_de_A_carrega_userId_de_B'] = !sseA.events.some((e) => JSON.stringify(e.data).includes(ctx.b.id))

    // ---- anomalias: duplicados e ordem ---------------------------------
    const seqB = publicEvents.filter((e) => e.data.connectorId === 1).map((e) => e.data.status as string)
    const dupConsecutive = seqB.some((st, i) => i > 0 && st === seqB[i - 1])
    if (dupConsecutive) anomalies.push(`info: status repetido em sequência no SSE de B (conector 1): ${seqB.join('>')} (cada StatusNotification emite evento, mesmo sem mudança de estado)`)
    // Ciclo esperado do conector: AVAILABLE -> (PREPARING) -> CHARGING -> (FINISHING) -> AVAILABLE. Etapas podem ser coalescidas, nunca invertidas.
    const allowedNext: Record<string, string[]> = {
      AVAILABLE: ['AVAILABLE', 'PREPARING', 'CHARGING', 'FINISHING'],
      PREPARING: ['PREPARING', 'CHARGING', 'FINISHING', 'AVAILABLE'],
      CHARGING: ['CHARGING', 'FINISHING', 'AVAILABLE'],
      FINISHING: ['FINISHING', 'AVAILABLE'],
    }
    const badStep = seqB.findIndex((st, i) => i > 0 && !(allowedNext[seqB[i - 1]] ?? []).includes(st))
    if (badStep > 0) anomalies.push(`ordem trocada no SSE de B (conector 1): ${seqB.join('>')}`)
    // Finishing costuma ser engolido pelo throttle de 2s (o "último vence") — não é bug, é o desenho; só registramos.
    if (!seqB.includes('FINISHING')) anomalies.push('info: FINISHING não chegou ao SSE público (coalescido pelo throttle de 2s — desenho)')
    if (!seqB.includes('PREPARING')) anomalies.push(`info: PREPARING não chegou ao SSE público (${kind}) — coalescido pelo throttle: sequência ${seqB.join('>')}`)
    metrics['B_eventos_chargepoint_status_conector1'] = seqB.length
    checks['todos_os_eventos_publicos_de_B_com_occurredAt_ISO'] = publicEvents.every((e) => !Number.isNaN(Date.parse(e.data.occurredAt as string)))
    mark('sequência SSE de B (conector 1)', 0)
    timeline.push(...seqB.map((s, i) => ({ label: `B[${i}] ${s}`, tMs: publicEvents.filter((e) => e.data.connectorId === 1)[i].at - tStart })))

    // ---- 4. carregador CAI (socket cortado, sem StopTransaction) ------------
    const tDrop = wallNow()
    await sim.dropConnection()
    const offline = await poller.waitFor((s) => !s.online && s.free === 0, tDrop, 20_000, 'carregador offline e 0 livres')
    metrics['9a_queda_ate_sites_offline_ms'] = offline.at - tDrop
    const eBDrop = await sseB.waitFor((e) => e.type === 'chargepoint.status', tDrop, 6_000, 'algum chargepoint.status após a queda').catch(() => undefined)
    if (eBDrop) metrics['9b_queda_ate_primeiro_evento_sse_B_ms'] = eBDrop.at - tDrop
    else anomalies.push('queda: nenhum chargepoint.status chegou ao SSE de B em 6s depois da queda (esperado ao menos 1)')
    // a queda repete o status persistido (AVAILABLE) — o cliente só sabe que "algo mudou" e refaz o fetch
    checks['queda_todos_conectores_nao_livres'] = offline.connectors.every((c) => !c.isFree)
    checks['queda_nao_altera_connector_status_persistido'] = offline.connectors.every((c) => c.status === 'AVAILABLE')

    // ---- 5. reconecta (só o socket, sem BootNotification) -------------------
    const tReconnect = wallNow()
    await sim.connect({ boot: false })
    const back = await poller.waitFor((s) => s.online && s.free === 2, tReconnect, 20_000, 'online de novo com 2/2 livres')
    metrics['10a_reconexao_ate_sites_online_2de2_ms'] = back.at - tReconnect
    const eBBack = await sseB.waitFor((e) => e.type === 'chargepoint.status', tReconnect, 6_000, 'algum chargepoint.status após a reconexão').catch(() => undefined)
    if (eBBack) metrics['10b_reconexao_ate_evento_sse_B_ms'] = eBBack.at - tReconnect
    else anomalies.push('reconexão: nenhum chargepoint.status no SSE de B em 6s')

    await sleep(600)
    const tail = sseB.events.filter((e) => e.type === 'chargepoint.status')
    const total = tail.length
    metrics['B_total_eventos_chargepoint_status'] = total
    const perKey = new Map<string, number>()
    for (const e of tail) perKey.set(`${e.data.connectorId}:${e.data.status}@${Math.round(e.at / 100)}`, (perKey.get(`${e.data.connectorId}:${e.data.status}@${Math.round(e.at / 100)}`) ?? 0) + 1)
    if ([...perKey.values()].some((n) => n > 1)) anomalies.push('evento duplicado no mesmo décimo de segundo no SSE de B')
    checks['B_continua_sem_evento_privado_apos_queda_e_reconexao'] = !sseB.events.some((e) => PRIVATE_TYPES.has(e.type))
  } catch (err) {
    // Diagnóstico: o que cada lado viu até o erro.
    const rel = (t: number) => Math.round(t % 100_000)
    console.error(`
[diagnóstico ${kind}#${index}] SSE B:`, sseB.events.map((e) => `${rel(e.at)} ${e.type} ${e.data.connectorId ?? ''} ${e.data.status ?? ''}`))
    console.error(`[diagnóstico ${kind}#${index}] SSE A:`, sseA.events.map((e) => `${rel(e.at)} ${e.type} ${e.data.connectorId ?? ''} ${e.data.status ?? ''}`))
    console.error(`[diagnóstico ${kind}#${index}] simulador:`, simEvents.map((e) => `${rel(e.at)} ${e.name} ${e.connectorId ?? ''} ${e.status ?? ''}`))
    throw err
  } finally {
    poller.stop()
    sseA.close()
    sseB.close()
    await sim.disconnect().catch(() => undefined)
    await Promise.all([sseA.closed(), sseB.closed()])
  }

  const r: IterationResult = { kind: `${kind}#${index}`, metrics, anomalies, checks, timeline }
  results.push(r)
  return r
}

// ------------------------------------- queda COM recarga em andamento

/** Carregador perde o socket no meio da recarga: o mapa tem que deixar de mostrá-lo como disponível, e ao voltar a recarga segue e ainda pode ser parada pelo app. */
async function runDropInCharge(ctx: Ctx, index: number): Promise<IterationResult> {
  const anomalies: string[] = []
  const checks: Record<string, boolean> = {}
  const metrics: Metrics = {}
  await ensureBalance(ctx.admin, ctx.a, 2500)
  const balanceBefore = await walletBalance(ctx.a)

  const poller = new SitesPoller()
  const sseB = new SseClient('B', `${API_URL}/api/me/events`, ctx.b.token)
  const sseA = new SseClient('A', `${API_URL}/api/me/events`, ctx.a.token)
  await Promise.all([sseB.ready(), sseA.ready()])
  const sim = new ChargerSimulator({ url: OCPP_URL, identity: IDENTITY, password: OCPP_PASSWORD, connectors: 2, meterIntervalMs: 2_000, startDelayMs: 250 })
  try {
    poller.start()
    const t0 = wallNow()
    await sim.connect()
    await poller.waitFor((s) => s.online && s.free === 2, t0, 10_000, 'online 2/2')
    await sleep(5_000)

    const start = await http('POST', '/api/me/sessions/start', { token: ctx.a.token, body: { ocppIdentity: IDENTITY, connectorId: 1 } })
    if (start.status !== 202) throw new Error(`start -> ${start.status} ${JSON.stringify(start.body)}`)
    const started = await sseA.waitFor((e) => e.type === 'session.started', t0, 10_000, 'session.started')
    const sessionId = started.data.sessionId as string
    await poller.waitFor((s) => s.free === 1 && s.connectors.some((c) => c.connectorId === 1 && s.connectors.length > 0 && c.status === 'CHARGING'), t0, 10_000, 'conector 1 CHARGING')
    await sleep(3_000)

    // ---- queda no meio da recarga (sem StopTransaction) --------------------
    const tDrop = wallNow()
    await sim.dropConnection()
    const offline = await poller.waitFor((s) => !s.online, tDrop, 20_000, 'offline com recarga em andamento')
    metrics['12a_queda_em_recarga_ate_sites_offline_ms'] = offline.at - tDrop
    checks['queda_em_recarga_zero_livres'] = offline.free === 0
    checks['queda_em_recarga_conector1_continua_CHARGING_persistido'] = offline.connectors.some((c) => c.connectorId === 1 && c.status === 'CHARGING')
    const active = await http('GET', '/api/me/sessions/active', { token: ctx.a.token })
    checks['queda_em_recarga_sessao_de_A_segue_aberta(sem_mentir_que_parou)'] = active.status === 200 && !!active.body.session && ['STARTED', 'CHARGING'].includes(active.body.session.status)

    // ---- volta só o socket; a transação do carregador continua viva -------
    const tReconnect = wallNow()
    await sim.connect({ boot: false })
    const back = await poller.waitFor((s) => s.online && s.free === 1, tReconnect, 20_000, 'online de novo, conector 1 ainda ocupado')
    metrics['12b_reconexao_em_recarga_ate_sites_online_ms'] = back.at - tReconnect
    await sleep(2_500) // deixa voltar a fluir MeterValues

    // ---- o app ainda consegue parar a recarga e o dinheiro fecha ------------
    const stop = await http('POST', `/api/me/sessions/${sessionId}/stop`, { token: ctx.a.token })
    checks['stop_apos_reconexao_aceito_202'] = stop.status === 202
    const tStop = wallNow()
    const wallet = await sseA.waitFor((e) => e.type === 'wallet.updated', tStop, 15_000, 'wallet.updated após stop pós-reconexão').catch(() => undefined)
    if (wallet) {
      metrics['12c_stop_pos_reconexao_ate_wallet_updated_ms'] = wallet.at - tStop
      checks['debito_apos_queda_e_reconexao_correto(saldo-500)'] = wallet.data.balanceCents === balanceBefore - 500
    } else anomalies.push('stop após queda+reconexão: wallet.updated não chegou em 15s')
    await poller.waitFor((s) => s.online && s.free === 2, tStop, 15_000, 'volta a 2 de 2 livres').catch(() => anomalies.push('stop após queda+reconexão: /api/sites não voltou a 2/2 em 15s'))
    checks['B_sem_evento_privado_na_queda_em_recarga'] = !sseB.events.some((e) => PRIVATE_TYPES.has(e.type))
  } finally {
    poller.stop()
    sseA.close()
    sseB.close()
    await sim.disconnect().catch(() => undefined)
    await Promise.all([sseA.closed(), sseB.closed()])
  }
  const r: IterationResult = { kind: `queda-em-recarga#${index}`, metrics, anomalies, checks, timeline: [] }
  results.push(r)
  return r
}

// ------------------------------------------------- queda SILENCIOSA (proxy)

async function runSilentDrop(ctx: Ctx, index: number): Promise<IterationResult> {
  const anomalies: string[] = []
  const checks: Record<string, boolean> = {}
  const metrics: Metrics = {}
  const proxy = new FreezableProxy()
  const proxyPort = 9100 + index
  const target = new URL(OCPP_URL.replace(/^ws/, 'http'))
  await proxy.listen(proxyPort, target.hostname, Number(target.port || 80))

  const poller = new SitesPoller()
  const sseB = new SseClient('B', `${API_URL}/api/me/events`, ctx.b.token)
  await sseB.ready()
  const sim = new ChargerSimulator({ url: `ws://127.0.0.1:${proxyPort}${target.pathname}`, identity: IDENTITY, password: OCPP_PASSWORD, connectors: 2 })
  try {
    poller.start()
    const t0 = wallNow()
    await sim.connect()
    await poller.waitFor((s) => s.online && s.free === 2, t0, 10_000, 'online 2/2')
    await sleep(1_500)

    const tFreeze = wallNow()
    proxy.freeze() // a partir daqui NADA passa; nenhum FIN/RST chega ao gateway
    const offline = await poller.waitFor((s) => !s.online, tFreeze, 130_000, 'carregador marcado offline (queda silenciosa)')
    metrics['11a_queda_silenciosa_ate_sites_offline_ms'] = offline.at - tFreeze
    // O evento da queda sai quando o gateway FECHA o socket (mesmo instante em que o REST vira offline); eventos anteriores são resíduo do Boot (throttle).
    const eB = sseB.find((e) => e.type === 'chargepoint.status' && e.at >= offline.at - 1_500)
    if (eB) metrics['11b_queda_silenciosa_ate_evento_sse_B_ms'] = eB.at - tFreeze
    else anomalies.push('queda silenciosa: nenhum chargepoint.status chegou ao SSE de B junto com a queda')
    checks['queda_silenciosa_conectores_nao_livres'] = offline.connectors.every((c) => !c.isFree)
  } finally {
    poller.stop()
    sseB.close()
    await sim.dropConnection().catch(() => undefined)
    await proxy.shutdown()
    await sseB.closed()
  }
  const r: IterationResult = { kind: `queda-silenciosa#${index}`, metrics, anomalies, checks, timeline: [] }
  results.push(r)
  return r
}

// ----------------------------------------------------------------- relatório

function report(): void {
  const keys = new Set<string>()
  for (const r of results) for (const k of Object.keys(r.metrics)) keys.add(k)
  console.log('\n=== LATÊNCIAS (ms) — min / mediana / máx (n) ===')
  for (const k of [...keys].sort()) {
    const s = stats(results.map((r) => r.metrics[k]).filter((v) => typeof v === 'number'))
    if (!s) continue
    console.log(`${k.padEnd(62)} ${s.min.toFixed(0).padStart(7)} ${s.median.toFixed(0).padStart(7)} ${s.max.toFixed(0).padStart(7)}   (n=${s.n})`)
  }
  console.log('\n=== VERIFICAÇÕES (todas as rodadas) ===')
  const names = new Set<string>()
  for (const r of results) for (const k of Object.keys(r.checks)) names.add(k)
  for (const n of [...names].sort()) {
    const all = results.filter((r) => n in r.checks)
    const ok = all.filter((r) => r.checks[n]).length
    console.log(`${ok === all.length ? 'OK  ' : 'FALHA'} ${n} (${ok}/${all.length})`)
  }
  console.log('\n=== ANOMALIAS ===')
  const anomalies = results.flatMap((r) => r.anomalies.map((a) => `${r.kind}: ${a}`))
  if (anomalies.length === 0) console.log('(nenhuma)')
  for (const a of anomalies) console.log(`- ${a}`)
}

async function main(): Promise<void> {
  assertLocalOnly()
  if (!OCPP_PASSWORD) {
    console.error('Defina OCPP_PASSWORD (senha do carregador no ambiente LOCAL; no seed: changeme-basic-auth-secret).')
    process.exit(2)
  }
  const argv = process.argv.slice(2)
  const arg = (name: string, dflt: number) => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 ? Number(argv[i + 1]) : dflt
  }
  const outIdx = argv.indexOf('--out')
  const iterations = arg('iterations', 5)
  const immediate = arg('immediate', 3)
  const silent = arg('silent-drop', 1)
  const dropInCharge = arg('drop-in-charge', 1)

  const admin = await adminToken()
  const a = await registerDriver('A')
  const b = await registerDriver('B')
  console.log(`motoristas de teste: A=${a.email} B=${b.email}`)
  const ctx: Ctx = { a, b, admin }

  for (let i = 1; i <= iterations; i++) {
    const r = await runCycle(ctx, 'calmo', i)
    console.log(`\n--- ciclo calmo #${i} ---`)
    for (const [k, v] of Object.entries(r.metrics)) console.log(`  ${k}: ${Math.round(v)}`)
    const failed = Object.entries(r.checks).filter(([, v]) => !v).map(([k]) => k)
    if (failed.length) console.log(`  FALHOU: ${failed.join(', ')}`)
    await sleep(1_000)
  }
  for (let i = 1; i <= immediate; i++) {
    const r = await runCycle(ctx, 'imediato', i)
    console.log(`\n--- ciclo imediato #${i} ---`)
    for (const [k, v] of Object.entries(r.metrics)) console.log(`  ${k}: ${Math.round(v)}`)
    const failed = Object.entries(r.checks).filter(([, v]) => !v).map(([k]) => k)
    if (failed.length) console.log(`  FALHOU: ${failed.join(', ')}`)
    await sleep(1_000)
  }
  for (let i = 1; i <= dropInCharge; i++) {
    const r = await runDropInCharge(ctx, i)
    console.log(`
--- queda em recarga #${i} ---`)
    for (const [k, v] of Object.entries(r.metrics)) console.log(`  ${k}: ${Math.round(v)}`)
    const failed = Object.entries(r.checks).filter(([, v]) => !v).map(([k]) => k)
    if (failed.length) console.log(`  FALHOU: ${failed.join(', ')}`)
    if (r.anomalies.length) console.log(`  anomalias: ${r.anomalies.join(' | ')}`)
    await sleep(1_000)
  }
  for (let i = 1; i <= silent; i++) {
    const r = await runSilentDrop(ctx, i)
    console.log(`\n--- queda silenciosa #${i} ---`)
    for (const [k, v] of Object.entries(r.metrics)) console.log(`  ${k}: ${Math.round(v)}`)
  }

  report()
  if (outIdx >= 0) writeFileSync(argv[outIdx + 1], JSON.stringify(results, null, 2))
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('FALHA NA VERIFICAÇÃO:', err)
      process.exit(1)
    })
}
