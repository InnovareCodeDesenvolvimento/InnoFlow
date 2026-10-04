import { spawnSync } from 'node:child_process'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CieloHttpClient, CieloTimeoutError } from '../../src/services/pagamentos/cieloHttpClient'
import { emitirAccessTokenDoNavegadorSop, obterTokenOAuthSop } from '../../src/services/pagamentos/cieloSopOAuth'

/**
 * Íris — rodada 2 (04/10/2026), sem banco: (S-4) o BOOT em produção com segredo/token do webhook curto; (S-6) prazos das ESCRITAS (20 s) x CONSULTAS (8 s) medidos com um
 * servidor lento; (S-2) `redirect: 'error'` em TODAS as chamadas (Cielo e Braspag), com um servidor "atacante" de verdade que registra tudo o que recebe.
 */

describe('S-4 — boot em produção com CIELO_WEBHOOK_PATH_TOKEN / CIELO_WEBHOOK_HEADER_SECRET curtos', () => {
  function subir(extra: Record<string, string>) {
    const e: NodeJS.ProcessEnv = { ...process.env, JWT_SECRET: 'ci-test-secret-nao-usar-em-producao-0000000000', ...extra }
    for (const k of ['CIELO_WEBHOOK_PATH_TOKEN', 'CIELO_WEBHOOK_HEADER_SECRET', 'CIELO_TIMEOUT_MS', 'CIELO_QUERY_TIMEOUT_MS']) if (!(k in extra)) delete e[k]
    const r = spawnSync(process.execPath, [join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'tests/integration/helpers/cieloEnvBoot.ts'], { cwd: process.cwd(), env: e, encoding: 'utf8', timeout: 60_000 })
    return { status: r.status, saida: `${r.stdout}${r.stderr}` }
  }

  it.each([
    ['token do caminho com 31 caracteres', { NODE_ENV: 'production', CIELO_WEBHOOK_PATH_TOKEN: 'a'.repeat(31) }, 'CIELO_WEBHOOK_PATH_TOKEN'],
    ['token do caminho com 8 caracteres (passa o schema, não a produção)', { NODE_ENV: 'production', CIELO_WEBHOOK_PATH_TOKEN: 'a'.repeat(8) }, 'CIELO_WEBHOOK_PATH_TOKEN'],
    ['segredo do header com 31 caracteres', { NODE_ENV: 'production', CIELO_WEBHOOK_HEADER_SECRET: 'b'.repeat(31) }, 'CIELO_WEBHOOK_HEADER_SECRET'],
    ['os dois curtos', { NODE_ENV: 'production', CIELO_WEBHOOK_PATH_TOKEN: 'a'.repeat(20), CIELO_WEBHOOK_HEADER_SECRET: 'b'.repeat(20) }, 'CIELO_WEBHOOK_PATH_TOKEN'],
  ])('produção com %s: o processo NÃO sobe (exit 1) e diz qual variável', (_n, extra, variavel) => {
    const r = subir(extra)
    expect(r.status).toBe(1)
    expect(r.saida).toContain(variavel)
    expect(r.saida).toContain('>= 32')
    expect(r.saida).not.toContain('BOOT-OK')
    expect(r.saida).not.toContain('a'.repeat(8)) // o valor da variável nunca vai ao log de boot
  })

  it.each([
    ['produção com os dois de 32 caracteres', { NODE_ENV: 'production', CIELO_WEBHOOK_PATH_TOKEN: 'a'.repeat(32), CIELO_WEBHOOK_HEADER_SECRET: 'b'.repeat(32) }],
    ['produção com os dois de 48 caracteres (hex de openssl rand -hex 24)', { NODE_ENV: 'production', CIELO_WEBHOOK_PATH_TOKEN: 'ab12'.repeat(12), CIELO_WEBHOOK_HEADER_SECRET: 'cd34'.repeat(12) }],
    ['produção com os dois AUSENTES (rota inalcançável por token aleatório)', { NODE_ENV: 'production' }],
    ['desenvolvimento com 8 caracteres (só produção endurece)', { NODE_ENV: 'development', CIELO_WEBHOOK_PATH_TOKEN: 'a'.repeat(8), CIELO_WEBHOOK_HEADER_SECRET: 'b'.repeat(8) }],
    ['test com 8 caracteres', { NODE_ENV: 'test', CIELO_WEBHOOK_PATH_TOKEN: 'a'.repeat(8), CIELO_WEBHOOK_HEADER_SECRET: 'b'.repeat(8) }],
  ])('%s: sobe (BOOT-OK)', (_n, extra) => {
    const r = subir(extra)
    expect(r.saida).toContain('BOOT-OK')
    expect(r.status).toBe(0)
  })

  it('S-6 — padrões: escritas 20 000 ms, consultas 8 000 ms; os dois configuráveis por env', () => {
    const padrao = subir({ NODE_ENV: 'test' })
    expect(padrao.saida).toContain('timeout=20000 query_timeout=8000')
    const custom = subir({ NODE_ENV: 'test', CIELO_TIMEOUT_MS: '30000', CIELO_QUERY_TIMEOUT_MS: '5000' })
    expect(custom.saida).toContain('timeout=30000 query_timeout=5000')
  })
})

