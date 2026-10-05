/**
 * "Google" FALSO para os testes do backup no Drive (OAuth + Drive v3 mínimo), em porta efêmera alta, só loopback. Implementa o que o NOSSO código chama: troca de `code`/refresh por
 * token, `drive/v3/about`, criação de pasta, listagem com `q`, upload retomável (2 passos), `alt=media`, conferência de arquivo/pasta, DELETE e revogação.
 *
 * O QUE ISTO NÃO PROVA: o comportamento do Google REAL (cotas, revogação por inatividade, tela de consentimento, refresh token de 7 dias em app em modo de teste). Prova o NOSSO código
 * contra o contrato documentado.
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'

export interface ArquivoFalso {
  id: string
  name: string
  parents: string[]
  mimeType: string
  corpo: Buffer
  criadoEm: Date
  trashed: boolean
}

export interface GoogleFalso {
  base: string
  porta: number
  /** Arquivos e pastas por id. */
  arquivos: Map<string, ArquivoFalso>
  requisicoes: string[]
  /** `code` válido que o consentimento "devolveu" (o teste o entrega ao callback). */
  codigoValido: string
  refreshTokenEmitido: string
  /** O Google passa a recusar o refresh token com `invalid_grant` (conta revogada). */
  revogarAcesso(): void
  /** O próximo `authorization_code` devolve SEM refresh_token (o Google só o dá no 1º consentimento). */
  semRefreshTokenNaProximaTroca: boolean
  /** Falha injetada (HTTP status) nas próximas `vezes` gravações no Drive. */
  falharProximosEnvios(vezes: number, status: number, corpo?: string): void
  fechar(): Promise<void>
}

