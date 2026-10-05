/**
 * Backup automático — ROTAS ADMIN `/api/admin/backup` (+ callback público do Google) ponta a ponta contra Postgres e Redis REAIS (banco próprio: `BackupConfig` é singleton global),
 * S3 falso (que confere SigV4) e Google falso. Prova: só ADMIN (OPERATOR/DRIVER 403 em TODAS as rotas); step-up obrigatório/fail-closed e a tranca de tentativas; segredo NUNCA em
 * resposta/log/auditoria e cifrado no banco; anti-SSRF e anti-exfiltração; ligar exige destino+chave; chave mostrada UMA vez (no-store); executar/conferir são assíncronos, sem duplicidade
 * (inclusive duplo clique); histórico paginado com CÓDIGO de erro; testar destino sempre 200 com o resultado; auditoria fail-closed (trigger real no banco); rate limit; o fluxo OAuth
 * do Google inteiro (state de uso único, replay, forjado, expirado, sem refresh token, desconectar). NÃO prova S3/Drive REAIS.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { criarBancoProprio } from './helpers/bancoProprio'
import { HASH_SENHA_ADMIN_TESTE, SENHA_ADMIN_TESTE } from './helpers/senhaAdmin'
import { binarioDoPg, ferramentasDoPgDisponiveis, prepararAmbienteDoPg } from './helpers/backupAmbiente'
import { iniciarS3Falso, type S3Falso } from '../helpers/s3Falso'
import { iniciarGoogleFalso, type GoogleFalso } from '../helpers/googleFalso'

const ACCESS = 'AKIAAPIMARCADORUNICO55'
const SECRET = 'SegredoS3-ApiMarcador-Unico-0a1b2c3d4e5f'
const CLIENT_ID = 'cliente-api-123.apps.googleusercontent.com'
const CLIENT_SECRET = 'SegredoDoAppGoogle-Marcador-Unico-777'
const temPg = ferramentasDoPgDisponiveis()
void binarioDoPg

type Mods = {
  createApp: typeof import('../../src/api/app').createApp
  prisma: typeof import('../../src/lib/prisma').prisma
  redis: typeof import('../../src/lib/redis').redis
  env: Record<string, unknown>
  logger: typeof import('../../src/lib/logger').logger
  issueToken: typeof import('../../src/lib/jwt').issueToken
  sec: typeof import('../../src/lib/crypto/paymentSecrets')
  bc: typeof import('../../src/lib/crypto/backupCrypto')
  ped: typeof import('../../src/services/backup/pedidosDeBackup')
  drive: typeof import('../../src/lib/backup/drive')
  throttle: typeof import('../../src/api/lib/loginThrottleInstance').stepUpThrottle
  exe: typeof import('../../src/services/backup/executarBackup')
  ver: typeof import('../../src/services/backup/verificarBackup')
}

const dump = (v: unknown): string => JSON.stringify(v, (_k, x) => (x instanceof Error ? { name: x.name, message: x.message, stack: x.stack } : typeof x === 'bigint' ? Number(x) : x))

describe('backup — rotas ADMIN (Postgres + Redis reais, S3 e Google falsos)', () => {
  let m: Mods
  let app: ReturnType<Mods['createApp']>
  let banco: Awaited<ReturnType<typeof criarBancoProprio>>
  let s3f: S3Falso
  let google: GoogleFalso
  let restaurarGoogle: () => void
  const logsTodos: string[] = []
  const alertas: Array<Record<string, unknown>> = []
  const enfileirados: Array<{ tipo: string; runId: string; criadoPorId: string }> = []
  const envSalvo: Record<string, string | undefined> = {}
  let contador = 0

  beforeAll(async () => {
    prepararAmbienteDoPg()
    banco = await criarBancoProprio('bka')
    s3f = await iniciarS3Falso({ bucket: 'bkt', accessKeyId: ACCESS, secretAccessKey: SECRET })
    google = await iniciarGoogleFalso({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, email: 'dono@gmail.example' })
    const [appMod, prismaMod, redisMod, envMod, loggerMod, jwtMod, secMod, bcMod, pedMod, driveMod, thMod, exe, ver] = await Promise.all([
      import('../../src/api/app'),
      import('../../src/lib/prisma'),
      import('../../src/lib/redis'),
      import('../../src/lib/env'),
      import('../../src/lib/logger'),
      import('../../src/lib/jwt'),
      import('../../src/lib/crypto/paymentSecrets'),
      import('../../src/lib/crypto/backupCrypto'),
      import('../../src/services/backup/pedidosDeBackup'),
      import('../../src/lib/backup/drive'),
      import('../../src/api/lib/loginThrottleInstance'),
      import('../../src/services/backup/executarBackup'),
      import('../../src/services/backup/verificarBackup'),
    ])
    m = { createApp: appMod.createApp, prisma: prismaMod.prisma, redis: redisMod.redis, env: envMod.env as unknown as Record<string, unknown>, logger: loggerMod.logger, issueToken: jwtMod.issueToken, sec: secMod, bc: bcMod, ped: pedMod, drive: driveMod, throttle: thMod.stepUpThrottle, exe, ver }
    app = m.createApp()
    restaurarGoogle = m.drive.definirUrlsDoGoogleParaTeste({ api: `${google.base}/drive/v3`, upload: `${google.base}/upload/drive/v3`, token: `${google.base}/token`, revogar: `${google.base}/revoke` })
    for (const nivel of ['info', 'warn', 'error', 'debug'] as const) {
      const original = m.logger[nivel].bind(m.logger) as (...a: unknown[]) => void
      vi.spyOn(m.logger, nivel).mockImplementation(((...args: unknown[]) => {
        logsTodos.push(dump(args))
        if (typeof args[0] === 'object' && args[0] && typeof (args[0] as { alert?: unknown }).alert === 'string') alertas.push(args[0] as Record<string, unknown>)
        original(...args)
      }) as never)
    }
    m.ped.definirEnfileiradorParaTeste(async (p) => void enfileirados.push(p))
    envSalvo.PAYMENT_SECRETS_KEY = m.env.PAYMENT_SECRETS_KEY as string | undefined
    envSalvo.PUBLIC_APP_URL = process.env.PUBLIC_APP_URL
    envSalvo.PUBLIC_API_BASE_URL = process.env.PUBLIC_API_BASE_URL
    process.env.PUBLIC_APP_URL = 'https://painel.exemplo.com.br'
  }, 180_000)

  afterAll(async () => {
    vi.restoreAllMocks()
    m?.ped.definirEnfileiradorParaTeste(null)
    restaurarGoogle?.()
    process.env.PUBLIC_APP_URL = envSalvo.PUBLIC_APP_URL
    await m?.prisma.$disconnect()
    m?.redis.disconnect()
    await banco?.descartar()
    await s3f?.fechar()
    await google?.fechar()
  }, 60_000)

  beforeEach(async () => {
    await m.prisma.backupRun.deleteMany()
    await m.prisma.$executeRawUnsafe(
      `UPDATE "BackupConfig" SET "enabled"=false, "enabledAt"=NULL, "hourLocal"=3, "frequencyDays"=1, "retentionCount"=7, "alertAfterHours"=36, "destination"=NULL,
        "s3Endpoint"=NULL, "s3Region"=NULL, "s3Bucket"=NULL, "s3Prefix"=NULL, "s3AccessKeyCiphertext"=NULL, "s3SecretKeyCiphertext"=NULL,
        "driveOauthClientId"=NULL, "driveOauthClientSecretCiphertext"=NULL, "driveOauthRefreshTokenCiphertext"=NULL, "driveOauthEmail"=NULL, "driveOauthFolderId"=NULL,
        "driveOauthConnectedAt"=NULL, "driveOauthConnectedById"=NULL, "oauthStateNonce"=NULL, "oauthStateExpiresAt"=NULL, "oauthStateAdminId"=NULL,
        "encryptionKeyFingerprint"=NULL, "encryptionKeyCiphertext"=NULL, "encryptionKeyCreatedAt"=NULL, "encryptionKeyShownAt"=NULL,
        "lastSuccessAt"=NULL, "lastAttemptAt"=NULL, "runningSince"=NULL, "lastStaleAlertAt"=NULL WHERE "id"=1`,
    )
    s3f.objetos.clear()
    s3f.requisicoes.length = 0
    google.arquivos.clear()
    google.reabrirAcesso()
    google.semRefreshTokenNaProximaTroca = false
    logsTodos.length = 0
    alertas.length = 0
    enfileirados.length = 0
  })
  afterEach(() => {
    m.env.PAYMENT_SECRETS_KEY = envSalvo.PAYMENT_SECRETS_KEY // (baseline é `undefined` desde a chave derivada do JWT_SECRET: atribuir direto, sem `??`, senão o override inválido de um teste vaza para o próximo)
    m.sec.resetPaymentSecretsKeyCacheParaTeste()
  })

  async function novoUsuario(role: 'ADMIN' | 'OPERATOR' | 'DRIVER' = 'ADMIN') {
    contador += 1
    const sufixo = `${contador}-${Math.random().toString(36).slice(2, 7)}`
    let operatorId: string | null = null
    if (role === 'OPERATOR') operatorId = (await m.prisma.operator.create({ data: { name: `Op ${sufixo}`, email: `op-${sufixo}@example.com` } })).id
    const user = await m.prisma.user.create({ data: { role, name: `${role} ${sufixo}`, email: `${role.toLowerCase()}-${sufixo}@example.com`, operatorId, passwordHash: HASH_SENHA_ADMIN_TESTE } })
    return { id: user.id, token: m.issueToken({ id: user.id, role, operatorId }), ip: `10.${50 + (contador >> 8)}.${contador & 255}.7` }
  }
  // Cada usuário sai de um IP próprio (X-Forwarded-For, trust proxy = 1): o teto GERAL por IP (300/min) não mistura as suítes nem os testes deste arquivo.
  type U = { id: string; token: string; ip: string }
  const auth = (u: U) => ({ Authorization: `Bearer ${u.token}`, 'X-Forwarded-For': u.ip })
  const B = '/api/admin/backup'
  const get = (u: U, rota: string) => request(app).get(`${B}${rota}`).set(auth(u))
  const post = (u: U, rota: string, body: Record<string, unknown> = {}) => request(app).post(`${B}${rota}`).set(auth(u)).send(body)
  const put = (u: U, body: Record<string, unknown>) => request(app).put(`${B}/config`).set(auth(u)).send(body)
  const senha = { currentPassword: SENHA_ADMIN_TESTE }
  const s3Completo = () => ({ endpoint: s3f.url, region: 'us-east-1', bucket: 'bkt', prefix: 'inno', accessKey: ACCESS, secretKey: SECRET })
  const salvarS3 = (u: U, extra: Record<string, unknown> = {}) => put(u, { ...senha, destination: 'S3', s3: s3Completo(), ...extra })
  const gerarChave = (u: U, extra: Record<string, unknown> = {}) => post(u, '/key', { ...senha, ...extra })
  const esperarAuditoria = async (userId: string, n: number) => {
    const limite = Date.now() + 5000
    let l = await m.prisma.auditLog.findMany({ where: { actorUserId: userId }, orderBy: { occurredAt: 'asc' } })
    while (l.length < n && Date.now() < limite) {
      await new Promise((r) => setTimeout(r, 50))
      l = await m.prisma.auditLog.findMany({ where: { actorUserId: userId }, orderBy: { occurredAt: 'asc' } })
    }
    return l
  }
  const cfg = () => m.prisma.backupConfig.findUniqueOrThrow({ where: { id: 1 } })

  // ---------------------------------------------------------------------------------------------------------------------------------
  describe('acesso: só ADMIN', () => {
    it('sem token 401; OPERATOR e DRIVER 403 em TODAS as rotas — e nada muda', async () => {
      const op = await novoUsuario('OPERATOR')
      const dr = await novoUsuario('DRIVER')
      const antes = dump(await cfg())
      expect((await request(app).get(`${B}/config`)).status).toBe(401)
      expect((await request(app).post(`${B}/run`).send({})).status).toBe(401)
      for (const u of [op, dr]) {
        expect((await get(u, '/config')).status).toBe(403)
        expect((await put(u, { ...senha, retentionCount: 3 })).status).toBe(403)
        expect((await get(u, '/status')).status).toBe(403)
        expect((await post(u, '/key', senha)).status).toBe(403)
        expect((await post(u, '/run')).status).toBe(403)
        expect((await post(u, '/verify')).status).toBe(403)
        expect((await post(u, '/test-destination')).status).toBe(403)
        expect((await get(u, '/runs')).status).toBe(403)
        expect((await get(u, '/runs/ckxxxxxxxxxxxxxxxxxxxxxxx')).status).toBe(403)
        expect((await post(u, '/google/start', senha)).status).toBe(403)
        expect((await post(u, '/google/disconnect', senha)).status).toBe(403)
      }
      expect(dump(await cfg())).toBe(antes)
      expect(await m.prisma.backupRun.count()).toBe(0)
      expect(enfileirados).toEqual([])
    })
  })

  // ---------------------------------------------------------------------------------------------------------------------------------
  describe('GET /config e PUT /config', () => {
    it('GET: padrões, nada configurado, sem segredo, com o que falta para ligar', async () => {
      const admin = await novoUsuario()
      const res = await get(admin, '/config')
      expect(res.status, dump(res.body)).toBe(200)
      expect(res.headers['cache-control']).toBe('no-store')
      expect(res.body).toMatchObject({
        enabled: false,
        hourLocal: 3,
        frequencyDays: 1,
        retentionCount: 7,
        alertAfterHours: 36,
        destination: null,
        destinationReady: false,
        s3: { endpoint: null, accessKeySet: false, secretKeySet: false },
        drive: { clientId: null, clientSecretSet: false, connected: false, accountEmail: null },
        encryptionKey: { exists: false, fingerprint: null },
        secretsKeyConfigured: true,
        secretsReadable: true,
        problemsToEnable: ['DESTINATION_INCOMPLETE', 'KEY_MISSING'],
      })
    })

    it('validação: 400 para campo desconhecido, faixas, endereço ruim, bucket ruim, controle no segredo — e NADA é gravado', async () => {
      let admin = await novoUsuario()
      let usados = 0
      const antes = dump(await cfg())
      for (const body of [
        { ...senha, hourLocal: 24 },
        { ...senha, hourLocal: -1 },
        { ...senha, frequencyDays: 3 },
        { ...senha, retentionCount: 0 },
        { ...senha, retentionCount: 366 },
        { ...senha, alertAfterHours: 5 },
        { ...senha, destination: 'FTP' },
        { ...senha, campoQueNaoExiste: 1 },
        { ...senha, s3: { bucket: '../etc' } },
        { ...senha, s3: { region: 'us east 1' } },
        { ...senha, s3: { prefix: 'a;b' } },
        { ...senha, s3: { secretKey: 'com\u0000controle' } },
        { ...senha, s3: { naoExiste: 1 } },
        { ...senha, clearSecrets: ['qualquerCoisa'] },
      ]) {
        if (usados === 8) {
          admin = await novoUsuario() // o limite de escritas (10/min) é por ADMIN e conta as 400
          usados = 0
        }
        usados += 1
        const res = await put(admin, body)
        expect(res.status, dump(body)).toBe(400)
        expect(res.body.code, dump(body)).toBe('VALIDATION_ERROR')
      }
      expect(dump(await cfg())).toBe(antes)
      // Endereço que não é URL: recusado pelo serviço (depende da política do ambiente), com código próprio.
      const url = await put(admin, { ...senha, s3: { endpoint: 'isto nao e url' } })
      expect(url.status).toBe(400)
      expect(url.body.code).toBe('INVALID_URL')
      expect(dump(await cfg())).toBe(antes)
    })

    it('step-up: horário/frequência/alerta e DESLIGAR dispensam a senha; tudo o mais (destino, segredo, retenção, ligar) exige — sem senha 400, errada 403 (DENIED, nada gravado, a senha nunca vaza)', async () => {
      const admin = await novoUsuario()
      expect((await put(admin, { hourLocal: 5, frequencyDays: 2, alertAfterHours: 48 })).status).toBe(200)
      expect((await put(admin, { enabled: false })).status).toBe(200)
      for (const corpo of [{ retentionCount: 3 }, { destination: 'S3' }, { s3: { bucket: 'x-bucket' } }, { enabled: true }, { drive: { clientId: 'x' } }, { clearSecrets: ['s3SecretKey'] }]) {
        const sem = await put(admin, corpo)
        expect(sem.status, dump(corpo)).toBe(400)
        expect(sem.body.code).toBe('CURRENT_PASSWORD_REQUIRED')
      }
      const ERRADA = 'SenhaErrada#Marcador-Unico-55ab'
      const res = await put(admin, { currentPassword: ERRADA, retentionCount: 3 })
      expect(res.status).toBe(403)
      expect(res.body.code).toBe('INVALID_CURRENT_PASSWORD')
      expect((await cfg()).retentionCount).toBe(7)
      const linhas = await esperarAuditoria(admin.id, 3)
      const negada = linhas.find((l) => l.outcome === 'DENIED')
      expect(negada).toMatchObject({ httpStatus: 403, entityType: 'BackupConfig', actionDetail: 'backup_config:stepup_failed' })
      expect(dump(linhas) + logsTodos.join('')).not.toContain(ERRADA)
      expect(dump(linhas) + logsTodos.join('')).not.toContain(SENHA_ADMIN_TESTE)
    })

    it('step-up FAIL-CLOSED: throttle (Redis) indisponível => 503 STEPUP_UNAVAILABLE e nada gravado, mesmo com a senha certa', async () => {
      const admin = await novoUsuario()
      const espiao = vi.spyOn(m.throttle, 'reserveAttempt').mockRejectedValue(new Error('redis fora'))
      try {
        const res = await put(admin, { ...senha, retentionCount: 3 })
        expect(res.status, dump(res.body)).toBe(503)
        expect(res.body.code).toBe('STEPUP_UNAVAILABLE')
      } finally {
        espiao.mockRestore()
      }
      expect((await cfg()).retentionCount).toBe(7)
    })

    it('tranca de tentativas: senha errada demais => 429 RATE_LIMITED_BACKUP com Retry-After (e não o código do gateway)', async () => {
      const admin = await novoUsuario()
      let ultimo = await put(admin, { currentPassword: 'errada-0', retentionCount: 3 })
      for (let i = 1; i < 8 && ultimo.status === 403; i += 1) ultimo = await put(admin, { currentPassword: `errada-${i}`, retentionCount: 3 })
      expect(ultimo.status, dump(ultimo.body)).toBe(429)
      expect(ultimo.body.code).toBe('RATE_LIMITED_BACKUP')
      expect(Number(ultimo.headers['retry-after'])).toBeGreaterThan(0)
      // Trancado: nem a senha certa passa enquanto dura a tranca.
      expect((await put(admin, { ...senha, retentionCount: 3 })).status).toBe(429)
      expect((await cfg()).retentionCount).toBe(7)
    })

    it('SEM PAYMENT_SECRETS_KEY (modo padrão, chave derivada do JWT_SECRET): gravar credencial e gerar a chave FUNCIONA — MUDANÇA DELIBERADA, como no InnoChat', async () => {
      const admin = await novoUsuario()
      expect(m.env.PAYMENT_SECRETS_KEY).toBeUndefined()
      const res = await salvarS3(admin)
      expect(res.status, dump(res.body)).toBe(200)
      expect(res.body.secretsKeyConfigured).toBe(true)
      expect((await cfg()).s3AccessKeyCiphertext).not.toBeNull()
      expect((await post(admin, '/key', senha)).status).toBe(201)
    })

    it('chave-mestra INDISPONÍVEL (override PAYMENT_SECRETS_KEY definido e inválido): gravar credencial => 503 SECRETS_KEY_MISSING; sem credencial continua funcionando', async () => {
      const admin = await novoUsuario()
      m.env.PAYMENT_SECRETS_KEY = 'isto-nao-e-uma-chave-base64-de-32-bytes'
      m.sec.resetPaymentSecretsKeyCacheParaTeste()
      const res = await salvarS3(admin)
      expect(res.status).toBe(503)
      expect(res.body.code).toBe('SECRETS_KEY_MISSING')
      expect((await cfg()).s3AccessKeyCiphertext).toBeNull()
      expect((await put(admin, { ...senha, retentionCount: 5 })).status).toBe(200)
      expect((await post(admin, '/key', senha)).status).toBe(503) // gerar chave também precisa
    })

    it('grava o S3: segredos NUNCA voltam (só "set"), ficam CIFRADOS no banco, auditados sem segredo (uma linha), e o alerta de mudança sai com NOMES de campos', async () => {
      const admin = await novoUsuario()
      const res = await salvarS3(admin)
      expect(res.status, dump(res.body)).toBe(200)
      expect(res.body).toMatchObject({ destination: 'S3', destinationReady: true, s3: { endpoint: s3f.url, region: 'us-east-1', bucket: 'bkt', prefix: 'inno', accessKeySet: true, secretKeySet: true } })
      const corpo = dump(res.body)
      for (const s of [ACCESS, SECRET, SENHA_ADMIN_TESTE, 'Ciphertext']) expect(corpo, s).not.toContain(s)
      expect((await get(admin, '/config')).body.s3).not.toHaveProperty('secretKey')

      const linha = await cfg()
      expect(linha.s3AccessKeyCiphertext).toMatch(/^v1:/)
      expect(linha.s3SecretKeyCiphertext).toMatch(/^v1:/)
      expect(m.sec.decryptPaymentSecret(linha.s3AccessKeyCiphertext!)).toBe(ACCESS)
      expect(m.sec.decryptPaymentSecret(linha.s3SecretKeyCiphertext!)).toBe(SECRET)
      expect(dump(linha)).not.toContain(SECRET)

      const sucesso = (await esperarAuditoria(admin.id, 1)).filter((l) => l.outcome === 'SUCCESS')
      expect(sucesso).toHaveLength(1) // exatamente UMA: fail-closed na transação, o middleware genérico não duplica
      expect(sucesso[0]).toMatchObject({ action: 'UPDATE', entityType: 'BackupConfig', entityId: '1', actionDetail: 'backup_config' })
      const changes = sucesso[0]!.changes as Record<string, unknown>
      expect(changes.s3AccessKey).toEqual({ changed: true })
      expect(changes.s3SecretKey).toEqual({ changed: true })
      expect(changes.s3Bucket).toBeDefined()
      for (const s of [ACCESS, SECRET, SENHA_ADMIN_TESTE, linha.s3SecretKeyCiphertext!]) expect(dump(sucesso), s).not.toContain(s)
      for (const s of [ACCESS, SECRET, SENHA_ADMIN_TESTE, linha.s3SecretKeyCiphertext!]) expect(logsTodos.join('\n'), s).not.toContain(s)
      const alerta = alertas.find((a) => a.alert === 'backup_config_changed')
      expect(alerta).toMatchObject({ escopo: 'config', actorUserId: admin.id })
      expect(alerta!.changedFields).toEqual(expect.arrayContaining(['destination', 's3.accessKey', 's3.secretKey']))
    })

    it('PUT parcial: só muda o que veio e as credenciais salvas permanecem; clearSecrets as apaga', async () => {
      const admin = await novoUsuario()
      await salvarS3(admin)
      const antes = await cfg()
      const res = await put(admin, { ...senha, retentionCount: 14, s3: { prefix: 'outro/prefixo/' } })
      expect(res.status, dump(res.body)).toBe(200)
      expect(res.body.s3.prefix).toBe('outro/prefixo')
      expect(res.body.retentionCount).toBe(14)
      const depois = await cfg()
      expect(depois.s3AccessKeyCiphertext).toBe(antes.s3AccessKeyCiphertext) // não foi regravado
      const limpou = await put(admin, { ...senha, clearSecrets: ['s3SecretKey'] })
      expect(limpou.body.s3).toMatchObject({ secretKeySet: false, accessKeySet: true })
      expect(limpou.body.destinationReady).toBe(false)
    })

    it('ANTI-EXFILTRAÇÃO: trocar o endereço do bucket com credencial salva exige reenviar as DUAS credenciais (senão 400 e nada muda)', async () => {
      const admin = await novoUsuario()
      await salvarS3(admin)
      const antes = await cfg()
      const res = await put(admin, { ...senha, s3: { endpoint: 'http://127.0.0.1:9' } })
      expect(res.status).toBe(400)
      expect(res.body.code).toBe('SECRET_REQUIRED_FOR_NEW_DESTINATION')
      expect(await cfg()).toMatchObject({ s3Endpoint: antes.s3Endpoint, s3AccessKeyCiphertext: antes.s3AccessKeyCiphertext })
      const so1 = await put(admin, { ...senha, s3: { endpoint: 'http://127.0.0.1:9', accessKey: 'AKIAOUTRA' } })
      expect(so1.status).toBe(400)
      const ok = await put(admin, { ...senha, s3: { endpoint: 'http://127.0.0.1:9', accessKey: 'AKIAOUTRA', secretKey: 'outro-segredo-qualquer' } })
      expect(ok.status, dump(ok.body)).toBe(200)
      expect((await cfg()).s3Endpoint).toBe('http://127.0.0.1:9')
      // Mesmo host, outra porta/caminho NÃO é "destino novo" para a regra (mesmo host => mesma credencial vai ao mesmo servidor)... mas host diferente é.
      const mesmoHost = await put(admin, { ...senha, s3: { endpoint: 'http://127.0.0.1:9/' } })
      expect(mesmoHost.status).toBe(200)
    })

    it('ANTI-SSRF em PRODUÇÃO: http, loopback, rede privada, nome interno e metadados são recusados; a permissão do deploy libera só http interno de rede PRIVADA', async () => {
      const admin = await novoUsuario()
      const admin2 = await novoUsuario() // o limite de escritas (10/min) é por ADMIN
      const nodeEnv = process.env.NODE_ENV
      process.env.NODE_ENV = 'production'
      try {
        const antes = dump(await cfg())
        for (const [url, codigo] of [
          ['http://s3.exemplo.com', 'HTTPS_REQUIRED'],
          ['https://127.0.0.1:9000', 'DESTINATION_NOT_ALLOWED'],
          ['https://10.0.0.7', 'DESTINATION_NOT_ALLOWED'],
          ['https://minio', 'DESTINATION_NOT_ALLOWED'],
          ['https://169.254.169.254', 'DESTINATION_NOT_ALLOWED'],
          ['https://user:pass@s3.exemplo.com', 'URL_HAS_CREDENTIALS'],
        ] as const) {
          const res = await put(admin, { ...senha, s3: { endpoint: url } })
          expect(res.status, url).toBe(400)
          expect(res.body.code, url).toBe(codigo)
        }
        expect(dump(await cfg())).toBe(antes)
        expect((await put(admin, { ...senha, s3: { endpoint: 'https://s3.us-east-1.amazonaws.com' } })).status).toBe(200)
        process.env.BACKUP_ALLOW_PRIVATE_HOSTS = 'true'
        expect((await put(admin2, { ...senha, s3: { endpoint: 'http://minio:9000', accessKey: 'a', secretKey: 'b' } })).status).toBe(200)
        expect((await put(admin2, { ...senha, s3: { endpoint: 'https://127.0.0.1:9000', accessKey: 'a', secretKey: 'b' } })).status).toBe(400) // loopback nunca
        expect((await put(admin2, { ...senha, s3: { endpoint: 'http://169.254.169.254', accessKey: 'a', secretKey: 'b' } })).status).toBe(400) // metadados nunca
      } finally {
        process.env.NODE_ENV = nodeEnv
        delete process.env.BACKUP_ALLOW_PRIVATE_HOSTS
      }
    })

    it('LIGAR exige destino completo (409 BACKUP_DESTINATION_MISSING) e chave do backup (409 BACKUP_KEY_MISSING); ligado grava enabledAt, desligado limpa (sem senha)', async () => {
      const admin = await novoUsuario()
      const semDestino = await put(admin, { ...senha, enabled: true })
      expect(semDestino.status).toBe(409)
      expect(semDestino.body.code).toBe('BACKUP_DESTINATION_MISSING')
      await salvarS3(admin)
      const semChave = await put(admin, { ...senha, enabled: true })
      expect(semChave.status).toBe(409)
      expect(semChave.body.code).toBe('BACKUP_KEY_MISSING')
      expect((await cfg()).enabled).toBe(false)
      expect((await gerarChave(admin)).status).toBe(201)
      const ligou = await put(admin, { ...senha, enabled: true })
      expect(ligou.status, dump(ligou.body)).toBe(200)
      expect(ligou.body).toMatchObject({ enabled: true, problemsToEnable: [] })
      expect((await cfg()).enabledAt).not.toBeNull()
      // Ligado, limpar uma credencial deixaria o automático sem destino: 409 e nada muda.
      const quebra = await put(admin, { ...senha, clearSecrets: ['s3SecretKey'] })
      expect(quebra.status).toBe(409)
      expect((await cfg()).s3SecretKeyCiphertext).not.toBeNull()
      const desligou = await put(admin, { enabled: false }) // sem senha
      expect(desligou.status).toBe(200)
      expect(await cfg()).toMatchObject({ enabled: false, enabledAt: null })
    })

    it('AUDITORIA FAIL-CLOSED de verdade: com um trigger que faz o INSERT da auditoria falhar, o PUT falha (500) e NADA é gravado', async () => {
      const admin = await novoUsuario()
      await m.prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION bka_falha_auditoria() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'auditoria indisponivel (teste)'; END; $$ LANGUAGE plpgsql`)
      await m.prisma.$executeRawUnsafe(`CREATE TRIGGER bka_falha_auditoria BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION bka_falha_auditoria()`)
      try {
        const res = await salvarS3(admin)
        expect(res.status).toBe(500)
        const c = await cfg()
        expect(c.s3AccessKeyCiphertext).toBeNull()
        expect(c.destination).toBeNull()
      } finally {
        await m.prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS bka_falha_auditoria ON "AuditLog"`)
        await m.prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS bka_falha_auditoria()`)
      }
      expect((await salvarS3(admin)).status).toBe(200) // sem o trigger volta ao normal
    })

    it('dois ADMINS gravando ao mesmo tempo se serializam (FOR UPDATE): nenhum PUT se perde', async () => {
      const a = await novoUsuario()
      const b = await novoUsuario()
      const [ra, rb] = await Promise.all([put(a, { ...senha, retentionCount: 11 }), put(b, { ...senha, alertAfterHours: 50 })])
      expect([ra.status, rb.status]).toEqual([200, 200])
      expect(await cfg()).toMatchObject({ retentionCount: 11, alertAfterHours: 50 })
    })
  })

  // ---------------------------------------------------------------------------------------------------------------------------------
  describe('POST /key — a chave do backup (mostrada UMA vez)', () => {
    it('exige a senha; gera 201 com a chave inteira, impressão digital e o .txt; no-store; guarda só a CÓPIA CIFRADA; nunca em log/auditoria; GET nunca a devolve', async () => {
      const admin = await novoUsuario()
      expect((await post(admin, '/key', {})).status).toBe(400)
      expect((await post(admin, '/key', { currentPassword: 'errada' })).status).toBe(403)
      expect((await cfg()).encryptionKeyCiphertext).toBeNull()

      const res = await gerarChave(admin)
      expect(res.status, dump(res.body)).toBe(201)
      expect(res.headers['cache-control']).toBe('no-store')
      const { key, fingerprint, fileName, fileText, replaced } = res.body as { key: string; fingerprint: string; fileName: string; fileText: string; replaced: boolean }
      expect(key).toMatch(/^([0-9a-f]{8}-){7}[0-9a-f]{8}$/)
      expect(fingerprint).toMatch(/^[0-9a-f]{8}$/)
      expect(fileName).toBe(`chave-backup-innoflow-${fingerprint}.txt`)
      expect(fileText).toContain(`CHAVE: ${key}`)
      expect(replaced).toBe(false)
      const parsed = m.bc.parseBackupKey(key)!
      expect(m.bc.keyFingerprint(parsed)).toBe(fingerprint)

      const linha = await cfg()
      expect(linha.encryptionKeyFingerprint).toBe(fingerprint)
      expect(linha.encryptionKeyCiphertext).toMatch(/^v1:/)
      expect(linha.encryptionKeyCiphertext).not.toContain(parsed.toString('hex'))
      expect(m.sec.decryptPaymentSecret(linha.encryptionKeyCiphertext!)).toBe(parsed.toString('hex')) // a cópia do agendador decifra para a MESMA chave
      expect(linha.encryptionKeyShownAt).not.toBeNull()

      const hex = parsed.toString('hex')
      const auditoria = dump(await esperarAuditoria(admin.id, 3))
      for (const s of [key, hex, SENHA_ADMIN_TESTE]) {
        expect(logsTodos.join('\n'), 'log').not.toContain(s)
        expect(auditoria, 'auditoria').not.toContain(s)
      }
      expect(auditoria).toContain(fingerprint) // a impressão digital é pública
      const cfgResp = await get(admin, '/config')
      expect(cfgResp.body.encryptionKey).toMatchObject({ exists: true, fingerprint })
      expect(dump(cfgResp.body)).not.toContain(hex)
      expect(alertas.find((a) => a.alert === 'backup_config_changed' && a.escopo === 'key')).toMatchObject({ desfecho: 'generated' })
    })

    it('trocar uma chave que existe: 409 sem replace; 400 sem a frase "GERAR NOVA CHAVE"; 409 se a tela viu outra impressão digital; 409 com backup em andamento; com tudo certo 201 replaced', async () => {
      const admin = await novoUsuario()
      const primeira = (await gerarChave(admin)).body as { fingerprint: string }
      expect((await gerarChave(admin)).body.code).toBe('BACKUP_KEY_EXISTS')
      const semFrase = await gerarChave(admin, { replace: true })
      expect(semFrase.status).toBe(400)
      expect(semFrase.body.code).toBe('BACKUP_KEY_CONFIRMATION_REQUIRED')
      expect((await gerarChave(admin, { replace: true, confirmation: 'gerar nova chave' })).status).toBe(400) // frase exata
      const desatualizada = await gerarChave(admin, { replace: true, confirmation: 'GERAR NOVA CHAVE', expectedFingerprint: 'deadbeef' })
      expect(desatualizada.status).toBe(409)
      expect(desatualizada.body.code).toBe('BACKUP_KEY_CHANGED')
      await m.prisma.backupConfig.update({ where: { id: 1 }, data: { runningSince: new Date() } })
      const ocupado = await gerarChave(admin, { replace: true, confirmation: 'GERAR NOVA CHAVE', expectedFingerprint: primeira.fingerprint })
      expect(ocupado.status).toBe(409)
      expect(ocupado.body.code).toBe('BACKUP_BUSY')
      await m.prisma.backupConfig.update({ where: { id: 1 }, data: { runningSince: null } })
      expect((await cfg()).encryptionKeyFingerprint).toBe(primeira.fingerprint) // nada mudou nas recusas
      const ok = await gerarChave(admin, { replace: true, confirmation: 'GERAR NOVA CHAVE', expectedFingerprint: primeira.fingerprint })
      expect(ok.status, dump(ok.body)).toBe(201)
      expect(ok.body.replaced).toBe(true)
      expect(ok.body.fingerprint).not.toBe(primeira.fingerprint)
      expect(alertas.filter((a) => a.alert === 'backup_config_changed' && a.escopo === 'key').map((a) => a.desfecho)).toEqual(['generated', 'replaced'])
    })

    it('dois cliques simultâneos geram UMA chave (o segundo é BACKUP_KEY_EXISTS) — a pessoa nunca vê uma chave que não ficou valendo', async () => {
      const admin = await novoUsuario()
      const [a, b] = await Promise.all([gerarChave(admin), gerarChave(admin)])
      expect([a.status, b.status].sort()).toEqual([201, 409])
      const vencedora = a.status === 201 ? a : b
      expect((await cfg()).encryptionKeyFingerprint).toBe(vencedora.body.fingerprint)
    })
  })

  // ---------------------------------------------------------------------------------------------------------------------------------
  describe('POST /run e /verify — assíncronos, sem duplicidade', () => {
    it('/run: 202 com a linha QUEUED, enfileira UMA vez; a 2ª enquanto há uma na fila é 409 BACKUP_BUSY; status mostra activeRun', async () => {
      const admin = await novoUsuario()
      const res = await post(admin, '/run')
      expect(res.status, dump(res.body)).toBe(202)
      expect(res.body).toMatchObject({ trigger: 'MANUAL', status: 'QUEUED', destination: null, errorCode: null, errorMessage: null })
      expect(enfileirados).toEqual([{ tipo: 'manual-run', runId: res.body.id, criadoPorId: admin.id }])
      const dup = await post(admin, '/run')
      expect(dup.status).toBe(409)
      expect(dup.body.code).toBe('BACKUP_BUSY')
      expect(await m.prisma.backupRun.count()).toBe(1)
      expect(enfileirados).toHaveLength(1)
      const status = await get(admin, '/status')
      expect(status.body.activeRun).toMatchObject({ id: res.body.id, status: 'QUEUED' })
      const linhas = (await esperarAuditoria(admin.id, 2)).filter((l) => l.outcome === 'SUCCESS')
      expect(linhas[0]).toMatchObject({ entityType: 'BackupRun', entityId: res.body.id, actionDetail: 'backup_run:manual' })
    })

    it('duplo clique (2 requisições ao mesmo tempo) cria UM pedido só', async () => {
      const admin = await novoUsuario()
      const [a, b] = await Promise.all([post(admin, '/run'), post(admin, '/run')])
      expect([a.status, b.status].sort()).toEqual([202, 409])
      expect(await m.prisma.backupRun.count()).toBe(1)
      expect(enfileirados).toHaveLength(1)
    })

    it('trava viva de uma execução (runningSince) também é BUSY; pedido velho na fila (> 15 min) não bloqueia mais', async () => {
      const admin = await novoUsuario()
      await m.prisma.backupConfig.update({ where: { id: 1 }, data: { runningSince: new Date(Date.now() - 10 * 60_000) } })
      expect((await post(admin, '/run')).body.code).toBe('BACKUP_BUSY')
      await m.prisma.backupConfig.update({ where: { id: 1 }, data: { runningSince: null } })
      await m.prisma.backupRun.create({ data: { trigger: 'MANUAL', status: 'QUEUED', createdAt: new Date(Date.now() - 20 * 60_000) } })
      expect((await post(admin, '/run')).status).toBe(202)
    })

    it('destino ESCOLHIDO mas incompleto: 409 BACKUP_DESTINATION_MISSING (um backup que descarta o dump em silêncio seria falsa segurança); com destino completo a linha leva o destino', async () => {
      const admin = await novoUsuario()
      await put(admin, { ...senha, destination: 'S3' })
      const res = await post(admin, '/run')
      expect(res.status).toBe(409)
      expect(res.body.code).toBe('BACKUP_DESTINATION_MISSING')
      expect(await m.prisma.backupRun.count()).toBe(0)
      await salvarS3(admin)
      const ok = await post(admin, '/run')
      expect(ok.status).toBe(202)
      expect(ok.body.destination).toBe('S3')
    })

    it('fila indisponível: 503 QUEUE_UNAVAILABLE e a linha vira FAILED/NOT_PICKED_UP (não fica pendurada)', async () => {
      const admin = await novoUsuario()
      m.ped.definirEnfileiradorParaTeste(async () => Promise.reject(new Error('redis fora')))
      try {
        const res = await post(admin, '/run')
        expect(res.status).toBe(503)
        expect(res.body.code).toBe('QUEUE_UNAVAILABLE')
      } finally {
        m.ped.definirEnfileiradorParaTeste(async (p) => void enfileirados.push(p))
      }
      expect(await m.prisma.backupRun.findFirstOrThrow()).toMatchObject({ status: 'FAILED', errorCode: 'NOT_PICKED_UP' })
      expect((await post(admin, '/run')).status).toBe(202) // e não trava os próximos
    })

    it('/verify: exige destino completo (409); 202 VERIFY/QUEUED enfileirado; não duplica; não conflita com um backup em andamento', async () => {
      const admin = await novoUsuario()
      expect((await post(admin, '/verify')).body.code).toBe('BACKUP_DESTINATION_MISSING')
      await salvarS3(admin)
      await m.prisma.backupConfig.update({ where: { id: 1 }, data: { runningSince: new Date() } }) // backup rodando: a conferência é outra coisa
      const res = await post(admin, '/verify')
      expect(res.status, dump(res.body)).toBe(202)
      expect(res.body).toMatchObject({ trigger: 'VERIFY', status: 'QUEUED', destination: 'S3' })
      expect(enfileirados[0]).toMatchObject({ tipo: 'manual-verify', runId: res.body.id })
      expect((await post(admin, '/verify')).body.code).toBe('BACKUP_BUSY')
    })

    it('corpo com campo a mais é 400 (nada é enfileirado)', async () => {
      const admin = await novoUsuario()
      expect((await post(admin, '/run', { qualquer: 1 })).status).toBe(400)
      expect(enfileirados).toEqual([])
    })
  })

  // ---------------------------------------------------------------------------------------------------------------------------------
  describe('GET /status, /runs e /runs/:id', () => {
    it('status: sem execução nenhuma, ligado há pouco, atrasado e rodando', async () => {
      const admin = await novoUsuario()
      let s = (await get(admin, '/status')).body
      expect(s).toMatchObject({ lastSuccessAt: null, running: false, stale: false, neverRan: false, nextRunAt: null, activeRun: null, lastBackupRun: null, lastVerifyRun: null })
      await m.prisma.backupConfig.update({ where: { id: 1 }, data: { enabled: true, enabledAt: new Date(Date.now() - 40 * 3600_000), hourLocal: 3 } })
      s = (await get(admin, '/status')).body
      expect(s).toMatchObject({ stale: true, neverRan: true })
      expect(new Date(s.nextRunAt).getUTCHours()).toBe(6) // 03h de Brasília
      await m.prisma.backupConfig.update({ where: { id: 1 }, data: { lastSuccessAt: new Date(Date.now() - 2 * 3600_000), runningSince: new Date() } })
      s = (await get(admin, '/status')).body
      expect(s).toMatchObject({ stale: false, neverRan: false, running: true, ageHours: 2 })
    })

    it('histórico: paginado, mais novo primeiro, filtros por trigger/status, DTO com errorCode + texto fixo, sem campo interno; pageSize > 100 é 400', async () => {
      const admin = await novoUsuario()
      const base = Date.now()
      for (let i = 0; i < 25; i += 1) {
        await m.prisma.backupRun.create({
          data: i % 5 === 0
            ? { trigger: 'VERIFY', status: 'FAILED', errorCode: 'CHECKSUM', finishedAt: new Date(), createdAt: new Date(base - i * 1000) }
            : { trigger: 'SCHEDULED', status: 'SUCCESS', finishedAt: new Date(), createdAt: new Date(base - i * 1000), sizeBytes: BigInt(1000 + i), checksumSha256: 'a'.repeat(64), objectKey: `inno/backup-${i}.dump.enc`, encryptionKeyFingerprint: '630dcd29' },
        })
      }
      const p1 = await get(admin, '/runs?page=1&pageSize=10')
      expect(p1.status, dump(p1.body)).toBe(200)
      expect(p1.body.meta).toEqual({ page: 1, pageSize: 10, total: 25, totalPages: 3 })
      expect(p1.body.items).toHaveLength(10)
      const datas = p1.body.items.map((r: { createdAt: string }) => r.createdAt)
      expect([...datas].sort().reverse()).toEqual(datas)
      expect((await get(admin, '/runs?page=3&pageSize=10')).body.items).toHaveLength(5)
      const verify = await get(admin, '/runs?trigger=VERIFY&pageSize=100')
      expect(verify.body.meta.total).toBe(5)
      expect(verify.body.items[0]).toMatchObject({ trigger: 'VERIFY', status: 'FAILED', errorCode: 'CHECKSUM' })
      expect(verify.body.items[0].errorMessage).toContain('SHA-256')
      const ok = await get(admin, '/runs?status=SUCCESS&pageSize=1')
      expect(ok.body.items[0]).toMatchObject({ status: 'SUCCESS', sizeBytes: expect.any(Number), checksumSha256: 'a'.repeat(64), keyFingerprint: '630dcd29', errorCode: null, errorMessage: null })
      expect(Object.keys(ok.body.items[0]).sort()).toEqual(['checksumSha256', 'createdAt', 'destination', 'durationMs', 'errorCode', 'errorMessage', 'fileName', 'finishedAt', 'id', 'keyFingerprint', 'objectKey', 'sizeBytes', 'startedAt', 'status', 'tablesWithData', 'trigger'])
      expect((await get(admin, '/runs?pageSize=101')).status).toBe(400)
      expect((await get(admin, '/runs?page=0')).status).toBe(400)
      expect((await get(admin, '/runs?trigger=QUALQUER')).status).toBe(400)
    })

    it('/runs/:id: acha, 404 para id inexistente, 400 para id que não é cuid', async () => {
      const admin = await novoUsuario()
      const r = await m.prisma.backupRun.create({ data: { trigger: 'MANUAL', status: 'FAILED', errorCode: 'KEY', finishedAt: new Date() } })
      const res = await get(admin, `/runs/${r.id}`)
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({ id: r.id, errorCode: 'KEY' })
      expect((await get(admin, '/runs/ckxxxxxxxxxxxxxxxxxxxxxxx')).status).toBe(404)
      expect((await get(admin, '/runs/nao-e-cuid')).status).toBe(400)
    })
  })

  // ---------------------------------------------------------------------------------------------------------------------------------
  describe('POST /test-destination', () => {
    it('sem destino: 200 ok:false CONFIG; com S3 certo: 200 ok:true (grava e apaga); com segredo errado: 200 ok:false CREDENTIAL sem texto cru do servidor', async () => {
      const admin = await novoUsuario()
      const sem = await post(admin, '/test-destination')
      expect(sem.status).toBe(200)
      expect(sem.body).toMatchObject({ ok: false, destination: null, error: { code: 'CONFIG' } })
      await salvarS3(admin)
      const ok = await post(admin, '/test-destination')
      expect(ok.body).toMatchObject({ ok: true, destination: 'S3' })
      expect(ok.body.message).toContain('bkt')
      expect([...s3f.objetos.keys()].filter((k) => k.includes('.teste-conexao-'))).toEqual([])
      await put(admin, { ...senha, s3: { secretKey: 'segredo-errado-errado' } })
      const ruim = await post(admin, '/test-destination')
      expect(ruim.status).toBe(200)
      expect(ruim.body).toMatchObject({ ok: false, destination: 'S3', error: { code: 'CREDENTIAL' } })
      expect(dump(ruim.body)).not.toContain('SignatureDoesNotMatch')
      expect(dump(ruim.body)).not.toContain(ACCESS)
      expect(dump(ruim.body)).not.toContain('segredo-errado-errado')
    })

    it('servidor de destino fora do ar => ok:false NETWORK', async () => {
      const admin = await novoUsuario()
      await salvarS3(admin)
      await m.prisma.backupConfig.update({ where: { id: 1 }, data: { s3Endpoint: 'http://127.0.0.1:1' } })
      expect((await post(admin, '/test-destination')).body).toMatchObject({ ok: false, error: { code: 'NETWORK' } })
    })

    it('rate limit: 5 por minuto por ADMIN (o 6º é 429 RATE_LIMITED_BACKUP)', async () => {
      const admin = await novoUsuario()
      for (let i = 0; i < 5; i += 1) expect((await post(admin, '/test-destination')).status).toBe(200)
      const res = await post(admin, '/test-destination')
      expect(res.status).toBe(429)
      expect(res.body.code).toBe('RATE_LIMITED_BACKUP')
      const outro = await novoUsuario()
      expect((await post(outro, '/test-destination')).status).toBe(200) // o balde é por ADMIN
    })
  })

  describe('rate limit de executar/conferir', () => {
    it('6 pedidos por 10 min por ADMIN (o 7º é 429)', async () => {
      const admin = await novoUsuario()
      for (let i = 0; i < 6; i += 1) {
        const r = await post(admin, '/verify') // 409 (sem destino) também gasta o balde
        expect([202, 409]).toContain(r.status)
      }
      expect((await post(admin, '/verify')).status).toBe(429)
      expect((await post(admin, '/run')).status).toBe(429) // run e verify dividem o balde
    })
  })

  // ---------------------------------------------------------------------------------------------------------------------------------
  describe('Google Drive (OAuth) — fluxo inteiro contra o Google falso', () => {
    let ipCb = 0
    const callback = (q: Record<string, string>) => request(app).get('/api/backup/google/callback').set('X-Forwarded-For', `10.99.${(ipCb += 1) & 255}.9`).query(q)
    const estadoDaUrl = (url: string) => new URL(url).searchParams.get('state')!

    async function prepararAppDoGoogle(admin: U) {
      const r = await put(admin, { ...senha, drive: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET } })
      expect(r.status, dump(r.body)).toBe(200)
      expect(r.body.drive).toMatchObject({ clientId: CLIENT_ID, clientSecretSet: true, connected: false })
      expect(dump(r.body)).not.toContain(CLIENT_SECRET)
    }

    it('start exige a senha e as credenciais do app; devolve a URL do Google (offline+consent+drive.file) e o redirect_uri a registrar', async () => {
      const admin = await novoUsuario()
      expect((await post(admin, '/google/start', {})).status).toBe(400)
      const semApp = await post(admin, '/google/start', senha)
      expect(semApp.status).toBe(409)
      expect(semApp.body.code).toBe('DRIVE_OAUTH_CREDENTIALS_MISSING')
      await prepararAppDoGoogle(admin)
      const res = await post(admin, '/google/start', senha)
      expect(res.status, dump(res.body)).toBe(200)
      expect(res.headers['cache-control']).toBe('no-store')
      const u = new URL(res.body.url)
      expect(u.origin).toBe('https://accounts.google.com')
      expect(u.searchParams.get('client_id')).toBe(CLIENT_ID)
      expect(u.searchParams.get('access_type')).toBe('offline')
      expect(u.searchParams.get('prompt')).toBe('consent')
      expect(u.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/drive.file')
      expect(u.searchParams.get('redirect_uri')).toMatch(/\/api\/backup\/google\/callback$/)
      expect(res.body.redirectUri).toBe(u.searchParams.get('redirect_uri'))
      expect((await cfg()).oauthStateNonce).not.toBeNull()
    })

    it('callback: conecta (302 para o painel), grava o refresh token CIFRADO, cria a pasta, e o segredo nunca aparece; replay do mesmo state é recusado', async () => {
      const admin = await novoUsuario()
      await prepararAppDoGoogle(admin)
      const { url } = (await post(admin, '/google/start', senha)).body as { url: string }
      const state = estadoDaUrl(url)
      const ok = await callback({ state, code: google.codigoValido })
      expect(ok.status).toBe(302)
      expect(ok.headers.location).toBe('https://painel.exemplo.com.br/admin/backup?google=ok')
      expect(ok.headers['cache-control']).toBe('no-store')
      expect(ok.headers['referrer-policy']).toBe('no-referrer')
      const c = await cfg()
      expect(c.driveOauthRefreshTokenCiphertext).toMatch(/^v1:/)
      expect(m.sec.decryptPaymentSecret(c.driveOauthRefreshTokenCiphertext!)).toBe(google.refreshTokenEmitido)
      expect(c).toMatchObject({ driveOauthEmail: 'dono@gmail.example', driveOauthConnectedById: admin.id, oauthStateNonce: null })
      expect(c.driveOauthFolderId).toBeTruthy()
      expect(google.arquivos.get(c.driveOauthFolderId!)?.name).toBe('Backups InnoFlow')
      for (const s of [google.refreshTokenEmitido, CLIENT_SECRET, google.codigoValido, state]) expect(logsTodos.join('\n'), s.slice(0, 8)).not.toContain(s)
      const dto = (await get(admin, '/config')).body
      expect(dto.drive).toMatchObject({ connected: true, accountEmail: 'dono@gmail.example' })
      expect(dump(dto)).not.toContain(google.refreshTokenEmitido)
      expect(alertas.find((a) => a.alert === 'backup_config_changed' && a.escopo === 'oauth_connect')).toMatchObject({ actorUserId: admin.id })

      // REPLAY: o mesmo state (uso único) não conecta de novo nem muda nada.
      const antes = dump(await cfg())
      const replay = await callback({ state, code: google.codigoValido })
      expect(replay.status).toBe(302)
      expect(replay.headers.location).toBe('https://painel.exemplo.com.br/admin/backup?google=erro&motivo=invalid_state')
      expect(dump(await cfg())).toBe(antes)
    })

    it('callback hostil: sem state, state forjado, adulterado, expirado, de admin desativado e `error` do Google — nada é conectado e o motivo é um CÓDIGO', async () => {
      const admin = await novoUsuario()
      await prepararAppDoGoogle(admin)
      const motivoDe = (r: request.Response) => new URL(r.headers.location!).searchParams.get('motivo')
      expect(motivoDe(await callback({ code: 'x' }))).toBe('invalid_state')
      expect(motivoDe(await callback({ state: 'lixo.lixo', code: 'x' }))).toBe('invalid_state')
      const { url } = (await post(admin, '/google/start', senha)).body as { url: string }
      const state = estadoDaUrl(url)
      const [corpo, assinatura] = state.split('.') as [string, string]
      const adulterado = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(corpo, 'base64url').toString()), adminId: 'outro-admin' })).toString('base64url')
      expect(motivoDe(await callback({ state: `${adulterado}.${assinatura}`, code: google.codigoValido }))).toBe('invalid_state')
      expect((await cfg()).driveOauthConnectedAt).toBeNull()
      // expirado (o nonce no banco expira)
      await m.prisma.backupConfig.update({ where: { id: 1 }, data: { oauthStateExpiresAt: new Date(Date.now() - 1000) } })
      expect(motivoDe(await callback({ state, code: google.codigoValido }))).toBe('invalid_state')
      // admin desativado entre o início e o callback
      const u2 = new URL((await post(admin, '/google/start', senha)).body.url)
      await m.prisma.user.update({ where: { id: admin.id }, data: { active: false } })
      expect(motivoDe(await callback({ state: u2.searchParams.get('state')!, code: google.codigoValido }))).toBe('invalid_state')
      await m.prisma.user.update({ where: { id: admin.id }, data: { active: true } })
      expect((await cfg()).driveOauthConnectedAt).toBeNull()
      // o usuário NEGA o consentimento: o state é consumido, nada conecta
      const admin2 = await novoUsuario()
      const u3 = new URL((await post(admin2, '/google/start', senha)).body.url)
      expect(motivoDe(await callback({ state: u3.searchParams.get('state')!, error: 'access_denied' }))).toBe('access_denied')
      expect((await cfg()).oauthStateNonce).toBeNull()
      expect((await cfg()).driveOauthConnectedAt).toBeNull()
    })

    it('Google sem refresh token => recusa (uma conexão que morre em 1 h é pior que nenhuma); credencial do app errada => bad_credentials', async () => {
      const admin = await novoUsuario()
      await prepararAppDoGoogle(admin)
      const motivoDe = (r: request.Response) => new URL(r.headers.location!).searchParams.get('motivo')
      google.semRefreshTokenNaProximaTroca = true
      const u1 = new URL((await post(admin, '/google/start', senha)).body.url)
      expect(motivoDe(await callback({ state: u1.searchParams.get('state')!, code: google.codigoValido }))).toBe('no_refresh_token')
      expect((await cfg()).driveOauthConnectedAt).toBeNull()
      await put(admin, { ...senha, drive: { clientSecret: 'segredo-do-app-errado' } })
      const u2 = new URL((await post(admin, '/google/start', senha)).body.url)
      expect(motivoDe(await callback({ state: u2.searchParams.get('state')!, code: google.codigoValido }))).toBe('bad_credentials')
      const u3 = new URL((await post(admin, '/google/start', senha)).body.url)
      expect(motivoDe(await callback({ state: u3.searchParams.get('state')!, code: 'codigo-invalido' }))).toBe('bad_credentials')
    })

    it('trocar o Client ID desconecta (o escopo drive.file é por app); desconectar exige senha, revoga no Google e limpa só a conexão', async () => {
      const admin = await novoUsuario()
      await prepararAppDoGoogle(admin)
      const u = new URL((await post(admin, '/google/start', senha)).body.url)
      expect((await callback({ state: u.searchParams.get('state')!, code: google.codigoValido })).headers.location).toContain('google=ok')
      expect((await post(admin, '/google/disconnect', {})).status).toBe(400)
      expect((await post(admin, '/google/disconnect', { currentPassword: 'errada' })).status).toBe(403)
      expect((await cfg()).driveOauthConnectedAt).not.toBeNull()
      const res = await post(admin, '/google/disconnect', senha)
      expect(res.status, dump(res.body)).toBe(200)
      expect(res.body.drive).toMatchObject({ connected: false, accountEmail: null, clientId: CLIENT_ID, clientSecretSet: true }) // Client ID/Secret ficam para reconectar
      expect(google.requisicoes).toContain('POST /revoke')
      const c = await cfg()
      expect(c).toMatchObject({ driveOauthRefreshTokenCiphertext: null, driveOauthFolderId: null })
      expect(alertas.find((a) => a.alert === 'backup_config_changed' && a.escopo === 'oauth_disconnect')).toBeDefined()
      // reconectar e depois trocar o Client ID: a conexão cai
      const u2 = new URL((await post(admin, '/google/start', senha)).body.url)
      await callback({ state: u2.searchParams.get('state')!, code: google.codigoValido })
      expect((await cfg()).driveOauthConnectedAt).not.toBeNull()
      const trocou = await put(admin, { ...senha, drive: { clientId: 'outro-app.apps.googleusercontent.com' } })
      expect(trocou.body.drive).toMatchObject({ connected: false, clientId: 'outro-app.apps.googleusercontent.com' })
    })

    it('com o Drive conectado: /test-destination abre a pasta (200 ok:true), e acesso revogado no Google vira ok:false OAUTH_DISCONNECTED', async () => {
      const admin = await novoUsuario()
      await prepararAppDoGoogle(admin)
      const u = new URL((await post(admin, '/google/start', senha)).body.url)
      await callback({ state: u.searchParams.get('state')!, code: google.codigoValido })
      expect((await put(admin, { ...senha, destination: 'DRIVE' })).body).toMatchObject({ destination: 'DRIVE', destinationReady: true })
      expect((await post(admin, '/test-destination')).body).toMatchObject({ ok: true, destination: 'DRIVE' })
      google.revogarAcesso()
      expect((await post(admin, '/test-destination')).body).toMatchObject({ ok: false, error: { code: 'OAUTH_DISCONNECTED' } })
    })

    it('sem origem de frontend utilizável o callback responde uma página mínima (sem eco de nada da requisição)', async () => {
      const salvo = process.env.PUBLIC_APP_URL
      delete process.env.PUBLIC_APP_URL
      const corsSalvo = m.env.CORS_ALLOWED_ORIGINS
      m.env.CORS_ALLOWED_ORIGINS = []
      try {
        const res = await callback({ state: '<script>alert(1)</script>', code: 'x' })
        expect(res.status).toBe(400)
        expect(res.headers['content-type']).toMatch(/html/)
        expect(res.text).not.toContain('<script>')
        expect(res.text).not.toContain('alert(1)')
      } finally {
        process.env.PUBLIC_APP_URL = salvo
        m.env.CORS_ALLOWED_ORIGINS = corsSalvo
      }
    })
  })

  // ---------------------------------------------------------------------------------------------------------------------------------
  describe.skipIf(!temPg)('Drive de ponta a ponta: backup real (pg_dump) para o Google falso e conferência', () => {
    it('sobe o .dump.enc cifrado para a pasta do Drive, poda além de N e a conferência passa', async () => {
      const admin = await novoUsuario()
      await put(admin, { ...senha, drive: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET } })
      const u = new URL((await post(admin, '/google/start', senha)).body.url)
      await request(app).get('/api/backup/google/callback').query({ state: u.searchParams.get('state')!, code: google.codigoValido })
      await put(admin, { ...senha, destination: 'DRIVE', retentionCount: 2 })
      const chave = (await gerarChave(admin)).body as { key: string }
      const tmp = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'bka-drive-'))
      try {
        for (let d = 1; d <= 3; d += 1) await m.exe.executarBackup({ gatilho: 'SCHEDULED' }, { agora: () => new Date(`2026-11-0${d}T06:10:00Z`), pastaTemporariaBase: tmp, dormir: async () => undefined })
        const pasta = (await cfg()).driveOauthFolderId!
        const nossos = [...google.arquivos.values()].filter((a) => a.parents.includes(pasta) && a.name.startsWith('backup-'))
        expect(nossos.map((a) => a.name).sort()).toEqual(['backup-innoflow-2026-11-02-03h10m00s.dump.enc', 'backup-innoflow-2026-11-03-03h10m00s.dump.enc']) // retenção 2
        expect(nossos[0]!.corpo.subarray(0, 7).toString('latin1')).toBe('INNOBKP')
        const v = await m.ver.verificarUltimaCopia({ gatilho: 'MANUAL' }, { pastaTemporariaBase: tmp })
        expect(v).toMatchObject({ encrypted: true, checksumConferido: true })
        // a chave que o dono recebeu (e só ela) abre o arquivo do Drive
        const key = m.bc.parseBackupKey(chave.key)!
        const fs = await import('node:fs')
        const path = await import('node:path')
        fs.writeFileSync(path.join(tmp, 'a.enc'), nossos[0]!.corpo)
        await m.bc.decryptFile(path.join(tmp, 'a.enc'), path.join(tmp, 'a.dump'), key)
        expect(fs.readFileSync(path.join(tmp, 'a.dump')).subarray(0, 5).toString('latin1')).toBe('PGDMP')
        expect(fs.readdirSync(tmp).filter((f) => f.startsWith('innoflow-'))).toEqual([]) // pastas temporárias do serviço removidas
      } finally {
        ;(await import('node:fs')).rmSync(tmp, { recursive: true, force: true })
      }
    }, 240_000)
  })
})
