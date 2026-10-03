import { afterEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import { RPCServer } from 'ocpp-rpc'
import { ChargerSimulator, type SimulatorBehavior } from '../../scripts/simulate-charger'

/**
 * F5.9b0 — os comportamentos de falha do simulador de carregador (`scripts/simulate-charger.ts`), provados contra uma central OCPP
 * de MENTIRA (um `RPCServer` do próprio `ocpp-rpc` que só aceita tudo e grava a sequência de mensagens recebidas). Sem Postgres/Redis.
 * O que cada teste prova é o COMPORTAMENTO OBSERVÁVEL NO FIO (a ordem e o conteúdo das mensagens), que é o que a Íris vai usar no S1-S6.
 * Timers em dezenas de ms: o simulador aceita tudo em ms pela API de biblioteca.
 */

interface Msg {
  method: string
  params: Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  at: number
}

const TX_ID = 777
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function esperarAte(cond: () => boolean, ms = 4000): Promise<void> {
  const limite = Date.now() + ms
  while (!cond()) {
    if (Date.now() > limite) throw new Error('timeout esperando condição')
    await esperar(10)
  }
}

interface Ambiente {
  log: Msg[]
  porMetodo: (m: string) => Msg[]
  central: () => { call: (m: string, p: unknown) => Promise<any> } // eslint-disable-line @typescript-eslint/no-explicit-any
  sim: ChargerSimulator
  iniciarRecarga: () => Promise<void>
  fechar: () => Promise<void>
}

const abertos: Array<() => Promise<void>> = []
afterEach(async () => {
  while (abertos.length) await abertos.pop()!()
})

async function montar(behavior: SimulatorBehavior = {}): Promise<Ambiente> {
  const log: Msg[] = []
  let atual: { call: (m: string, p: unknown) => Promise<any> } | undefined // eslint-disable-line @typescript-eslint/no-explicit-any
  const server = new RPCServer({ protocols: ['ocpp1.6'], strictMode: false })
  server.auth((accept) => accept({}))
  server.on('client', (client) => {
    atual = client
    const grava = (method: string) => client.handle(method, ({ params }) => {
      log.push({ method, params: params as Msg['params'], at: Date.now() })
      return undefined
    })
    client.handle('BootNotification', ({ params }) => {
      log.push({ method: 'BootNotification', params: params as Msg['params'], at: Date.now() })
      return { status: 'Accepted', interval: 300, currentTime: new Date().toISOString() }
    })
    client.handle('StartTransaction', ({ params }) => {
      log.push({ method: 'StartTransaction', params: params as Msg['params'], at: Date.now() })
      return { transactionId: TX_ID, idTagInfo: { status: 'Accepted' } }
    })
    client.handle('Heartbeat', () => {
      log.push({ method: 'Heartbeat', params: {}, at: Date.now() })
      return { currentTime: new Date().toISOString() }
    })
    for (const m of ['StatusNotification', 'MeterValues', 'StopTransaction']) grava(m)
  })
  const http = await server.listen(0, '127.0.0.1')
  const port = (http.address() as AddressInfo).port

  const sim = new ChargerSimulator({
    url: `ws://127.0.0.1:${port}/ocpp`,
    identity: 'CP-SIM-TESTE',
    password: 'x',
    connectors: 1,
    meterIntervalMs: 30,
    powerW: 3_600_000, // 30 ms * 3,6 MW = 30 Wh por amostra: energia visivelmente crescente
    startDelayMs: 5,
    heartbeatSeconds: 0.05,
    autoReconnect: false,
    behavior,
  })
  const fechar = async () => {
    await sim.disconnect()
    await server.close({ force: true })
  }
  abertos.push(fechar)
  await sim.connect()
  return {
    log,
    porMetodo: (m) => log.filter((x) => x.method === m),
    central: () => atual!,
    sim,
    iniciarRecarga: async () => {
      const r = await atual!.call('RemoteStartTransaction', { connectorId: 1, idTag: 'TAG-1' })
      expect(r.status).toBe('Accepted')
      await esperarAte(() => log.some((m) => m.method === 'StartTransaction') && log.some((m) => m.method === 'MeterValues'))
    },
    fechar,
  }
}

const energia = (m: Msg): number => Number(m.params.meterValue[0].sampledValue.find((v: { measurand: string }) => v.measurand === 'Energy.Active.Import.Register').value)

describe('simulador — comportamento padrão (linha de base)', () => {
  it('RemoteStop => Accepted e StopTransaction com a leitura; TriggerMessage(MeterValues) => Accepted + amostra extra com contexto Trigger', async () => {
    const a = await montar()
    await a.iniciarRecarga()
    const trig = await a.central().call('TriggerMessage', { requestedMessage: 'MeterValues', connectorId: 1 })
    expect(trig.status).toBe('Accepted')
    await esperarAte(() => a.porMetodo('MeterValues').some((m) => m.params.meterValue[0].sampledValue[0].context === 'Trigger'))

    const stop = await a.central().call('RemoteStopTransaction', { transactionId: TX_ID })
    expect(stop.status).toBe('Accepted')
    await esperarAte(() => a.porMetodo('StopTransaction').length === 1)
    expect(a.porMetodo('StopTransaction')[0].params).toMatchObject({ transactionId: TX_ID, reason: 'Remote' })
  })
})

describe('--reject-stop-keep-charging / --accept-stop-keep-charging (S2)', () => {
  it('rejeita o RemoteStop e SEGUE entregando: a energia continua subindo e nunca há StopTransaction', async () => {
    const a = await montar({ rejectStopKeepCharging: true })
    await a.iniciarRecarga()
    const stop = await a.central().call('RemoteStopTransaction', { transactionId: TX_ID })
    expect(stop.status).toBe('Rejected')
    const antes = a.porMetodo('MeterValues').length
    await esperarAte(() => a.porMetodo('MeterValues').length >= antes + 3)
    const amostras = a.porMetodo('MeterValues').map(energia)
    expect(amostras[amostras.length - 1]).toBeGreaterThan(amostras[0])
    expect(a.porMetodo('StopTransaction')).toHaveLength(0)
  })

  it('o par aceita-e-ignora: responde Accepted, mas também nunca manda o StopTransaction', async () => {
    const a = await montar({ acceptStopKeepCharging: true })
    await a.iniciarRecarga()
    const stop = await a.central().call('RemoteStopTransaction', { transactionId: TX_ID })
    expect(stop.status).toBe('Accepted')
    const antes = a.porMetodo('MeterValues').length
    await esperarAte(() => a.porMetodo('MeterValues').length >= antes + 2)
    expect(a.porMetodo('StopTransaction')).toHaveLength(0)
  })

  it('as duas juntas são contraditórias e o construtor recusa', () => {
    expect(() => new ChargerSimulator({ url: 'ws://x', identity: 'i', password: 'p', behavior: { rejectStopKeepCharging: true, acceptStopKeepCharging: true } })).toThrow(/contradit/)
  })
})

describe('--silent-after-start (S3)', () => {
  it('manda UM MeterValues e fica mudo, mas o Heartbeat segue vivo; TriggerMessage => NotImplemented; o RemoteStop ainda funciona', async () => {
    const a = await montar({ silentAfterStart: true })
    await a.iniciarRecarga()
    const hb = a.porMetodo('Heartbeat').length
    await esperarAte(() => a.porMetodo('Heartbeat').length >= hb + 3) // várias amostras teriam passado nesse tempo (30 ms)
    expect(a.porMetodo('MeterValues')).toHaveLength(1)

    const trig = await a.central().call('TriggerMessage', { requestedMessage: 'MeterValues', connectorId: 1 })
    expect(trig.status).toBe('NotImplemented')
    await esperar(100)
    expect(a.porMetodo('MeterValues')).toHaveLength(1)

    expect((await a.central().call('RemoteStopTransaction', { transactionId: TX_ID })).status).toBe('Accepted')
    await esperarAte(() => a.porMetodo('StopTransaction').length === 1)
  })
})

describe('--no-meter-values (S5)', () => {
  it('zero MeterValues (nem o inicial), TriggerMessage => NotImplemented, e o Stop sai com meterStop = meterStart', async () => {
    const a = await montar({ noMeterValues: true })
    const r = await a.central().call('RemoteStartTransaction', { connectorId: 1, idTag: 'TAG-1' })
    expect(r.status).toBe('Accepted')
    await esperarAte(() => a.porMetodo('StartTransaction').length === 1)
    await esperarAte(() => a.porMetodo('StatusNotification').some((m) => m.params.status === 'Charging'))
    await esperar(200) // seriam ~6 amostras
    expect(a.porMetodo('MeterValues')).toHaveLength(0)

    expect((await a.central().call('TriggerMessage', { requestedMessage: 'MeterValues' })).status).toBe('NotImplemented')
    await a.central().call('RemoteStopTransaction', { transactionId: TX_ID })
    await esperarAte(() => a.porMetodo('StopTransaction').length === 1)
    expect(a.porMetodo('StopTransaction')[0].params.meterStop).toBe(a.porMetodo('StartTransaction')[0].params.meterStart)
    expect(a.porMetodo('MeterValues')).toHaveLength(0)
  })
})

describe('--fault-mid-session (S6)', () => {
  it('manda Faulted/GroundFailure, PARA os MeterValues e mantém a transação aberta (sem Stop)', async () => {
    const a = await montar({ faultMidSession: true, incidentAfterMs: 100 })
    await a.iniciarRecarga()
    await esperarAte(() => a.porMetodo('StatusNotification').some((m) => m.params.status === 'Faulted'))
    expect(a.porMetodo('StatusNotification').find((m) => m.params.status === 'Faulted')!.params).toMatchObject({ connectorId: 1, errorCode: 'GroundFailure' })
    const n = a.porMetodo('MeterValues').length
    await esperar(200)
    expect(a.porMetodo('MeterValues')).toHaveLength(n)
    expect(a.porMetodo('StopTransaction')).toHaveLength(0)
  })

  it('com --fault-recover-after-s volta a Charging e retoma os MeterValues', async () => {
    const a = await montar({ faultMidSession: true, incidentAfterMs: 80, faultRecoverAfterMs: 120 })
    await a.iniciarRecarga()
    await esperarAte(() => a.porMetodo('StatusNotification').filter((m) => m.params.status === 'Charging').length === 2)
    const n = a.porMetodo('MeterValues').length
    await esperarAte(() => a.porMetodo('MeterValues').length >= n + 2)
  })
})

describe('--reboot-with-queued-stop (S1)', () => {
  it('queda de energia: nada medido offline; volta com BootNotification e SÓ DEPOIS manda o StopTransaction com a leitura real e o timestamp da queda', async () => {
    const a = await montar({ rebootWithQueuedStop: true, incidentAfterMs: 120, offlineForMs: 200 })
    await a.iniciarRecarga()
    await esperarAte(() => a.porMetodo('StopTransaction').length === 1, 6000)

    expect(a.porMetodo('BootNotification')).toHaveLength(2)
    const idxBoot2 = a.log.findIndex((m, i) => m.method === 'BootNotification' && i > 0 && a.log.slice(0, i).some((x) => x.method === 'BootNotification'))
    const idxStop = a.log.findIndex((m) => m.method === 'StopTransaction')
    expect(idxStop).toBeGreaterThan(idxBoot2)

    // nada de MeterValues entre a queda e o Stop
    const ultimoMvAntesDoBoot = [...a.log.slice(0, idxBoot2)].reverse().find((m) => m.method === 'MeterValues')!
    expect(a.log.slice(idxBoot2).some((m) => m.method === 'MeterValues')).toBe(false)

    const stop = a.log[idxStop]
    expect(stop.params).toMatchObject({ transactionId: TX_ID, reason: 'PowerLoss' })
    expect(stop.params.meterStop).toBe(energia(ultimoMvAntesDoBoot)) // leitura REAL do medidor, a última antes de cair
    // timestamp = instante da queda (anterior ao reboot por >= offlineFor), não o do momento do envio
    expect(Date.parse(stop.params.timestamp)).toBeLessThanOrEqual(stop.at - 150)
  })
})

describe('--offline-queue (S4)', () => {
  it('rede cai e o poste segue medindo: ao voltar SEM Boot despeja MeterValues enfileirados (com os timestamps originais) e depois o Stop', async () => {
    const a = await montar({ offlineQueue: true, incidentAfterMs: 120, offlineForMs: 250 })
    await a.iniciarRecarga()
    await esperarAte(() => a.porMetodo('StopTransaction').length === 1, 6000)

    expect(a.porMetodo('BootNotification')).toHaveLength(1) // sem reinício
    const idxStop = a.log.findIndex((m) => m.method === 'StopTransaction')
    const stop = a.log[idxStop]
    expect(stop.params.reason).toBe('Other')

    // houve MeterValues despejados em lote DEPOIS do corte (timestamp do payload bem anterior ao instante do recebimento)
    const atrasados = a.porMetodo('MeterValues').filter((m) => m.at - Date.parse(m.params.meterValue[0].timestamp) > 100)
    expect(atrasados.length).toBeGreaterThanOrEqual(3)
    // e a ordem da fila foi preservada: MeterValues atrasados -> Finishing -> Stop, tudo antes do Stop
    const idxUltimoAtrasado = a.log.lastIndexOf(atrasados[atrasados.length - 1])
    const idxFinishing = a.log.findIndex((m) => m.method === 'StatusNotification' && m.params.status === 'Finishing')
    expect(idxUltimoAtrasado).toBeLessThan(idxFinishing)
    expect(idxFinishing).toBeLessThan(idxStop)
    // meterStop = a maior leitura vista (nada se perdeu)
    expect(stop.params.meterStop).toBe(Math.max(...a.porMetodo('MeterValues').map(energia)))
  })

  it('as duas quedas juntas são contraditórias e o construtor recusa', () => {
    expect(() => new ChargerSimulator({ url: 'ws://x', identity: 'i', password: 'p', behavior: { offlineQueue: true, rebootWithQueuedStop: true } })).toThrow(/contradit/)
  })
})
