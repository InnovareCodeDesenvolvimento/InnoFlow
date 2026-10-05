/**
 * Backup automático — SERVIÇO de ponta a ponta contra Postgres 16/18 REAL (`pg_dump`/`pg_restore` de verdade), Redis real e um S3 FALSO local que confere a assinatura SigV4
 * (`tests/helpers/s3Falso.ts`). Banco próprio (a `BackupConfig` é singleton global e as suítes rodam em paralelo).
 *
 * Prova: ciclo completo (seed -> backup CIFRADO -> S3 -> DROP SCHEMA -> decifrar -> pg_restore -> dados voltam); trava concorrente; arquivo temporário apagado SEMPRE (inclusive em
 * falha e em timeout); retenção (nunca apaga a nova nem a única); retentativa só para rede; erro como CÓDIGO; conferência semanal (integridade, troca de arquivo, chave errada,
 * adulteração); agendador (janela, anti-duplicidade, retentativa após falha, atraso, abandonadas); segredo ausente de log/histórico/argv.
 *
 * NÃO PROVA: S3/Google Drive REAIS (provedores têm particularidades que um servidor falso não reproduz).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { criarBancoProprio } from './helpers/bancoProprio'
import { binarioDoPg, ferramentasDoPgDisponiveis, prepararAmbienteDoPg, restaurarDumpPeloRoteiro } from './helpers/backupAmbiente'
import { iniciarS3Falso, type S3Falso } from '../helpers/s3Falso'

const ACCESS = 'AKIAMARCADORUNICO7QX'
const SECRET = 'Segredo-S3-Marcador-Unico-abc123/xyz+987'
const temPg = ferramentasDoPgDisponiveis()
if (!temPg && process.env.CI) throw new Error('pg_dump/pg_restore não encontrados na CI: o teste de backup não pode "passar" sem provar nada (instale postgresql-client ou defina BACKUP_PG_BIN_DIR).')
if (!temPg) console.warn('[backupExecucao] pg_dump/pg_restore indisponíveis nesta máquina — suíte PULADA (defina BACKUP_PG_BIN_DIR).')

type Mods = {
  prisma: typeof import('../../src/lib/prisma').prisma
  logger: typeof import('../../src/lib/logger').logger
  exe: typeof import('../../src/services/backup/executarBackup')
  ver: typeof import('../../src/services/backup/verificarBackup')
  ag: typeof import('../../src/services/backup/agendador')
  pgf: typeof import('../../src/services/backup/pgFerramentas')
  sec: typeof import('../../src/lib/crypto/paymentSecrets')
  bc: typeof import('../../src/lib/crypto/backupCrypto')
  dest: typeof import('../../src/services/backup/destinos')
  trava: typeof import('../../src/services/backup/trava')
  redis: typeof import('../../src/lib/redis').redis
}

const dump = (v: unknown): string => JSON.stringify(v, (_k, x) => (x instanceof Error ? { name: x.name, message: x.message, stack: x.stack } : typeof x === 'bigint' ? Number(x) : x))
const dia = (n: number, hhmm = '06:10') => new Date(`2026-11-${String(n).padStart(2, '0')}T${hhmm}:00.000Z`) // 06:10 UTC = 03:10 Brasília

describe.skipIf(!temPg)('backup automático — serviço contra Postgres, Redis e S3 (falso) reais', () => {
  let m: Mods
  let banco: Awaited<ReturnType<typeof criarBancoProprio>>
  let s3f: S3Falso
  let urlDoBanco = ''
  let senhaDoBanco = ''
  let tmpBase: string
  let chaveDoDono: Buffer
  const logs: string[] = []
  const alertas: Array<Record<string, unknown>> = []

  beforeAll(async () => {
    prepararAmbienteDoPg()
    banco = await criarBancoProprio('bkx')
    // Senha MARCADOR na URL quando o Postgres local é "trust" (ignora a senha): prova que ela nunca aparece em log/argv/histórico. Com senha real (CI) vale a real.
    const u = new URL(banco.url)
    if (!u.password) u.password = 'SenhaDoBanco-Marcador-9x'
    senhaDoBanco = u.password
    urlDoBanco = u.toString()
    process.env.DATABASE_URL = urlDoBanco
    s3f = await iniciarS3Falso({ bucket: 'bkt', accessKeyId: ACCESS, secretAccessKey: SECRET })
    tmpBase = mkdtempSync(join(tmpdir(), 'bkx-base-'))
    const [prismaMod, loggerMod, exe, ver, ag, pgf, sec, bc, dest, trava, redisMod] = await Promise.all([
      import('../../src/lib/prisma'),
      import('../../src/lib/logger'),
      import('../../src/services/backup/executarBackup'),
      import('../../src/services/backup/verificarBackup'),
      import('../../src/services/backup/agendador'),
      import('../../src/services/backup/pgFerramentas'),
      import('../../src/lib/crypto/paymentSecrets'),
      import('../../src/lib/crypto/backupCrypto'),
      import('../../src/services/backup/destinos'),
      import('../../src/services/backup/trava'),
      import('../../src/lib/redis'),
    ])
    m = { prisma: prismaMod.prisma, logger: loggerMod.logger, exe, ver, ag, pgf, sec, bc, dest, trava, redis: redisMod.redis }
    for (const nivel of ['info', 'warn', 'error', 'debug'] as const) {
      const original = m.logger[nivel].bind(m.logger) as (...a: unknown[]) => void
      vi.spyOn(m.logger, nivel).mockImplementation(((...args: unknown[]) => {
        logs.push(dump(args))
        if (typeof args[0] === 'object' && args[0] && typeof (args[0] as { alert?: unknown }).alert === 'string') alertas.push(args[0] as Record<string, unknown>)
        original(...args)
      }) as never)
    }
    chaveDoDono = m.bc.generateBackupKey()
    jwtSecretOriginal = (await import('../../src/lib/env')).env.JWT_SECRET
  }, 180_000)

  afterAll(async () => {
    vi.restoreAllMocks()
    await m?.prisma.$disconnect()
    m?.redis.disconnect()
    await banco?.descartar()
    await s3f?.fechar()
    if (tmpBase) rmSync(tmpBase, { recursive: true, force: true })
  }, 60_000)

  async function configurar(extra: Record<string, unknown> = {}, opcoes: { semChave?: boolean; semDestino?: boolean } = {}): Promise<void> {
    await m.prisma.backupConfig.update({
      where: { id: 1 },
      data: {
        enabled: false,
        enabledAt: null,
        destination: opcoes.semDestino ? null : 'S3',
        s3Endpoint: s3f.url,
        s3Region: 'us-east-1',
        s3Bucket: 'bkt',
        s3Prefix: 'inno',
        s3AccessKeyCiphertext: m.sec.encryptPaymentSecret(ACCESS),
        s3SecretKeyCiphertext: m.sec.encryptPaymentSecret(SECRET),
        encryptionKeyCiphertext: opcoes.semChave ? null : m.sec.encryptPaymentSecret(chaveDoDono.toString('hex')),
        encryptionKeyFingerprint: opcoes.semChave ? null : m.bc.keyFingerprint(chaveDoDono),
        retentionCount: 7,
        frequencyDays: 1,
        hourLocal: 3,
        alertAfterHours: 36,
        runningSince: null,
        lastSuccessAt: null,
        lastAttemptAt: null,
        lastStaleAlertAt: null,
        ...extra,
      },
    })
  }

  beforeEach(async () => {
    await m.prisma.backupRun.deleteMany()
    s3f.objetos.clear()
    s3f.requisicoes.length = 0
    s3f.latenciaMs = 0
    logs.length = 0
    alertas.length = 0
    await configurar()
  })
  afterEach(async () => {
    // Isolamento: um teste que trocou o JWT_SECRET (a chave dos segredos é derivada dele) NUNCA pode vazar para o seguinte, nem em ordem embaralhada.
    const { env } = await import('../../src/lib/env')
    env.JWT_SECRET = jwtSecretOriginal
    m.sec.resetPaymentSecretsKeyCacheParaTeste()
    // Nenhum teste pode deixar processo/arquivo temporário para trás.
    expect(readdirSync(tmpBase)).toEqual([])
  })

  let jwtSecretOriginal = ''
  const semEspera = async (_ms: number): Promise<void> => undefined

  function execEspiao(sobrescrever: Partial<Record<'pg_dump' | 'pg_restore', (args: string[], env: Record<string, string>, opcoes?: { timeoutMs?: number }) => Promise<string>>> = {}) {
    const chamadas: Array<{ comando: string; args: string[] }> = []
    const fn: import('../../src/services/backup/pgFerramentas').ExecutorDeComando = async (comando, args, env, opcoes) => {
      chamadas.push({ comando, args: [...args] })
      const o = sobrescrever[comando]
      return o ? o(args, env, opcoes) : m.pgf.executarComando(comando, args, env, opcoes)
    }
    return { fn, chamadas }
  }

  const rodar = (extra: Partial<import('../../src/services/backup/executarBackup').DepsDoBackup> = {}, gatilho: 'SCHEDULED' | 'MANUAL' = 'SCHEDULED', agora = dia(10)) =>
    m.exe.executarBackup({ gatilho }, { agora: () => agora, dormir: semEspera, pastaTemporariaBase: tmpBase, ...extra })
  const ultimaExecucao = () => m.prisma.backupRun.findFirstOrThrow({ orderBy: { createdAt: 'desc' } })
  const alertasDe = (nome: string) => alertas.filter((a) => a.alert === nome)

  // ---------------------------------------------------------------------------------------------------------------------------------
  describe('ciclo completo: seed -> backup cifrado no S3 -> DROP SCHEMA -> decifrar -> pg_restore -> conferir', () => {
    it('os dados voltam, o arquivo no destino é cifrado e o histórico descreve o que subiu', async () => {
      const marcador = `SEED-${Math.random().toString(36).slice(2, 9)}`
      for (let i = 0; i < 3; i += 1) await m.prisma.operator.create({ data: { name: `${marcador}-op${i}`, email: `${marcador}-${i}@example.com` } })
      const totalDeOperadores = await m.prisma.operator.count()

      const r = await rodar()
      expect(r.objectKey).toMatch(/^inno\/backup-innoflow-2026-11-10-03h10m00s\.dump\.enc$/)
      expect(r.destination).toBe('S3')
      expect(r.tablesWithData).toBeGreaterThan(0)

      // O objeto no destino: cifrado (marca INNOBKP, NÃO é um dump em claro), com o SHA-256 como metadado, e com o tamanho do histórico.
      const obj = s3f.objetos.get(r.objectKey!)!
      expect(obj.corpo.subarray(0, 7).toString('latin1')).toBe('INNOBKP')
      expect(obj.corpo.subarray(0, 5).toString('latin1')).not.toBe('PGDMP')
      expect(obj.metadados.sha256).toBe(r.checksumSha256)
      const run = await ultimaExecucao()
      expect(run).toMatchObject({ trigger: 'SCHEDULED', status: 'SUCCESS', destination: 'S3', objectKey: r.objectKey, checksumSha256: r.checksumSha256, errorCode: null, encryptionKeyFingerprint: m.bc.keyFingerprint(chaveDoDono) })
      expect(Number(run.sizeBytes)).toBe(obj.corpo.length)
      expect(run.durationMs).not.toBeNull()
      expect(run.tablesWithData).toBe(r.tablesWithData)
      expect((await m.prisma.backupConfig.findUniqueOrThrow({ where: { id: 1 } })).lastSuccessAt).not.toBeNull()

      // Decifra com a chave DO DONO (a que ele guardou), como faria o decrypt-backup.mjs, e confere o formato custom.
      const pasta = mkdtempSync(join(tmpdir(), 'bkx-restore-'))
      try {
        writeFileSync(join(pasta, 'x.dump.enc'), obj.corpo)
        await m.bc.decryptFile(join(pasta, 'x.dump.enc'), join(pasta, 'x.dump'), chaveDoDono)
        expect(readFileSync(join(pasta, 'x.dump')).subarray(0, 5).toString('latin1')).toBe('PGDMP')

        // DROP SCHEMA e restore de verdade.
        await m.prisma.$disconnect()
        const u = new URL(urlDoBanco)
        const envPg = { ...process.env, PGHOST: u.hostname, PGPORT: u.port, PGUSER: decodeURIComponent(u.username), PGPASSWORD: decodeURIComponent(u.password), PGDATABASE: u.pathname.slice(1) }
        const drop = spawnSync(binarioDoPg('psql'), ['-v', 'ON_ERROR_STOP=1', '-c', 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'], { env: envPg, encoding: 'utf8' })
        expect(drop.status, drop.stderr).toBe(0)
        const verificaVazio = new PrismaClient({ datasources: { db: { url: urlDoBanco } } })
        await expect(verificaVazio.operator.count()).rejects.toThrow() // a tabela sumiu
        await verificaVazio.$disconnect()

        // Restaura pelo MESMO caminho do restore-db.sh (roteiro sem o SET transaction_timeout + psql em transação): o pg_restore direto quebra com cliente 18 x servidor 16 (a CI).
        const restore = restaurarDumpPeloRoteiro(join(pasta, 'x.dump'), envPg, pasta)
        expect(restore.status, restore.stderr).toBe(0)

        const depois = new PrismaClient({ datasources: { db: { url: urlDoBanco } } })
        try {
          expect(await depois.operator.count()).toBe(totalDeOperadores)
          const nomes = (await depois.operator.findMany({ where: { name: { startsWith: marcador } }, orderBy: { name: 'asc' } })).map((o) => o.name)
          expect(nomes).toEqual([`${marcador}-op0`, `${marcador}-op1`, `${marcador}-op2`])
          // A própria config (com os segredos CIFRADOS) volta junto — e só decifra com a PAYMENT_SECRETS_KEY original.
          const cfg = await depois.backupConfig.findUniqueOrThrow({ where: { id: 1 } })
          expect(cfg.s3AccessKeyCiphertext).toMatch(/^v1:/)
          expect(m.sec.decryptPaymentSecret(cfg.s3AccessKeyCiphertext!)).toBe(ACCESS)
          // Os dados de BackupRun do momento do dump também (o histórico estava RUNNING quando o dump saiu).
          expect(await depois.backupRun.count()).toBeGreaterThanOrEqual(1)
        } finally {
          await depois.$disconnect()
        }
      } finally {
        rmSync(pasta, { recursive: true, force: true })
      }
    }, 180_000)
  })

  // ---------------------------------------------------------------------------------------------------------------------------------
  describe('segredo nunca aparece (log, histórico, argv)', () => {
    it('chave de acesso, segredo do S3, chave do backup e senha do banco ficam FORA de logs, de BackupRun e dos argumentos dos processos', async () => {
      const espiao = execEspiao()
      await rodar({ exec: espiao.fn })
      await m.ver.verificarUltimaCopia({ gatilho: 'MANUAL' }, { exec: espiao.fn, agora: () => dia(10, '07:00'), pastaTemporariaBase: tmpBase })
      const historico = dump(await m.prisma.backupRun.findMany())
      const config = dump(await m.prisma.backupConfig.findMany())
      const argv = dump(espiao.chamadas)
      const logado = logs.join('\n')
      const segredos = [ACCESS, SECRET, chaveDoDono.toString('hex'), m.bc.formatBackupKey(chaveDoDono), ...(senhaDoBanco.length >= 12 ? [senhaDoBanco] : [])] // senha curta da CI ("postgres") colide com o nome do usuário/banco
      for (const segredo of segredos) {
        expect(logado, `log vazou ${segredo.slice(0, 6)}...`).not.toContain(segredo)
        expect(historico, 'BackupRun vazou').not.toContain(segredo)
        expect(argv, 'argv vazou').not.toContain(segredo)
      }
      // Na config os segredos estão CIFRADOS (nunca em claro).
      for (const segredo of [ACCESS, SECRET, chaveDoDono.toString('hex')]) expect(config).not.toContain(segredo)
      // O pg_dump recebeu a senha por ENV (não por argv): nenhum argumento carrega a URL do banco.
      expect(argv).not.toContain('postgresql://')
    }, 120_000)
  })

  // ---------------------------------------------------------------------------------------------------------------------------------
  describe('falhas: viram CÓDIGO no histórico, a trava é liberada e o temporário some', () => {
    it('sem a chave do backup: falha ANTES do dump (KEY) — pg_dump nem roda, nada sobe', async () => {
      await configurar({}, { semChave: true })
      const espiao = execEspiao()
      await expect(rodar({ exec: espiao.fn })).rejects.toMatchObject({ codigo: 'KEY' })
      expect(espiao.chamadas).toEqual([])
      expect(s3f.objetos.size).toBe(0)
      expect(await ultimaExecucao()).toMatchObject({ status: 'FAILED', errorCode: 'KEY', finishedAt: expect.any(Date) })
      expect((await m.prisma.backupConfig.findUniqueOrThrow({ where: { id: 1 } })).runningSince).toBeNull()
      expect(alertasDe('backup_failed')).toHaveLength(1)
      expect(alertasDe('backup_failed')[0]).toMatchObject({ motivo: 'KEY', operacao: 'SCHEDULED' })
    })

    it('chave-mestra trocada (segredos do destino não decifram — kid desconhecido): SECRETS_KEY, sem gastar o dump', async () => {
      await m.prisma.backupConfig.update({ where: { id: 1 }, data: { s3SecretKeyCiphertext: 'v1:deadbeef:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } })
      const espiao = execEspiao()
      await expect(rodar({ exec: espiao.fn })).rejects.toMatchObject({ codigo: 'SECRETS_KEY' })
      expect(espiao.chamadas).toEqual([])
      expect(await ultimaExecucao()).toMatchObject({ status: 'FAILED', errorCode: 'SECRETS_KEY' })
    })

    it('JWT_SECRET TROCADO (a chave dos segredos é derivada dele; MUDANÇA DELIBERADA, como no InnoChat): destino e cópia da chave viram ilegíveis — SECRETS_KEY, sem gastar o dump, SEM derrubar o worker (erro tipado, trava liberada); voltar ao JWT_SECRET antigo restabelece', async () => {
      await configurar({})
      const { env } = await import('../../src/lib/env')
      const original = env.JWT_SECRET
      const espiao = execEspiao()
      try {
        env.JWT_SECRET = 'jwt-secret-TROCADO-pelo-dono-do-sistema-0123456789-xyz'
        await expect(rodar({ exec: espiao.fn })).rejects.toMatchObject({ codigo: 'SECRETS_KEY' })
        expect(espiao.chamadas).toEqual([])
        expect(s3f.objetos.size).toBe(0)
        expect(await ultimaExecucao()).toMatchObject({ status: 'FAILED', errorCode: 'SECRETS_KEY', finishedAt: expect.any(Date) })
        expect((await m.prisma.backupConfig.findUniqueOrThrow({ where: { id: 1 } })).runningSince).toBeNull()
        const log = JSON.stringify(logs)
        expect(log).not.toContain(original)
        expect(log).not.toContain(env.JWT_SECRET)
      } finally {
        env.JWT_SECRET = original
      }
      // o JWT_SECRET antigo de volta: os segredos e a cópia da chave do backup decifram de novo (sem rodar outro pg_dump inteiro: um backup completo a mais, ao fim do teste, só aumenta a janela de interferência)
      const config = await m.prisma.backupConfig.findUniqueOrThrow({ where: { id: 1 } })
      expect(m.sec.decifrarSegredoOuNull(config.s3SecretKeyCiphertext)).toBe(SECRET)
      expect((await import('../../src/services/backup/configBackup')).chaveDoBackupDaConfig(config).impressaoDigital).toBe(m.bc.keyFingerprint(chaveDoDono))
    }, 120_000)

    it('só a CÓPIA da chave do backup ilegível (destino recadastrado depois da troca do JWT_SECRET): KEY — "gere a chave de novo" —, sem gastar o dump nem derrubar o worker', async () => {
      await configurar({})
      // cópia cifrada por OUTRA chave-mestra (kid desconhecido): é o que sobra no banco depois de trocar o JWT_SECRET; o destino (S3) já foi recadastrado e decifra
      await m.prisma.backupConfig.update({ where: { id: 1 }, data: { encryptionKeyCiphertext: 'v1:deadbeef:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } })
      const espiao = execEspiao()
      await expect(rodar({ exec: espiao.fn })).rejects.toMatchObject({ codigo: 'KEY' })
      expect(espiao.chamadas).toEqual([])
      expect(await ultimaExecucao()).toMatchObject({ status: 'FAILED', errorCode: 'KEY', finishedAt: expect.any(Date) })
      expect((await m.prisma.backupConfig.findUniqueOrThrow({ where: { id: 1 } })).runningSince).toBeNull()
    })

    it('credencial do S3 recusada: CREDENTIAL (e o dump em claro NÃO fica no disco)', async () => {
      await m.prisma.backupConfig.update({ where: { id: 1 }, data: { s3SecretKeyCiphertext: m.sec.encryptPaymentSecret('segredo-errado-errado') } })
      await expect(rodar()).rejects.toMatchObject({ codigo: 'CREDENTIAL' })
      expect(await ultimaExecucao()).toMatchObject({ status: 'FAILED', errorCode: 'CREDENTIAL' })
      expect(s3f.objetos.size).toBe(0)
    }, 120_000)

    it('S3 fora do ar: NETWORK depois de 3 tentativas (rede é o único erro retentado)', async () => {
      await m.prisma.backupConfig.update({ where: { id: 1 }, data: { s3Endpoint: 'http://127.0.0.1:1' } })
      await expect(rodar()).rejects.toMatchObject({ codigo: 'NETWORK' })
      expect(await ultimaExecucao()).toMatchObject({ status: 'FAILED', errorCode: 'NETWORK' })
    }, 120_000)

    it('RETENTATIVA: 2 falhas de rede (500) e a 3ª tentativa passa — com fluxo NOVO a cada tentativa (o objeto sobe inteiro e íntegro)', async () => {
      s3f.falharProximasGravacoes(2, 500)
      const esperas: number[] = []
      const r = await rodar({ dormir: async (ms) => void esperas.push(ms) })
      expect(esperas).toEqual([2_000, 10_000]) // backoff entre as tentativas
      const obj = s3f.objetos.get(r.objectKey!)!
      expect(obj.corpo.length).toBe(r.sizeBytes)
      expect(obj.metadados.sha256).toBe(r.checksumSha256)
      expect(s3f.requisicoes.filter((q) => q.startsWith('PUT /bkt/inno/backup-')).length).toBe(3)
    }, 120_000)

    it('credencial recusada NÃO é retentada (repetir não resolve)', async () => {
      await m.prisma.backupConfig.update({ where: { id: 1 }, data: { s3AccessKeyCiphertext: m.sec.encryptPaymentSecret('AKIAERRADA') } })
      const esperas: number[] = []
      await expect(rodar({ dormir: async (ms) => void esperas.push(ms) })).rejects.toMatchObject({ codigo: 'CREDENTIAL' })
      expect(esperas).toEqual([])
    }, 120_000)

    it('pg_dump passa do PRAZO: é morto, vira DUMP_TIMEOUT, a trava é liberada e o temporário some', async () => {
      const espiao = execEspiao({
        pg_dump: async (args, env, opcoes) => {
          if (args[0] === '--version') return m.pgf.executarComando('pg_dump', args, env, opcoes)
          return m.pgf.executarComando('pg_dump', ['-e', 'setTimeout(() => {}, 60000)'], env, { ...opcoes, binario: process.execPath })
        },
      })
      const t0 = Date.now()
      await expect(rodar({ exec: espiao.fn, prazoDoDumpMs: 500 })).rejects.toMatchObject({ codigo: 'DUMP_TIMEOUT' })
      expect(Date.now() - t0).toBeLessThan(30_000)
      expect(await ultimaExecucao()).toMatchObject({ status: 'FAILED', errorCode: 'DUMP_TIMEOUT' })
      expect((await m.prisma.backupConfig.findUniqueOrThrow({ where: { id: 1 } })).runningSince).toBeNull()
      expect(s3f.objetos.size).toBe(0)
    }, 120_000)

    it('cliente do Postgres ausente na imagem: DUMP (a causa vai no log, não na tela)', async () => {
      const antes = process.env.BACKUP_PG_BIN_DIR
      process.env.BACKUP_PG_BIN_DIR = join(tmpBase, 'nao-existe')
      try {
        await expect(rodar()).rejects.toMatchObject({ codigo: 'DUMP' })
      } finally {
        process.env.BACKUP_PG_BIN_DIR = antes
      }
      expect(await ultimaExecucao()).toMatchObject({ status: 'FAILED', errorCode: 'DUMP' })
    })

    it('arquivo temporário apagado EM FALHA: a pasta existiu durante o dump e não existe depois', async () => {
      let pasta = ''
      await configurar({}, { semChave: false })
      await m.prisma.backupConfig.update({ where: { id: 1 }, data: { s3Endpoint: 'http://127.0.0.1:1' } })
      await expect(rodar({ aoCriarPastaTemporaria: (p) => void (pasta = p) })).rejects.toBeTruthy()
      expect(pasta).not.toBe('')
      expect(existsSync(pasta)).toBe(false)
      expect(readdirSync(tmpBase)).toEqual([]) // o afterEach confere de novo
    }, 120_000)

    it('agendado SEM destino completo: falha CONFIG (cópia que fica no servidor não é backup) — mas o MANUAL sem destino NENHUM vale como teste do pg_dump', async () => {
      await configurar({}, { semDestino: true })
      await expect(rodar()).rejects.toMatchObject({ codigo: 'CONFIG' })
      expect(await ultimaExecucao()).toMatchObject({ trigger: 'SCHEDULED', status: 'FAILED', errorCode: 'CONFIG' })
      const r = await rodar({}, 'MANUAL')
      expect(r.objectKey).toBeNull()
      expect(r.destination).toBeNull()
      expect(r.tablesWithData).toBeGreaterThan(0)
      expect(await m.prisma.backupRun.findFirstOrThrow({ where: { trigger: 'MANUAL' } })).toMatchObject({ status: 'SUCCESS', objectKey: null })
      // Teste sem destino NÃO conta como cópia: não mexe em lastSuccessAt (senão calaria o alerta de atraso).
      expect((await m.prisma.backupConfig.findUniqueOrThrow({ where: { id: 1 } })).lastSuccessAt).toBeNull()
    }, 120_000)

    it('falha de pedido MANUAL fica só no histórico: sem alerta backup_failed (quem pediu está na tela)', async () => {
      await configurar({}, { semChave: true })
      await expect(rodar({}, 'MANUAL')).rejects.toMatchObject({ codigo: 'KEY' })
      expect(alertasDe('backup_failed')).toHaveLength(0)
    })

    it('DATABASE_URL inválida: CONFIG, e a mensagem de erro não ecoa a URL', async () => {
      try {
        await rodar({ databaseUrl: 'isto-nao-e-uma-url://senha:segredo-na-url' })
        expect.unreachable()
      } catch (e) {
        expect((e as { codigo: string }).codigo).toBe('CONFIG')
        expect((e as Error).message).not.toContain('segredo-na-url')
      }
    })
  })

  // ---------------------------------------------------------------------------------------------------------------------------------
  describe('trava (runningSince) e concorrência', () => {
    it('dois backups ao mesmo tempo: UM roda, o outro é BUSY; só um objeto sobe', async () => {
      const [a, b] = await Promise.allSettled([rodar({}, 'SCHEDULED', dia(10)), rodar({}, 'SCHEDULED', dia(10, '06:10'))])
      const resultados = [a, b]
      expect(resultados.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      const rejeitado = resultados.find((r) => r.status === 'rejected') as PromiseRejectedResult
      expect(rejeitado.reason).toMatchObject({ codigo: 'BUSY' })
      expect(s3f.objetos.size).toBe(1)
      expect(await m.prisma.backupRun.count({ where: { status: 'SUCCESS' } })).toBe(1)
      expect((await m.prisma.backupConfig.findUniqueOrThrow({ where: { id: 1 } })).runningSince).toBeNull()
    }, 180_000)

    it('trava VIVA de outra execução: BUSY sem tocar em nada; trava ABANDONADA (> 2 h) é tomada', async () => {
      const agora = dia(10)
      await m.prisma.backupConfig.update({ where: { id: 1 }, data: { runningSince: new Date(agora.getTime() - 30 * 60_000) } })
      await expect(rodar()).rejects.toMatchObject({ codigo: 'BUSY' })
      expect(s3f.objetos.size).toBe(0)
      await m.prisma.backupConfig.update({ where: { id: 1 }, data: { runningSince: new Date(agora.getTime() - 3 * 60 * 60_000) } })
      const r = await rodar()
      expect(r.objectKey).toBeTruthy()
      expect((await m.prisma.backupConfig.findUniqueOrThrow({ where: { id: 1 } })).runningSince).toBeNull()
    }, 120_000)

    it('o processo vivo RENOVA a trava (batimento): uma execução longa não a perde para outra', async () => {
      const espiao = execEspiao({
        pg_dump: async (args, env, opcoes) => {
          if (args[0] !== '--version') await new Promise((r) => setTimeout(r, 2500))
          return m.pgf.executarComando('pg_dump', args, env, opcoes)
        },
      })
      const p = m.exe.executarBackup({ gatilho: 'SCHEDULED' }, { pastaTemporariaBase: tmpBase, dormir: semEspera, exec: espiao.fn, intervaloDoBatimentoMs: 100 })
      const lerTrava = async () => (await m.prisma.backupConfig.findUniqueOrThrow({ where: { id: 1 } })).runningSince
      const limite = Date.now() + 20_000
      let r1: Date | null = null
      while (!r1 && Date.now() < limite) {
        await new Promise((r) => setTimeout(r, 50))
        r1 = await lerTrava()
      }
      let r2 = r1
      while (r1 && r2 && r2.getTime() === r1.getTime() && Date.now() < limite) {
        await new Promise((r) => setTimeout(r, 50))
        r2 = await lerTrava()
      }
      expect(r1).not.toBeNull()
      expect(r2!.getTime()).toBeGreaterThan(r1!.getTime()) // a trava ANDOU: foi renovada pelo processo vivo
      await p
    }, 120_000)

    it('banco MAIS LENTO que o batimento (intervalo de 1 ms: batimentos se sobreporiam) NÃO dá falso "trava tomada por outro": um batimento por vez', async () => {
      const espiao = execEspiao({
        pg_dump: async (args, env, opcoes) => {
          if (args[0] !== '--version') await new Promise((r) => setTimeout(r, 1500))
          return m.pgf.executarComando('pg_dump', args, env, opcoes)
        },
      })
      const r = await m.exe.executarBackup({ gatilho: 'SCHEDULED' }, { pastaTemporariaBase: tmpBase, dormir: semEspera, exec: espiao.fn, intervaloDoBatimentoMs: 1 })
      expect(r.objectKey).toBeTruthy()
      expect((await m.prisma.backupConfig.findUniqueOrThrow({ where: { id: 1 } })).runningSince).toBeNull()
    }, 120_000)

    it('se OUTRO tomou a trava no meio (batimento descobre), o upload NÃO acontece e a trava do outro não é apagada', async () => {
      const dono = new Date(Date.now() + 5_000)
      const espiao = execEspiao({
        pg_dump: async (args, env, opcoes) => {
          if (args[0] !== '--version') {
            await m.prisma.backupConfig.update({ where: { id: 1 }, data: { runningSince: dono } }) // "outra réplica" tomou
            await new Promise((r) => setTimeout(r, 400)) // dá tempo ao batimento (50 ms) de perceber
          }
          return m.pgf.executarComando('pg_dump', args, env, opcoes)
        },
      })
      await expect(m.exe.executarBackup({ gatilho: 'SCHEDULED' }, { pastaTemporariaBase: tmpBase, dormir: semEspera, exec: espiao.fn, intervaloDoBatimentoMs: 50 })).rejects.toMatchObject({ codigo: 'BUSY' })
      expect(s3f.objetos.size).toBe(0)
      const cfg = await m.prisma.backupConfig.findUniqueOrThrow({ where: { id: 1 } })
      expect(cfg.runningSince?.getTime()).toBe(dono.getTime()) // a trava do outro continua dele
    }, 120_000)

    it('pedido MANUAL (QUEUED) vira RUNNING e termina; se a trava está com outro, o pedido é fechado como BUSY (não fica pendurado)', async () => {
      const queued = await m.prisma.backupRun.create({ data: { trigger: 'MANUAL', status: 'QUEUED', destination: 'S3' } })
      const r = await m.exe.executarBackup({ gatilho: 'MANUAL', runId: queued.id }, { pastaTemporariaBase: tmpBase, dormir: semEspera })
      expect(r.runId).toBe(queued.id)
      expect(await m.prisma.backupRun.findUniqueOrThrow({ where: { id: queued.id } })).toMatchObject({ status: 'SUCCESS', startedAt: expect.any(Date), finishedAt: expect.any(Date) })

      const queued2 = await m.prisma.backupRun.create({ data: { trigger: 'MANUAL', status: 'QUEUED', destination: 'S3' } })
      await m.prisma.backupConfig.update({ where: { id: 1 }, data: { runningSince: new Date() } })
      await expect(m.exe.executarBackup({ gatilho: 'MANUAL', runId: queued2.id }, { pastaTemporariaBase: tmpBase, dormir: semEspera })).rejects.toMatchObject({ codigo: 'BUSY' })
      expect(await m.prisma.backupRun.findUniqueOrThrow({ where: { id: queued2.id } })).toMatchObject({ status: 'FAILED', errorCode: 'BUSY' })
      // Um pedido que o agendador já fechou (NOT_PICKED_UP) não é executado depois.
      await m.prisma.backupConfig.update({ where: { id: 1 }, data: { runningSince: null } })
      const velho = await m.prisma.backupRun.create({ data: { trigger: 'MANUAL', status: 'FAILED', errorCode: 'NOT_PICKED_UP', finishedAt: new Date() } })
      await expect(m.exe.executarBackup({ gatilho: 'MANUAL', runId: velho.id }, { pastaTemporariaBase: tmpBase, dormir: semEspera })).rejects.toMatchObject({ codigo: 'NOT_PICKED_UP' })
      expect(s3f.objetos.size).toBe(1) // só o do primeiro pedido
    }, 180_000)
  })

  // ---------------------------------------------------------------------------------------------------------------------------------
  describe('retenção: N cópias, nunca a nova, nunca a única', () => {
    it('mantém só as N mais novas, ignora arquivos que não são backup e não apaga nada quando o envio falha', async () => {
      await configurar({ retentionCount: 3 })
      s3f.objetos.set('inno/foto-do-dono.jpg', { corpo: Buffer.from('foto'), metadados: {}, contentType: '', modificadoEm: new Date(2020, 0, 1) })
      s3f.objetos.set('outra-pasta/backup-innoflow-2020-01-01-03h00m00s.dump.enc', { corpo: Buffer.from('x'), metadados: {}, contentType: '', modificadoEm: new Date(2020, 0, 1) })
      for (let d = 1; d <= 5; d += 1) await rodar({}, 'SCHEDULED', dia(d))
      const backups = [...s3f.objetos.keys()].filter((k) => /^inno\/backup-innoflow-/.test(k)).sort()
      expect(backups).toEqual(['inno/backup-innoflow-2026-11-03-03h10m00s.dump.enc', 'inno/backup-innoflow-2026-11-04-03h10m00s.dump.enc', 'inno/backup-innoflow-2026-11-05-03h10m00s.dump.enc'])
      expect(s3f.objetos.has('inno/foto-do-dono.jpg')).toBe(true)
      expect(s3f.objetos.has('outra-pasta/backup-innoflow-2020-01-01-03h00m00s.dump.enc')).toBe(true)

      // Envio que FALHA não apaga nenhuma cópia existente (a poda só roda depois do envio confirmado).
      await m.prisma.backupConfig.update({ where: { id: 1 }, data: { s3SecretKeyCiphertext: m.sec.encryptPaymentSecret('errado-errado') } })
      await expect(rodar({}, 'SCHEDULED', dia(6))).rejects.toBeTruthy()
      expect([...s3f.objetos.keys()].filter((k) => /^inno\/backup-innoflow-/.test(k))).toHaveLength(3)
    }, 240_000)

    it('retenção 1: fica só a nova; com UMA cópia só, ela nunca é apagada', async () => {
      await configurar({ retentionCount: 1 })
      await rodar({}, 'SCHEDULED', dia(1))
      await rodar({}, 'SCHEDULED', dia(2))
      expect([...s3f.objetos.keys()]).toEqual(['inno/backup-innoflow-2026-11-02-03h10m00s.dump.enc'])
    }, 180_000)

    it('falha ao APAGAR cópias antigas não derruba o backup que já subiu (e emite backup_prune_failed)', async () => {
      await configurar({ retentionCount: 1 })
      await rodar({}, 'SCHEDULED', dia(1))
      const dest = await import('../../src/services/backup/destinos')
      const real = dest.criarDestinoDaConfig(await m.prisma.backupConfig.findUniqueOrThrow({ where: { id: 1 } }))!
      const comFalhaNaPoda = { ...real, apagar: async () => Promise.reject(Object.assign(new Error('x'), { codigo: 'NETWORK' })) }
      const r = await rodar({ destino: comFalhaNaPoda }, 'SCHEDULED', dia(2))
      expect(r.objectKey).toBeTruthy()
      expect(await ultimaExecucao()).toMatchObject({ status: 'SUCCESS' })
      expect(alertasDe('backup_prune_failed')).toHaveLength(1)
      expect(s3f.objetos.size).toBe(2) // sobrou a velha, mas o backup novo está lá
    }, 180_000)
  })

  // ---------------------------------------------------------------------------------------------------------------------------------
  describe('conferência (VERIFY): baixa, confere SHA-256/cabeçalho/chave, decifra por inteiro e lê o índice', () => {
    it('cópia íntegra: passa, grava VERIFY, NÃO mexe em lastSuccessAt e não escreve em banco algum', async () => {
      await rodar({}, 'SCHEDULED', dia(10))
      const antes = (await m.prisma.backupConfig.findUniqueOrThrow({ where: { id: 1 } })).lastSuccessAt
      const v = await m.ver.verificarUltimaCopia({ gatilho: 'MANUAL' }, { agora: () => dia(11), pastaTemporariaBase: tmpBase })
      expect(v).toMatchObject({ encrypted: true, keyFingerprint: m.bc.keyFingerprint(chaveDoDono), checksumConferido: true })
      expect(v.tablesWithData).toBeGreaterThan(0)
      expect(await ultimaExecucao()).toMatchObject({ trigger: 'VERIFY', status: 'SUCCESS', tablesWithData: v.tablesWithData })
      expect((await m.prisma.backupConfig.findUniqueOrThrow({ where: { id: 1 } })).lastSuccessAt?.getTime()).toBe(antes?.getTime())
    }, 180_000)

    it('arquivo ADULTERADO no destino (1 byte): CHECKSUM — e, sem referência de SHA-256, a TAG do GCM pega (VERIFY)', async () => {
      const r = await rodar({}, 'SCHEDULED', dia(10))
      const obj = s3f.objetos.get(r.objectKey!)!
      obj.corpo[obj.corpo.length - 30] ^= 0xff
      await expect(m.ver.verificarUltimaCopia({ gatilho: 'MANUAL' }, { pastaTemporariaBase: tmpBase })).rejects.toMatchObject({ codigo: 'CHECKSUM' })
      // Sem o SHA-256 gravado (banco restaurado/cópia antiga) só resta a integridade do GCM — que também reprova.
      await m.prisma.backupRun.updateMany({ data: { checksumSha256: null } })
      delete (obj.metadados as Record<string, string>).sha256
      await expect(m.ver.verificarUltimaCopia({ gatilho: 'MANUAL' }, { pastaTemporariaBase: tmpBase })).rejects.toMatchObject({ codigo: 'VERIFY' })
    }, 180_000)

    it('cópia mais recente cifrada com OUTRA chave: KEY (com a impressão digital, nunca a chave)', async () => {
      await rodar({}, 'SCHEDULED', dia(10))
      const outra = m.bc.generateBackupKey()
      const pasta = mkdtempSync(join(tmpdir(), 'bkx-troca-'))
      try {
        writeFileSync(join(pasta, 'a.dump'), 'PGDMP-qualquer-coisa'.repeat(50))
        await m.bc.encryptFile(join(pasta, 'a.dump'), join(pasta, 'a.dump.enc'), outra)
        s3f.objetos.set('inno/backup-innoflow-2026-11-12-03h00m00s.dump.enc', { corpo: readFileSync(join(pasta, 'a.dump.enc')), metadados: {}, contentType: '', modificadoEm: new Date(Date.now() + 60_000) })
      } finally {
        rmSync(pasta, { recursive: true, force: true })
      }
      await expect(m.ver.verificarUltimaCopia({ gatilho: 'MANUAL' }, { pastaTemporariaBase: tmpBase })).rejects.toMatchObject({ codigo: 'KEY' })
    }, 180_000)

    it('arquivo TROCADO por um dump em claro (sem a marca) quando o sistema já usa chave: reprova (VERIFY) — um dump forjado executa SQL no restore', async () => {
      await rodar({}, 'SCHEDULED', dia(10))
      s3f.objetos.set('inno/backup-innoflow-2026-11-12-03h00m00s.dump', { corpo: Buffer.from('PGDMP' + 'x'.repeat(200)), metadados: {}, contentType: '', modificadoEm: new Date(Date.now() + 60_000) })
      await expect(m.ver.verificarUltimaCopia({ gatilho: 'MANUAL' }, { pastaTemporariaBase: tmpBase })).rejects.toMatchObject({ codigo: 'VERIFY' })
    }, 180_000)

    it('cópia vazia, destino sem cópia e destino incompleto', async () => {
      await expect(m.ver.verificarUltimaCopia({ gatilho: 'MANUAL' }, { pastaTemporariaBase: tmpBase })).rejects.toMatchObject({ codigo: 'NO_BACKUP' })
      s3f.objetos.set('inno/backup-innoflow-2026-11-12-03h00m00s.dump.enc', { corpo: Buffer.alloc(0), metadados: {}, contentType: '', modificadoEm: new Date() })
      await expect(m.ver.verificarUltimaCopia({ gatilho: 'MANUAL' }, { pastaTemporariaBase: tmpBase })).rejects.toMatchObject({ codigo: 'VERIFY' })
      await configurar({}, { semDestino: true })
      await expect(m.ver.verificarUltimaCopia({ gatilho: 'MANUAL' }, { pastaTemporariaBase: tmpBase })).rejects.toMatchObject({ codigo: 'CONFIG' })
    }, 120_000)

    it('conferência AGENDADA que reprova emite backup_verify_failed (CRITICO); a manual não alerta', async () => {
      await rodar({}, 'SCHEDULED', dia(10))
      const obj = [...s3f.objetos.values()][0]!
      obj.corpo[40] ^= 0xff
      await expect(m.ver.verificarUltimaCopia({ gatilho: 'MANUAL' }, { pastaTemporariaBase: tmpBase })).rejects.toBeTruthy()
      expect(alertasDe('backup_verify_failed')).toHaveLength(0)
      await expect(m.ver.verificarUltimaCopia({ gatilho: 'SCHEDULED' }, { pastaTemporariaBase: tmpBase })).rejects.toBeTruthy()
      expect(alertasDe('backup_verify_failed')).toHaveLength(1)
      expect(alertasDe('backup_verify_failed')[0]).toMatchObject({ motivo: 'CHECKSUM', operacao: 'VERIFY' })
    }, 180_000)
  })

  // ---------------------------------------------------------------------------------------------------------------------------------
  describe('agendador (tick de 10 em 10 minutos)', () => {
    const tick = (agora: Date, extra: Record<string, unknown> = {}) => m.ag.executarTickDoBackup(agora, { pastaTemporariaBase: tmpBase, dormir: semEspera, ...extra })

    it('liga o automático: roda na hora marcada, NÃO repete nos ticks seguintes do mesmo dia e roda de novo no dia seguinte', async () => {
      await configurar({ enabled: true, enabledAt: dia(9) })
      expect((await tick(dia(10, '05:50'))).executou).toBe(false) // 02:50 Brasília: ainda não é a hora
      const r1 = await tick(dia(10, '06:00'))
      expect(r1).toMatchObject({ executou: true, ok: true })
      expect(s3f.objetos.size).toBe(1)
      expect((await tick(dia(10, '06:10'))).executou).toBe(false)
      expect((await tick(dia(10, '12:00'))).executou).toBe(false)
      expect((await tick(dia(10, '18:00'))).executou).toBe(false)
      const r2 = await tick(dia(11, '06:00'))
      expect(r2).toMatchObject({ executou: true, ok: true })
      expect(s3f.objetos.size).toBe(2)
    }, 240_000)

    it('desligado nunca roda; backup MANUAL feito antes NÃO faz o agendado pular', async () => {
      expect((await tick(dia(10, '06:05'))).executou).toBe(false)
      await configurar({ enabled: true, enabledAt: dia(9) })
      await m.exe.executarBackup({ gatilho: 'MANUAL' }, { agora: () => dia(9, '20:00'), pastaTemporariaBase: tmpBase, dormir: semEspera })
      expect((await tick(dia(10, '06:05'))).executou).toBe(true)
      expect(s3f.objetos.size).toBe(2)
    }, 180_000)

    it('falhou: tenta de novo só depois de 1 h, e no máximo 3 vezes por horário; cada falha emite backup_failed', async () => {
      await configurar({ enabled: true, enabledAt: dia(9) })
      await m.prisma.backupConfig.update({ where: { id: 1 }, data: { s3Endpoint: 'http://127.0.0.1:1' } })
      expect(await tick(dia(10, '06:00'))).toMatchObject({ executou: true, ok: false })
      expect((await tick(dia(10, '06:30'))).executou).toBe(false) // cedo demais
      expect((await tick(dia(10, '07:01'))).executou).toBe(true)
      expect((await tick(dia(10, '08:02'))).executou).toBe(true)
      expect((await tick(dia(10, '09:03'))).executou).toBe(false) // 3 tentativas: teto
      expect(await m.prisma.backupRun.count({ where: { trigger: 'SCHEDULED', status: 'FAILED' } })).toBe(3)
      expect(alertasDe('backup_failed')).toHaveLength(3)
      // O destino volta: o dia seguinte tenta normalmente.
      await configurar({ enabled: true, enabledAt: dia(9) })
      expect(await tick(dia(11, '06:00'))).toMatchObject({ executou: true, ok: true })
    }, 300_000)

    it('processo fora do ar na hora marcada: cobre até 12 h depois; passou disso, pula (e o alerta de atraso cobre)', async () => {
      await configurar({ enabled: true, enabledAt: dia(9) })
      expect((await tick(dia(10, '18:30'))).executou).toBe(false) // 15:30 Brasília: 12 h30 depois
      expect((await tick(dia(10, '17:30'))).executou).toBe(true) // 11 h30 depois
    }, 180_000)

    it('frequência de 2 dias: roda dia sim, dia não', async () => {
      await configurar({ enabled: true, enabledAt: dia(1), frequencyDays: 2 })
      expect((await tick(dia(10, '06:00'))).executou).toBe(true)
      expect((await tick(dia(11, '06:00'))).executou).toBe(false)
      expect((await tick(dia(12, '06:00'))).executou).toBe(true)
    }, 240_000)

    it('fecha o que ficou pendurado: RUNNING há 3 h = INTERRUPTED (+ backup_failed se agendado), QUEUED há 20 min = NOT_PICKED_UP', async () => {
      await configurar({ enabled: true, enabledAt: dia(9) })
      const agora = dia(10, '12:00')
      const velho = await m.prisma.backupRun.create({ data: { trigger: 'SCHEDULED', status: 'RUNNING', createdAt: new Date(agora.getTime() - 3 * 3600_000), startedAt: new Date(agora.getTime() - 3 * 3600_000) } })
      const fila = await m.prisma.backupRun.create({ data: { trigger: 'MANUAL', status: 'QUEUED', createdAt: new Date(agora.getTime() - 20 * 60_000) } })
      const recente = await m.prisma.backupRun.create({ data: { trigger: 'MANUAL', status: 'QUEUED', createdAt: new Date(agora.getTime() - 5 * 60_000) } })
      const r = await tick(agora)
      expect(r.fechadas).toBe(2)
      expect(await m.prisma.backupRun.findUniqueOrThrow({ where: { id: velho.id } })).toMatchObject({ status: 'FAILED', errorCode: 'INTERRUPTED', finishedAt: expect.any(Date) })
      expect(await m.prisma.backupRun.findUniqueOrThrow({ where: { id: fila.id } })).toMatchObject({ status: 'FAILED', errorCode: 'NOT_PICKED_UP' })
      expect((await m.prisma.backupRun.findUniqueOrThrow({ where: { id: recente.id } })).status).toBe('QUEUED') // ainda dentro do prazo
      expect(alertasDe('backup_failed').some((a) => a.motivo === 'INTERRUPTED')).toBe(true)
    }, 120_000)

    it('ATRASO: sem sucesso há mais de 36 h com o automático ligado emite backup_stale; no máximo 1 a cada 12 h; dentro do limite não alerta', async () => {
      await configurar({ enabled: true, enabledAt: dia(1), lastSuccessAt: dia(3, '00:00') })
      const agora = dia(5, '12:00') // 60 h depois do último sucesso
      expect(await m.ag.verificarAtrasoDoBackup(agora)).toEqual({ atrasado: true, alertou: true })
      expect(alertasDe('backup_stale')).toHaveLength(1)
      expect(alertasDe('backup_stale')[0]).toMatchObject({ desfecho: 'stale', limite: 36, ageMinutes: 60 * 60 })
      expect(await m.ag.verificarAtrasoDoBackup(new Date(agora.getTime() + 11 * 3600_000))).toEqual({ atrasado: true, alertou: false }) // ainda dentro das 12 h
      expect(alertasDe('backup_stale')).toHaveLength(1)
      expect(await m.ag.verificarAtrasoDoBackup(new Date(agora.getTime() + 12 * 3600_000 + 1000))).toEqual({ atrasado: true, alertou: true })
      expect(alertasDe('backup_stale')).toHaveLength(2)
      // Dois ticks SIMULTÂNEOS (duas réplicas) emitem UM alerta só (reserva atômica no banco).
      alertas.length = 0
      await m.prisma.backupConfig.update({ where: { id: 1 }, data: { lastStaleAlertAt: null } })
      await Promise.all([m.ag.verificarAtrasoDoBackup(agora), m.ag.verificarAtrasoDoBackup(agora), m.ag.verificarAtrasoDoBackup(agora)])
      expect(alertasDe('backup_stale')).toHaveLength(1)
      // Dentro do limite (35 h): sem alerta.
      alertas.length = 0
      await m.prisma.backupConfig.update({ where: { id: 1 }, data: { lastSuccessAt: new Date(agora.getTime() - 35 * 3600_000), lastStaleAlertAt: null } })
      expect(await m.ag.verificarAtrasoDoBackup(agora)).toEqual({ atrasado: false, alertou: false })
      expect(alertasDe('backup_stale')).toHaveLength(0)
      // Desligado nunca alerta.
      await m.prisma.backupConfig.update({ where: { id: 1 }, data: { enabled: false, lastSuccessAt: dia(1) } })
      expect((await m.ag.verificarAtrasoDoBackup(agora)).atrasado).toBe(false)
    }, 120_000)

    it('o tick informa o atraso (sem rodar backup fora do horário)', async () => {
      await configurar({ enabled: true, enabledAt: dia(1), lastSuccessAt: dia(3, '00:00'), hourLocal: 22 }) // 22h Brasília = 01h UTC
      expect(await tick(dia(5, '14:00'))).toMatchObject({ executou: false, atrasado: true }) // 13 h depois do horário: fora da folga
      expect(alertasDe('backup_stale')).toHaveLength(1)
    }, 120_000)

    it('"nunca rodou": alerta quando o automático foi ligado há mais de 36 h e nenhuma cópia saiu (âncora = enabledAt, não updatedAt)', async () => {
      await configurar({ enabled: true, enabledAt: dia(1, '00:00') })
      // Mexer na config (o Prisma renova updatedAt) NÃO adia o alerta: a âncora é quando o automático foi ligado.
      await m.prisma.backupConfig.update({ where: { id: 1 }, data: { lastAttemptAt: dia(2, '12:00') } })
      expect((await m.ag.verificarAtrasoDoBackup(dia(2, '08:00'))).atrasado).toBe(false) // 32 h
      expect((await m.ag.verificarAtrasoDoBackup(dia(2, '13:00'))).atrasado).toBe(true) // 37 h
      expect(alertasDe('backup_stale')[0]).toMatchObject({ desfecho: 'never_ran' })
    }, 120_000)

    it('conferência semanal: roda depois de haver cópia, uma vez por semana, e nunca na mesma passada do backup', async () => {
      await configurar({ enabled: true, enabledAt: dia(1) })
      const r1 = await tick(dia(10, '06:00'))
      expect(r1).toMatchObject({ executou: true, conferiu: null }) // mesma passada do backup: não confere
      const r2 = await tick(dia(10, '06:10'))
      expect(r2).toMatchObject({ executou: false, conferiu: true })
      expect(await m.prisma.backupRun.count({ where: { trigger: 'VERIFY', status: 'SUCCESS' } })).toBe(1)
      expect((await tick(dia(12, '18:30'))).conferiu).toBeNull() // < 7 dias (e fora da folga do horário marcado: sem backup na passada)
      expect((await tick(dia(17, '18:30'))).conferiu).toBe(true) // >= 7 dias
      expect(await m.prisma.backupRun.count({ where: { trigger: 'VERIFY' } })).toBe(2)
    }, 300_000)

    it('o histórico velho (> 180 dias) é apagado, o recente fica', async () => {
      const agora = dia(10, '12:00')
      const velho = await m.prisma.backupRun.create({ data: { trigger: 'SCHEDULED', status: 'SUCCESS', finishedAt: new Date(), createdAt: new Date(agora.getTime() - 181 * 86_400_000) } })
      const novo = await m.prisma.backupRun.create({ data: { trigger: 'SCHEDULED', status: 'SUCCESS', finishedAt: new Date(), createdAt: new Date(agora.getTime() - 10 * 86_400_000) } })
      const r = await tick(agora)
      expect(r.historicoApagado).toBe(1)
      expect(await m.prisma.backupRun.findUnique({ where: { id: velho.id } })).toBeNull()
      expect(await m.prisma.backupRun.findUnique({ where: { id: novo.id } })).not.toBeNull()
    }, 120_000)

    it('o tick NUNCA lança, mesmo com o destino em estado ruim (a falha vira histórico + alerta, não exceção)', async () => {
      await configurar({ enabled: true, enabledAt: dia(9) })
      await m.prisma.backupConfig.update({ where: { id: 1 }, data: { s3Endpoint: 'isto não é um endereço' } })
      await expect(tick(dia(10, '06:00'))).resolves.toMatchObject({ executou: true, ok: false })
      expect(await ultimaExecucao()).toMatchObject({ status: 'FAILED' })
    }, 120_000)
  })
})
