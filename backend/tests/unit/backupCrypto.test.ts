/**
 * Cifra do arquivo de backup (`src/lib/crypto/backupCrypto.ts`) — roda ANTES de qualquer banco entrar na história. Cobre:
 *  - ida e volta (vários tamanhos, entrega em pedaços de 1 byte);
 *  - VETOR FIXO gerado pelo `decrypt-backup.mjs --cifrar` do InnoChat (a fonte do formato): se o nosso código parar de abrir o que o InnoChat cifra (ou de cifrar byte a byte
 *    igual, com o mesmo IV), este teste quebra — é o contrato com o decifrador do Vulcano;
 *  - layout byte a byte do cabeçalho;
 *  - adulteração em CADA região do arquivo, chave errada, corte, versão futura, arquivo que não é nosso;
 *  - arquivo temporário apagado em falha.
 */
import { createCipheriv, createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  BackupCryptoError,
  HEADER_BYTES,
  backupKeyFileText,
  createDecryptStream,
  createEncryptStream,
  decryptFile,
  encryptFile,
  extractBackupKey,
  formatBackupKey,
  generateBackupKey,
  keyFingerprint,
  parseBackupKey,
  readBackupFileFingerprint,
} from '../../src/lib/crypto/backupCrypto'

/** Chave 00 01 02 ... 1f, a mesma do vetor. */
const CHAVE_VETOR = Buffer.from(Array.from({ length: 32 }, (_, i) => i))
const DUMP_VETOR = 'PGDMP-vetor-fixo-InnoFlow: dados de teste 0123456789'
/** Saída REAL do `decrypt-backup.mjs --cifrar` do InnoChat para (CHAVE_VETOR, DUMP_VETOR). 92 bytes = 24 de cabeçalho + 52 de texto cifrado + 16 de tag. */
const VETOR_HEX =
  '494e4e4f424b5001630dcd29f807afc63f469e11d7319de26c83d30b7549b1767cb152053bf76f40d8972e6c8c365ccae02ed6a01ffe57701f4fb85a1ad88af5d8818c36d1d9b530ff06f45ed54619b1de9bfc0dcebca48622ad1288'

async function cifrar(dados: Buffer, key: Buffer, iv?: Buffer): Promise<Buffer> {
  const saida: Buffer[] = []
  const enc = createEncryptStream(key, iv)
  enc.on('data', (c: Buffer) => saida.push(c))
  await pipeline(Readable.from([dados]), enc)
  return Buffer.concat(saida)
}

async function decifrar(arquivo: Buffer, key: Buffer, tamanhoDoPedaco = 64 * 1024): Promise<Buffer> {
  const pedacos: Buffer[] = []
  for (let i = 0; i < arquivo.length; i += tamanhoDoPedaco) pedacos.push(arquivo.subarray(i, i + tamanhoDoPedaco))
  const saida: Buffer[] = []
  const dec = createDecryptStream(key)
  dec.on('data', (c: Buffer) => saida.push(c))
  await pipeline(Readable.from(pedacos), dec)
  return Buffer.concat(saida)
}

async function codigoDoErro(promessa: Promise<unknown>): Promise<string> {
  try {
    await promessa
  } catch (e) {
    if (e instanceof BackupCryptoError) return e.code
    throw e
  }
  return 'NAO_FALHOU'
}

