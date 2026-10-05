import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Ferramentas do Postgres para os testes do backup (`pg_dump`/`pg_restore`). Na CI (ubuntu, servidor postgres:16) vêm do cliente 16+ do runner (PATH ou /usr/lib/postgresql/<versão>/bin); nesta máquina de desenvolvimento ficam em
 * `C:\Program Files\PostgreSQL\18\bin`. `BACKUP_PG_BIN_DIR` manda sobre tudo. Sem as ferramentas a suíte avisa e PULA — exceto na CI (`CI=true`), onde a ausência é FALHA (sem isso o
 * teste de ciclo completo "passaria" sem provar nada).
 */
export function pastaDasFerramentasDoPg(): string {
  const env = process.env.BACKUP_PG_BIN_DIR?.trim()
  if (env) return env
  for (const candidato of [
    'C:/Program Files/PostgreSQL/18/bin',
    'C:/Program Files/PostgreSQL/17/bin',
    'C:/Program Files/PostgreSQL/16/bin',
    // Linux (runner do GitHub / Debian): os binários versionados ficam aqui, mesmo quando só o wrapper está no PATH.
    '/usr/lib/postgresql/18/bin',
    '/usr/lib/postgresql/17/bin',
    '/usr/lib/postgresql/16/bin',
  ]) {
    if (existsSync(candidato)) return candidato
  }
  return ''
}

export function binarioDoPg(nome: 'pg_dump' | 'pg_restore' | 'psql'): string {
  const pasta = pastaDasFerramentasDoPg()
  const arquivo = process.platform === 'win32' ? `${nome}.exe` : nome
  return pasta ? path.join(pasta, arquivo) : nome
}

export function ferramentasDoPgDisponiveis(): boolean {
  const r = spawnSync(binarioDoPg('pg_dump'), ['--version'], { encoding: 'utf8' })
  return r.status === 0
}

/**
 * Remove do roteiro SQL o `SET transaction_timeout = 0;` (que o pg_restore 17+ escreve e só o SERVIDOR 17+ conhece). Mesmo filtro do `backend/scripts/restore-db.sh`
 * (`sed '/^SET transaction_timeout = 0;$/d'`), mas tolerante a CRLF (no Windows o pg_restore pode escrever o arquivo com fim de linha CRLF).
 */
export function removerSetTransactionTimeout(roteiro: string): string {
  return roteiro
    .split('\n')
    .filter((linha) => linha.replace(/\r$/, '') !== 'SET transaction_timeout = 0;')
    .join('\n')
}

/**
 * Restaura um dump no banco do `envPg` PELO MESMO CAMINHO do `backend/scripts/restore-db.sh`: o pg_restore gera o roteiro SQL SEM conectar (`--file`), o `SET transaction_timeout`
 * sai dele, e o psql aplica o roteiro numa transação única com ON_ERROR_STOP. Por quê não `pg_restore --dbname=...` direto: com o cliente 18 (CI e esta máquina) contra um servidor 16
 * o pg_restore aborta em `unrecognized configuration parameter "transaction_timeout"` — a mistura cliente novo x servidor antigo é exatamente o que a CI faz. `pastaDoRoteiro` precisa
 * existir e ser apagada por quem chama.
 */
export function restaurarDumpPeloRoteiro(dump: string, envPg: NodeJS.ProcessEnv, pastaDoRoteiro: string): { status: number | null; stderr: string } {
  const bruto = path.join(pastaDoRoteiro, 'roteiro-bruto.sql')
  const limpo = path.join(pastaDoRoteiro, 'roteiro.sql')
  const gerar = spawnSync(binarioDoPg('pg_restore'), ['--no-owner', '--no-privileges', `--file=${bruto}`, dump], { env: envPg, encoding: 'utf8' })
  if (gerar.status !== 0) return { status: gerar.status ?? 1, stderr: `pg_restore --file falhou: ${gerar.stderr}` }
  writeFileSync(limpo, removerSetTransactionTimeout(readFileSync(bruto, 'utf8')), 'utf8')
  const aplicar = spawnSync(binarioDoPg('psql'), ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-f', limpo], { env: envPg, encoding: 'utf8' })
  return { status: aplicar.status, stderr: aplicar.stderr }
}

/** Configura `BACKUP_PG_BIN_DIR` para os módulos da aplicação (que o leem de `process.env` na hora de executar). */
export function prepararAmbienteDoPg(): void {
  const pasta = pastaDasFerramentasDoPg()
  if (pasta) process.env.BACKUP_PG_BIN_DIR = pasta
}
