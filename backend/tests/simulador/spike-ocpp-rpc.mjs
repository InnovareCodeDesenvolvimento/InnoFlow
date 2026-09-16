// Spike de validação da API do ocpp-rpc (não faz parte da suíte de testes
// automatizados — é prova pontual, mantida aqui como referência de como a
// lib se comporta). Roda com: node tests/simulador/spike-ocpp-rpc.mjs
//
// Prova: WebSocket sobe, identidade+senha chegam no handshake (o mesmo
// caminho que o gateway real usa com ocppIdentity/basicAuthSecretHash), CALL
// funciona nos dois sentidos (charge point -> servidor via BootNotification,
// servidor -> charge point via Reset, o mesmo padrão do barramento de
// comandos da API).
import { RPCServer, RPCClient, createRPCError } from 'ocpp-rpc'

const PORT = 9911
const IDENTITY = 'spike-cp-01'
const PASSWORD = 'segredo123'

async function main() {
  const server = new RPCServer({ protocols: ['ocpp1.6'], strictMode: true })

  server.auth((accept, reject, handshake) => {
    console.log('[server] auth handshake:', {
      identity: handshake.identity,
      endpoint: handshake.endpoint,
      password: handshake.password?.toString('utf8'),
      protocols: [...handshake.protocols],
    })
    if (handshake.identity === IDENTITY && handshake.password?.toString('utf8') === PASSWORD) {
      accept({ chargePointId: handshake.identity })
    } else {
      reject(401, 'unauthorized')
    }
  })

  let serverSideClient
  server.on('client', (client) => {
    console.log('[server] client connected:', client.identity, client.session)
    serverSideClient = client

    client.handle('BootNotification', ({ params }) => {
      console.log('[server] got BootNotification:', params)
      return { status: 'Accepted', interval: 300, currentTime: new Date().toISOString() }
    })

    client.handle(({ method, params }) => {
      console.log('[server] wildcard got', method, params)
      throw createRPCError('NotImplemented')
    })
  })

  await server.listen(PORT)
  console.log('[server] listening on', PORT)

  const cli = new RPCClient({
    endpoint: `ws://localhost:${PORT}/ocpp`,
    identity: IDENTITY,
    password: PASSWORD,
    protocols: ['ocpp1.6'],
    strictMode: true,
  })

  cli.handle('Reset', ({ params }) => {
    console.log('[client] got Reset command from server:', params)
    return { status: 'Accepted' }
  })

  await cli.connect()
  console.log('[client] connected')

  const bootResp = await cli.call('BootNotification', {
    chargePointVendor: 'InnoElektron',
    chargePointModel: 'spike',
  })
  console.log('[client] BootNotification response:', bootResp)

  // Sentido inverso: servidor manda comando para o charge point (equivalente
  // a RemoteStartTransaction/Reset/etc. vindos da API via Redis).
  const resetResp = await serverSideClient.call('Reset', { type: 'Soft' })
  console.log('[server] Reset response from client:', resetResp)

  await cli.close()
  await server.close()
  console.log('SPIKE OK: conexão + CALL nos dois sentidos funcionou')
  process.exit(0)
}

main().catch((err) => {
  console.error('SPIKE FALHOU:', err)
  process.exit(1)
})
