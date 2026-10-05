/**
 * Servidor S3-compatível MÍNIMO para os testes do backup (porta efêmera alta, só loopback). Implementa o que o backup usa — PutObject, GetObject, DeleteObject, DeleteObjects,
 * ListObjectsV2 (com paginação) — e CONFERE A ASSINATURA SigV4 de verdade (com a chave secreta cadastrada): credencial errada devolve o mesmo erro XML que o S3 (`InvalidAccessKeyId` /
 * `SignatureDoesNotMatch`), então os testes de "credencial recusada" passam pelo caminho real do SDK. Também confere o SHA-256 do corpo quando o cliente o assina (http sem TLS).
 *
 * O QUE ISTO NÃO PROVA: o comportamento de um S3 REAL (AWS, R2, B2, MinIO) — provedores reais têm particularidades de checksum, multipart e consistência que um servidor falso não
 * reproduz. Prova o NOSSO código contra o contrato HTTP do S3.
 */
import { createHash, createHmac } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

export interface ObjetoFalso {
  corpo: Buffer
  metadados: Record<string, string>
  modificadoEm: Date
  contentType: string
}

export interface OpcoesDoS3Falso {
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  region?: string
  /** Itens por página no ListObjectsV2 (para provar a paginação). */
  tamanhoDaPagina?: number
}

export interface S3Falso {
  url: string
  porta: number
  objetos: Map<string, ObjetoFalso>
  /** Todas as requisições recebidas: `METODO caminho`. */
  requisicoes: string[]
  /** Faz as próximas `vezes` gravações (PUT de objeto) responderem `status` (ex.: 500 para provar a retentativa, 403 para credencial). */
  falharProximasGravacoes(vezes: number, status: number, codigo?: string): void
  /** Atraso artificial (ms) antes de responder (provar prazos). */
  latenciaMs: number
  fechar(): Promise<void>
}

const rfc3986 = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
const sha256Hex = (d: string | Buffer): string => createHash('sha256').update(d).digest('hex')
const hmac = (k: Buffer | string, d: string): Buffer => createHmac('sha256', k).update(d).digest()

