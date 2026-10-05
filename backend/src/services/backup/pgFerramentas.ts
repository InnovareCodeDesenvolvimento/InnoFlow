import { spawn } from 'node:child_process'
import path from 'node:path'
import { logger } from '../../lib/logger'
import { limparTextoSensivel } from '../../lib/logSerializers'
import { ErroDeBackup } from '../../core/backup/erros'

/**
 * Processos filhos do backup (`pg_dump`, `pg_restore --list`). Regras:
 *  - `shell: false` e argumentos FIXOS: nada que venha da configuração vira comando;
 *  - a SENHA do banco vai por variável de ambiente do processo filho (`PGPASSWORD`), nunca em argv (legível por qualquer `ps`) nem em log;
 *  - o ambiente do filho é MÍNIMO (PATH + o que o Windows exige + as `PG*` herdadas, como `PGSSLROOTCERT`): o `JWT_SECRET`/`PAYMENT_SECRETS_KEY` do servidor não são passados a um
 *    binário externo;
 *  - PRAZO: passou do limite, o filho recebe SIGKILL e o erro é `DUMP_TIMEOUT`;
 *  - o stderr (onde o Postgres explica) vai só para o LOG, limpo e sem a senha; o histórico/tela recebem o CÓDIGO.
 * `BACKUP_PG_BIN_DIR` (opcional) aponta a pasta dos binários quando não estão no PATH (ex.: `C:\Program Files\PostgreSQL\18\bin` no desenvolvimento).
 */

export type ExecutorDeComando = (comando: 'pg_dump' | 'pg_restore', args: string[], env: Record<string, string>, opcoes?: { timeoutMs?: number; /** Só teste: substitui o binário (para provar prazo/erro sem Postgres). */ binario?: string }) => Promise<string>

const CHAVES_DO_AMBIENTE_BASE = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL', 'COMSPEC', 'PATHEXT']
const MAX_STDOUT = 16 * 1024 * 1024
const MAX_STDERR = 16 * 1024

export const PRAZO_PADRAO_DO_PG_DUMP_MS = 60 * 60 * 1000
export const PRAZO_DO_PG_RESTORE_LIST_MS = 10 * 60 * 1000

export function caminhoDaFerramenta(nome: 'pg_dump' | 'pg_restore', fonteEnv: Readonly<Record<string, string | undefined>> = process.env, plataforma: string = process.platform): string {
  const pasta = fonteEnv.BACKUP_PG_BIN_DIR?.trim()
  const arquivo = plataforma === 'win32' ? `${nome}.exe` : nome
  return pasta ? path.join(pasta, arquivo) : nome
}

export function ambienteDoFilho(envDoPg: Record<string, string>, fonte: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const chave of CHAVES_DO_AMBIENTE_BASE) {
    const v = fonte[chave]
    if (v !== undefined) env[chave] = v
  }
  // Variáveis PG* herdadas (ex.: PGSSLROOTCERT, PGSSLCERT) — as do banco (da DATABASE_URL) vêm depois e mandam.
  for (const [chave, valor] of Object.entries(fonte)) {
    if (valor !== undefined && chave.startsWith('PG') && !(chave in envDoPg)) env[chave] = valor
  }
  env.PGCONNECT_TIMEOUT = '15'
  return { ...env, ...envDoPg }
}

/** Apaga a senha do banco de uma mensagem antes de logar (o stderr do cliente do Postgres não deveria trazê-la, mas o limpador não custa nada). */
export function semASenhaDoBanco(mensagem: string, senha: string | undefined): string {
  let saida = limparTextoSensivel(mensagem)
  if (senha) saida = saida.split(senha).join('[senha]')
  return saida
}

export const executarComando: ExecutorDeComando = (comando, args, env, opcoes = {}) =>
  new Promise((resolve, reject) => {
    const exe = opcoes.binario ?? caminhoDaFerramenta(comando)
    const proc = spawn(exe, args, { env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let saida = ''
    let erro = ''
    let estourou = false
    const timer = setTimeout(() => {
      estourou = true
      proc.kill('SIGKILL')
    }, opcoes.timeoutMs ?? PRAZO_PADRAO_DO_PG_DUMP_MS)
    timer.unref()
    proc.stdout.on('data', (d: Buffer) => {
      if (saida.length < MAX_STDOUT) saida += d.toString()
    })
    proc.stderr.on('data', (d: Buffer) => {
      if (erro.length < MAX_STDERR) erro += d.toString()
    })
    proc.on('error', (e) => {
      clearTimeout(timer)
      logger.error({ comando, errCode: (e as NodeJS.ErrnoException).code, detalhe: limparTextoSensivel(e.message).slice(0, 200) }, '[backup] não consegui executar o cliente do PostgreSQL (a imagem do worker precisa do postgresql-client)')
      reject(new ErroDeBackup(`Não consegui executar ${comando}.`, 'DUMP'))
    })
    proc.on('close', (codigo) => {
      clearTimeout(timer)
      if (estourou) {
        logger.error({ comando, prazoMs: opcoes.timeoutMs ?? PRAZO_PADRAO_DO_PG_DUMP_MS }, '[backup] o cliente do PostgreSQL passou do prazo e foi morto')
        reject(new ErroDeBackup(`${comando} passou do prazo.`, 'DUMP_TIMEOUT'))
        return
      }
      if (codigo === 0) {
        resolve(saida)
        return
      }
      // stderr só no log (limpo): ele cita host/usuário do banco. A senha nunca está nele, mas passa pelo limpador do mesmo jeito.
      logger.error({ comando, codigo, stderr: semASenhaDoBanco(erro, env.PGPASSWORD).slice(0, 800) }, '[backup] o cliente do PostgreSQL terminou com erro')
      reject(new ErroDeBackup(`${comando} falhou.`, 'DUMP'))
    })
  })
