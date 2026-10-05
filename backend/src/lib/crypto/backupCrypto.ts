import { createCipheriv, createDecipheriv, createHash, randomBytes, type DecipherGCM } from 'node:crypto'
import { createReadStream, createWriteStream, promises as fs } from 'node:fs'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/**
 * Cifra do arquivo de backup, EM FLUXO (o dump pode ter gigas: nada aqui carrega o arquivo inteiro na memória). Puro: só `node:crypto`/`node:fs`/`node:stream`,
 * sem `env` nem `logger` (importar `env.ts` dispara a validação eager de TODAS as envs — ver `bug-env-eager-todos-entrypoints`).
 *
 * FORMATO (versão 1), `*.dump.enc` — o MESMO do InnoChat, de propósito: `scripts/decrypt-backup.mjs` (Vulcano) reimplementa o formato sem depender do projeto, e a
 * documentação byte a byte está em `docs/BACKUP-FORMATO.md`. Se mudar qualquer byte, suba a versão E o decifrador dos scripts E o teste do vetor fixo.
 *
 *   bytes  0..6   "INNOBKP"            marca do formato (ASCII)
 *   byte   7      0x01                 versão
 *   bytes  8..11  impressão digital    4 primeiros bytes do SHA-256 da chave (8 hex na tela)
 *   bytes 12..23  IV                   12 bytes aleatórios, um por arquivo
 *   bytes 24..    texto cifrado        AES-256-GCM, do dump inteiro (sem preenchimento)
 *   últimos 16    tag de autenticação  só confere no FIM: arquivo adulterado ou cortado é reprovado
 *
 * O cabeçalho (marca, versão e impressão digital = os 12 primeiros bytes) entra como dado autenticado (AAD): trocar a impressão digital no arquivo também reprova.
 * O IV não entra no AAD (ele já é entrada do GCM: trocá-lo muda o keystream e a tag não confere). A chave NUNCA vai no arquivo.
 *
 * ATENÇÃO À DECIFRAGEM EM FLUXO: o GCM só prova que o conteúdo é íntegro no FIM. Quem decifra grava num arquivo temporário e só usa o resultado depois que
 * `decryptFile` terminou sem erro (em erro o temporário é apagado aqui mesmo).
 */

const MAGIC = Buffer.from('INNOBKP', 'latin1')
const VERSION = 1
const FINGERPRINT_BYTES = 4
const IV_BYTES = 12
const TAG_BYTES = 16
/** O que vem antes do IV: é o que entra como AAD. */
const AAD_BYTES = MAGIC.length + 1 + FINGERPRINT_BYTES
export const HEADER_BYTES = AAD_BYTES + IV_BYTES
export const KEY_BYTES = 32
export const BACKUP_FORMAT_VERSION = VERSION
/** Limite do GCM com um IV só: 2^36 - 32 bytes. Passar disso repetiria o keystream. */
const MAX_PLAINTEXT_BYTES = 2 ** 36 - 64

export type CryptoErrorCode = 'NOT_ENCRYPTED' | 'UNSUPPORTED_VERSION' | 'WRONG_KEY' | 'AUTH_FAILED' | 'TRUNCATED' | 'BAD_KEY' | 'TOO_BIG'

/** Erro de cifra, já com texto para uma pessoa ler. NUNCA carrega chave nem conteúdo. */
export class BackupCryptoError extends Error {
  constructor(
    message: string,
    readonly code: CryptoErrorCode,
    /** Impressão digital da chave com que o ARQUIVO foi feito (quando o cabeçalho foi lido). */
    readonly fileFingerprint?: string,
  ) {
    super(message)
    this.name = 'BackupCryptoError'
  }
}

// ---------------------------------------------------------------------------------------------
// Chave
// ---------------------------------------------------------------------------------------------

export function generateBackupKey(): Buffer {
  return randomBytes(KEY_BYTES)
}

/** Impressão digital: 8 primeiros hex do SHA-256 da chave. Serve para conferir "é a chave certa?" sem revelar a chave. */
export function keyFingerprint(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, FINGERPRINT_BYTES * 2)
}

/** Chave em hex, em 8 grupos de 8 separados por hífen (cabe numa linha e dá para ler em voz alta). */
export function formatBackupKey(key: Buffer): string {
  return (key.toString('hex').match(/.{8}/g) ?? []).join('-')
}

/** Aceita hex com ou sem hífens e espaços. `null` se não for uma chave de 32 bytes. */
export function parseBackupKey(text: string): Buffer | null {
  const clean = text.replace(/[\s-]/g, '')
  return /^[0-9a-fA-F]{64}$/.test(clean) ? Buffer.from(clean, 'hex') : null
}

