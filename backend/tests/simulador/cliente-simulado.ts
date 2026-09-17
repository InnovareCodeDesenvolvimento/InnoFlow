/**
 * Cliente de teste simples com o próprio `RPCClient` do `ocpp-rpc` — prova o
 * handshake OCPP 1.6-J completo contra o gateway REAL (`entrypoints/ocpp.ts`),
 * exercitando toda a sequência de mensagens do MVP (F3a) + a tarifação/
 * carteira reais da F4:
 *
 *   connect (Basic Auth) -> BootNotification -> StatusNotification(Available)
 *   -> Authorize -> StartTransaction -> MeterValues (kWh, prova a
 *   normalização de unidade) -> StatusNotification(Charging) -> MeterValues
 *   (Wh) -> StatusNotification(Finishing) -> StopTransaction -> close
 *
 * Usa a identidade e credenciais do seed (`prisma/seed.ts`):
 *   ocppIdentity = CP-INNOELEKTRON-001, connectorId = 1 (DC CCS2),
 *   basic auth secret = changeme-basic-auth-secret, idTag = SEED-DRIVER-01.
 *
 * PRÉ-REQUISITO da F4 (novo — não existia na F3a): o `User` dono do
 * `idTag` precisa ter `Wallet` com saldo >= `WALLET_MIN_START_BALANCE_CENTS`
 * (default R$ 20,00) e NENHUMA `Debt` OPEN, senão `StartTransaction` volta
 * `idTagInfo.status: 'Blocked'` e `transactionId: 0` — o seed base
 * (`npm run db:seed`, diferente do `db:seed:demo`) precisa garantir isso pro
 * motorista SEED-DRIVER-01; se não garantir, credite manualmente via
 * `POST /api/admin/drivers/:id/wallet/entries` (ADMIN) antes de rodar isto.
 *
 * Como rodar (requer Postgres + Redis de pé, migration aplicada, seed
 * rodado, e o gateway OCPP + a API escutando — ver docker-compose.yml da raiz):
 *
 *   docker compose up -d postgres redis
 *   cd backend && npx prisma migrate deploy && npm run db:seed
 *   npm run dev:ocpp    # noutro terminal
 *   npm run dev:api     # noutro terminal (só necessário se for creditar saldo pela API)
 *   npm run dev:worker  # noutro terminal (processa o retry de liquidação, se algum StopTransaction falhar)
 *   npx tsx tests/simulador/cliente-simulado.ts
 *
 * Como CONFIRMAR que a F4 funcionou de ponta a ponta (não só que o OCPP
 * respondeu `Accepted`): depois do script rodar, consulte o Postgres —
 *
 *   SELECT status, "totalCostCents", "energyDeliveredWh", "idleSeconds"
 *     FROM "ChargingSession" WHERE "ocppTransactionId" = <transactionId impresso>;
 *   SELECT type, "amountCents", "balanceAfterCents", "referenceType", "referenceId"
 *     FROM "WalletEntry" WHERE "referenceType" = 'CHARGING_SESSION' AND "referenceId" = '<id da sessão acima>';
 *
 * Espera-se `ChargingSession.status = 'STOPPED'` com `totalCostCents`
 * preenchido (não `null`) e UMA `WalletEntry` `CHARGE_DEBIT` referenciando
 * essa sessão com `amountCents` negativo — é essa dupla que prova a
 * liquidação financeira real (ver `services/carteira/liquidarSessao.ts`).
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

  // Amostra em kWh de propósito — prova a normalização de unidade da F4
  // (`meterValues.ts`: sem ela, 0.25kWh viraria "0.25Wh" gravado, subfaturando
  // por 1000×). 0.25kWh = 250Wh, mesma energia da amostra que já existia aqui.
  await cli.call('MeterValues', {
    connectorId: CONNECTOR_ID,
    transactionId: start.transactionId,
    meterValue: [
      {
        timestamp: new Date().toISOString(),
        sampledValue: [{ value: '0.25', measurand: 'Energy.Active.Import.Register', unit: 'kWh' }],
      },
    ],
  })
  console.log('[cliente-simulado] MeterValues (0.25 kWh) enviado — deve gravar 250 Wh normalizado')

  await cli.call('MeterValues', {
    connectorId: CONNECTOR_ID,
    transactionId: start.transactionId,
    meterValue: [
      {
        timestamp: new Date().toISOString(),
        sampledValue: [{ value: String(meterStart + 500), measurand: 'Energy.Active.Import.Register', unit: 'Wh' }],
      },
    ],
  })
  console.log('[cliente-simulado] MeterValues (500 Wh acumulado) enviado')

  // Finishing ANTES do Stop — abre a janela de ociosidade que `stopTransaction.ts`
  // usa pra calcular `idleSeconds`/`idleFeeCents` (carro parou de carregar, mas
  // a transação OCPP só encerra de fato no StopTransaction, alguns segundos depois).
  await cli.call('StatusNotification', {
    connectorId: CONNECTOR_ID,
    errorCode: 'NoError',
    status: 'Finishing',
    timestamp: new Date().toISOString(),
  })
  console.log('[cliente-simulado] StatusNotification (Finishing) enviado — janela de ociosidade aberta')

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