describe('formato cifrado do backup — layout e vetor fixo', () => {
  it('vetor fixo gerado pelo InnoChat: abre e devolve o texto exato', async () => {
    const claro = await decifrar(Buffer.from(VETOR_HEX, 'hex'), CHAVE_VETOR)
    expect(claro.toString('utf8')).toBe(DUMP_VETOR)
  })

  it('com o MESMO IV do vetor, nosso cifrador produz os MESMOS 92 bytes (byte a byte)', async () => {
    const vetor = Buffer.from(VETOR_HEX, 'hex')
    const iv = vetor.subarray(12, 24)
    const nosso = await cifrar(Buffer.from(DUMP_VETOR), CHAVE_VETOR, iv)
    expect(nosso.toString('hex')).toBe(VETOR_HEX)
  })

  it('layout: marca INNOBKP, versão 1, 4 bytes de impressão digital, IV de 12, texto cifrado, tag de 16', async () => {
    const arquivo = await cifrar(Buffer.from('x'.repeat(100)), CHAVE_VETOR)
    expect(HEADER_BYTES).toBe(24)
    expect(arquivo.subarray(0, 7).toString('latin1')).toBe('INNOBKP')
    expect(arquivo[7]).toBe(1)
    expect(arquivo.subarray(8, 12).toString('hex')).toBe(createHash('sha256').update(CHAVE_VETOR).digest('hex').slice(0, 8))
    expect(keyFingerprint(CHAVE_VETOR)).toBe('630dcd29')
    expect(arquivo.length).toBe(24 + 100 + 16) // GCM não preenche: tamanho do texto cifrado == tamanho do claro
  })

  it('o cabeçalho de 12 bytes (marca+versão+impressão digital) é o AAD: o decifrador independente (node:crypto cru) fecha a conta', async () => {
    const arquivo = await cifrar(Buffer.from(DUMP_VETOR), CHAVE_VETOR)
    const decipher = (await import('node:crypto')).createDecipheriv('aes-256-gcm', CHAVE_VETOR, arquivo.subarray(12, 24), { authTagLength: 16 })
    decipher.setAAD(arquivo.subarray(0, 12))
    decipher.setAuthTag(arquivo.subarray(arquivo.length - 16))
    const claro = Buffer.concat([decipher.update(arquivo.subarray(24, arquivo.length - 16)), decipher.final()])
    expect(claro.toString()).toBe(DUMP_VETOR)
    // E ao contrário: um cifrador cru com o mesmo AAD gera o que o nosso decifra.
    const iv = Buffer.alloc(12, 7)
    const cru = createCipheriv('aes-256-gcm', CHAVE_VETOR, iv, { authTagLength: 16 })
    const cab = Buffer.concat([Buffer.from('INNOBKP', 'latin1'), Buffer.from([1]), Buffer.from('630dcd29', 'hex')])
    cru.setAAD(cab)
    const corpo = Buffer.concat([cru.update(Buffer.from('ola')), cru.final()])
    const montado = Buffer.concat([cab, iv, corpo, cru.getAuthTag()])
    expect((await decifrar(montado, CHAVE_VETOR)).toString()).toBe('ola')
  })
})

describe('ida e volta', () => {
  it.each([0, 1, 15, 16, 17, 1000, 70_000, 3 * 1024 * 1024 + 5])('dump de %i bytes', async (n) => {
    const dump = Buffer.alloc(n)
    for (let i = 0; i < n; i += 1) dump[i] = (i * 31 + 7) & 0xff
    const key = generateBackupKey()
    const arquivo = await cifrar(dump, key)
    expect(arquivo.length).toBe(24 + n + 16)
    expect((await decifrar(arquivo, key)).equals(dump)).toBe(true)
  })

  it('dois arquivos do mesmo dump com a mesma chave diferem (IV aleatório por arquivo)', async () => {
    const key = generateBackupKey()
    const a = await cifrar(Buffer.from('mesmo conteudo'), key)
    const b = await cifrar(Buffer.from('mesmo conteudo'), key)
    expect(a.subarray(12, 24).equals(b.subarray(12, 24))).toBe(false)
    expect(a.equals(b)).toBe(false)
  })

  it('o decifrador aguenta o arquivo chegando em pedaços de 1 byte (cabeçalho e tag partidos)', async () => {
    const key = generateBackupKey()
    const dump = Buffer.from('conteudo de teste '.repeat(30))
    const arquivo = await cifrar(dump, key)
    expect((await decifrar(arquivo, key, 1)).equals(dump)).toBe(true)
    expect((await decifrar(arquivo, key, 5)).equals(dump)).toBe(true)
  })
})

