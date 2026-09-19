import { EventEmitter } from 'node:events'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openSseStream, type SseCloseReason, type SseDeps } from '../../src/api/lib/sseStream'
import { createStreamLimiter } from '../../src/core/realtime/streamLimiter'
import { errorHandler } from '../../src/api/middleware/errorHandler'
import type { AuthPayload } from '../../src/api/middleware/auth'

/** Response falso — só o que `openSseStream` usa. `writeReturns` controla o backpressure. */
function fakeRes(writeReturns: () => boolean = () => true) {
  const res = new EventEmitter() as EventEmitter & {
    statusCode?: number
    headers: Record<string, string>
    written: string[]
    writableEnded: boolean
    status(c: number): unknown
    setHeader(k: string, v: string): void
    flushHeaders(): void
    write(chunk: string): boolean
    end(): void
  }
  res.headers = {}
  res.written = []
  res.writableEnded = false
  res.status = (c) => {
    res.statusCode = c
    return res
  }
  res.setHeader = (k, v) => {
    res.headers[k.toLowerCase()] = v
  }
  res.flushHeaders = () => {}
  res.write = (chunk) => {
    res.written.push(chunk)
    return writeReturns()
  }
  res.end = () => {
    res.writableEnded = true
    res.emit('close')
  }
  return res
}

function setup(over: Partial<SseDeps> & { user?: Partial<AuthPayload> } = {}) {
  const closes: SseCloseReason[] = []
  let listener: ((e: { type: string }, raw: string) => void) | undefined
  let unsubscribed = 0
  const deps: SseDeps = {
    subscribe: (_channels, l) => {
      listener = l
      return () => {
        unsubscribed++
      }
    },
    limiter: createStreamLimiter({ perUser: 5, perIp: 50, total: 100 }),
    validateSession: async () => ({ ok: true }),
    heartbeatMs: 10,
    onClose: (r) => closes.push(r),
    ...over,
  }
  const req = { user: { userId: 'u1', role: 'DRIVER', operatorId: null, exp: 4_000_000_000, ...over.user }, ip: '1.1.1.1' }
  return { deps, req, closes, emit: (e: { type: string }) => listener?.(e, JSON.stringify(e)), unsubscribedCount: () => unsubscribed }
}

const open = (t: ReturnType<typeof setup>, res: ReturnType<typeof fakeRes>) => openSseStream(t.deps, t.req as never, res as never, ['c'])

afterEach(() => vi.useRealTimers())