export async function iniciarGoogleFalso(opcoes: { clientId: string; clientSecret: string; email: string }): Promise<GoogleFalso> {
  const arquivos = new Map<string, ArquivoFalso>()
  const sessoes = new Map<string, { name: string; parents: string[] }>()
  const requisicoes: string[] = []
  const codigoValido = `codigo-${randomUUID()}`
  const refreshTokenEmitido = `refresh-${randomUUID()}`
  const estado = { acessoRevogado: false, semRefresh: false, tokensDeAcesso: new Set<string>(), falhas: [] as Array<{ vezes: number; status: number; corpo: string }> }
  let porta = 0

  const lerCorpo = (req: http.IncomingMessage): Promise<Buffer> =>
    new Promise((resolve) => {
      const partes: Buffer[] = []
      req.on('data', (c: Buffer) => partes.push(c))
      req.on('end', () => resolve(Buffer.concat(partes)))
    })

  const servidor = http.createServer((req, res) => {
    void (async () => {
      const json = (status: number, obj: unknown, cab: Record<string, string> = {}): void => {
        const corpo = JSON.stringify(obj)
        res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(corpo), ...cab })
        res.end(corpo)
      }
      const corpoBruto = await lerCorpo(req)
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${porta}`)
      requisicoes.push(`${req.method} ${url.pathname}`)

      if (req.method === 'POST' && url.pathname === '/token') {
        const f = new URLSearchParams(corpoBruto.toString('utf8'))
        if (f.get('client_id') !== opcoes.clientId || f.get('client_secret') !== opcoes.clientSecret) return json(401, { error: 'invalid_client', error_description: 'credenciais do app erradas' })
        if (f.get('grant_type') === 'authorization_code') {
          if (f.get('code') !== codigoValido) return json(400, { error: 'invalid_grant', error_description: 'codigo invalido' })
          const acesso = `acesso-${randomUUID()}`
          estado.tokensDeAcesso.add(acesso)
          const semRefresh = estado.semRefresh
          estado.semRefresh = false
          return json(200, { access_token: acesso, expires_in: 3600, ...(semRefresh ? {} : { refresh_token: refreshTokenEmitido }) })
        }
        if (f.get('grant_type') === 'refresh_token') {
          if (estado.acessoRevogado || f.get('refresh_token') !== refreshTokenEmitido) return json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' })
          const acesso = `acesso-${randomUUID()}`
          estado.tokensDeAcesso.add(acesso)
          return json(200, { access_token: acesso, expires_in: 3600 })
        }
        return json(400, { error: 'unsupported_grant_type' })
      }
      if (req.method === 'POST' && url.pathname === '/revoke') return json(200, {})

      const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1]
      const sessaoDeUpload = req.method === 'PUT' && url.pathname.startsWith('/upload/session/')
      if (!sessaoDeUpload && (!bearer || !estado.tokensDeAcesso.has(bearer))) return json(401, { error: { code: 401, message: 'Invalid Credentials', errors: [{ reason: 'authError', message: 'Invalid Credentials' }] } })

      const falha = estado.falhas[0]
      if (falha && (req.method === 'POST' || req.method === 'PUT') && (url.pathname.startsWith('/upload/') || url.pathname.startsWith('/files'))) {
        falha.vezes -= 1
        if (falha.vezes <= 0) estado.falhas.shift()
        res.writeHead(falha.status, { 'Content-Type': 'application/json' })
        return void res.end(falha.corpo)
      }

      if (req.method === 'GET' && url.pathname === '/drive/v3/about') return json(200, { user: { emailAddress: opcoes.email } })

      if (req.method === 'POST' && url.pathname === '/drive/v3/files') {
        const meta = JSON.parse(corpoBruto.toString('utf8')) as { name: string; mimeType: string }
        const id = `pasta-${randomUUID().slice(0, 8)}`
        arquivos.set(id, { id, name: meta.name, parents: [], mimeType: meta.mimeType, corpo: Buffer.alloc(0), criadoEm: new Date(), trashed: false })
        return json(200, { id })
      }

      if (req.method === 'GET' && url.pathname === '/drive/v3/files') {
        const q = url.searchParams.get('q') ?? ''
        const pasta = /'([^']+)' in parents/.exec(q)?.[1]
        const todos = [...arquivos.values()].filter((a) => a.parents.includes(pasta ?? '') && !a.trashed && a.name.includes('backup-')).sort((a, b) => a.criadoEm.getTime() - b.criadoEm.getTime())
        const inicio = Number(url.searchParams.get('pageToken') ?? 0)
        const tamanhoDaPagina = 2
        const pagina = todos.slice(inicio, inicio + tamanhoDaPagina)
        const proxima = inicio + tamanhoDaPagina < todos.length ? String(inicio + tamanhoDaPagina) : undefined
        return json(200, { ...(proxima ? { nextPageToken: proxima } : {}), files: pagina.map((a) => ({ id: a.id, name: a.name, createdTime: a.criadoEm.toISOString(), size: String(a.corpo.length) })) })
      }

      if (req.method === 'POST' && url.pathname === '/upload/drive/v3/files') {
        const meta = JSON.parse(corpoBruto.toString('utf8')) as { name: string; parents: string[] }
        const sid = randomUUID()
        sessoes.set(sid, { name: meta.name, parents: meta.parents })
        res.writeHead(200, { Location: `http://127.0.0.1:${porta}/upload/session/${sid}`, 'Content-Length': 0 })
        return void res.end()
      }
      if (sessaoDeUpload) {
        const sid = url.pathname.split('/').pop() ?? ''
        const s = sessoes.get(sid)
        if (!s) return json(404, { error: { code: 404, message: 'sessão inexistente' } })
        const id = `arq-${randomUUID().slice(0, 8)}`
        arquivos.set(id, { id, name: s.name, parents: s.parents, mimeType: 'application/octet-stream', corpo: corpoBruto, criadoEm: new Date(), trashed: false })
        return json(200, { id, name: s.name })
      }

      const m = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname)
      if (m) {
        const id = decodeURIComponent(m[1]!)
        const a = arquivos.get(id)
        if (!a) return json(404, { error: { code: 404, message: 'File not found: ' + id, errors: [{ reason: 'notFound', message: 'File not found' }] } })
        if (req.method === 'DELETE') {
          arquivos.delete(id)
          res.writeHead(204)
          return void res.end()
        }
        if (req.method === 'GET' && url.searchParams.get('alt') === 'media') {
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': a.corpo.length })
          return void res.end(a.corpo)
        }
        if (req.method === 'GET') return json(200, { id: a.id, name: a.name, mimeType: a.mimeType, size: String(a.corpo.length), trashed: a.trashed, capabilities: { canAddChildren: true } })
      }
      return json(400, { error: { code: 400, message: 'operação não suportada pelo Google falso' } })
    })()
  })

  await new Promise<void>((resolve) => servidor.listen(0, '127.0.0.1', resolve))
  porta = (servidor.address() as AddressInfo).port
  return {
    base: `http://127.0.0.1:${porta}`,
    porta,
    arquivos,
    requisicoes,
    codigoValido,
    refreshTokenEmitido,
    revogarAcesso() {
      estado.acessoRevogado = true
    },
    get semRefreshTokenNaProximaTroca() {
      return estado.semRefresh
    },
    set semRefreshTokenNaProximaTroca(v: boolean) {
      estado.semRefresh = v
    },
    falharProximosEnvios(vezes, status, corpo = '{"error":{"code":500,"message":"backendError"}}') {
      estado.falhas.push({ vezes, status, corpo })
    },
    fechar: () =>
      new Promise<void>((resolve) => {
        servidor.closeAllConnections?.()
        servidor.close(() => resolve())
      }),
  }
}