describe('adulteração, chave errada e arquivo que não é nosso', () => {
  const key = generateBackupKey()
  const dump = Buffer.from('dado sensivel do banco inteiro '.repeat(40))
  let arquivo: Buffer
  beforeAll(async () => {
    arquivo = await cifrar(dump, key)
  })

  it('um bit trocado no TEXTO CIFRADO reprova (AUTH_FAILED)', async () => {
    const x = Buffer.from(arquivo)
    x[24 + 10] ^= 0x01
    expect(await codigoDoErro(decifrar(x, key))).toBe('AUTH_FAILED')
  })

  it('um bit trocado na TAG reprova', async () => {
    const x = Buffer.from(arquivo)
    x[x.length - 1] ^= 0x80
    expect(await codigoDoErro(decifrar(x, key))).toBe('AUTH_FAILED')
  })

  it('um bit trocado no IV reprova', async () => {
    const x = Buffer.from(arquivo)
    x[12] ^= 0x01
    expect(await codigoDoErro(decifrar(x, key))).toBe('AUTH_FAILED')
  })

  it('a impressão digital trocada no cabeçalho reprova: WRONG_KEY (não bate com a chave informada)', async () => {
    const x = Buffer.from(arquivo)
    x[8] ^= 0x01
    expect(await codigoDoErro(decifrar(x, key))).toBe('WRONG_KEY')
  })

  it('o cabeçalho é AAD: mesmo com a impressão digital "consertada" para a de OUTRA chave que decifre, a tag reprova', async () => {
    // Cifra com a chave B mas o cabeçalho diz A: o decifrador com A passa da checagem de impressão digital e quem reprova é o GCM (AAD diferente / chave diferente).
    const outra = generateBackupKey()
    const feito = await cifrar(dump, outra)
    const x = Buffer.from(feito)
    keyFingerprintBytes(key).copy(x, 8)
    expect(await codigoDoErro(decifrar(x, key))).toBe('AUTH_FAILED')
  })

  it('chave errada: WRONG_KEY, com as duas impressões digitais na mensagem', async () => {
    const outra = generateBackupKey()
    try {
      await decifrar(arquivo, outra)
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(BackupCryptoError)
      expect((e as BackupCryptoError).code).toBe('WRONG_KEY')
      expect((e as BackupCryptoError).fileFingerprint).toBe(keyFingerprint(key))
      expect((e as Error).message).toContain(keyFingerprint(outra))
      expect((e as Error).message).not.toContain(key.toString('hex'))
    }
  })

  it('arquivo CORTADO (sem a tag, ou no meio) reprova: TRUNCATED/AUTH_FAILED, nunca devolve texto como se estivesse tudo bem', async () => {
    expect(await codigoDoErro(decifrar(arquivo.subarray(0, arquivo.length - 16), key))).toBe('AUTH_FAILED')
    expect(await codigoDoErro(decifrar(arquivo.subarray(0, 24 + 5), key))).toBe('TRUNCATED')
    expect(await codigoDoErro(decifrar(arquivo.subarray(0, 10), key))).toBe('TRUNCATED')
    expect(await codigoDoErro(decifrar(arquivo.subarray(0, arquivo.length - 3), key))).toBe('AUTH_FAILED')
  })

  it('bytes a MAIS no fim reprovam', async () => {
    expect(await codigoDoErro(decifrar(Buffer.concat([arquivo, Buffer.from('lixo')]), key))).toBe('AUTH_FAILED')
  })

  it('arquivo que NÃO é nosso (dump em claro "PGDMP", texto qualquer, vazio) = NOT_ENCRYPTED (ou TRUNCATED se vazio)', async () => {
    expect(await codigoDoErro(decifrar(Buffer.from('PGDMP\u0001\u000e\u0000\u0004'.padEnd(80, 'x')), key))).toBe('NOT_ENCRYPTED')
    expect(await codigoDoErro(decifrar(Buffer.from('qualquer coisa que nao e um backup'), key))).toBe('NOT_ENCRYPTED')
    expect(await codigoDoErro(decifrar(Buffer.alloc(0), key))).toBe('NOT_ENCRYPTED')
  })

  it('versão futura do formato: UNSUPPORTED_VERSION (e não tenta decifrar)', async () => {
    const x = Buffer.from(arquivo)
    x[7] = 2
    expect(await codigoDoErro(decifrar(x, key))).toBe('UNSUPPORTED_VERSION')
  })

  it('chave com tamanho errado é recusada na criação do fluxo (BAD_KEY)', () => {
    expect(() => createEncryptStream(Buffer.alloc(16))).toThrow(BackupCryptoError)
    expect(() => createDecryptStream(Buffer.alloc(31))).toThrow(BackupCryptoError)
  })
})