describe('openSseStream', () => {
  it('cabeçalhos SSE (incl. X-Accel-Buffering: no) e primeiro byte imediato', () => {
    const t = setup()
    const res = fakeRes()
    open(t, res)

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/event-stream')
    expect(res.headers['x-accel-buffering']).toBe('no')
    expect(res.written[0]).toBe(': ok\n\n')
  })

  it('entrega o evento no formato SSE (event:/data: com o JSON cru)', () => {
    const t = setup()
    const res = fakeRes()
    open(t, res)

    t.emit({ type: 'wallet.updated' })

    expect(res.written[1]).toBe('event: wallet.updated\ndata: {"type":"wallet.updated"}\n\n')
  })

  it('BACKPRESSURE: write() devolvendo false fecha o stream e solta assinatura e vaga (cliente que não lê não acumula memória)', () => {
    let saturado = false
    const t = setup()
    const res = fakeRes(() => !saturado)
    open(t, res)

    saturado = true
    t.emit({ type: 'session.metrics' })

    expect(t.closes).toEqual(['backpressure'])
    expect(res.writableEnded).toBe(true)
    expect(t.unsubscribedCount()).toBe(1)
    expect(t.deps.limiter.stats().total).toBe(0)
  })

  it('cliente desconectou (close da resposta): solta assinatura e vaga, sem chamar end()', () => {
    const t = setup()
    const res = fakeRes()
    open(t, res)

    res.emit('close')

    expect(t.closes).toEqual(['client_closed'])
    expect(t.unsubscribedCount()).toBe(1)
    expect(t.deps.limiter.stats().total).toBe(0)
    expect(res.writableEnded).toBe(false)
  })

  it('depois de fechado, eventos e heartbeat não escrevem mais', async () => {
    vi.useFakeTimers()
    const t = setup()
    const res = fakeRes()
    open(t, res)
    res.emit('close')
    const antes = res.written.length

    t.emit({ type: 'x' })
    await vi.advanceTimersByTimeAsync(100)

    expect(res.written.length).toBe(antes)
  })

  it('heartbeat: escreve o ping enquanto a sessão vale', async () => {
    vi.useFakeTimers()
    const t = setup()
    const res = fakeRes()
    open(t, res)

    await vi.advanceTimersByTimeAsync(25)

    expect(res.written).toContain(': ping\n\n')
    expect(t.closes).toEqual([])
  })

  it('SESSÃO REVOGADA (conta desativada / senha trocada): o stream se ENCERRA no próximo heartbeat (Órion M1)', async () => {
    vi.useFakeTimers()
    const t = setup({ validateSession: async () => ({ ok: false }) })
    const res = fakeRes()
    open(t, res)

    await vi.advanceTimersByTimeAsync(25)

    expect(t.closes).toEqual(['session_revoked'])
    expect(res.writableEnded).toBe(true)
    expect(t.deps.limiter.stats().total).toBe(0)
  })

  it('TOKEN EXPIRADO (exp venceu com o stream aberto): encerra no heartbeat seguinte ao vencimento e para de consultar o banco', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-19T12:00:00Z'))
    const validate = vi.fn(async () => ({ ok: true }))
    const t = setup({ validateSession: validate, user: { exp: Math.floor(new Date('2026-09-19T12:00:00Z').getTime() / 1000) + 1 } })
    const res = fakeRes()
    open(t, res)

    await vi.advanceTimersByTimeAsync(2_000) // passou do exp

    expect(t.closes).toEqual(['token_expired'])
    const consultasAteFechar = validate.mock.calls.length
    await vi.advanceTimersByTimeAsync(2_000)
    expect(validate.mock.calls.length).toBe(consultasAteFechar) // fechado: nenhum heartbeat/consulta a mais
  })

  it('falha TRANSITÓRIA do banco na re-checagem NÃO derruba o stream', async () => {
    vi.useFakeTimers()
    const t = setup({
      validateSession: async () => {
        throw new Error('db fora')
      },
    })
    const res = fakeRes()
    open(t, res)

    await vi.advanceTimersByTimeAsync(25)

    expect(t.closes).toEqual([])
    expect(res.written).toContain(': ping\n\n')
  })

  it('teto por IP: lança 429 SSE_TOO_MANY_STREAMS ANTES de escrever qualquer cabeçalho', () => {
    const limiter = createStreamLimiter({ perUser: 5, perIp: 1, total: 100 })
    const t1 = setup({ limiter })
    open(t1, fakeRes())

    const t2 = setup({ limiter, user: { userId: 'u2' } })
    const res2 = fakeRes()
    expect(() => open(t2, res2)).toThrowError(expect.objectContaining({ statusCode: 429, code: 'SSE_TOO_MANY_STREAMS' }))
    expect(res2.written).toEqual([])
  })

  it('teto total: 503 SSE_CAPACITY', () => {
    const limiter = createStreamLimiter({ perUser: 5, perIp: 100, total: 1 })
    open(setup({ limiter }), fakeRes())
    expect(() => open(setup({ limiter, user: { userId: 'u2' } }), fakeRes())).toThrowError(expect.objectContaining({ statusCode: 503, code: 'SSE_CAPACITY' }))
  })

  it('teto por usuário: o stream MAIS ANTIGO é expulso (fecha com "evicted") e o novo entra', () => {
    const limiter = createStreamLimiter({ perUser: 1, perIp: 100, total: 100 })
    const t1 = setup({ limiter })
    const res1 = fakeRes()
    open(t1, res1)

    const t2 = setup({ limiter })
    open(t2, fakeRes())

    expect(t1.closes).toEqual(['evicted'])
    expect(res1.writableEnded).toBe(true)
    expect(t2.closes).toEqual([])
  })
})

describe('openSseStream sobre HTTP real (detecção de desconexão do cliente)', () => {
  const servers: http.Server[] = []
  afterEach(async () => {
    await Promise.all(servers.map((s) => new Promise((r) => s.close(() => r(null)))))
    servers.length = 0
  })

  it('mantém o stream ABERTO depois do primeiro chunk e libera assinatura/vaga quando o cliente desconecta', async () => {
    const closes: SseCloseReason[] = []
    let unsubscribed = 0
    const limiter = createStreamLimiter({ perUser: 5, perIp: 50, total: 100 })
    const deps: SseDeps = {
      subscribe: () => () => {
        unsubscribed++
      },
      limiter,
      validateSession: async () => ({ ok: true }),
      heartbeatMs: 60_000,
      onClose: (r) => closes.push(r),
    }
    const app = express()
    app.get('/events', (req, res) => {
      req.user = { userId: 'u1', role: 'DRIVER', operatorId: null }
      openSseStream(deps, req, res, ['c'])
    })
    app.use(errorHandler)
    const server = http.createServer(app)
    servers.push(server)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as AddressInfo).port

    const chunks: string[] = []
    const clientReq = http.get({ host: '127.0.0.1', port, path: '/events' })
    const response = await new Promise<http.IncomingMessage>((r) => clientReq.on('response', r))
    response.setEncoding('utf8')
    response.on('data', (c) => chunks.push(c))

    await new Promise((r) => setTimeout(r, 150))
    expect(response.headers['content-type']).toBe('text/event-stream')
    expect(chunks.join('')).toContain(': ok')
    // Se `req.on('close')` fosse usado (dispara ao fim da leitura da REQUISIÇÃO), o stream já teria sido derrubado aqui.
    expect(closes).toEqual([])
    expect(limiter.stats().total).toBe(1)

    clientReq.destroy() // o cliente vai embora
    await new Promise((r) => setTimeout(r, 150))

    expect(closes).toEqual(['client_closed'])
    expect(unsubscribed).toBe(1)
    expect(limiter.stats().total).toBe(0)
  })
})
