/**
 * Cliente de teste simples com o próprio `RPCClient` do `ocpp-rpc` — prova o
 * handshake OCPP 1.6-J completo contra o gateway REAL (`entrypoints/ocpp.ts`),
 * exercitando toda a sequência de mensagens do MVP (F3a):
 *
 *   connect (Basic Auth) -> BootNotification -> StatusNotification ->
 *   Authorize -> StartTransaction -> MeterValues -> StopTransaction -> close
 *
 * Usa a identidade e credenciais do seed (`prisma/seed.ts`):
 *   ocppIdentity = CP-INNOELEKTRON-001, connectorId = 1 (DC CCS2),
 *   basic auth secret = changeme-basic-auth-secret, idTag = SEED-DRIVER-01.
 *
 * Como rodar (requer Postgres + Redis de pé, migration aplicada, seed
 * rodado, e o gateway OCPP escutando — ver docker-compose.yml da raiz):
 *
 *   docker compose up -d postgres redis
 *   cd backend && npx prisma migrate deploy && npm run db:seed
 *   npm run dev:ocpp   # noutro terminal
 *   npx tsx tests/simulador/cliente-simulado.ts
 *
 * NÃO É rodado pela suíte automatizada (`npm test`) — depende de um gateway
 * de pé com banco real, o que os testes do Vitest não sobem sozinhos. É a
 * prova manual do "entregável" desta fase (ver handoff do Vega).
 */
import { RPCClient } from 'ocpp-rpc'

const OCPP_HOST = process.env.OCPP_SIMULATOR_HOST ?? 'localhost'
const OCPP_PORT = process.env.OCPP_SIMULATOR_PORT ?? '9000'
const OCPP_IDENTITY = process.env.OCPP_SIMULATOR_IDENTITY ?? 'CP-INNOELEKTRON-001'
const OCPP_SECRET = process.env.OCPP_SIMULATOR_SECRET ?? 'changeme-basic-auth-secret'
const CONNECTOR_ID = 1
const ID_TAG = process.env.OCPP_SIMULATOR_ID_TAG ?? 'SEED-DRIVER-01'

async function main() {
  const cli = new RPCClient({
    endpoint: `ws://${OCPP_HOST}:${OCPP_PORT}/ocpp`,
    identity: OCPP_IDENTITY,
    password: OCPP_SECRET,
    protocols: ['ocpp1.6'],
  })

  cli.handle('Reset', ({ params }) => {
    console.log('[cliente-simulado] recebeu Reset do servidor:', params)
    return { status: 'Accepted' }
  })

  console.log(`[cliente-simulado] conectando em ws://${OCPP_HOST}:${OCPP_PORT}/ocpp/${OCPP_IDENTITY} ...`)
  await cli.connect()
  console.log('[cliente-simulado] conectado')

  const boot = await cli.call('BootNotification', {
    chargePointVendor: 'InnoElektron',
    chargePointModel: 'Simulador CLI',
    firmwareVersion: '0.1.0-sim',
  })
  console.log('[cliente-simulado] BootNotification ->', boot)

  await cli.call('StatusNotification', {
    connectorId: CONNECTOR_ID,
    errorCode: 'NoError',
    status: 'Available',
    timestamp: new Date().toISOString(),
  })
  console.log('[cliente-simulado] StatusNotification (Available) enviado')

  const auth = await cli.call('Authorize', { idTag: ID_TAG })
  console.log('[cliente-simulado] Authorize ->', auth)

  const meterStart = 1000
  const start = (await cli.call('StartTransaction', {
    connectorId: CONNECTOR_ID,
    idTag: ID_TAG,
    meterStart,
    timestamp: new Date().toISOString(),
  })) as { transactionId: number; idTagInfo: { status: string } }
  console.log('[cliente-simulado] StartTransaction ->', start)

  if (start.idTagInfo.status !== 'Accepted' || start.transactionId === 0) {
    throw new Error('StartTransaction não foi aceito — confira se o seed rodou e o idTag existe/está ACCEPTED')
  }

  await cli.call('StatusNotification', {
    connectorId: CONNECTOR_ID,
    errorCode: 'NoError',
    status: 'Charging',
    timestamp: new Date().toISOString(),
  })
  console.log('[cliente-simulado] StatusNotification (Charging) enviado')

  await cli.call('MeterValues', {
    connectorId: CONNECTOR_ID,
    transactionId: start.transactionId,
    meterValue: [
      {
        timestamp: new Date().toISOString(),
        sampledValue: [{ value: String(meterStart + 250), measurand: 'Energy.Active.Import.Register', unit: 'Wh' }],
      },
    ],
  })
  console.log('[cliente-simulado] MeterValues enviado')

  const meterStop = meterStart + 500
  const stop = await cli.call('StopTransaction', {
    transactionId: start.transactionId,
    idTag: ID_TAG,
    meterStop,
    timestamp: new Date().toISOString(),
    reason: 'Local',
  })
  console.log('[cliente-simulado] StopTransaction ->', stop)

  await cli.call('StatusNotification', {
    connectorId: CONNECTOR_ID,
    errorCode: 'NoError',
    status: 'Available',
    timestamp: new Date().toISOString(),
  })
  console.log('[cliente-simulado] StatusNotification (Available) enviado')

  await cli.close()
  console.log('[cliente-simulado] SUCESSO: handshake OCPP 1.6-J completo, sessão', start.transactionId, `— ${meterStop - meterStart}Wh entregues`)
  process.exit(0)
}

main().catch((err) => {
  console.error('[cliente-simulado] FALHOU:', err)
  process.exit(1)
})