describe('S-6 — prazo das ESCRITAS x das CONSULTAS (cliente HTTP real contra servidor lento)', () => {
  let lento: Server
  let url = ''
  const atrasoPorRota = new Map<string, number>()
  beforeAll(async () => {
    lento = createServer((req, res) => {
      const rota = `${req.method} ${(req.url ?? '').split('?')[0]}`
      const atraso = [...atrasoPorRota.entries()].find(([k]) => rota.startsWith(k))?.[1] ?? 0
      setTimeout(() => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ Payment: { PaymentId: 'p', Status: 1, ReturnCode: '4' }, Payments: [] }))
      }, atraso)
    })
    await new Promise<void>((r) => lento.listen(0, '127.0.0.1', r))
    url = `http://127.0.0.1:${(lento.address() as AddressInfo).port}`
  })
  afterAll(() => new Promise((r) => lento.close(r)))

  const cliente = () => new CieloHttpClient({ merchantId: 'm', merchantKey: 'k', apiBaseUrl: url, apiQueryBaseUrl: url, timeoutMs: 1500, queryTimeoutMs: 150 })

  it('com resposta em 400 ms: escritas (POST sale, PUT capture, PUT void) PASSAM (prazo 1500); consultas (GET por id, GET por pedido, GET /1/card) ESTOURAM (prazo 150)', async () => {
    atrasoPorRota.set('POST /1/sales', 400)
    atrasoPorRota.set('PUT /1/sales', 400)
    atrasoPorRota.set('GET /1/sales', 400)
    atrasoPorRota.set('GET /1/card', 400)
    const c = cliente()
    await expect(c.postSale({ x: 1 })).resolves.toBeTruthy()
    await expect(c.capture('abc', 100)).resolves.toBeTruthy()
    await expect(c.void('abc')).resolves.toBeTruthy()
    await expect(c.getByPaymentId('abc')).rejects.toBeInstanceOf(CieloTimeoutError)
    await expect(c.getByMerchantOrderId('ord')).rejects.toBeInstanceOf(CieloTimeoutError)
    await expect(c.getCard('tok')).rejects.toBeInstanceOf(CieloTimeoutError)
  })

  it('sem `queryTimeoutMs` configurado as consultas usam o prazo das escritas (retrocompatível)', async () => {
    atrasoPorRota.set('GET /1/sales', 300)
    const c = new CieloHttpClient({ merchantId: 'm', merchantKey: 'k', apiBaseUrl: url, apiQueryBaseUrl: url, timeoutMs: 1500 })
    await expect(c.getByPaymentId('abc')).resolves.toBeTruthy()
  })

  it('escrita que passa do SEU prazo estoura como timeout (não vira erro genérico) — o que dispara a reconciliação no adaptador', async () => {
    atrasoPorRota.set('POST /1/sales', 500)
    const c = new CieloHttpClient({ merchantId: 'm', merchantKey: 'k', apiBaseUrl: url, apiQueryBaseUrl: url, timeoutMs: 150, queryTimeoutMs: 1500 })
    await expect(c.postSale({ x: 1 })).rejects.toBeInstanceOf(CieloTimeoutError)
  })
})

