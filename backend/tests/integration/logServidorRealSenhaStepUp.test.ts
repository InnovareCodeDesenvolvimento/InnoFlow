import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { PrismaClient } from '@prisma/client'
import jwt from 'jsonwebtoken'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { criarBancoProprio } from './helpers/bancoProprio'
import { HASH_SENHA_ADMIN_TESTE, SENHA_ADMIN_TESTE } from './helpers/senhaAdmin'

/**
 * O LOG REAL do servidor de verdade (`NODE_ENV=production`, `LOG_LEVEL=info`, transport `pino-pretty`) NÃO contém a senha do step-up
 * do `PUT /api/admin/payment-gateway` (F5.7, M2) — nem a errada nem a certa — e CONTÉM os dois alertas (controle positivo: sem ele o teste
 * passaria só porque o servidor parou de logar). Mesmo desenho de `logServidorRealSegredosGateway.test.ts` (Íris): processo filho
 * real, captura do stdout/stderr INTEIRO e requisição SENTINELA (o transport escreve de uma thread à parte, com atraso variável).
 */

const SENHA_ERRADA = 'SENHA-ERRADA-nao-pode-aparecer-aaa111'
const SEGREDO_PUT = 'MKEY-stepup-log-real-bbb222'

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

describe('log REAL do servidor — a senha do step-up nunca aparece; os alertas aparecem', () => {
  let banco: Awaited<ReturnType<typeof criarBancoProprio>>
  let appPrisma: PrismaClient
  let child: ChildProcess | undefined
  let base = ''
  let saida = ''
  let adminId = ''
  let adminToken = ''

  async function logAssentado(): Promise<string> {
    const sentinela = `SENTINELA-${Math.random().toString(36).slice(2, 12)}`
    await fetch(`${base}/health`, { headers: { 'x-request-id': sentinela } })
    const deadline = Date.now() + 20_000
    while (!saida.includes(sentinela)) {
      if (Date.now() > deadline) throw new Error(`a requisição sentinela nunca apareceu no log em 20s:\n${saida.slice(-1500)}`)
      await new Promise((r) => setTimeout(r, 50))
    }
    return saida
  }

  const put = (body: Record<string, unknown>) =>
    fetch(`${base}/api/admin/payment-gateway`, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` }, body: JSON.stringify(body) })

  beforeAll(async () => {
    banco = await criarBancoProprio('pgk')
    process.env.DATABASE_URL = banco.url
    appPrisma = new PrismaClient({ datasources: { db: { url: banco.url } } })
    const admin = await appPrisma.user.create({ data: { role: 'ADMIN', name: 'Admin Step-up Log', email: `admin-stepup-log-${Math.random().toString(36).slice(2, 8)}@example.com`, passwordHash: HASH_SENHA_ADMIN_TESTE } })
    adminId = admin.id
    adminToken = jwt.sign({ userId: admin.id, role: 'ADMIN', operatorId: null }, process.env.JWT_SECRET!, { algorithm: 'HS256', expiresIn: '1h' })

    const porta = await portaLivre()
    base = `http://127.0.0.1:${porta}`
    const envFilho: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production', LOG_LEVEL: 'info', PORT: String(porta), DATABASE_URL: banco.url }
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
    await appPrisma?.$disconnect()
    await banco?.descartar()
  }, 60_000)

  it('senha ERRADA (403) e senha CERTA (200): nenhuma das duas, nem o segredo do corpo, nem o token, aparece no stdout/stderr inteiro; os alertas aparecem (controle positivo)', async () => {
    const errada = await put({ sopClientId: 'sop-log', currentPassword: SENHA_ERRADA })
    expect(errada.status, await errada.clone().text()).toBe(403)
    expect(await errada.text()).not.toContain(SENHA_ERRADA)

    const certa = await put({ merchantId: 'mid-log', merchantKey: SEGREDO_PUT, currentPassword: SENHA_ADMIN_TESTE })
    expect(certa.status, await certa.clone().text()).toBe(200)
    expect(await certa.text()).not.toContain(SENHA_ADMIN_TESTE)

    const log = await logAssentado()
    // controle positivo: o servidor loga o que deveria
    expect(log).toContain('request completed')
    expect(log).toContain('payment_gateway_stepup_failed')
    expect(log).toContain('payment_config_changed')
    expect(log).toContain(adminId) // o alerta carrega o id do ator
    // o que NÃO pode estar
    expect(log).not.toContain(SENHA_ERRADA)
    expect(log).not.toContain(SENHA_ADMIN_TESTE)
    expect(log).not.toContain(SEGREDO_PUT)
    expect(log).not.toContain(adminToken)
    // o alerta de mudança traz NOMES de campo, não valores
    expect(log).toContain('changedFields')
    expect(log).not.toContain('mid-log')
  })

  it('PUT com corpo inválido (400) + senha no corpo: a senha também não vai para o log (nem pelo caminho do erro de validação)', async () => {
    const senhaMarcada = 'SENHA-NO-400-nao-pode-aparecer-ccc333'
    const r = await put({ campoInexistente: 1, currentPassword: senhaMarcada })
    expect(r.status).toBe(400)
    expect(await r.text()).not.toContain(senhaMarcada)
    expect(await logAssentado()).not.toContain(senhaMarcada)
  })
})