function xmlErro(codigo: string, mensagem: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${codigo}</Code><Message>${mensagem}</Message><RequestId>fake</RequestId></Error>`
}

function assinaturaConfere(req: http.IncomingMessage, o: OpcoesDoS3Falso): { ok: true } | { ok: false; codigo: string } {
  const auth = req.headers.authorization ?? ''
  const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(auth)
  if (!m) return { ok: false, codigo: 'AccessDenied' }
  const [, accessKey, data, regiao, signedHeaders, assinatura] = m as unknown as [string, string, string, string, string, string]
  if (accessKey !== o.accessKeyId) return { ok: false, codigo: 'InvalidAccessKeyId' }
  const [caminho = '', consulta = ''] = (req.url ?? '').split('?')
  const params = [...new URLSearchParams(consulta).entries()].map(([k, v]) => [rfc3986(k), rfc3986(v)] as const).sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
  const consultaCanonica = params.map(([k, v]) => `${k}=${v}`).join('&')
  const nomes = signedHeaders.split(';')
  const cabecalhos = nomes.map((n) => `${n}:${String(req.headers[n] ?? '').trim().replace(/\s+/g, ' ')}\n`).join('')
  const hashDoCorpo = String(req.headers['x-amz-content-sha256'] ?? '')
  const canonica = [req.method, caminho, consultaCanonica, cabecalhos, signedHeaders, hashDoCorpo].join('\n')
  const escopo = `${data}/${regiao}/s3/aws4_request`
  const paraAssinar = ['AWS4-HMAC-SHA256', String(req.headers['x-amz-date'] ?? ''), escopo, sha256Hex(canonica)].join('\n')
  const chave = hmac(hmac(hmac(hmac(`AWS4${o.secretAccessKey}`, data), regiao), 's3'), 'aws4_request')
  const esperada = createHmac('sha256', chave).update(paraAssinar).digest('hex')
  return esperada === assinatura ? { ok: true } : { ok: false, codigo: 'SignatureDoesNotMatch' }
}

function lerCorpo(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const partes: Buffer[] = []
    req.on('data', (c: Buffer) => partes.push(c))
    req.on('end', () => resolve(Buffer.concat(partes)))
    req.on('error', reject)
  })
}

export async function iniciarS3Falso(opcoes: OpcoesDoS3Falso): Promise<S3Falso> {
  const objetos = new Map<string, ObjetoFalso>()
  const requisicoes: string[] = []
  const falhas: Array<{ vezes: number; status: number; codigo: string }> = []
  const estado = { latenciaMs: 0 }
  const tamanhoDaPagina = opcoes.tamanhoDaPagina ?? 1000

  const servidor = http.createServer((req, res) => {
    void (async () => {
      const responder = (status: number, corpo = '', cabecalhos: Record<string, string> = {}): void => {
        res.writeHead(status, { 'Content-Length': Buffer.byteLength(corpo), ...cabecalhos })
        res.end(corpo)
      }
      try {
        const corpo = await lerCorpo(req)
        requisicoes.push(`${req.method} ${(req.url ?? '').split('?')[0]}`)
        if (estado.latenciaMs > 0) await new Promise((r) => setTimeout(r, estado.latenciaMs))

        const falha = falhas[0]
        if (falha && req.method === 'PUT' && (req.url ?? '').split('?')[0]!.split('/').length > 2) {
          falha.vezes -= 1
          if (falha.vezes <= 0) falhas.shift()
          return responder(falha.status, xmlErro(falha.codigo, 'falha injetada'), { 'Content-Type': 'application/xml' })
        }

        const auth = assinaturaConfere(req, opcoes)
        if (!auth.ok) return responder(403, xmlErro(auth.codigo, 'credencial recusada'), { 'Content-Type': 'application/xml' })
        const hashDoCorpo = String(req.headers['x-amz-content-sha256'] ?? '')
        if (/^[0-9a-f]{64}$/.test(hashDoCorpo) && sha256Hex(corpo) !== hashDoCorpo) return responder(400, xmlErro('XAmzContentSHA256Mismatch', 'o corpo não bate com o hash assinado'), { 'Content-Type': 'application/xml' })

        const [caminho = '', consulta = ''] = (req.url ?? '').split('?')
        const segmentos = caminho.split('/').filter(Boolean).map(decodeURIComponent)
        const bucket = segmentos.shift()
        if (bucket !== opcoes.bucket) return responder(404, xmlErro('NoSuchBucket', 'bucket inexistente'), { 'Content-Type': 'application/xml' })
        const chave = segmentos.join('/')
        const params = new URLSearchParams(consulta)

        if (chave === '' && req.method === 'GET') {
          const prefixo = params.get('prefix') ?? ''
          const inicio = params.get('continuation-token') ?? ''
          const todas = [...objetos.keys()].filter((k) => k.startsWith(prefixo)).sort()
          const aPartirDe = inicio ? todas.filter((k) => k > inicio) : todas
          const pagina = aPartirDe.slice(0, tamanhoDaPagina)
          const truncada = aPartirDe.length > pagina.length
          const itens = pagina
            .map((k) => {
              const o = objetos.get(k)!
              return `<Contents><Key>${k}</Key><LastModified>${o.modificadoEm.toISOString()}</LastModified><ETag>"x"</ETag><Size>${o.corpo.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`
            })
            .join('')
          const xml = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${bucket}</Name><Prefix>${prefixo}</Prefix><KeyCount>${pagina.length}</KeyCount><MaxKeys>${tamanhoDaPagina}</MaxKeys><IsTruncated>${truncada}</IsTruncated>${truncada ? `<NextContinuationToken>${pagina[pagina.length - 1]}</NextContinuationToken>` : ''}${itens}</ListBucketResult>`
          return responder(200, xml, { 'Content-Type': 'application/xml' })
        }
        if (chave === '' && req.method === 'POST' && params.has('delete')) {
          const chaves = [...corpo.toString('utf8').matchAll(/<Key>([^<]*)<\/Key>/g)].map((m) => m[1]!)
          for (const k of chaves) objetos.delete(k)
          return responder(200, `<?xml version="1.0" encoding="UTF-8"?><DeleteResult>${chaves.map((k) => `<Deleted><Key>${k}</Key></Deleted>`).join('')}</DeleteResult>`, { 'Content-Type': 'application/xml' })
        }
        if (req.method === 'PUT' && chave !== '') {
          const declarado = req.headers['content-length']
          if (declarado !== undefined && Number(declarado) !== corpo.length) return responder(400, xmlErro('IncompleteBody', 'tamanho divergente'), { 'Content-Type': 'application/xml' })
          const metadados: Record<string, string> = {}
          for (const [n, v] of Object.entries(req.headers)) if (n.startsWith('x-amz-meta-')) metadados[n.slice('x-amz-meta-'.length)] = String(v)
          objetos.set(chave, { corpo, metadados, modificadoEm: new Date(), contentType: String(req.headers['content-type'] ?? '') })
          return responder(200, '', { ETag: '"fake"' })
        }
        if (req.method === 'GET' && chave !== '') {
          const o = objetos.get(chave)
          if (!o) return responder(404, xmlErro('NoSuchKey', 'objeto inexistente'), { 'Content-Type': 'application/xml' })
          const meta: Record<string, string> = {}
          for (const [n, v] of Object.entries(o.metadados)) meta[`x-amz-meta-${n}`] = v
          res.writeHead(200, { 'Content-Length': o.corpo.length, 'Content-Type': 'application/octet-stream', ETag: '"fake"', ...meta })
          return void res.end(o.corpo)
        }
        if (req.method === 'DELETE' && chave !== '') {
          objetos.delete(chave)
          return responder(204)
        }
        return responder(400, xmlErro('InvalidRequest', 'operação não suportada pelo servidor falso'), { 'Content-Type': 'application/xml' })
      } catch {
        if (!res.headersSent) responder(500, xmlErro('InternalError', 'falha do servidor falso'))
      }
    })()
  })

  await new Promise<void>((resolve) => servidor.listen(0, '127.0.0.1', resolve))
  const porta = (servidor.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${porta}`,
    porta,
    objetos,
    requisicoes,
    falharProximasGravacoes(vezes, status, codigo = 'InternalError') {
      falhas.push({ vezes, status, codigo })
    },
    get latenciaMs() {
      return estado.latenciaMs
    },
    set latenciaMs(v: number) {
      estado.latenciaMs = v
    },
    fechar: () =>
      new Promise<void>((resolve) => {
        servidor.closeAllConnections?.()
        servidor.close(() => resolve())
      }),
  }
}