describe('arquivos: temporário apagado em falha, nunca texto não autenticado', () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'backupcrypto-'))
  })
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('encryptFile + decryptFile: ida e volta e leitura da impressão digital pelo cabeçalho', async () => {
    const key = generateBackupKey()
    const origem = join(dir, 'a.dump')
    writeFileSync(origem, Buffer.from('PGDMP' + 'dados'.repeat(5000)))
    await encryptFile(origem, join(dir, 'a.dump.enc'), key)
    expect(await readBackupFileFingerprint(join(dir, 'a.dump.enc'))).toBe(keyFingerprint(key))
    expect(await readBackupFileFingerprint(origem)).toBeNull()
    await decryptFile(join(dir, 'a.dump.enc'), join(dir, 'a.out'), key)
    expect(readFileSync(join(dir, 'a.out')).equals(readFileSync(origem))).toBe(true)
  })

  it('decryptFile com arquivo adulterado: lança E não deixa o arquivo de saída (nada de texto não autenticado em disco)', async () => {
    const key = generateBackupKey()
    const origem = join(dir, 'b.dump')
    writeFileSync(origem, Buffer.from('dados'.repeat(20000)))
    await encryptFile(origem, join(dir, 'b.dump.enc'), key)
    const bytes = readFileSync(join(dir, 'b.dump.enc'))
    bytes[bytes.length - 40] ^= 0xff
    writeFileSync(join(dir, 'b.adulterado.enc'), bytes)
    expect(await codigoDoErro(decryptFile(join(dir, 'b.adulterado.enc'), join(dir, 'b.out'), key))).toBe('AUTH_FAILED')
    expect(readdirSync(dir).includes('b.out')).toBe(false)
  })

  it('decryptFile com chave errada: lança e não deixa saída', async () => {
    const key = generateBackupKey()
    writeFileSync(join(dir, 'c.dump'), Buffer.from('x'.repeat(1000)))
    await encryptFile(join(dir, 'c.dump'), join(dir, 'c.dump.enc'), key)
    expect(await codigoDoErro(decryptFile(join(dir, 'c.dump.enc'), join(dir, 'c.out'), generateBackupKey()))).toBe('WRONG_KEY')
    expect(readdirSync(dir).includes('c.out')).toBe(false)
  })

  it('encryptFile com origem inexistente: lança e não deixa o .enc', async () => {
    await expect(encryptFile(join(dir, 'nao-existe.dump'), join(dir, 'd.dump.enc'), generateBackupKey())).rejects.toThrow()
    expect(readdirSync(dir).includes('d.dump.enc')).toBe(false)
  })
})

