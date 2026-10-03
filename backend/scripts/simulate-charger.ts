/**
 * Simulador de CARREGADOR OCPP 1.6-J (Íris, 2026-09-19) — conecta no gateway
 * OCPP do InnoElektron como se fosse um poste de verdade e se comporta como
 * um: anuncia-se, mantém Heartbeat, obedece `RemoteStartTransaction` /
 * `RemoteStopTransaction` e reporta a sequência de status e de medições.
 *
 * Serve para provar, sem hardware, o caminho "motorista aperta Iniciar ->
 * carregador ocupa -> mapa dos outros motoristas atualiza" contra QUALQUER
 * ambiente (local, staging, produção) — com as credenciais de QUEM RODA.
 *
 * ---------------------------------------------------------------------------
 * COMO RODAR (a partir de `backend/`)
 * ---------------------------------------------------------------------------
 *
 *   # local (gateway em `npm run dev:ocpp`, seed aplicado):
 *   OCPP_PASSWORD=changeme-basic-auth-secret \
 *     npx tsx scripts/simulate-charger.ts --identity CP-INNOELEKTRON-001
 *
 *   # outro ambiente (a senha é a do carregador CADASTRADO NAQUELE ambiente):
 *   OCPP_PASSWORD='***' npx tsx scripts/simulate-charger.ts \
 *     --url wss://ocpp.seu-dominio.com.br/ocpp --identity CP-DE-TESTE-01
 *
 * Opções (todas opcionais, exceto a senha por ENV):
 *   --url <ws[s]://host[:porta]/ocpp>  base do gateway, SEM a identidade   (padrão ws://localhost:9000/ocpp)
 *   --identity <ocppIdentity>          identidade cadastrada do carregador  (padrão CP-INNOELEKTRON-001)
 *   --connectors <n>                   quantos conectores simular (1..n)    (padrão 2)
 *   --heartbeat-s <s>                  força o intervalo de Heartbeat       (padrão: o que o servidor manda no Boot)
 *   --meter-interval-s <s>             intervalo dos MeterValues em sessão  (padrão 5)
 *   --power-kw <kW>                    potência simulada durante a recarga  (padrão 7)
 *   --start-delay-ms <ms>              atraso entre aceitar o RemoteStart e abrir a transação (padrão 300)
 *   --no-auto-reconnect                não reconectar sozinho se o socket cair
 *   --verbose                          loga também cada mensagem OCPP enviada/recebida
 *   --help                             lista tudo, inclusive os comportamentos de falha abaixo
 *
 * COMPORTAMENTOS DE FALHA (F5.9 — sessão travada). Todos desligados por padrão; cada flag é INDEPENDENTE das outras (os únicos pares
 * proibidos são os contraditórios: as duas queda-com-fila, e rejeitar+aceitar o stop). Reproduzem os cenários S1-S6 do desenho:
 *   --reject-stop-keep-charging        (S2) responde `Rejected` ao RemoteStopTransaction e SEGUE entregando energia/MeterValues (carregador que desobedece)
 *   --accept-stop-keep-charging        (S2/R3) responde `Accepted` ao RemoteStopTransaction mas NUNCA manda o StopTransaction e segue entregando
 *   --silent-after-start               (S3) abre a transação, manda UM MeterValues e fica mudo: o socket e o Heartbeat seguem vivos, mas não manda mais
 *                                      MeterValues nem StatusNotification e responde `NotImplemented` ao TriggerMessage. RemoteStop continua funcionando.
 *   --offline-queue                    (S4) depois de --incident-after-s do início da carga o socket CAI sem close frame; o poste segue medindo e ENFILEIRA
 *                                      os MeterValues; passado --offline-for-s a recarga termina localmente (StopTransaction enfileirado com a leitura real)
 *                                      e o poste RECONECTA SEM BootNotification, despejando a fila em ordem (rede que voltou, firmware que não reiniciou)
 *   --reboot-with-queued-stop          (S1) igual, mas é QUEDA DE ENERGIA: nada é medido offline, e ao voltar o poste manda BootNotification e SÓ DEPOIS
 *                                      o StopTransaction enfileirado (meterStop real, timestamp do instante da queda). É a ordem que o OCPP 1.6 permite
 *   --no-meter-values                  (S5) nunca manda MeterValues (equivale a MeterValueSampleInterval=0) e responde `NotImplemented` ao TriggerMessage
 *                                      => sessão sem NENHUMA amostra. O StopTransaction (se houver) sai normal, com meterStop = meterStart
 *   --fault-mid-session                (S6) --incident-after-s depois do início da carga manda StatusNotification(Faulted, GroundFailure) e PARA os MeterValues;
 *                                      a transação continua aberta no poste
 *   --incident-after-s <s>             quando o incidente dispara depois do início da carga (offline-queue, reboot-with-queued-stop, fault-mid-session) (padrão 20)
 *   --offline-for-s <s>                quanto tempo o poste fica fora do ar nas duas flags de queda (padrão 60)
 *   --fault-recover-after-s <s>        com --fault-mid-session: depois disto volta a `Charging` e retoma os MeterValues (sem isso fica Faulted até o RemoteStop)
 * O TriggerMessage(MeterValues) é atendido (Accepted + um MeterValues extra) em todos os modos, exceto --silent-after-start e --no-meter-values.
 *
 * A SENHA vem SÓ de `OCPP_PASSWORD` (nunca por argumento: argumento vai para o
 * histórico do shell e para a lista de processos). Este script NÃO cria conta,
 * NÃO conhece nenhuma senha de usuário e só fala OCPP — quem inicia a recarga
 * é o app/API real (`POST /api/me/sessions/start`), como no uso de verdade.
 *
 * O que ele faz, na ordem:
 *   1. conecta com Basic Auth; BootNotification;
 *   2. StatusNotification(Available) do carregador (connectorId 0) e de cada conector;
 *   3. Heartbeat periódico;
 *   4. RemoteStartTransaction -> responde Accepted (ou Rejected se o conector
 *      não está livre) e, em seguida: Preparing -> StartTransaction(idTag do
 *      pedido) -> Charging -> MeterValues periódicos (energia crescente,
 *      potência, SoC);
 *   5. RemoteStopTransaction -> responde Accepted e: Finishing ->
 *      StopTransaction -> Available.
 *   Ctrl+C encerra (sem fechar transação aberta — igual a um poste que perde a
 *   energia; a API reconcilia a sessão órfã no próximo BootNotification).
 *
 * Também é uma BIBLIOTECA: `import { ChargerSimulator } from './simulate-charger'`
 * (é o que `scripts/verify-realtime-stations.ts` usa para medir latências).
 */