/** Lê a chave de dentro do arquivo .txt baixado da tela (linha "CHAVE: ...") ou de um arquivo que só tem a chave. */
export function extractBackupKey(fileText: string): Buffer | null {
  for (const line of fileText.split(/\r?\n/)) {
    const m = line.match(/^\s*chave\s*:\s*(.+)$/i)
    if (m) {
      const key = parseBackupKey(m[1])
      if (key) return key
    }
  }
  return parseBackupKey(fileText)
}

function assertKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw new BackupCryptoError('A chave de backup precisa ter 32 bytes (64 caracteres hexadecimais).', 'BAD_KEY')
}

/** Texto do arquivo que o dono baixa ao gerar a chave. A linha `CHAVE:` é a que os scripts leem. */
export function backupKeyFileText(opts: { key: Buffer; createdAt: Date }): string {
  return [
    'CHAVE DE CRIPTOGRAFIA DO BACKUP DO INNOFLOW',
    '',
    `CHAVE: ${formatBackupKey(opts.key)}`,
    `IMPRESSAO DIGITAL: ${keyFingerprint(opts.key)}`,
    `GERADA EM: ${opts.createdAt.toISOString()}`,
    '',
    'GUARDE ESTE ARQUIVO FORA DO SERVIDOR (gerenciador de senhas, pen drive, outro e-mail).',
    'Sem esta chave os backups não abrem. Quem tem a chave e o arquivo de backup lê o banco inteiro: não compartilhe.',
    'ATENCAO: a chave do backup NAO substitui o JWT_SECRET do servidor (dele deriva a chave dos segredos salvos no banco). Guarde as duas (docs/DEPLOY-EASYPANEL.md, secao Backups).',
    '',
    'Para abrir um backup (.dump.enc):',
    '  node scripts/decrypt-backup.mjs backup-AAAA.dump.enc --chave este-arquivo.txt',
    'Para restaurar direto num banco:',
    '  ./scripts/restore-db.sh backup-AAAA.dump.enc URL-DO-BANCO --confirmar --chave este-arquivo.txt',
    'Passo a passo completo: docs/DEPLOY-EASYPANEL.md, secao Backups > Restaurar.',
    '',
  ].join('\n')
}

// ---------------------------------------------------------------------------------------------
// Fluxos
// ---------------------------------------------------------------------------------------------

function buildHeader(key: Buffer, iv: Buffer): Buffer {
  const fp = createHash('sha256').update(key).digest().subarray(0, FINGERPRINT_BYTES)
  return Buffer.concat([MAGIC, Buffer.from([VERSION]), fp, iv])
}

/** Transform que cifra: emite cabeçalho, texto cifrado e, no fim, a tag. `ivParaTeste` existe SÓ para o vetor fixo — nunca passe IV em produção (IV repetido com a mesma chave quebra o GCM). */
export function createEncryptStream(key: Buffer, ivParaTeste?: Buffer): Transform {
  assertKey(key)
  const iv = ivParaTeste ?? randomBytes(IV_BYTES)
  if (iv.length !== IV_BYTES) throw new BackupCryptoError('IV de teste com tamanho errado.', 'BAD_KEY')
  const header = buildHeader(key, iv)
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
  cipher.setAAD(header.subarray(0, AAD_BYTES))
  let started = false
  let total = 0
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      try {
        total += chunk.length
        if (total > MAX_PLAINTEXT_BYTES) throw new BackupCryptoError('O dump passa do limite de 64 GiB por arquivo cifrado.', 'TOO_BIG')
        if (!started) {
          this.push(header)
          started = true
        }
        cb(null, cipher.update(chunk))
      } catch (error) {
        cb(error as Error)
      }
    },
    flush(cb) {
      try {
        if (!started) this.push(header)
        this.push(cipher.final())
        this.push(cipher.getAuthTag())
        cb()
      } catch (error) {
        cb(error as Error)
      }
    },
  })
}

/**
 * Transform que decifra. Segura os últimos 16 bytes (a tag) até o fim; o `flush` confere. Quem consome só pode confiar na saída depois que o fluxo terminou sem erro.
 */