describe('chave: formato legível e arquivo .txt', () => {
  it('formatBackupKey/parseBackupKey: 8 grupos de 8 hex; aceita com/sem hífen e espaço; recusa lixo', () => {
    const key = generateBackupKey()
    const texto = formatBackupKey(key)
    expect(texto).toMatch(/^([0-9a-f]{8}-){7}[0-9a-f]{8}$/)
    expect(parseBackupKey(texto)?.equals(key)).toBe(true)
    expect(parseBackupKey(texto.replace(/-/g, ' '))?.equals(key)).toBe(true)
    expect(parseBackupKey(key.toString('hex').toUpperCase())?.equals(key)).toBe(true)
    expect(parseBackupKey('zzzz')).toBeNull()
    expect(parseBackupKey(texto.slice(0, -2))).toBeNull()
  })

  it('o .txt baixado da tela tem a linha "CHAVE:" que os scripts leem, e extractBackupKey a recupera', () => {
    const key = generateBackupKey()
    const txt = backupKeyFileText({ key, createdAt: new Date('2026-10-06T12:00:00Z') })
    expect(txt).toContain(`CHAVE: ${formatBackupKey(key)}`)
    expect(txt).toContain(`IMPRESSAO DIGITAL: ${keyFingerprint(key)}`)
    expect(txt).toContain('JWT_SECRET') // MUDANÇA DELIBERADA (chave derivada do JWT_SECRET, como no InnoChat): o arquivo manda guardar o JWT_SECRET, não mais a PAYMENT_SECRETS_KEY
    expect(extractBackupKey(txt)?.equals(key)).toBe(true)
    expect(extractBackupKey(formatBackupKey(key))?.equals(key)).toBe(true)
    expect(extractBackupKey('sem chave nenhuma aqui')).toBeNull()
  })
})

// --- contrato com o decifrador do Vulcano (quando ele existir no repositório) -----------------------------------------------------------
const CANDIDATOS_DECIFRADOR = [process.env.BACKUP_DECRYPT_SCRIPT ?? '', join(process.cwd(), 'scripts', 'decrypt-backup.mjs'), join(process.cwd(), '..', 'scripts', 'decrypt-backup.mjs')]
const DECIFRADOR = CANDIDATOS_DECIFRADOR.find((c) => c !== '' && existsSync(c))

describe.skipIf(!DECIFRADOR)('contrato com scripts/decrypt-backup.mjs (Vulcano): os dois lados abrem o que o outro cifra', () => {
  it('o script abre o que o nosso código cifrou; nosso código abre o que o script cifrou', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'backupcontrato-'))
    try {
      const key = generateBackupKey()
      writeFileSync(join(dir, 'chave.txt'), backupKeyFileText({ key, createdAt: new Date() }))
      writeFileSync(join(dir, 'x.dump'), Buffer.from('PGDMP-contrato-' + 'abc'.repeat(100000)))
      await encryptFile(join(dir, 'x.dump'), join(dir, 'x.dump.enc'), key)
      const r1 = spawnSync(process.execPath, [DECIFRADOR!, join(dir, 'x.dump.enc'), '--chave', join(dir, 'chave.txt'), '--saida', join(dir, 'x.script.out')], { encoding: 'utf8' })
      expect(r1.status, r1.stderr).toBe(0)
      expect(readFileSync(join(dir, 'x.script.out')).equals(readFileSync(join(dir, 'x.dump')))).toBe(true)
      const r2 = spawnSync(process.execPath, [DECIFRADOR!, join(dir, 'x.dump'), '--cifrar', '--chave', join(dir, 'chave.txt'), '--saida', join(dir, 'y.dump.enc')], { encoding: 'utf8' })
      expect(r2.status, r2.stderr).toBe(0)
      await decryptFile(join(dir, 'y.dump.enc'), join(dir, 'y.out'), key)
      expect(readFileSync(join(dir, 'y.out')).equals(readFileSync(join(dir, 'x.dump')))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

function keyFingerprintBytes(key: Buffer): Buffer {
  return Buffer.from(keyFingerprint(key), 'hex')
}
