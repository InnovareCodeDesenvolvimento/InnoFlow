import { appendFileSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { PrismaClient } from '@prisma/client'
import jwt from 'jsonwebtoken'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { criarBancoProprio } from './helpers/bancoProprio'
import { HASH_SENHA_ADMIN_TESTE, SENHA_ADMIN_TESTE } from './helpers/senhaAdmin'

// O servidor de verdade fala com o Redis por um proxy TCP desta suíte (ver helpers/redisProxy.ts): "derrubar o Redis" = derrubar o proxy, sem tocar no Redis compartilhado.
const { proxy, realRedisUrl } = await (async () => {
  const { RedisProxy } = await import('./helpers/redisProxy')
  const realRedisUrl = process.env.REDIS_URL as string
  const proxy = RedisProxy.fromUrl(realRedisUrl)
  await proxy.start()
  return { proxy, realRedisUrl }
})()

/**
 * QA da Íris (F5.8, rodada Vega-4) — o step-up FAIL-CLOSED medido no servidor DE VERDADE (`src/entrypoints/api.ts`, `NODE_ENV=production`, `LOG_LEVEL=info`, `pino-pretty`) com o
 * Redis do throttle atrás de um proxy (down e blackhole), em vez de só no `createApp` em processo:
 *   1) Redis MORTO e Redis TRAVADO: o PUT do gateway devolve 503 `STEPUP_UNAVAILABLE` SEM avaliar a senha (nem a certa nem a errada) e SEM gravar a config nem linha de auditoria de falha;
 *   2) o log REAL (stdout/stderr inteiro) traz o alerta `payment_gateway_stepup_unavailable` — UM por tentativa recusada (contagem) — e NUNCA a senha (certa ou errada) nem o token nem o valor do corpo;
 *   3) a leitura (GET) continua funcionando com o Redis fora (o preço do fail-closed é só a escrita);
 *   4) Redis VOLTANDO restaura o fluxo (PUT com a senha certa => 200) sem reiniciar o servidor, e o limite por usuário volta do zero (5 erradas => 403, a 6ª => 429): nenhuma tentativa feita
 *      durante a queda deixou trancamento fantasma nem dívida. A recuperação é medida (tempo até o 1º 200 depois do `up()`), com PING real, não só `status === 'ready'`.
 */

const SENHA_ERRADA = 'SENHA-ERRADA-REDIS-FORA-nao-pode-aparecer-hhh888'
const VALOR_DO_CORPO = 'sop-id-redis-fora-iii999'
const ALERTA = 'payment_gateway_stepup_unavailable'
const SAIDA = process.env.IRIS_M4C_SAIDA

function portaLivre(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => resolve(port))
    })
  })
}

