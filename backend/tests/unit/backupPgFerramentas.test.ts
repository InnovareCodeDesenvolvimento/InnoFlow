/**
 * Processos filhos do backup (`src/services/backup/pgFerramentas.ts`): ambiente MÍNIMO (o JWT_SECRET/PAYMENT_SECRETS_KEY do servidor não vão a um binário externo), senha só em
 * variável de ambiente (nunca em argv nem em log), prazo que MATA o filho, erro sem stderr na mensagem. Usa o próprio Node como "binário" (opcao `binario`), sem precisar de Postgres.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ErroDeBackup } from '../../src/core/backup/erros'
import { logger } from '../../src/lib/logger'
import { ambienteDoFilho, caminhoDaFerramenta, executarComando, semASenhaDoBanco } from '../../src/services/backup/pgFerramentas'

afterEach(() => vi.restoreAllMocks())

describe('ambiente do processo filho', () => {
  it('só leva PATH/Windows/TEMP + variáveis PG* — NÃO leva JWT_SECRET, PAYMENT_SECRETS_KEY, DATABASE_URL, REDIS_URL', () => {
    const fonte = {
      PATH: '/usr/bin',
      HOME: '/root',
      JWT_SECRET: 'segredo-do-jwt',
      PAYMENT_SECRETS_KEY: 'chave-de-pagamentos',
      DATABASE_URL: 'postgresql://u:senhadobanco@h/db',
      REDIS_URL: 'redis://h',
      PGSSLROOTCERT: '/certs/ca.pem',
      PGPASSWORD: 'senha-herdada-do-processo',
    }
    const env = ambienteDoFilho({ PGHOST: 'db', PGPASSWORD: 'senha-da-url' }, fonte)
    expect(Object.keys(env).sort()).toEqual(['HOME', 'PATH', 'PGCONNECT_TIMEOUT', 'PGHOST', 'PGPASSWORD', 'PGSSLROOTCERT'].sort())
    expect(env.PGPASSWORD).toBe('senha-da-url') // a da DATABASE_URL manda sobre a herdada
    expect(JSON.stringify(env)).not.toContain('segredo-do-jwt')
    expect(JSON.stringify(env)).not.toContain('chave-de-pagamentos')
    expect(JSON.stringify(env)).not.toContain('senhadobanco')
  })

  it('BACKUP_PG_BIN_DIR aponta a pasta dos binários; no Windows o executável ganha .exe', () => {
    expect(caminhoDaFerramenta('pg_dump', {}, 'linux')).toBe('pg_dump')
    expect(caminhoDaFerramenta('pg_restore', { BACKUP_PG_BIN_DIR: '/usr/lib/postgresql/16/bin' }, 'linux').replace(/\\/g, '/')).toBe('/usr/lib/postgresql/16/bin/pg_restore')
    expect(caminhoDaFerramenta('pg_dump', { BACKUP_PG_BIN_DIR: 'C:\\pg\\bin' }, 'win32')).toMatch(/pg_dump\.exe$/)
  })

  it('o limpador tira a senha do banco (e o texto sensível) de uma mensagem', () => {
    expect(semASenhaDoBanco('falha ao conectar com a senha hunter2 no host db', 'hunter2')).not.toContain('hunter2')
    expect(semASenhaDoBanco('sem senha', undefined)).toBe('sem senha')
  })
})

describe('executarComando', () => {
  const node = process.execPath

  it('sucesso devolve o stdout', async () => {
    expect(await executarComando('pg_dump', ['-e', 'process.stdout.write("ola")'], {}, { binario: node })).toBe('ola')
  })

  it('a senha chega ao filho SÓ por variável de ambiente (e o argv não a contém)', async () => {
    const saida = await executarComando('pg_dump', ['-e', 'process.stdout.write(JSON.stringify({ senha: process.env.PGPASSWORD, argv: process.argv.slice(1) }))', 'arg-publico'], { PGPASSWORD: 'senha-do-banco-123', PATH: process.env.PATH ?? '' }, { binario: node })
    const r = JSON.parse(saida) as { senha: string; argv: string[] }
    expect(r.senha).toBe('senha-do-banco-123')
    expect(r.argv.join(' ')).not.toContain('senha-do-banco-123')
  })

  it('PRAZO: passou do limite o filho é MORTO e o erro é DUMP_TIMEOUT', async () => {
    const t0 = Date.now()
    try {
      await executarComando('pg_dump', ['-e', 'setTimeout(() => {}, 60000)'], {}, { binario: node, timeoutMs: 400 })
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(ErroDeBackup)
      expect((e as ErroDeBackup).codigo).toBe('DUMP_TIMEOUT')
    }
    expect(Date.now() - t0).toBeLessThan(15_000)
  })

  it('saída diferente de zero => DUMP; o stderr (que cita host/usuário) vai só para o LOG, sem a senha, e NUNCA para a mensagem do erro', async () => {
    const espiao = vi.spyOn(logger, 'error').mockImplementation(() => undefined)
    try {
      await executarComando('pg_dump', ['-e', 'console.error("conexao recusada: usuario=postgres senha=hunter2-no-stderr"); process.exit(3)'], { PGPASSWORD: 'hunter2-no-stderr', PATH: process.env.PATH ?? '' }, { binario: node })
      expect.unreachable()
    } catch (e) {
      expect((e as ErroDeBackup).codigo).toBe('DUMP')
      expect((e as Error).message).not.toContain('conexao recusada')
      expect((e as Error).message).not.toContain('hunter2')
    }
    const logado = JSON.stringify(espiao.mock.calls)
    expect(logado).toContain('conexao recusada') // o detalhe está no log...
    expect(logado).not.toContain('hunter2-no-stderr') // ...mas a senha não
  })

  it('binário inexistente (imagem sem postgresql-client) => DUMP, com a causa no log', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined)
    await expect(executarComando('pg_dump', [], {}, { binario: '/caminho/que/nao/existe/pg_dump' })).rejects.toMatchObject({ codigo: 'DUMP' })
  })
})
