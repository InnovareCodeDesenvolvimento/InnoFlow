import { createHash } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

/** SHA-256 (hex) de um arquivo, em fluxo (o dump cifrado pode ter gigas). */
export async function sha256DoArquivo(arquivo: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(arquivo), hash)
  return hash.digest('hex')
}

/**
 * Pasta de trabalho PRÓPRIA do backup, 0700: o dump em claro tem TODOS os dados da plataforma, e em `/tmp` o padrão seria legível por outros usuários da máquina. A pasta inteira some
 * no `finally` de quem a criou (inclusive em falha) — `removerPastaTemporaria` nunca lança.
 */
export async function criarPastaTemporaria(prefixo: string, base: string = os.tmpdir()): Promise<string> {
  const pasta = await fs.mkdtemp(path.join(base, prefixo))
  await fs.chmod(pasta, 0o700) // no Windows o modo é ignorado; produção é Linux
  return pasta
}

export async function removerPastaTemporaria(pasta: string | null): Promise<void> {
  if (pasta) await fs.rm(pasta, { recursive: true, force: true }).catch(() => undefined)
}

/** Primeiros `n` bytes de um arquivo (para conferir a marca do dump sem ler tudo). */
export async function primeirosBytes(arquivo: string, n: number): Promise<Buffer> {
  const handle = await fs.open(arquivo, 'r')
  try {
    const buf = Buffer.alloc(n)
    const { bytesRead } = await handle.read(buf, 0, n, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}
