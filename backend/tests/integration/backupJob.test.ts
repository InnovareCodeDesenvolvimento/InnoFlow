/**
 * Job BullMQ do backup (`src/worker/jobs/backupJob.ts`) contra Redis e Postgres REAIS (+ `pg_dump` de verdade e S3 falso): o agendamento é UM só mesmo chamado por 2 réplicas
 * (`upsertJobScheduler`), o pedido manual enfileirado pela "API" é executado pelo worker, falha de pedido não vira job falho/retentado, o tick roda o backup agendado, e DOIS workers
 * (2 réplicas) disputando pedidos simultâneos executam UM backup só (trava `runningSince`).
 * Banco próprio; fila `backup` própria (esvaziada ao final).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Queue, type Worker } from 'bullmq'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { criarBancoProprio } from './helpers/bancoProprio'
import { ferramentasDoPgDisponiveis, prepararAmbienteDoPg } from './helpers/backupAmbiente'
import { iniciarS3Falso, type S3Falso } from '../helpers/s3Falso'

const ACCESS = 'AKIAJOBMARCADOR1234'
const SECRET = 'segredo-do-job-marcador-9876543210'
const temPg = ferramentasDoPgDisponiveis()
if (!temPg && process.env.CI) throw new Error('pg_dump/pg_restore não encontrados na CI: o teste do job de backup não pode "passar" sem provar nada.')

type Mods = {
  prisma: typeof import('../../src/lib/prisma').prisma
  redis: typeof import('../../src/lib/redis').redis
  job: typeof import('../../src/worker/jobs/backupJob')
  sec: typeof import('../../src/lib/crypto/paymentSecrets')
  bc: typeof import('../../src/lib/crypto/backupCrypto')
  conn: typeof import('../../src/lib/redis').createRedisConnection
}

async function esperarTerminal(m: Mods, runId: string, ms = 90_000) {
  const limite = Date.now() + ms
  for (;;) {
    const r = await m.prisma.backupRun.findUniqueOrThrow({ where: { id: runId } })
    if (r.status === 'SUCCESS' || r.status === 'FAILED') return r
    if (Date.now() > limite) throw new Error(`execução ${runId} não terminou: ${r.status}`)
    await new Promise((res) => setTimeout(res, 100))
  }
}

describe.skipIf(!temPg)('job BullMQ do backup — Redis e Postgres reais', () => {
  let m: Mods
  let banco: Awaited<ReturnType<typeof criarBancoProprio>>
  let s3f: S3Falso
  let tmp: string
  let chave: Buffer
  const workers: Worker[] = []

  beforeAll(async () => {
    prepararAmbienteDoPg()
    banco = await criarBancoProprio('bkj')
    tmp = mkdtempSync(join(tmpdir(), 'bkj-'))
    s3f = await iniciarS3Falso({ bucket: 'bkt', accessKeyId: ACCESS, secretAccessKey: SECRET })
    const [prismaMod, redisMod, job, sec, bc] = await Promise.all([
      import('../../src/lib/prisma'),
      import('../../src/lib/redis'),
      import('../../src/worker/jobs/backupJob'),
      import('../../src/lib/crypto/paymentSecrets'),
      import('../../src/lib/crypto/backupCrypto'),
    ])
    m = { prisma: prismaMod.prisma, redis: redisMod.redis, job, sec, bc, conn: redisMod.createRedisConnection }
    chave = bc.generateBackupKey()
  }, 180_000)

  afterAll(async () => {
    for (const w of workers) await w.close()
    await m?.job.fecharFilaDaApiDeBackup()
    const q = new Queue(m.job.BACKUP_QUEUE_NAME, { connection: m.conn() })
    await q.removeJobScheduler('backup-tick').catch(() => undefined)
    await q.obliterate({ force: true }).catch(() => undefined)
    await q.close()
    await m?.prisma.$disconnect()
    m?.redis.disconnect()
    await banco?.descartar()
    await s3f?.fechar()
    if (tmp) rmSync(tmp, { recursive: true, force: true })
  }, 60_000)

  beforeEach(async () => {
    await m.prisma.backupRun.deleteMany()
    s3f.objetos.clear()
    await m.prisma.backupConfig.update({
      where: { id: 1 },
      data: {
        enabled: false,
        enabledAt: null,
        destination: 'S3',
        s3Endpoint: s3f.url,
        s3Region: 'us-east-1',
        s3Bucket: 'bkt',
        s3Prefix: null,
        s3AccessKeyCiphertext: m.sec.encryptPaymentSecret(ACCESS),
        s3SecretKeyCiphertext: m.sec.encryptPaymentSecret(SECRET),
        encryptionKeyCiphertext: m.sec.encryptPaymentSecret(chave.toString('hex')),
        encryptionKeyFingerprint: m.bc.keyFingerprint(chave),
        retentionCount: 7,
        runningSince: null,
        lastSuccessAt: null,
        lastAttemptAt: null,
        lastStaleAlertAt: null,
      },
    })
  })

  it('o tick é agendado UMA vez mesmo se 2 réplicas chamarem scheduleBackupTick (upsertJobScheduler idempotente), a cada 10 min', async () => {
    await Promise.all([m.job.scheduleBackupTick(), m.job.scheduleBackupTick()])
    await m.job.scheduleBackupTick()
    const q = new Queue(m.job.BACKUP_QUEUE_NAME, { connection: m.conn() })
    try {
      const agendamentos = await q.getJobSchedulers()
      const meus = agendamentos.filter((a) => a.key === 'backup-tick' || a.id === 'backup-tick')
      expect(meus).toHaveLength(1)
      expect(Number(meus[0]!.every)).toBe(10 * 60 * 1000)
    } finally {
      await q.close()
    }
  })

  it('pedido MANUAL enfileirado pela API é executado pelo worker (QUEUED -> RUNNING -> SUCCESS) e a cópia sobe cifrada', async () => {
    workers.push(m.job.startBackupWorker())
    const run = await m.prisma.backupRun.create({ data: { trigger: 'MANUAL', status: 'QUEUED', destination: 'S3' } })
    await m.job.enfileirarPedidoDeBackup({ tipo: 'manual-run', runId: run.id, criadoPorId: 'admin-teste' })
    const fim = await esperarTerminal(m, run.id)
    expect(fim).toMatchObject({ status: 'SUCCESS', trigger: 'MANUAL', errorCode: null })
    expect([...s3f.objetos.keys()]).toHaveLength(1)
    expect([...s3f.objetos.values()][0]!.corpo.subarray(0, 7).toString('latin1')).toBe('INNOBKP')

    // Conferir a cópia: também pelo worker.
    const v = await m.prisma.backupRun.create({ data: { trigger: 'VERIFY', status: 'QUEUED', destination: 'S3' } })
    await m.job.enfileirarPedidoDeBackup({ tipo: 'manual-verify', runId: v.id, criadoPorId: 'admin-teste' })
    expect(await esperarTerminal(m, v.id)).toMatchObject({ status: 'SUCCESS', trigger: 'VERIFY' })
  }, 240_000)

  it('pedido que FALHA vira FAILED com código no histórico, e o job do BullMQ termina OK (nada de retentativa do BullMQ repetindo o dump)', async () => {
    await m.prisma.backupConfig.update({ where: { id: 1 }, data: { encryptionKeyCiphertext: null, encryptionKeyFingerprint: null } })
    const run = await m.prisma.backupRun.create({ data: { trigger: 'MANUAL', status: 'QUEUED', destination: 'S3' } })
    await m.job.enfileirarPedidoDeBackup({ tipo: 'manual-run', runId: run.id, criadoPorId: 'admin-teste' })
    expect(await esperarTerminal(m, run.id)).toMatchObject({ status: 'FAILED', errorCode: 'KEY' })
    const q = new Queue(m.job.BACKUP_QUEUE_NAME, { connection: m.conn() })
    try {
      await new Promise((r) => setTimeout(r, 300))
      const falhos = await q.getFailed()
      expect(falhos.filter((j) => j.data && (j.data as { runId?: string }).runId === run.id)).toHaveLength(0)
    } finally {
      await q.close()
    }
  }, 120_000)

  it('o job `tick` roda o backup AGENDADO quando é a hora e o automático está ligado', async () => {
    const horaUtc = new Date().getUTCHours()
    const horaBrasiliaAnterior = (horaUtc - 3 - 1 + 48) % 24 // 1 h antes de agora: dentro da folga de 12 h, sem tentativa hoje
    await m.prisma.backupConfig.update({ where: { id: 1 }, data: { enabled: true, enabledAt: new Date(Date.now() - 3600_000), hourLocal: horaBrasiliaAnterior } })
    const q = new Queue(m.job.BACKUP_QUEUE_NAME, { connection: m.conn() })
    try {
      await q.add('tick', { tipo: 'tick' }, { attempts: 1 })
    } finally {
      await q.close()
    }
    const limite = Date.now() + 90_000
    let run = null
    while (!run && Date.now() < limite) {
      run = await m.prisma.backupRun.findFirst({ where: { trigger: 'SCHEDULED', status: { in: ['SUCCESS', 'FAILED'] } } })
      if (!run) await new Promise((r) => setTimeout(r, 200))
    }
    expect(run).toMatchObject({ status: 'SUCCESS', destination: 'S3' })
    expect([...s3f.objetos.keys()]).toHaveLength(1)
  }, 180_000)

  it('DUAS réplicas do worker disputando pedidos simultâneos: UM backup executa, o outro pedido é fechado como BUSY (trava runningSince), um objeto só', async () => {
    workers.push(m.job.startBackupWorker()) // segundo worker (o primeiro já está de pé nos testes anteriores)
    s3f.latenciaMs = 1500 // o envio dura o bastante para os dois pedidos se encontrarem na trava
    const a = await m.prisma.backupRun.create({ data: { trigger: 'MANUAL', status: 'QUEUED', destination: 'S3' } })
    const b = await m.prisma.backupRun.create({ data: { trigger: 'MANUAL', status: 'QUEUED', destination: 'S3' } })
    await Promise.all([m.job.enfileirarPedidoDeBackup({ tipo: 'manual-run', runId: a.id, criadoPorId: 'x' }), m.job.enfileirarPedidoDeBackup({ tipo: 'manual-run', runId: b.id, criadoPorId: 'x' })])
    const [ra, rb] = await Promise.all([esperarTerminal(m, a.id), esperarTerminal(m, b.id)])
    const status = [ra.status, rb.status].sort()
    expect(status).toEqual(['FAILED', 'SUCCESS'])
    const falhou = ra.status === 'FAILED' ? ra : rb
    expect(falhou.errorCode).toBe('BUSY')
    expect([...s3f.objetos.keys()]).toHaveLength(1)
    s3f.latenciaMs = 0
  }, 240_000)
})