export function createDecryptStream(key: Buffer): Transform {
  assertKey(key)
  const expectedFingerprint = keyFingerprint(key)
  let head: Buffer = Buffer.alloc(0)
  let tail: Buffer = Buffer.alloc(0)
  let decipher: DecipherGCM | null = null

  function open(): void {
    const magic = head.subarray(0, MAGIC.length)
    if (!magic.equals(MAGIC)) {
      throw new BackupCryptoError('Este arquivo não é um backup cifrado do InnoFlow (a marca do formato não bate). Se é um .dump comum, ele não precisa de chave.', 'NOT_ENCRYPTED')
    }
    const version = head[MAGIC.length]
    const fileFingerprint = head.subarray(MAGIC.length + 1, AAD_BYTES).toString('hex')
    if (version !== VERSION) {
      throw new BackupCryptoError(`Este backup usa a versão ${version} do formato, e esta versão do sistema só abre a ${VERSION}. Use um InnoFlow mais novo.`, 'UNSUPPORTED_VERSION', fileFingerprint)
    }
    if (fileFingerprint !== expectedFingerprint) {
      throw new BackupCryptoError(
        `Chave errada: este backup foi cifrado com a chave de impressão digital ${fileFingerprint}, e a chave informada é a ${expectedFingerprint}.`,
        'WRONG_KEY',
        fileFingerprint,
      )
    }
    decipher = createDecipheriv('aes-256-gcm', key, head.subarray(AAD_BYTES, HEADER_BYTES), { authTagLength: TAG_BYTES })
    decipher.setAAD(head.subarray(0, AAD_BYTES))
  }

  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      try {
        let data: Buffer = chunk
        if (!decipher) {
          head = Buffer.concat([head, chunk])
          // Reprova cedo o que claramente não é o nosso formato, sem esperar 24 bytes.
          const probe = head.subarray(0, Math.min(head.length, MAGIC.length))
          if (!probe.equals(MAGIC.subarray(0, probe.length))) open()
          if (head.length < HEADER_BYTES) return cb()
          open()
          data = head.subarray(HEADER_BYTES)
          head = Buffer.alloc(0)
        }
        tail = Buffer.concat([tail, data])
        if (tail.length > TAG_BYTES) {
          const release = tail.subarray(0, tail.length - TAG_BYTES)
          tail = tail.subarray(tail.length - TAG_BYTES)
          cb(null, decipher!.update(release))
        } else {
          cb()
        }
      } catch (error) {
        cb(error as Error)
      }
    },
    flush(cb) {
      try {
        if (!decipher) {
          const probe = head.subarray(0, Math.min(head.length, MAGIC.length))
          if (probe.length === 0 || !probe.equals(MAGIC.subarray(0, probe.length))) open()
          throw new BackupCryptoError('O arquivo está cortado: termina antes do fim do cabeçalho.', 'TRUNCATED')
        }
        if (tail.length < TAG_BYTES) throw new BackupCryptoError('O arquivo está cortado: falta o final, onde fica a prova de integridade.', 'TRUNCATED')
        decipher.setAuthTag(tail)
        try {
          cb(null, decipher.final())
        } catch {
          throw new BackupCryptoError('Falha na verificação: o arquivo foi alterado, está corrompido ou está incompleto. Não use este backup.', 'AUTH_FAILED')
        }
      } catch (error) {
        cb(error as Error)
      }
    },
  })
}

async function removeQuietly(file: string): Promise<void> {
  await fs.rm(file, { force: true }).catch(() => undefined)
}

/** Cifra `source` para `dest` (0600). Em erro, apaga o que escreveu. */
export async function encryptFile(source: string, dest: string, key: Buffer): Promise<void> {
  try {
    await pipeline(createReadStream(source), createEncryptStream(key), createWriteStream(dest, { mode: 0o600 }))
  } catch (error) {
    await removeQuietly(dest)
    throw error
  }
}

/**
 * Decifra `source` para `dest` (0600) e SÓ DEPOIS de a tag conferir devolve. Em qualquer erro (chave errada, adulteração, corte) o arquivo de saída é apagado:
 * nunca sobra texto não autenticado.
 */
export async function decryptFile(source: string, dest: string, key: Buffer): Promise<void> {
  try {
    await pipeline(createReadStream(source), createDecryptStream(key), createWriteStream(dest, { mode: 0o600 }))
  } catch (error) {
    await removeQuietly(dest)
    throw error
  }
}

/** Lê só o cabeçalho: devolve a impressão digital da chave do arquivo, ou `null` se não for um backup cifrado nosso. */
export async function readBackupFileFingerprint(file: string): Promise<string | null> {
  const handle = await fs.open(file, 'r')
  try {
    const buf = Buffer.alloc(HEADER_BYTES)
    const { bytesRead } = await handle.read(buf, 0, HEADER_BYTES, 0)
    if (bytesRead < HEADER_BYTES || !buf.subarray(0, MAGIC.length).equals(MAGIC)) return null
    return buf.subarray(MAGIC.length + 1, AAD_BYTES).toString('hex')
  } finally {
    await handle.close()
  }
}

/** O nome é de um backup cifrado? (`backup-...dump.enc`) */
export function isEncryptedBackupName(name: string): boolean {
  return name.endsWith('.dump.enc')
}
