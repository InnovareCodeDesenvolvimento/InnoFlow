/**
 * Cliente do destino S3 (`src/lib/backup/s3.ts`) contra o servidor S3 FALSO local (`tests/helpers/s3Falso.ts`), que confere a assinatura SigV4 de verdade. Prova o NOSSO código
 * (envio em fluxo + metadado SHA-256, listagem paginada só do que é backup, download, apagar em lote, teste de escrita, classificação de erro, política anti-SSRF no cliente);
 * NÃO prova um S3 real.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ErroDeBackup } from '../../src/core/backup/erros'
import { apagarObjetos, baixarObjeto, classificarFalhaS3, criarClienteS3, criarLookupGuardado, enviarObjeto, listarCopias, testarEscritaEApagar, type ConfigDoS3 } from '../../src/lib/backup/s3'
import { iniciarS3Falso, type S3Falso } from '../helpers/s3Falso'

const POLITICA_DEV = { producao: false, permitirRedePrivada: false }
let s3f: S3Falso
let dir: string
let cfg: ConfigDoS3

beforeAll(async () => {
  s3f = await iniciarS3Falso({ bucket: 'meu-bucket', accessKeyId: 'AKIATESTE', secretAccessKey: 'segredo-super-secreto-123', tamanhoDaPagina: 2 })
  dir = mkdtempSync(join(tmpdir(), 'backups3-'))
  cfg = { endpoint: s3f.url, region: 'us-east-1', bucket: 'meu-bucket', prefix: 'inno/flow', accessKeyId: 'AKIATESTE', secretAccessKey: 'segredo-super-secreto-123' }
})
afterAll(async () => {
  await s3f.fechar()
  rmSync(dir, { recursive: true, force: true })
})

async function codigo(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (e) {
    if (e instanceof ErroDeBackup) return e.codigo
    throw e
  }
  return 'NAO_FALHOU'
}

describe('S3: envio, listagem, download e remoção (assinatura SigV4 conferida pelo servidor)', () => {
  it('envia em fluxo com o SHA-256 como metadado, lista, baixa idêntico e apaga em lote', async () => {
    const s3 = criarClienteS3(cfg, POLITICA_DEV)
    const arquivo = join(dir, 'a.dump.enc')
    const conteudo = Buffer.alloc(300_000, 7)
    writeFileSync(arquivo, conteudo)
    const chave = await enviarObjeto(s3, cfg, { arquivo, nome: 'backup-innoflow-2026-10-06-03h00m00s.dump.enc', tamanho: conteudo.length, sha256: 'a'.repeat(64) })
    expect(chave).toBe('inno/flow/backup-innoflow-2026-10-06-03h00m00s.dump.enc')
    expect(s3f.objetos.get(chave)!.corpo.equals(conteudo)).toBe(true)
    expect(s3f.objetos.get(chave)!.metadados.sha256).toBe('a'.repeat(64))

    const copias = await listarCopias(s3, cfg)
    expect(copias.map((c) => c.id)).toEqual([chave])
    expect(copias[0]!.tamanho).toBe(300_000)

    const baixado = join(dir, 'baixado.bin')
    const { sha256DoMetadado } = await baixarObjeto(s3, cfg, chave, baixado)
    expect(readFileSync(baixado).equals(conteudo)).toBe(true)
    expect(sha256DoMetadado).toBe('a'.repeat(64))

    expect(await apagarObjetos(s3, cfg, [chave])).toBe(1)
    expect(s3f.objetos.has(chave)).toBe(false)
  })

  it('a listagem PAGINA até o fim e ignora o que não é backup nosso (outros arquivos, subpastas, outro prefixo)', async () => {
    const s3 = criarClienteS3(cfg, POLITICA_DEV)
    const base = { corpo: Buffer.from('x'), metadados: {}, contentType: '', modificadoEm: new Date() }
    for (let i = 0; i < 5; i += 1) s3f.objetos.set(`inno/flow/backup-innoflow-2026-10-0${i + 1}-03h00m00s.dump.enc`, { ...base })
    s3f.objetos.set('inno/flow/outro-arquivo.txt', { ...base })
    s3f.objetos.set('inno/flow/subpasta/backup-innoflow-2026-10-01-03h00m00s.dump.enc', { ...base })
    s3f.objetos.set('outra-instalacao/backup-innoflow-2026-10-01-03h00m00s.dump.enc', { ...base })
    const copias = await listarCopias(s3, cfg)
    expect(copias).toHaveLength(5)
    expect(copias.every((c) => c.nome.startsWith('backup-') && c.id.startsWith('inno/flow/backup-'))).toBe(true)
    expect(s3f.requisicoes.filter((r) => r.startsWith('GET /meu-bucket')).length).toBeGreaterThanOrEqual(3) // 5 itens, 2 por página => 3 páginas
    s3f.objetos.clear()
  })

  it('o teste de escrita grava E apaga o arquivinho (não deixa lixo no bucket)', async () => {
    const s3 = criarClienteS3(cfg, POLITICA_DEV)
    await testarEscritaEApagar(s3, cfg)
    expect([...s3f.objetos.keys()].filter((k) => k.includes('.teste-conexao-'))).toEqual([])
    expect(s3f.requisicoes.some((r) => r.startsWith('PUT') && r.includes('.teste-conexao-'))).toBe(true)
  })
})

describe('S3: erros viram CÓDIGOS acionáveis (nunca o texto cru)', () => {
  it('segredo errado => CREDENTIAL (SignatureDoesNotMatch); chave de acesso errada => CREDENTIAL (InvalidAccessKeyId)', async () => {
    const ruim = criarClienteS3({ ...cfg, secretAccessKey: 'errado-errado-errado' }, POLITICA_DEV)
    expect(await codigo(listarCopias(ruim, cfg))).toBe('CREDENTIAL')
    const ruim2 = criarClienteS3({ ...cfg, accessKeyId: 'AKIAOUTRA' }, POLITICA_DEV)
    expect(await codigo(testarEscritaEApagar(ruim2, cfg))).toBe('CREDENTIAL')
  })

  it('bucket inexistente => FOLDER', async () => {
    const c = { ...cfg, bucket: 'nao-existe' }
    const s3 = criarClienteS3(c, POLITICA_DEV)
    expect(await codigo(listarCopias(s3, c))).toBe('FOLDER')
  })

  it('servidor fora do ar => NETWORK', async () => {
    const c = { ...cfg, endpoint: 'http://127.0.0.1:1' }
    const s3 = criarClienteS3(c, POLITICA_DEV)
    expect(await codigo(listarCopias(s3, c))).toBe('NETWORK')
  })

  it('500 do servidor => NETWORK; a mensagem do erro não carrega nada do servidor nem do segredo', async () => {
    const s3 = criarClienteS3(cfg, POLITICA_DEV)
    const arquivo = join(dir, 'b.bin')
    writeFileSync(arquivo, 'conteudo')
    s3f.falharProximasGravacoes(1, 500, 'InternalError')
    try {
      await enviarObjeto(s3, cfg, { arquivo, nome: 'backup-x.dump.enc', tamanho: 8, sha256: 'b'.repeat(64) })
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(ErroDeBackup)
      expect((e as ErroDeBackup).codigo).toBe('NETWORK')
      expect((e as Error).message).not.toContain('falha injetada')
      expect((e as Error).message).not.toContain(cfg.secretAccessKey)
    }
  })

  it('arquivo acima de 5 GiB => TOO_BIG sem nem tentar enviar', async () => {
    const s3 = criarClienteS3(cfg, POLITICA_DEV)
    const antes = s3f.requisicoes.length
    expect(await codigo(enviarObjeto(s3, cfg, { arquivo: join(dir, 'a.dump.enc'), nome: 'backup-grande.dump.enc', tamanho: 5 * 1024 ** 3 + 1, sha256: 'c'.repeat(64) }))).toBe('TOO_BIG')
    expect(s3f.requisicoes.length).toBe(antes)
  })

  it('classificarFalhaS3: mapeia os nomes de erro do S3', () => {
    expect(classificarFalhaS3({ name: 'AccessDenied' }, 'x').codigo).toBe('CREDENTIAL')
    expect(classificarFalhaS3({ name: 'NoSuchBucket' }, 'x').codigo).toBe('FOLDER')
    expect(classificarFalhaS3({ name: 'QuotaExceeded' }, 'x').codigo).toBe('QUOTA')
    expect(classificarFalhaS3({ $metadata: { httpStatusCode: 507 } }, 'x').codigo).toBe('QUOTA')
    expect(classificarFalhaS3({ code: 'EBLOCKEDADDR' }, 'x').codigo).toBe('CONFIG')
    expect(classificarFalhaS3(new Error('qualquer'), 'x').codigo).toBe('NETWORK')
  })
})

describe('S3: política anti-SSRF no cliente', () => {
  it('produção exige https: endpoint http é recusado ao montar o cliente (CONFIG)', () => {
    expect(() => criarClienteS3({ ...cfg, endpoint: 'http://s3.exemplo.com' }, { producao: true, permitirRedePrivada: false })).toThrowError(ErroDeBackup)
  })

  it('loopback e rede privada em PRODUÇÃO são recusados; a permissão do deploy libera só a rede PRIVADA (nunca loopback nem metadados)', () => {
    const prod = { producao: true, permitirRedePrivada: false }
    expect(() => criarClienteS3({ ...cfg, endpoint: 'https://127.0.0.1:9000' }, prod)).toThrow()
    expect(() => criarClienteS3({ ...cfg, endpoint: 'https://10.0.0.5:9000' }, prod)).toThrow()
    const liberada = { producao: true, permitirRedePrivada: true }
    expect(() => criarClienteS3({ ...cfg, endpoint: 'http://minio:9000' }, liberada)).not.toThrow()
    expect(() => criarClienteS3({ ...cfg, endpoint: 'https://127.0.0.1:9000' }, liberada)).toThrow()
    expect(() => criarClienteS3({ ...cfg, endpoint: 'http://169.254.169.254' }, liberada)).toThrow()
  })

  it('o lookup valida CADA endereço resolvido na conexão (DNS rebinding): um nome que resolve para o IP de metadados é barrado', async () => {
    const rebinding = criarLookupGuardado({ producao: true, permitirRedePrivada: false }, (_h, _o, cb) => cb(null, [{ address: '169.254.169.254', family: 4 }]))
    const erro = await new Promise<NodeJS.ErrnoException | null>((resolve) => rebinding('s3.exemplo.com', { all: true }, (err) => resolve(err)))
    expect(erro?.code).toBe('EBLOCKEDADDR')
    // Um endereço público passa.
    const ok = criarLookupGuardado({ producao: true, permitirRedePrivada: false }, (_h, _o, cb) => cb(null, [{ address: '93.184.216.34', family: 4 }]))
    const res = await new Promise<{ err: NodeJS.ErrnoException | null; address?: unknown }>((resolve) => ok('s3.exemplo.com', {}, (err, address) => resolve({ err, address })))
    expect(res.err).toBeNull()
    expect(res.address).toBe('93.184.216.34')
    // Um nome com UM endereço bom e UM ruim também é barrado (o SO poderia escolher qualquer um).
    const misto = criarLookupGuardado({ producao: true, permitirRedePrivada: false }, (_h, _o, cb) =>
      cb(null, [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.1', family: 4 },
      ]),
    )
    const e2 = await new Promise<NodeJS.ErrnoException | null>((resolve) => misto('s3.exemplo.com', { all: true }, (err) => resolve(err)))
    expect(e2?.code).toBe('EBLOCKEDADDR')
  })
})
