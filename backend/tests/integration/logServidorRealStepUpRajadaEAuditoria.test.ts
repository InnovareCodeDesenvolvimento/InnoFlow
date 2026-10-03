import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { PrismaClient } from '@prisma/client'
import jwt from 'jsonwebtoken'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { criarBancoProprio } from './helpers/bancoProprio'
import { HASH_SENHA_ADMIN_TESTE, SENHA_ADMIN_TESTE } from './helpers/senhaAdmin'

/**
 * QA da Íris (F5.8, rodada Vega-2) — PROVA NO LOG REAL do step-up, indo além do teste do Vega (`logServidorRealSenhaStepUp`): servidor de verdade
 * (`src/entrypoints/api.ts`, `NODE_ENV=production`, `LOG_LEVEL=info`, transport `pino-pretty`) com
 *   - PUT com senha CERTA gravando os 3 segredos;
 *   - uma RAJADA de senhas ERRADAS em paralelo até o trancamento (5 avaliadas, o resto 429 do step-up);
 *   - o stdout/stderr INTEIRO varrido por senha certa, senha errada, os 3 segredos e o JWT;
 *   - TODAS as linhas de `AuditLog` (serializadas inteiras) e as respostas HTTP varridas pelos mesmos valores;
 *   - os 3 alertas com CONTROLE POSITIVO e contagem (sem ele "não vazou" poderia ser só "o servidor parou de logar"). O transport escreve de uma
 *     thread à parte e o stdout chega ao teste com atraso variável: usa requisição SENTINELA em header não redigido e espera ela aparecer.
 */

const SENHA_ERRADA = 'SENHA-ERRADA-RAJADA-nao-pode-aparecer-ddd444'
const SEG = { merchantKey: 'MKEY-iris-log-real-eee555', sopClientSecret: 'SOPSECRET-iris-log-real-fff666', webhookHeaderSecret: 'WHSECRET-iris-log-real-ggg777-0123456789abcdef' }

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

