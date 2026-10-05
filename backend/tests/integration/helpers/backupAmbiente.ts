import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * Ferramentas do Postgres para os testes do backup (`pg_dump`/`pg_restore`). Na CI (`postgres:16` + ubuntu) estão no PATH; nesta máquina de desenvolvimento ficam em
 * `C:\Program Files\PostgreSQL\18\bin`. `BACKUP_PG_BIN_DIR` manda sobre tudo. Sem as ferramentas a suíte avisa e PULA — exceto na CI (`CI=true`), onde a ausência é FALHA (sem isso o
 * teste de ciclo completo "passaria" sem provar nada).
 */
export function pastaDasFerramentasDoPg(): string {
  const env = process.env.BACKUP_PG_BIN_DIR?.trim()
  if (env) return env
  for (const candidato of ['C:/Program Files/PostgreSQL/18/bin', 'C:/Program Files/PostgreSQL/17/bin', 'C:/Program Files/PostgreSQL/16/bin']) if (existsSync(candidato)) return candidato
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

/** Configura `BACKUP_PG_BIN_DIR` para os módulos da aplicação (que o leem de `process.env` na hora de executar). */
export function prepararAmbienteDoPg(): void {
  const pasta = pastaDasFerramentasDoPg()
  if (pasta) process.env.BACKUP_PG_BIN_DIR = pasta
}
