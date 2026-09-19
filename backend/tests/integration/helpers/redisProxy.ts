import { createServer, connect, type Server, type Socket } from 'node:net'

/**
 * Proxy TCP entre a aplicação e o Redis REAL — existe para "derrubar o Redis" num teste SEM tocar no
 * Redis compartilhado (as suítes rodam em paralelo no mesmo Redis; derrubá-lo de verdade quebraria as
 * outras) e sem depender de um binário `redis-server` na máquina (a CI usa um service container).
 *
 * Do ponto de vista do cliente (ioredis) os três estados são fiéis ao que a produção vê:
 *  - `up`:        repassa tudo (Redis saudável);
 *  - `down`:      derruba as conexões abertas e para de escutar — ECONNRESET e depois ECONNREFUSED,
 *                 exatamente o que se vê com o processo do Redis morto;
 *  - `blackhole`: aceita a conexão e engole os bytes, sem nunca responder — partição de rede /
 *                 Redis travado (o caso PIOR: não dá erro, o comando simplesmente não volta).
 *
 * A porta é fixa depois do primeiro `start()` — o cliente reconecta na MESMA URL quando voltar a `up`.
 */
export class RedisProxy {
  private server: Server | undefined
  private readonly sockets = new Set<Socket>()
  private mode: 'up' | 'down' | 'blackhole' = 'up'
  port = 0

  constructor(private readonly target: { host: string; port: number }) {}

  static fromUrl(redisUrl: string): RedisProxy {
    const u = new URL(redisUrl)
    return new RedisProxy({ host: u.hostname, port: Number(u.port || 6379) })
  }

  get url(): string {
    return `redis://127.0.0.1:${this.port}`
  }

  async start(): Promise<void> {
    await this.listen(this.port)
  }

  private listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((client) => this.onClient(client))
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        this.port = (server.address() as { port: number }).port
        this.server = server
        resolve()
      })
    })
  }

  private onClient(client: Socket): void {
    this.sockets.add(client)
    client.on('close', () => this.sockets.delete(client))
    client.on('error', () => {})

    const upstream = connect(this.target.port, this.target.host)
    this.sockets.add(upstream)
    upstream.on('close', () => {
      this.sockets.delete(upstream)
      client.destroy()
    })
    upstream.on('error', () => client.destroy())
    client.on('close', () => upstream.destroy())

    client.on('data', (chunk) => {
      if (this.mode === 'blackhole') return
      upstream.write(chunk)
    })
    upstream.on('data', (chunk) => {
      if (this.mode === 'blackhole') return
      client.write(chunk)
    })
  }

  private killSockets(): void {
    for (const s of this.sockets) s.destroy()
    this.sockets.clear()
  }

  /** Redis "morto": derruba tudo e recusa novas conexões. */
  async down(): Promise<void> {
    this.mode = 'down'
    const server = this.server
    this.server = undefined
    this.killSockets()
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  /** Redis "travado": aceita e não responde. As conexões abertas ficam abertas, mudas. */
  async blackhole(): Promise<void> {
    if (!this.server) await this.listen(this.port)
    this.mode = 'blackhole'
  }

  /** Volta ao normal. Conexões enterradas no blackhole são derrubadas (o cliente reconecta limpo). */
  async up(): Promise<void> {
    if (this.mode === 'blackhole') this.killSockets()
    this.mode = 'up'
    if (!this.server) await this.listen(this.port)
  }

  async stop(): Promise<void> {
    await this.down()
  }
}