import { EventEmitter } from 'node:events'
import { performance } from 'node:perf_hooks'
import { RPCClient } from 'ocpp-rpc'

/** Relógio de parede em ms com fração — comparável ao `occurredAt` (ISO) que o servidor carimba. */
export function wallNow(): number {
  return performance.timeOrigin + performance.now()
}

export interface SimulatorOptions {
  /** Base do gateway SEM a identidade, ex. `ws://localhost:9000/ocpp`. */
  url: string
  identity: string
  password: string
  connectors?: number
  heartbeatSeconds?: number
  meterIntervalMs?: number
  powerW?: number
  startDelayMs?: number
  autoReconnect?: boolean
  vendor?: string
  model?: string
  behavior?: SimulatorBehavior
}

/** Comportamentos de falha (F5.9). Tudo opcional/desligado; ver o cabeçalho do arquivo para o que cada um faz. */
export interface SimulatorBehavior {
  rejectStopKeepCharging?: boolean
  acceptStopKeepCharging?: boolean
  silentAfterStart?: boolean
  offlineQueue?: boolean
  rebootWithQueuedStop?: boolean
  noMeterValues?: boolean
  faultMidSession?: boolean
  /** ms depois do início da carga em que o incidente dispara (offline-queue / reboot-with-queued-stop / fault-mid-session). Padrão 20 000. */
  incidentAfterMs?: number
  /** ms que o poste fica fora do ar nas flags de queda. Padrão 60 000. */
  offlineForMs?: number
  /** com fault-mid-session: ms até voltar a Charging. Ausente = fica Faulted. */
  faultRecoverAfterMs?: number
}

