import { execSync, spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { PrismaClient } from '@prisma/client'
import jwt from 'jsonwebtoken'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * O LOG REAL do servidor de verdade — a prova que faltava ao redact da F5.5 (Íris, 02/10/2026).
 *
 * O Vega achou que o `pino-http` logava `req.headers` e o segredo do webhook da Cielo saía EM CLARO a cada
 * notificação (F5.2 em diante), e corrigiu em `lib/logRedactPaths.ts` — mas só provou com o `pino` ISOLADO
 * (`tests/unit/loggerRedact.test.ts`). Isso não prova que o servidor usa o `redact` no `req` que o `pino-http`
 * serializa (a ordem dos middlewares, o transport `pino-pretty` e o `singleLine` são parte do caminho). Aqui sobe-se
 * `src/entrypoints/api.ts` COMO PROCESSO, com `NODE_ENV=production` e `LOG_LEVEL=info`, captura-se o stdout/stderr
 * INTEIRO e procura-se cada segredo nele.
 *
 * CONTROLE POSITIVO (sem ele o teste poderia passar só porque o servidor parou de logar os headers): um header
 * qualquer que NÃO está na lista de redact PRECISA aparecer no log. Se um dia sumir, os testes de "não vaza" deixam de
 * provar alguma coisa — e este controle avisa.
 *
 * BANCO PRÓPRIO (o `PaymentGatewayConfig` é singleton global e as suítes rodam em paralelo — mesma razão de
 * `paymentGatewayConfig.test.ts`): `CREATE DATABASE` + `migrate deploy`, derrubado no `afterAll`.
 */

const BASE_URL = process.env.DATABASE_URL!
const NOME_BANCO = `pgl_${Math.random().toString(36).slice(2, 10)}`
const URL_BANCO = BASE_URL.replace(/\/[^/?]+(\?|$)/, `/${NOME_BANCO}$1`)

const PATH_TOKEN = 'pathtoken-log-real-9d8c7b6a'
const HEADER_SECRET_ENV = 'ENVHDRSECRET-log-real-aaa111'
const CONTROLE_POSITIVO = 'CONTROLEPOSITIVO-valor-visivel-no-log'
const SEGREDOS_PUT = {
  merchantKey: 'MKEY-log-real-bbb222',
  sopClientSecret: 'SOPSECRET-log-real-ccc333',
  webhookHeaderSecret: 'WHSECRET-log-real-ddd444-0123456789abcdef', // 40 caracteres (mínimo 32, B2)
}

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

describe('log REAL do servidor (NODE_ENV=production, LOG_LEVEL=info) — nenhum segredo do gateway/webhook em claro', () => {
  let adminPrisma: PrismaClient
  let appPrisma: PrismaClient
  let child: ChildProcess | undefined
  let base = ''
  let saida = ''
  let adminToken = ''

  /**
   * Devolve o log JÁ FLUSHADO até aqui. O transport `pino-pretty` escreve de uma thread à parte e o stdout chega ao teste
   * com atraso variável (medido: de milissegundos a vários segundos sob carga) — "esperar o log silenciar" dá falso
   * NEGATIVO (nada chegou ainda => "não vazou"). Em vez de adivinhar tempo: faz-se uma requisição SENTINELA com um
   * valor único num header (que não está na lista de redact) e espera-se esse valor aparecer. O log é ordenado
   * (uma thread só), então quando a sentinela aparece, tudo o que veio antes dela já está em `saida`.
   */
  async function logAssentado(): Promise<string> {
    const sentinela = `SENTINELA-${Math.random().toString(36).slice(2, 12)}`
    await fetch(`${base}/health`, { headers: { 'x-sentinela': sentinela } })
    const deadline = Date.now() + 20_000
    while (!saida.includes(sentinela)) {
      if (Date.now() > deadline) throw new Error(`a requisição sentinela nunca apareceu no log em 20s — captura do stdout quebrada:
${saida.slice(-2000)}`)
      await new Promise((r) => setTimeout(r, 50))
    }
    return saida
  }

  beforeAll(async () => {
    adminPrisma = new PrismaClient({ datasources: { db: { url: BASE_URL } } })
    await adminPrisma.$executeRawUnsafe(`CREATE DATABASE "${NOME_BANCO}"`)
    execSync('npx prisma migrate deploy', { env: { ...process.env, DATABASE_URL: URL_BANCO }, stdio: 'pipe', cwd: process.cwd() })

    appPrisma = new PrismaClient({ datasources: { db: { url: URL_BANCO } } })
    const admin = await appPrisma.user.create({ data: { role: 'ADMIN', name: 'Admin Log Real', email: `admin-log-real-${Math.random().toString(36).slice(2, 8)}@example.com` } })
    adminToken = jwt.sign({ userId: admin.id, role: 'ADMIN', operatorId: null }, process.env.JWT_SECRET!, { algorithm: 'HS256', expiresIn: '1h' })

    const porta = await portaLivre()
    base = `http://127.0.0.1:${porta}`
    const envFilho: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: 'production',
      LOG_LEVEL: 'info',
      PORT: String(porta),
      DATABASE_URL: URL_BANCO,
      CIELO_WEBHOOK_PATH_TOKEN: PATH_TOKEN,
      CIELO_WEBHOOK_HEADER_SECRET: HEADER_SECRET_ENV,
    }
    for (const k of ['CIELO_MERCHANT_ID', 'CIELO_MERCHANT_KEY', 'CIELO_SOP_CLIENT_ID', 'CIELO_SOP_CLIENT_SECRET', 'PUBLIC_API_BASE_URL', 'CIELO_API_BASE_URL', 'CIELO_API_QUERY_BASE_URL', 'PAYMENT_ALLOW_FAKE_ADAPTER']) delete envFilho[k]

    // `node tsx/cli.mjs` direto (não `npx`): o PID do filho é o do servidor e o `kill` o encerra de verdade (Windows inclusive).
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
    await adminPrisma?.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${NOME_BANCO}" WITH (FORCE)`)
    await adminPrisma?.$disconnect()
  }, 60_000)

  const webhook = (headerSecret: string | null, path = PATH_TOKEN) =>
    fetch(`${base}/api/webhooks/cielo/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-controle-positivo': CONTROLE_POSITIVO, ...(headerSecret ? { 'x-innoelektron-webhook-secret': headerSecret } : {}) },
      body: JSON.stringify({ PaymentId: 'pagamento-desconhecido-log-real', ChangeType: 1 }),
    })

  it('CONTROLE POSITIVO: o servidor loga os headers da requisição (um header fora da lista de redact aparece) — senão os testes abaixo não provariam nada', async () => {
    const r = await webhook(HEADER_SECRET_ENV)
    expect(r.status).toBe(200)
    const log = await logAssentado()
    expect(log).toContain(CONTROLE_POSITIVO)
    expect(log).toContain('request completed')
    expect(log).toContain('[redacted]')
  })

  it('webhook ACEITO: o segredo do header (valor em claro) NÃO aparece no stdout/stderr inteiro do servidor', async () => {
    const r = await webhook(HEADER_SECRET_ENV)
    expect(r.status).toBe(200)
    expect(await logAssentado()).not.toContain(HEADER_SECRET_ENV)
  })

  it('webhook com segredo ERRADO (401): nem o valor que o atacante mandou nem o esperado aparecem no log', async () => {
    const tentativa = 'TENTATIVA-de-adivinhar-o-segredo-xyz'
    const r = await webhook(tentativa)
    expect(r.status).toBe(401)
    const log = await logAssentado()
    expect(log).not.toContain(tentativa)
    expect(log).not.toContain(HEADER_SECRET_ENV)
  })

  it('PUT /api/admin/payment-gateway com segredos no corpo (200): nem o corpo, nem o Authorization, nem o segredo do webhook trocado vão para o log', async () => {
    const r = await fetch(`${base}/api/admin/payment-gateway`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}`, 'x-controle-positivo': CONTROLE_POSITIVO },
      body: JSON.stringify({ merchantId: 'mid-log-real', ...SEGREDOS_PUT, pixEnabled: true }),
    })
    expect(r.status, await r.clone().text()).toBe(200)
    const log = await logAssentado()
    for (const segredo of Object.values(SEGREDOS_PUT)) expect(log).not.toContain(segredo)
    expect(log).not.toContain(adminToken)

    // e a mudança vale na hora: o segredo do banco passou a ser o do webhook (o do env deixou de valer) — prova que o PUT de fato rodou
    expect((await webhook(SEGREDOS_PUT.webhookHeaderSecret)).status).toBe(200)
    expect((await webhook(HEADER_SECRET_ENV)).status).toBe(401)
    const logDepois = await logAssentado()
    expect(logDepois).not.toContain(SEGREDOS_PUT.webhookHeaderSecret)
    expect(logDepois).not.toContain(HEADER_SECRET_ENV)
  })

  it('PUT recusado (400/409): os valores enviados não vão para o log nem para a resposta de erro', async () => {
    const segredoRecusado = 'MKEY-RECUSADA-nao-pode-aparecer-eee555'
    const r409 = await fetch(`${base}/api/admin/payment-gateway`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ cardEnabled: true, merchantKey: segredoRecusado }), // cartão sem SOP => GATEWAY_NOT_READY
    })
    expect(r409.status).toBe(409)
    expect(await r409.text()).not.toContain(segredoRecusado)

    const r400 = await fetch(`${base}/api/admin/payment-gateway`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ merchantkey: segredoRecusado }), // typo de campo => 400 strict
    })
    expect(r400.status).toBe(400)
    expect(await r400.text()).not.toContain(segredoRecusado)
    expect(await logAssentado()).not.toContain(segredoRecusado)
  })

  /**
   * Força uma falha de verdade na GRAVAÇÃO do PUT: a constraint barra qualquer linha com `merchantKeyCiphertext` (o
   * Postgres devolve 23514 e o erro sobe pelo errorHandler como 5xx). Devolve o log inteiro.
   */
  async function provocarErro500NoPut(segredo: string): Promise<{ log: string }> {
    await appPrisma.$executeRawUnsafe(`ALTER TABLE "PaymentGatewayConfig" ADD CONSTRAINT iris_barra_chave CHECK ("merchantKeyCiphertext" IS NULL) NOT VALID`)
    try {
      const r = await fetch(`${base}/api/admin/payment-gateway`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ merchantKey: segredo, merchantId: 'mid-500' }),
      })
      expect(r.status, await r.clone().text()).toBe(500)
      const log = await logAssentado()
      expect(log).toContain('erro não tratado') // o caminho de erro DE FATO foi exercitado e logado
      // e o Postgres/Prisma devolveu a linha rejeitada ("Failing row contains (...)") na mensagem do erro — o log traz o marcador no lugar (F5.7 B3)
      expect(log).toContain('[linha rejeitada pelo banco omitida do log]')
      return { log }
    } finally {
      await appPrisma.$executeRawUnsafe(`ALTER TABLE "PaymentGatewayConfig" DROP CONSTRAINT IF EXISTS iris_barra_chave`)
    }
  }

  it('erro 500 NÃO TRATADO no PUT (o banco recusa a gravação): o SEGREDO EM CLARO enviado nunca chega ao log (o `err` do Prisma não carrega o corpo)', async () => {
    const segredo500 = 'MKEY-500-nao-pode-aparecer-fff666'
    const { log } = await provocarErro500NoPut(segredo500)
    expect(log).not.toContain(segredo500)
  })

  // ACHADO INFORMATIVO/BAIXO (Íris, 02/10/2026 — para o Órion decidir): o `DETAIL` do Postgres ("Failing row contains (...)") vai
  // dentro da mensagem do erro do Prisma e entra no log 3 vezes (stderr cru do engine do Prisma — que NEM PASSA pelo `redact` do
  // pino —, `err.message` e `err.stack`), com os `*Ciphertext` TRUNCADOS em 64 caracteres. Nunca o segredo em claro (a cifragem é
  // antes do Prisma) e só com uma falha de gravação no banco (constraint), mas o texto cifrado é justamente o que esta tela promete
  // nunca logar. CORRIGIDO (Vega, F5.7 B3): o log do engine do Prisma sai como evento pelo nosso logger e o serializer do `err` limpa o `Failing row contains (...)` (`lib/logSerializers.ts`); `it.fails` virou `it`, asserção inalterada.
  it('(achado baixo, corrigido na F5.7 B3) o erro de gravação no banco NÃO despeja pedaço do texto cifrado das credenciais no log', async () => {
    const { log } = await provocarErro500NoPut('MKEY-500b-nao-pode-aparecer-ggg777')
    expect(log).not.toContain('Failing row contains') // a linha rejeitada (com os `*Ciphertext` truncados) é o que não deve ir para o log
  })

  // DECISÃO REGISTRADA (não é defeito aberto): o `pathToken` do webhook vai NO CAMINHO, então o `url` que o `pino-http` loga em TODA
  // notificação o traz em claro. O desenho aceita isso — o `pathToken` é só roteamento e o segredo DE VERDADE é o header
  // (`webhooksCielo.routes.ts`), que o redact protege (testes acima). Fixado aqui para que mudar isto (redact do `url`) seja
  // deliberado e visível, e para o Órion saber que quem lê o log do EasyPanel vê metade do par de segredos.
  it('documentado: o `pathToken` do webhook aparece em claro no `req.url` do log (o segredo de verdade é o header, que NÃO aparece)', async () => {
    const log = await logAssentado()
    expect(log).toContain(`/api/webhooks/cielo/${PATH_TOKEN}`)
    expect(log).not.toContain(HEADER_SECRET_ENV)
  })
})