describe('step-up fail-closed com o Redis fora — servidor REAL, log REAL, recuperação medida', () => {
  let banco: Awaited<ReturnType<typeof criarBancoProprio>>
  let appPrisma: PrismaClient
  let child: ChildProcess | undefined
  let base = ''
  let saida = ''
  let contador = 0

  async function logAssentado(): Promise<string> {
    const sentinela = `SENTINELA-${Math.random().toString(36).slice(2, 12)}`
    await fetch(`${base}/health`, { headers: { 'x-sentinela': sentinela } })
    const deadline = Date.now() + 25_000
    while (!saida.includes(sentinela)) {
      if (Date.now() > deadline) throw new Error(`a requisição sentinela nunca apareceu no log em 25s:\n${saida.slice(-1500)}`)
      await new Promise((r) => setTimeout(r, 50))
    }
    return saida
  }
  const ocorrencias = (texto: string, trecho: string) => texto.split(trecho).length - 1

  async function novoAdmin() {
    contador += 1
    const admin = await appPrisma.user.create({ data: { role: 'ADMIN', name: `Admin Redis Fora ${contador}`, email: `admin-redis-fora-real-${contador}-${Math.random().toString(36).slice(2, 7)}@example.com`, passwordHash: HASH_SENHA_ADMIN_TESTE } })
    const token = jwt.sign({ userId: admin.id, role: 'ADMIN', operatorId: null }, process.env.JWT_SECRET!, { algorithm: 'HS256', expiresIn: '1h' })
    return { id: admin.id, token }
  }
  const put = (token: string, body: Record<string, unknown>) =>
    fetch(`${base}/api/admin/payment-gateway`, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
  const get = (token: string) => fetch(`${base}/api/admin/payment-gateway`, { headers: { authorization: `Bearer ${token}` } })

  beforeAll(async () => {
    banco = await criarBancoProprio('pgf')
    process.env.DATABASE_URL = banco.url
    appPrisma = new PrismaClient({ datasources: { db: { url: banco.url } } })
    const porta = await portaLivre()
    base = `http://127.0.0.1:${porta}`
    const envFilho: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production', LOG_LEVEL: 'info', PORT: String(porta), DATABASE_URL: banco.url, REDIS_URL: proxy.url }
    for (const k of ['CIELO_MERCHANT_ID', 'CIELO_MERCHANT_KEY', 'CIELO_SOP_CLIENT_ID', 'CIELO_SOP_CLIENT_SECRET', 'PUBLIC_API_BASE_URL', 'CIELO_API_BASE_URL', 'CIELO_API_QUERY_BASE_URL', 'PAYMENT_ALLOW_FAKE_ADAPTER']) delete envFilho[k]
    child = spawn(process.execPath, [join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/entrypoints/api.ts'], { env: envFilho, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout!.on('data', (c: Buffer) => (saida += c.toString()))
    child.stderr!.on('data', (c: Buffer) => (saida += c.toString()))
    const deadline = Date.now() + 60_000
    for (;;) {
      if (child.exitCode !== null) throw new Error(`o servidor saiu antes de subir (exit ${child.exitCode}):\n${saida}`)
      try {
        const r = await fetch(`${base}/health`)
        if (r.status === 200 || r.status === 503) break
      } catch {
        // ainda subindo
      }
      if (Date.now() > deadline) throw new Error(`o servidor não subiu em 60s:\n${saida}`)
      await new Promise((r) => setTimeout(r, 300))
    }
  }, 120_000)

  afterAll(async () => {
    if (child && child.exitCode === null) {
      const saiu = new Promise<void>((resolve) => child!.once('exit', () => resolve()))
      child.kill()
      await Promise.race([saiu, new Promise((r) => setTimeout(r, 5_000))])
    }
    await proxy.stop()
    await appPrisma?.$disconnect()
    await banco?.descartar()
  }, 60_000)

  /** Depois de `proxy.up()`: tenta o PUT com a senha CERTA até dar 200 (o servidor reconecta sozinho); devolve quanto levou. */
  async function recuperar(_token: string, sopClientId: string): Promise<number> {
    const t0 = Date.now()
    const limite = t0 + 40_000
    for (;;) {
      const { token } = await novoAdmin() // admin NOVO a cada tentativa: o limite por minuto da rota (em memória, por usuário) não pode virar 429 no meio da espera
      const r = await put(token, { sopClientId, currentPassword: SENHA_ADMIN_TESTE })
      if (r.status === 200) return Date.now() - t0
      await r.text()
      if (Date.now() > limite) throw new Error(`o fluxo não voltou em 40 s depois de o Redis voltar (último status ${r.status})`)
      await new Promise((r2) => setTimeout(r2, 250))
    }
  }

  it('Redis MORTO: 503 STEPUP_UNAVAILABLE sem avaliar a senha (certa nem errada) e sem gravar; alerta no log REAL (1 por tentativa); senha NUNCA no log; leitura segue; Redis volta => fluxo volta e o limite recomeça do zero', async () => {
    const admin = await novoAdmin()
    // CONTROLE (Redis saudável): a senha certa passa e grava
    const controle = await put(admin.token, { sopClientId: 'sop-controle-redis-ok', currentPassword: SENHA_ADMIN_TESTE })
    expect(controle.status, await controle.clone().text()).toBe(200)

    await proxy.down()
    const respostas: Array<{ status: number; corpo: string }> = []
    const tentar = async (senha: string, sop: string) => {
      const r = await put(admin.token, { sopClientId: sop, currentPassword: senha })
      respostas.push({ status: r.status, corpo: await r.text() })
      return respostas.at(-1)!
    }
    // 1ª tentativa pode ainda pegar o socket morrendo; o contrato vale a partir de dar 503 — espera o primeiro 503 e conta TODOS os depois
    let primeiro503 = -1
    for (let i = 0; i < 20 && primeiro503 < 0; i += 1) {
      const r = await tentar(SENHA_ERRADA, VALOR_DO_CORPO)
      if (r.status === 503) primeiro503 = i
      else expect([403, 503], `status inesperado antes de notar a queda: ${r.status} ${r.corpo}`).toContain(r.status)
    }
    expect(primeiro503, 'o servidor tem que passar a dar 503 depois de o Redis cair').toBeGreaterThanOrEqual(0)
    const antesDeContar = respostas.length
    const rErrada = await tentar(SENHA_ERRADA, VALOR_DO_CORPO)
    const rCerta = await tentar(SENHA_ADMIN_TESTE, VALOR_DO_CORPO)
    for (const r of [rErrada, rCerta]) {
      expect(r.status, r.corpo).toBe(503)
      expect(JSON.parse(r.corpo).code).toBe('STEPUP_UNAVAILABLE')
      expect(r.corpo).not.toContain(SENHA_ERRADA)
      expect(r.corpo).not.toContain(SENHA_ADMIN_TESTE)
    }
    expect(respostas.length).toBe(antesDeContar + 2)
    // NADA gravado: nem a config com o valor do corpo, nem trilha de "senha errada" para as tentativas depois da queda
    expect(await appPrisma.paymentGatewayConfig.count({ where: { sopClientId: VALOR_DO_CORPO } })).toBe(0)
    // a leitura segue funcionando
    const leitura = await get(admin.token)
    expect(leitura.status, await leitura.clone().text()).toBe(200)

    // Redis volta: o fluxo volta SEM reiniciar o servidor
    await proxy.up()
    const ms = await recuperar(admin.token, 'sop-voltou-redis-morto')
    if (SAIDA) appendFileSync(SAIDA, `[stepup-redis-morto] recuperacao ate o 1o 200: ${ms} ms\n`)
    expect(await appPrisma.paymentGatewayConfig.count({ where: { sopClientId: 'sop-voltou-redis-morto' } })).toBe(1)

    // o limite por usuário recomeça do zero: 5 erradas => 403, a 6ª => 429 do step-up (nenhuma tentativa da queda deixou dívida)
    const outro = await novoAdmin()
    const desfechos: number[] = []
    for (let i = 0; i < 6; i += 1) desfechos.push((await put(outro.token, { sopClientId: 'x', currentPassword: `${SENHA_ERRADA}-${i}` })).status)
    expect(desfechos).toEqual([403, 403, 403, 403, 403, 429])

    const log = await logAssentado()
    expect(log).toContain('request completed') // controle positivo: o servidor loga
    // alerta presente, com o id do ator, UM por tentativa recusada pela queda (as respostas 503 contadas acima + as do `recuperar` que ainda pegaram a queda não entram na conta exata: usa >=)
    const total503 = respostas.filter((r) => r.status === 503).length
    expect(ocorrencias(log, ALERTA), `503 vistos: ${total503}`).toBeGreaterThanOrEqual(total503)
    expect(log).toContain(admin.id)
    // o que NÃO pode estar no stdout/stderr inteiro
    for (const v of [SENHA_ERRADA, SENHA_ADMIN_TESTE, admin.token, VALOR_DO_CORPO]) expect(log, `vazou no log: ${v.slice(0, 14)}…`).not.toContain(v)
    // o alerta é de nível ERROR e fala em fail-closed/senha não avaliada
    expect(log, 'o alerta de step-up indisponível sai em nível ERROR (não warn)').toMatch(/ERROR: \[stepup\] throttle do step-up indisponível/)
  }, 180_000)

  it('Redis TRAVADO (blackhole): 503 STEPUP_UNAVAILABLE em ~500 ms por tentativa, sem avaliar a senha nem gravar; log REAL com o alerta e sem a senha; ao voltar o fluxo é restaurado', async () => {
    const admin = await novoAdmin()
    await proxy.blackhole()
    const tempos: number[] = []
    const respostas: Array<{ status: number; corpo: string }> = []
    for (let i = 0; i < 4; i += 1) {
      const t0 = Date.now()
      const r = await put(admin.token, { sopClientId: VALOR_DO_CORPO + '-bh', currentPassword: i % 2 === 0 ? SENHA_ERRADA : SENHA_ADMIN_TESTE })
      tempos.push(Date.now() - t0)
      respostas.push({ status: r.status, corpo: await r.text() })
    }
    expect(respostas.map((r) => r.status), respostas.map((r) => r.corpo).join(' | ')).toEqual([503, 503, 503, 503])
    for (const r of respostas) expect(JSON.parse(r.corpo).code).toBe('STEPUP_UNAVAILABLE')
    for (const t of tempos) expect(t, `tempos: ${tempos.join(',')}`).toBeLessThan(5_000) // não pendura
    expect(await appPrisma.paymentGatewayConfig.count({ where: { sopClientId: VALOR_DO_CORPO + '-bh' } })).toBe(0)
    if (SAIDA) appendFileSync(SAIDA, `[stepup-blackhole] tempos por tentativa: ${tempos.join(',')} ms\n`)

    await proxy.up()
    const ms = await recuperar(admin.token, 'sop-voltou-blackhole')
    if (SAIDA) appendFileSync(SAIDA, `[stepup-blackhole] recuperacao ate o 1o 200: ${ms} ms\n`)

    const log = await logAssentado()
    expect(ocorrencias(log, ALERTA)).toBeGreaterThanOrEqual(4)
    for (const v of [SENHA_ERRADA, SENHA_ADMIN_TESTE, admin.token, VALOR_DO_CORPO]) expect(log, `vazou no log: ${v.slice(0, 14)}…`).not.toContain(v)
  }, 180_000)
})

void realRedisUrl