/** Mensagem que o poste não conseguiu enviar (offline) e despeja ao voltar. */
interface QueuedMessage {
  method: string
  params: Record<string, unknown>
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export interface SimulatorEvent {
  /** `wallNow()` no instante do fato (lado do simulador). */
  at: number
  name: string
  [key: string]: unknown
}

type ConnectorState = {
  status: string
  tx?: { id: number; idTag: string; meterStartWh: number; meterWh: number; timer?: NodeJS.Timeout; incidentTimer?: NodeJS.Timeout }
}

export class ChargerSimulator extends EventEmitter {
  private client?: RPCClient
  private readonly connectors = new Map<number, ConnectorState>()
  private heartbeatTimer?: NodeJS.Timeout
  private heartbeatSeconds = 60
  private opened = false
  private readonly opts: Required<Omit<SimulatorOptions, 'heartbeatSeconds' | 'behavior'>> & { heartbeatSeconds?: number }
  private readonly behavior: Required<Pick<SimulatorBehavior, 'incidentAfterMs' | 'offlineForMs'>> & SimulatorBehavior
  /** Fila do poste offline (flags de queda). Despejada em ordem ao reconectar. */
  private readonly queue: QueuedMessage[] = []
  /** `true` enquanto o poste está "sem rede" por incidente: MeterValues viram fila em vez de serem descartados. */
  private queueing = false

  constructor(options: SimulatorOptions) {
    super()
    const behavior = options.behavior ?? {}
    if (behavior.offlineQueue && behavior.rebootWithQueuedStop) throw new Error('--offline-queue e --reboot-with-queued-stop são contraditórios (reconecta com ou sem Boot?): use um só')
    if (behavior.rejectStopKeepCharging && behavior.acceptStopKeepCharging) throw new Error('--reject-stop-keep-charging e --accept-stop-keep-charging são contraditórios: use um só')
    this.behavior = { incidentAfterMs: 20_000, offlineForMs: 60_000, ...behavior }
    this.opts = {
      connectors: 2,
      meterIntervalMs: 5_000,
      powerW: 7_000,
      startDelayMs: 300,
      autoReconnect: false,
      vendor: 'InnoElektron',
      model: 'Simulador OCPP',
      // `undefined` explícito (opção CLI não informada) NÃO pode apagar o padrão acima.
      ...(Object.fromEntries(Object.entries(options).filter(([k, v]) => v !== undefined && k !== 'behavior')) as SimulatorOptions),
    }
    for (let id = 1; id <= this.opts.connectors; id++) this.connectors.set(id, { status: 'Available' })
  }

  private note(name: string, data: Record<string, unknown> = {}): void {
    const event: SimulatorEvent = { at: wallNow(), name, ...data }
    this.emit('evt', event)
  }

  get isConnected(): boolean {
    return this.client?.state === 1 // OPEN
  }

  connectorStatus(connectorId: number): string | undefined {
    return this.connectors.get(connectorId)?.status
  }

  /** `boot: false` = só reconectou o socket (sem reiniciar) — não manda BootNotification, só reanuncia os status. */
  async connect(opts: { boot?: boolean } = {}): Promise<void> {
    const boot = opts.boot ?? true
    const client = new RPCClient({
      endpoint: this.opts.url,
      identity: this.opts.identity,
      password: this.opts.password,
      protocols: ['ocpp1.6'],
      reconnect: this.opts.autoReconnect,
      backoff: { initialDelay: 1000, maxDelay: 10_000, factor: 2, randomisationFactor: 0.25 },
      // O tipo do ocpp-rpc exige TODAS as opções; só passamos as que importam (o resto tem default).
    } as unknown as ConstructorParameters<typeof RPCClient>[0])
    this.client = client
    this.opened = false

    client.handle('RemoteStartTransaction', async ({ params }) => this.onRemoteStart(params as { connectorId?: number; idTag: string }))
    client.handle('RemoteStopTransaction', async ({ params }) => this.onRemoteStop(params as { transactionId: number }))
    client.handle('TriggerMessage', async ({ params }) => this.onTriggerMessage(params as { requestedMessage: string; connectorId?: number }))
    client.handle('Reset', async () => ({ status: 'Accepted' }))
    client.handle('ChangeAvailability', async () => ({ status: 'Accepted' }))
    client.handle('UnlockConnector', async () => ({ status: 'NotSupported' }))

    client.on('close', ({ code, reason }: { code: number; reason: string }) => {
      this.stopHeartbeat()
      this.note('socket-closed', { code, reason })
    })
    // Reconexão AUTOMÁTICA (só com autoReconnect): reanuncia sem BootNotification.
    client.on('open', () => {
      if (!this.opened) return
      this.note('socket-reopened')
      void this.announce(false).catch((err) => this.note('announce-failed', { error: String(err) }))
    })

    this.note('connecting', { identity: this.opts.identity })
    await client.connect()
    this.opened = true
    this.note('socket-open')
    await this.announce(boot)
  }

