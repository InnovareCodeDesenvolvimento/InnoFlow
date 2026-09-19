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
  private latencyMs = 0
  private readonly lanes = new Set<DelayLane>()
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

    const toUpstream = new DelayLane((chunk) => upstream.write(chunk))
    this.lanes.add(toUpstream)
    client.on('close', () => {
      toUpstream.clear()
      this.lanes.delete(toUpstream)
    })
    client.on('data', (chunk) => {
      if (this.mode === 'blackhole') return
      toUpstream.push(chunk, this.latencyMs)
    })
    upstream.on('data', (chunk) => {
      if (this.mode === 'blackhole') return
      client.write(chunk)
    })
  }

  private killSockets(): void {
    for (const lane of this.lanes) lane.clear()
    this.lanes.clear()
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

  /**
   * Redis "LENTO" (vivo, mas cada comando so chega ao Redis `ms` milissegundos depois: fork de BGSAVE, disco, CPU
   * disputada): NAO da erro e NAO trava, so demora. A ordem dos bytes e preservada. `0` volta ao normal (os
   * comandos ja atrasados ainda sao entregues, na ordem).
   */
  latency(ms: number): void {
    this.latencyMs = ms
  }

  /** Volta ao normal. Conexões enterradas no blackhole são derrubadas (o cliente reconecta limpo). */
  async up(): Promise<void> {
    if (this.mode === 'blackhole') this.killSockets()
    this.mode = 'up'
    this.latencyMs = 0
    if (!this.server) await this.listen(this.port)
  }

  async stop(): Promise<void> {
    await this.down()
  }
}

/** Fila ordenada com atraso: cada chunk sai em max(agora + atraso, saida do anterior) — nunca reordena. */
class DelayLane {
  private queue: Array<{ at: number; chunk: Buffer }> = []
  private timer: NodeJS.Timeout | undefined

  constructor(private readonly write: (chunk: Buffer) => void) {}

  push(chunk: Buffer, delayMs: number): void {
    if (delayMs <= 0 && this.queue.length === 0) return this.write(chunk) // caminho normal: sem custo
    const at = Math.max(Date.now() + delayMs, this.queue.at(-1)?.at ?? 0)
    this.queue.push({ at, chunk })
    this.schedule()
  }

  private schedule(): void {
    if (this.timer || this.queue.length === 0) return
    this.timer = setTimeout(
      () => {
        this.timer = undefined
        const now = Date.now()
        while (this.queue.length > 0 && this.queue[0].at <= now) this.write(this.queue.shift()!.chunk)
        this.schedule()
      },
      Math.max(0, this.queue[0].at - Date.now()),
    )
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.queue = []
  }
}