describe('S-2 — redirect: nenhum redirecionamento é seguido (Cielo e Braspag); o atacante NÃO recebe NADA', () => {
  const recebido: Array<{ metodo: string; url: string; headers: IncomingHttpHeaders; corpo: string }> = []
  let atacante: Server
  let atacanteUrl = ''
  let redirecionador: Server
  let redirUrl = ''
  let codigo = 302

  beforeAll(async () => {
    atacante = createServer((req, res) => {
      const partes: Buffer[] = []
      req.on('data', (c: Buffer) => partes.push(c))
      req.on('end', () => {
        recebido.push({ metodo: req.method ?? '', url: req.url ?? '', headers: req.headers, corpo: Buffer.concat(partes).toString('utf8') })
        res.setHeader('content-type', 'application/json')
        res.end('{}')
      })
    })
    await new Promise<void>((r) => atacante.listen(0, '127.0.0.1', r))
    atacanteUrl = `http://127.0.0.1:${(atacante.address() as AddressInfo).port}`
    redirecionador = createServer((req, res) => {
      res.statusCode = codigo
      res.setHeader('location', `${atacanteUrl}${req.url}`)
      res.end()
    })
    await new Promise<void>((r) => redirecionador.listen(0, '127.0.0.1', r))
    redirUrl = `http://127.0.0.1:${(redirecionador.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    await new Promise((r) => atacante.close(r))
    await new Promise((r) => redirecionador.close(r))
  })

  it.each([301, 302, 303, 307, 308])('HTTP %s em TODAS as chamadas da Cielo (POST sale com CardToken, PUT capture/void, GET por id, GET por pedido, GET /1/card): falha, e o servidor de destino não recebe NENHUMA requisição', async (cod) => {
    codigo = cod
    recebido.length = 0
    const c = new CieloHttpClient({ merchantId: 'MID-QUE-NAO-PODE-VAZAR', merchantKey: 'CHAVE-QUE-NAO-PODE-VAZAR', apiBaseUrl: redirUrl, apiQueryBaseUrl: redirUrl, timeoutMs: 2000 })
    const chamadas: Array<() => Promise<unknown>> = [
      () => c.postSale({ Payment: { CreditCard: { CardToken: 'TOKEN-DO-CARTAO-NAO-PODE-VAZAR' } } }),
      () => c.capture('abc', 100),
      () => c.void('abc'),
      () => c.getByPaymentId('abc'),
      () => c.getByMerchantOrderId('ord'),
      () => c.getCard('tok'),
    ]
    for (const chamar of chamadas) await expect(chamar()).rejects.toBeTruthy()
    expect(recebido, 'o destino do redirecionamento recebeu requisição(ões)').toEqual([])
  })

  it.each([307, 302])('SOP (HTTP %s no OAuth e na emissão do AccessToken): falha como `indisponivel` e o destino não recebe nada (nem Basic, nem Bearer, nem MerchantId)', async (cod) => {
    codigo = cod
    recebido.length = 0
    const cfg = { clientId: 'cid', clientSecret: 'SOP-SECRET-NAO-PODE-VAZAR', merchantId: 'MID-SOP', oauthTokenUrl: `${redirUrl}/oauth2/token`, accessTokenUrl: `${redirUrl}/post/api/public/v2/accesstoken`, timeoutMs: 2000 }
    await expect(obterTokenOAuthSop(cfg)).rejects.toMatchObject({ kind: 'indisponivel', passo: 'oauth' })
    await expect(emitirAccessTokenDoNavegadorSop(cfg, 'TOKEN-OAUTH-NAO-PODE-VAZAR')).rejects.toMatchObject({ kind: 'indisponivel', passo: 'accesstoken' })
    expect(recebido).toEqual([])
  })
})