  /** Corta o socket SEM close frame (`terminate`) e sem StopTransaction — poste que perdeu a rede/energia. Não reconecta (a menos que `autoReconnect`). */
  async dropConnection(): Promise<void> {
    this.note('dropping-socket')
    this.stopHeartbeat()
    await this.client?.close({ force: true })
  }

  /** Encerra de forma limpa (close frame). Não mexe em transação aberta. */
  async disconnect(): Promise<void> {
    this.stopHeartbeat()
    for (const c of this.connectors.values()) {
      if (c.tx?.timer) clearInterval(c.tx.timer)
      if (c.tx?.incidentTimer) clearTimeout(c.tx.incidentTimer)
    }
    await this.client?.close({ awaitPending: false }).catch(() => undefined)
  }

  // ---------------------------------------------------------------- envio

  private async call<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    const started = wallNow()
    this.emit('ocpp', { dir: 'out', method, params, at: started })
    const result = (await this.client!.call(method, params)) as T
    this.emit('ocpp', { dir: 'in-reply', method, result, at: wallNow() })
    return result
  }

  private async sendStatus(connectorId: number, status: string, errorCode = 'NoError'): Promise<void> {
    if (connectorId > 0) {
      const state = this.connectors.get(connectorId)
      if (state) state.status = status
    }
    const at = wallNow()
    await this.call('StatusNotification', { connectorId, errorCode, status, timestamp: new Date().toISOString() })
    this.note('status-sent', { connectorId, status, sentAt: at })
  }

  private async announce(boot: boolean): Promise<void> {
    if (boot) {
      const res = await this.call<{ status: string; interval: number }>('BootNotification', {
        chargePointVendor: this.opts.vendor,
        chargePointModel: this.opts.model,
        firmwareVersion: 'sim-1.0',
      })
      this.note('boot-accepted', { status: res.status, interval: res.interval })
      if (res.interval > 0) this.heartbeatSeconds = res.interval
    }
    // OCPP 1.6: o que o poste enfileirou offline sai DEPOIS do Boot (se houve) e ANTES de reanunciar os status.
    await this.flushQueue()
    await this.sendStatus(0, 'Available')
    for (const [id, state] of this.connectors) await this.sendStatus(id, state.status === 'Charging' && !state.tx ? 'Available' : state.status)
    this.startHeartbeat()
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    const seconds = this.opts.heartbeatSeconds ?? this.heartbeatSeconds
    // Um Heartbeat de cara (prova de vida) e depois no intervalo combinado.
    const beat = () =>
      void this.call('Heartbeat', {})
        .then(() => this.note('heartbeat'))
        .catch((err) => this.note('heartbeat-failed', { error: String(err) }))
    beat()
    this.heartbeatTimer = setInterval(beat, seconds * 1000)
    this.heartbeatTimer.unref?.()
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
  }

  // ------------------------------------------------- comandos do servidor

  private onRemoteStart(params: { connectorId?: number; idTag: string }): { status: 'Accepted' | 'Rejected' } {
    const receivedAt = wallNow()
    this.note('remote-start-received', { params, receivedAt })
    const connectorId = params.connectorId ?? [...this.connectors.entries()].find(([, s]) => s.status === 'Available')?.[0]
    const state = connectorId !== undefined ? this.connectors.get(connectorId) : undefined
    if (!state || state.status !== 'Available' || state.tx) {
      this.note('remote-start-rejected', { connectorId, status: state?.status })
      return { status: 'Rejected' }
    }
    // Reserva o conector JÁ (uma 2ª ordem concorrente não pode passar) e abre a transação logo depois da resposta.
    state.status = 'Preparing'
    setTimeout(() => void this.runStartFlow(connectorId!, params.idTag).catch((err) => this.note('start-flow-failed', { error: String(err) })), this.opts.startDelayMs)
    this.note('remote-start-accepted', { connectorId })
    return { status: 'Accepted' }
  }