describe('log REAL + AuditLog do servidor de verdade — step-up: rajada de senhas erradas, nenhum valor sensível, 3 alertas presentes', () => {
  let banco: Awaited<ReturnType<typeof criarBancoProprio>>
  let appPrisma: PrismaClient
  let child: ChildProcess | undefined
  let base = ''
  let saida = ''
  let adminId = ''
  let adminToken = ''

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
  const put = (body: Record<string, unknown>) =>
    fetch(`${base}/api/admin/payment-gateway`, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` }, body: JSON.stringify(body) })
  const ocorrencias = (texto: string, trecho: string) => texto.split(trecho).length - 1

  beforeAll(async () => {
    banco = await criarBancoProprio('pgl')
    process.env.DATABASE_URL = banco.url
    appPrisma = new PrismaClient({ datasources: { db: { url: banco.url } } })
    const admin = await appPrisma.user.create({ data: { role: 'ADMIN', name: 'Admin Log Rajada', email: `admin-log-rajada-${Math.random().toString(36).slice(2, 8)}@example.com`, passwordHash: HASH_SENHA_ADMIN_TESTE } })
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

  it('senha CERTA com 3 segredos + RAJADA de 8 senhas erradas em paralelo: 5 avaliadas (403) e 3 trancadas (429 do step-up); nada sensível no stdout/stderr inteiro, nas respostas nem na AuditLog; os 3 alertas aparecem', async () => {
    const respostasTexto: string[] = []

    const certa = await put({ ...SEG, merchantId: 'mid-iris-log', currentPassword: SENHA_ADMIN_TESTE })
    const certaTexto = await certa.text()
    respostasTexto.push(certaTexto)
    expect(certa.status, certaTexto).toBe(200)
    await new Promise((r) => setTimeout(r, 300)) // o registerSuccess é fire-and-forget

    const rajada = await Promise.all(Array.from({ length: 8 }, (_, i) => put({ sopClientId: 'sop-iris-rajada', currentPassword: `${SENHA_ERRADA}-${i}` })))
    const textos = await Promise.all(rajada.map((r) => r.text()))
    respostasTexto.push(...textos)
    const status = rajada.map((r) => r.status)
    expect(status.filter((s) => s === 403), `status da rajada: ${status.join(',')}`).toHaveLength(5)
    const trancadas = rajada.filter((r, i) => r.status === 429 && textos[i]!.includes('Muitas tentativas de confirmação de senha'))
    expect(trancadas).toHaveLength(3)
    for (const r of trancadas) expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0)

    // depois do trancamento nem a senha CERTA passa (e a config não foi tocada de novo)
    const certaTrancada = await put({ sopClientId: 'sop-iris-trancada', currentPassword: SENHA_ADMIN_TESTE })
    respostasTexto.push(await certaTrancada.text())
    expect(certaTrancada.status).toBe(429)

    const log = await logAssentado()

    // CONTROLE POSITIVO: o servidor loga o que deveria — com contagem
    expect(log).toContain('request completed')
    expect(log).toContain(adminId)
    expect(ocorrencias(log, 'payment_config_changed')).toBe(1)
    expect(ocorrencias(log, 'payment_gateway_stepup_failed'), 'um alerta por senha errada AVALIADA (5)').toBe(5)
    expect(ocorrencias(log, 'payment_gateway_stepup_locked'), '1 no instante do trancamento + 3 da rajada recusadas + 1 da senha certa recusada').toBe(5)
    expect(log).toContain('lockSeconds')
    expect(log).toContain('changedFields')

    // O QUE NÃO PODE ESTAR — no stdout/stderr INTEIRO...
    const proibidos = [SENHA_ADMIN_TESTE, SENHA_ERRADA, ...Object.values(SEG), adminToken, 'mid-iris-log']
    for (const v of proibidos) expect(log, `vazou no log: ${v.slice(0, 12)}…`).not.toContain(v)

    // ...nas respostas HTTP...
    const respostas = respostasTexto.join('\n')
    for (const v of [SENHA_ADMIN_TESTE, SENHA_ERRADA, ...Object.values(SEG)]) expect(respostas, `vazou na resposta: ${v.slice(0, 12)}…`).not.toContain(v)

    // ...e em TODAS as linhas de AuditLog (serializadas inteiras, inclusive `changes`)
    // A auditoria do 403 é gravada em FIRE-AND-FORGET depois da resposta (e do log): sob carga da suíte inteira a 5ª linha chegou depois da leitura (1 flaky em 3 rodadas, F5.8 Vega-4).
    // Espera, com limite, as 5 linhas DENIED de senha errada — o que a asserção abaixo exige — antes de ler; não afrouxa nenhuma contagem.
    const prazo = Date.now() + 15_000
    while ((await appPrisma.auditLog.count({ where: { actionDetail: 'stepup_failed', outcome: 'DENIED' } })) < 5 && Date.now() < prazo) await new Promise((r) => setTimeout(r, 100))
    const linhas = await appPrisma.auditLog.findMany({ orderBy: { occurredAt: 'asc' } })
    expect(linhas.length).toBeGreaterThanOrEqual(1 + 5) // 1 sucesso da config + 5 DENIED de senha errada (controle positivo: a trilha existe)
    const auditoria = JSON.stringify(linhas)
    for (const v of [SENHA_ADMIN_TESTE, SENHA_ERRADA, ...Object.values(SEG), adminToken, 'currentPassword']) expect(auditoria, `vazou na AuditLog: ${v.slice(0, 12)}…`).not.toContain(v)
    expect(linhas.filter((l) => l.actionDetail === 'stepup_failed' && l.outcome === 'DENIED')).toHaveLength(5)
    expect(linhas.filter((l) => l.action === 'PAYMENT_CONFIG_CHANGE' && l.outcome === 'SUCCESS')).toHaveLength(1)

    // as colunas dos segredos no banco estão cifradas (nenhum valor em claro na linha do gateway)
    const cfg = await appPrisma.paymentGatewayConfig.findUniqueOrThrow({ where: { id: 1 } })
    const cfgJson = JSON.stringify(cfg)
    for (const v of Object.values(SEG)) expect(cfgJson).not.toContain(v)
    expect(cfg.merchantKeyCiphertext).toMatch(/^v1:[0-9a-f]{8}:/)
  }, 120_000)
})