  private async runStartFlow(connectorId: number, idTag: string): Promise<void> {
    const state = this.connectors.get(connectorId)!
    await this.sendStatus(connectorId, 'Preparing')
    const meterStartWh = 1_000
    const start = await this.call<{ transactionId: number; idTagInfo: { status: string } }>('StartTransaction', {
      connectorId,
      idTag,
      meterStart: meterStartWh,
      timestamp: new Date().toISOString(),
    })
    this.note('start-transaction-replied', { connectorId, transactionId: start.transactionId, idTagStatus: start.idTagInfo.status })

    if (start.idTagInfo.status !== 'Accepted' || start.transactionId === 0) {
      await this.sendStatus(connectorId, 'Available')
      return
    }

    state.tx = { id: start.transactionId, idTag, meterStartWh, meterWh: meterStartWh }
    await this.sendStatus(connectorId, 'Charging')
    await this.sendMeterValues(connectorId)
    // --silent-after-start: UM MeterValues e depois mudo (o timer periódico nem nasce). --no-meter-values é barrado dentro de sendMeterValues.
    this.startMeterTimer(connectorId)
    this.scheduleIncident(connectorId)
  }

  private startMeterTimer(connectorId: number): void {
    const tx = this.connectors.get(connectorId)?.tx
    if (!tx || this.behavior.silentAfterStart || this.behavior.noMeterValues) return
    if (tx.timer) clearInterval(tx.timer)
    const timer = setInterval(() => void this.sendMeterValues(connectorId).catch((err) => this.note('meter-failed', { error: String(err) })), this.opts.meterIntervalMs)
    timer.unref?.()
    tx.timer = timer
  }

  // ------------------------------------------------- incidentes (F5.9)

  private scheduleIncident(connectorId: number): void {
    const tx = this.connectors.get(connectorId)?.tx
    if (!tx) return
    const { offlineQueue, rebootWithQueuedStop, faultMidSession, incidentAfterMs } = this.behavior
    if (!offlineQueue && !rebootWithQueuedStop && !faultMidSession) return
    const timer = setTimeout(() => {
      const run = faultMidSession ? this.runFaultIncident(connectorId) : this.runOfflineIncident(connectorId, rebootWithQueuedStop === true)
      void run.catch((err) => this.note('incident-failed', { error: String(err) }))
    }, incidentAfterMs)
    timer.unref?.()
    tx.incidentTimer = timer
  }

  /** --fault-mid-session: Faulted + para de medir; a transação segue aberta no poste. Com `faultRecoverAfterMs`, volta a Charging e retoma. */
  private async runFaultIncident(connectorId: number): Promise<void> {
    const tx = this.connectors.get(connectorId)?.tx
    if (!tx) return
    if (tx.timer) clearInterval(tx.timer)
    tx.timer = undefined
    this.note('incident-fault', { connectorId, transactionId: tx.id })
    await this.sendStatus(connectorId, 'Faulted', 'GroundFailure')
    const recoverAfter = this.behavior.faultRecoverAfterMs
    if (recoverAfter === undefined) return
    await sleep(recoverAfter)
    if (this.connectors.get(connectorId)?.tx !== tx) return // um RemoteStop encerrou nesse meio-tempo
    await this.sendStatus(connectorId, 'Charging')
    this.note('incident-fault-recovered', { connectorId, transactionId: tx.id })
    this.startMeterTimer(connectorId)
  }

  /**
   * --offline-queue / --reboot-with-queued-stop: o poste perde a conexão no meio da recarga, a recarga termina LOCALMENTE e o
   * StopTransaction (com o meterStop real) fica na fila. `reboot` = queda de energia (nada medido offline, volta com BootNotification
   * e o Stop sai depois dele, timestamp = instante da queda); sem `reboot` = só a rede caiu (segue medindo e enfileirando MeterValues,
   * volta sem Boot).
   */
  private async runOfflineIncident(connectorId: number, reboot: boolean): Promise<void> {
    const state = this.connectors.get(connectorId)
    const tx = state?.tx
    if (!state || !tx) return
    const droppedAt = new Date().toISOString()
    this.note('incident-offline', { connectorId, transactionId: tx.id, reboot })
    if (reboot && tx.timer) {
      clearInterval(tx.timer) // sem energia, nada é medido
      tx.timer = undefined
    }
    this.queueing = !reboot
    await this.dropConnection()

    await sleep(this.behavior.offlineForMs)

    // A recarga acaba localmente: para de medir e enfileira o fim, na ordem em que um firmware real o faria.
    if (tx.timer) clearInterval(tx.timer)
    tx.timer = undefined
    const stoppedAt = reboot ? droppedAt : new Date().toISOString()
    this.queue.push(
      { method: 'StatusNotification', params: { connectorId, errorCode: 'NoError', status: 'Finishing', timestamp: stoppedAt } },
      { method: 'StopTransaction', params: { transactionId: tx.id, idTag: tx.idTag, meterStop: tx.meterWh, timestamp: stoppedAt, reason: reboot ? 'PowerLoss' : 'Other' } },
    )
    state.tx = undefined
    state.status = 'Available'
    this.queueing = false
    this.note('incident-reconnecting', { connectorId, transactionId: tx.id, queued: this.queue.length, boot: reboot })
    await this.connect({ boot: reboot })
  }

  /** Despeja a fila em ordem. Se uma chamada falhar, o resto fica para a próxima reconexão. */
  private async flushQueue(): Promise<void> {
    while (this.queue.length > 0 && this.isConnected) {
      const next = this.queue[0]
      await this.call(next.method, next.params)
      this.queue.shift()
      this.note('queued-message-flushed', { method: next.method, ...(next.method === 'StopTransaction' ? { meterStop: next.params.meterStop } : {}) })
    }
  }

  private onTriggerMessage(params: { requestedMessage: string; connectorId?: number }): { status: 'Accepted' | 'NotImplemented' | 'Rejected' } {
    this.note('trigger-message-received', { params })
    if (params.requestedMessage !== 'MeterValues') return { status: 'NotImplemented' }
    // Poste mudo/sem amostragem: não sabe atender (é o que torna a sessão uma "sessão sem leitura" de verdade).
    if (this.behavior.silentAfterStart || this.behavior.noMeterValues) return { status: 'NotImplemented' }
    const entry = [...this.connectors.entries()].find(([id, s]) => s.tx && (params.connectorId === undefined || params.connectorId === id))
    if (!entry) return { status: 'Rejected' }
    setTimeout(() => void this.sendMeterValues(entry[0], { advance: false, context: 'Trigger' }).catch((err) => this.note('meter-failed', { error: String(err) })), 50)
    return { status: 'Accepted' }
  }

  private async sendMeterValues(connectorId: number, opts: { advance?: boolean; context?: string } = {}): Promise<void> {
    const tx = this.connectors.get(connectorId)?.tx
    if (!tx) return
    if (this.behavior.noMeterValues) return // MeterValueSampleInterval=0: este poste nunca amostra
    if (!this.isConnected && !this.queueing) return
    if (opts.advance ?? true) tx.meterWh += Math.round((this.opts.powerW * this.opts.meterIntervalMs) / 3_600_000)
    const context = opts.context ?? 'Sample.Periodic'
    const params = {
      connectorId,
      transactionId: tx.id,
      meterValue: [
        {
          timestamp: new Date().toISOString(),
          sampledValue: [
            { value: String(tx.meterWh), measurand: 'Energy.Active.Import.Register', unit: 'Wh', context },
            { value: String(this.opts.powerW), measurand: 'Power.Active.Import', unit: 'W', context },
            { value: String(Math.min(99, 20 + Math.round((tx.meterWh - tx.meterStartWh) / 10))), measurand: 'SoC', unit: 'Percent', context },
          ],
        },
      ],
    }
    if (!this.isConnected) {
      // Sem rede (--offline-queue): mede e guarda, com o timestamp de quando foi medido.
      this.queue.push({ method: 'MeterValues', params })
      this.note('meter-values-queued', { connectorId, transactionId: tx.id, meterWh: tx.meterWh })
      return
    }
    const at = wallNow()
    await this.call('MeterValues', params)
    this.note('meter-values-sent', { connectorId, transactionId: tx.id, meterWh: tx.meterWh, sentAt: at })
  }

  private onRemoteStop(params: { transactionId: number }): { status: 'Accepted' | 'Rejected' } {
    const receivedAt = wallNow()
    this.note('remote-stop-received', { params, receivedAt })
    const entry = [...this.connectors.entries()].find(([, s]) => s.tx?.id === params.transactionId)
    if (!entry) {
      this.note('remote-stop-rejected', { transactionId: params.transactionId })
      return { status: 'Rejected' }
    }
    const [connectorId] = entry
    // F5.9 — carregador que desobedece: segue entregando, sem StopTransaction.
    if (this.behavior.rejectStopKeepCharging) {
      this.note('remote-stop-rejected-keep-charging', { transactionId: params.transactionId })
      return { status: 'Rejected' }
    }
    if (this.behavior.acceptStopKeepCharging) {
      this.note('remote-stop-accepted-ignored', { transactionId: params.transactionId })
      return { status: 'Accepted' }
    }
    setTimeout(() => void this.runStopFlow(connectorId, 'Remote').catch((err) => this.note('stop-flow-failed', { error: String(err) })), this.opts.startDelayMs)
    return { status: 'Accepted' }
  }

  private async runStopFlow(connectorId: number, reason: string): Promise<void> {
    const state = this.connectors.get(connectorId)!
    const tx = state.tx
    if (!tx) return
    if (tx.timer) clearInterval(tx.timer)
    if (tx.incidentTimer) clearTimeout(tx.incidentTimer)
    await this.sendStatus(connectorId, 'Finishing')
    const sentAt = wallNow()
    await this.call('StopTransaction', { transactionId: tx.id, idTag: tx.idTag, meterStop: tx.meterWh, timestamp: new Date().toISOString(), reason })
    this.note('stop-transaction-sent', { connectorId, transactionId: tx.id, meterStop: tx.meterWh, sentAt })
    state.tx = undefined
    await this.sendStatus(connectorId, 'Available')
  }
}

// ===========================================================================
// CLI
// ===========================================================================

function parseArgs(argv: string[]): Map<string, string | true> {
  const args = new Map<string, string | true>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      args.set(key, next)
      i++
    } else {
      args.set(key, true)
    }
  }
  return args
}

const HELP = `Uso: OCPP_PASSWORD=... npx tsx scripts/simulate-charger.ts [opções]

Opções gerais:
  --url <ws[s]://host[:porta]/ocpp>   base do gateway, SEM a identidade        (padrão ws://localhost:9000/ocpp)
  --identity <ocppIdentity>           identidade cadastrada do carregador       (padrão CP-INNOELEKTRON-001)
  --connectors <n>                    quantos conectores simular                (padrão 2)
  --heartbeat-s <s>                   força o intervalo de Heartbeat            (padrão: o do BootNotification.conf)
  --meter-interval-s <s>              intervalo dos MeterValues em sessão       (padrão 5)
  --power-kw <kW>                     potência simulada                         (padrão 7)
  --start-delay-ms <ms>               atraso entre aceitar o RemoteStart e abrir a transação (padrão 300)
  --no-auto-reconnect                 não reconectar sozinho se o socket cair
  --verbose                           loga cada mensagem OCPP
  --help

Comportamentos de falha (F5.9 — sessão travada; desligados por padrão, cada um independente):
  --reject-stop-keep-charging         RemoteStopTransaction => Rejected, e o poste SEGUE entregando (carregador que desobedece)
  --accept-stop-keep-charging         RemoteStopTransaction => Accepted, mas NUNCA manda o StopTransaction e segue entregando
  --silent-after-start                abre a transação, manda UM MeterValues e fica mudo (socket e Heartbeat vivos; sem MeterValues/Status;
                                      TriggerMessage => NotImplemented; RemoteStop continua funcionando)
  --offline-queue                     o socket cai sem close frame; o poste segue medindo e enfileira; a recarga acaba localmente e ele
                                      reconecta SEM BootNotification despejando a fila (MeterValues, Finishing, StopTransaction)
  --reboot-with-queued-stop           queda de energia: nada medido offline; volta com BootNotification e SÓ DEPOIS manda o StopTransaction
                                      enfileirado (meterStop real, timestamp do instante da queda)
  --no-meter-values                   nunca manda MeterValues (intervalo 0) e responde NotImplemented ao TriggerMessage => sessão sem nenhuma amostra
  --fault-mid-session                 StatusNotification(Faulted/GroundFailure) e PARA os MeterValues; a transação segue aberta
  --incident-after-s <s>              atraso do incidente depois do início da carga (offline-queue, reboot-with-queued-stop, fault-mid-session) (padrão 20)
  --offline-for-s <s>                 tempo fora do ar nas duas flags de queda                                                      (padrão 60)
  --fault-recover-after-s <s>         com --fault-mid-session: volta a Charging e retoma os MeterValues depois disto (padrão: fica Faulted)

A senha vem SÓ de OCPP_PASSWORD. Detalhes no cabeçalho do arquivo.`

function stamp(): string {
  return new Date().toISOString().slice(11, 23)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.has('help')) {
    console.log(HELP)
    return
  }
  const password = process.env.OCPP_PASSWORD
  if (!password) {
    console.error('Defina a senha do carregador em OCPP_PASSWORD (ex.: OCPP_PASSWORD=... npx tsx scripts/simulate-charger.ts). Nunca por argumento.')
    process.exit(2)
  }

  const num = (key: string): number | undefined => (typeof args.get(key) === 'string' ? Number(args.get(key)) : undefined)
  const sim = new ChargerSimulator({
    url: (args.get('url') as string | undefined) ?? 'ws://localhost:9000/ocpp',
    identity: (args.get('identity') as string | undefined) ?? 'CP-INNOELEKTRON-001',
    password,
    connectors: num('connectors'),
    heartbeatSeconds: num('heartbeat-s'),
    meterIntervalMs: num('meter-interval-s') !== undefined ? num('meter-interval-s')! * 1000 : undefined,
    powerW: num('power-kw') !== undefined ? num('power-kw')! * 1000 : undefined,
    startDelayMs: num('start-delay-ms'),
    autoReconnect: !args.has('no-auto-reconnect'),
    behavior: {
      rejectStopKeepCharging: args.has('reject-stop-keep-charging'),
      acceptStopKeepCharging: args.has('accept-stop-keep-charging'),
      silentAfterStart: args.has('silent-after-start'),
      offlineQueue: args.has('offline-queue'),
      rebootWithQueuedStop: args.has('reboot-with-queued-stop'),
      noMeterValues: args.has('no-meter-values'),
      faultMidSession: args.has('fault-mid-session'),
      incidentAfterMs: num('incident-after-s') !== undefined ? num('incident-after-s')! * 1000 : undefined,
      offlineForMs: num('offline-for-s') !== undefined ? num('offline-for-s')! * 1000 : undefined,
      faultRecoverAfterMs: num('fault-recover-after-s') !== undefined ? num('fault-recover-after-s')! * 1000 : undefined,
    },
  })

  sim.on('evt', (e: SimulatorEvent) => {
    const { at: _at, name, ...rest } = e
    console.log(`[${stamp()}] ${name}${Object.keys(rest).length ? ' ' + JSON.stringify(rest) : ''}`)
  })
  if (args.has('verbose')) {
    sim.on('ocpp', (m: { dir: string; method: string; params?: unknown; result?: unknown }) => console.log(`[${stamp()}]   ocpp ${m.dir} ${m.method} ${JSON.stringify(m.params ?? m.result ?? {})}`))
  }

  process.on('SIGINT', () => {
    console.log(`\n[${stamp()}] encerrando…`)
    void sim.disconnect().finally(() => process.exit(0))
  })

  await sim.connect()
  console.log(`[${stamp()}] pronto — aguardando RemoteStartTransaction (inicie uma recarga pelo app/API). Ctrl+C para sair.`)
}

if (require.main === module) {
  main().catch((err) => {
    console.error('falha:', err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
