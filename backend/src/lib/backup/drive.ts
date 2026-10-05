import { createReadStream, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import http from 'node:http'
import https from 'node:https'
import type { IncomingMessage } from 'node:http'
import { logger } from '../logger'
import { limparTextoSensivel } from '../logSerializers'
import { ErroDeBackup, type CodigoDeErroDoBackup } from '../../core/backup/erros'
import { ehNomeDeBackup } from '../../core/backup/politica'

/**
 * Google Drive como destino do backup (alternativa ao S3), SÓ por OAuth ("Conectar com Google"): o arquivo pertence à conta do dono. Porte do `drive.ts` do InnoChat sem o modo
 * conta de serviço (conta de serviço não tem espaço próprio e não é o que o dono pediu), sem `googleapis` (a superfície é pequena: token, subir, listar, apagar, baixar).
 *
 * A RESSALVA DE SEMPRE: no Drive o acesso pode ser revogado por uma pessoa e, sem cuidado, o backup para calado. Por isso toda falha daqui sai CLASSIFICADA num CÓDIGO que pede
 * uma ação diferente (credencial, pasta, cota, rede, conta desconectada); o texto cru do Google fica só no log (passando por `limparTextoSensivel`).
 *
 * NÃO PROVADO CONTRA O GOOGLE REAL: o desenvolvimento não tem app OAuth nem conta Drive. O contrato HTTP está conferido contra a documentação pública (upload retomável,
 * `files.list`, `alt=media`) e contra um servidor FALSO local (`tests/helpers/googleFalso.ts`) — que prova o NOSSO código, não o comportamento do Google.
 */

export const URLS_DO_GOOGLE = {
  /** `API`/`UPLOAD` ficam em objeto mutável só para o teste apontar para o servidor falso (`definirUrlsDoGoogleParaTeste`). */
  api: 'https://www.googleapis.com/drive/v3',
  upload: 'https://www.googleapis.com/upload/drive/v3',
  token: 'https://oauth2.googleapis.com/token',
  autorizacao: 'https://accounts.google.com/o/oauth2/v2/auth',
  revogar: 'https://oauth2.googleapis.com/revoke',
}

/** Só para teste: troca os endereços (aceita `http://127.0.0.1:porta`). NUNCA chamado em produção. */
export function definirUrlsDoGoogleParaTeste(urls: Partial<typeof URLS_DO_GOOGLE>): () => void {
  const antes = { ...URLS_DO_GOOGLE }
  Object.assign(URLS_DO_GOOGLE, urls)
  return () => Object.assign(URLS_DO_GOOGLE, antes)
}

const TIMEOUT_JSON_MS = 30_000
const TIMEOUT_TRANSFERENCIA_MS = 5 * 60_000
const MAX_CORPO = 64 * 1024

export type TokenGetter = () => Promise<string>

function falha(codigo: CodigoDeErroDoBackup, mensagem: string): ErroDeBackup {
  return new ErroDeBackup(mensagem, codigo)
}

function detalheDoErro(corpo: string): { motivo: string; mensagem: string } {
  try {
    const obj = JSON.parse(corpo) as { error?: { message?: string; errors?: Array<{ reason?: string; message?: string }> } | string; error_description?: string }
    if (typeof obj.error === 'string') return { motivo: obj.error, mensagem: obj.error_description ?? '' }
    const primeiro = obj.error?.errors?.[0]
    return { motivo: primeiro?.reason ?? '', mensagem: obj.error?.message ?? primeiro?.message ?? '' }
  } catch {
    return { motivo: '', mensagem: corpo.slice(0, 300) }
  }
}

/** Traduz status + corpo do Google numa causa acionável. Pura, para testar sem rede. */
export function classificarFalhaDoDrive(status: number, corpo: string): CodigoDeErroDoBackup {
  const { motivo, mensagem } = detalheDoErro(corpo)
  const texto = `${motivo} ${mensagem}`.toLowerCase()
  // Cota primeiro: também chega como 403, e confundir com permissão mandaria mexer no compartilhamento.
  if (texto.includes('storagequotaexceeded') || texto.includes('quotaexceeded') || texto.includes('storage quota')) return 'QUOTA'
  if (texto.includes('invalid_grant')) return 'OAUTH_DISCONNECTED'
  if (status === 401 || texto.includes('invalid_client') || texto.includes('unauthorized_client') || texto.includes('invalid credentials')) return 'CREDENTIAL'
  if (status === 404 || texto.includes('notfound') || texto.includes('file not found') || texto.includes('insufficientfilepermissions') || (status === 403 && (texto.includes('permission') || texto.includes('forbidden')))) return 'FOLDER'
  if (status === 429 || status >= 500 || texto.includes('ratelimit') || texto.includes('backenderror')) return 'NETWORK'
  return 'UNKNOWN'
}

export function falhaHttp(status: number, corpo: string, fazendo: string): ErroDeBackup {
  const codigo = classificarFalhaDoDrive(status, corpo)
  logger.warn({ fazendo, httpStatus: status, codigo, detalhe: limparTextoSensivel(corpo).slice(0, 300) }, '[backup][drive] o Google recusou a operação')
  return falha(codigo, `O Google recusou a operação (${fazendo}).`)
}

interface RespostaHttp {
  status: number
  texto: string
  headers: IncomingMessage['headers']
}

function escolherCliente(url: string): typeof https | typeof http {
  return url.startsWith('http://') ? http : https
}

function requisitar(url: string, opcoes: { method: string; headers?: Record<string, string>; body?: string; timeoutMs?: number }): Promise<RespostaHttp> {
  return new Promise((resolve, reject) => {
    const req = escolherCliente(url).request(url, { method: opcoes.method, headers: opcoes.headers }, (res) => {
      let texto = ''
      res.setEncoding('utf8')
      res.on('data', (pedaco: string) => {
        if (texto.length < MAX_CORPO) texto += pedaco
      })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, texto, headers: res.headers }))
    })
    req.setTimeout(opcoes.timeoutMs ?? TIMEOUT_JSON_MS, () => req.destroy(new Error('tempo esgotado esperando o Google responder')))
    req.on('error', (err) => {
      logger.warn({ errCode: (err as NodeJS.ErrnoException).code, detalhe: limparTextoSensivel(err.message).slice(0, 200) }, '[backup][drive] falha de rede')
      reject(falha('NETWORK', 'Não foi possível falar com o Google Drive.'))
    })
    if (opcoes.body) req.write(opcoes.body)
    req.end()
  })
}

export interface ArquivoDoDrive {
  id: string
  nome: string
  criadoEm: Date
  tamanho: number | null
}

/** Escapa o id para a query do Drive (aspas simples e barras). */
function escaparParaQuery(valor: string): string {
  return valor.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

export function consultaDosDumps(pastaId: string): string {
  return `'${escaparParaQuery(pastaId)}' in parents and trashed = false and name contains 'backup-'`
}

/** Lista os backups dentro da pasta (paginando até o fim), já filtrando só o que é nosso pelo nome. */
export async function listarDumpsDoDrive(token: TokenGetter, pastaId: string): Promise<ArquivoDoDrive[]> {
  const acesso = await token()
  const arquivos: ArquivoDoDrive[] = []
  let paginaToken: string | undefined
  do {
    const url =
      `${URLS_DO_GOOGLE.api}/files?q=${encodeURIComponent(consultaDosDumps(pastaId))}&pageSize=200&orderBy=createdTime` +
      `&fields=${encodeURIComponent('nextPageToken,files(id,name,createdTime,size)')}&supportsAllDrives=true&includeItemsFromAllDrives=true` +
      (paginaToken ? `&pageToken=${encodeURIComponent(paginaToken)}` : '')
    const res = await requisitar(url, { method: 'GET', headers: { Authorization: `Bearer ${acesso}` } })
    if (res.status !== 200) throw falhaHttp(res.status, res.texto, 'listar')
    const dados = JSON.parse(res.texto) as { nextPageToken?: string; files?: Array<{ id: string; name: string; createdTime: string; size?: string }> }
    for (const f of dados.files ?? []) {
      if (!ehNomeDeBackup(f.name)) continue
      arquivos.push({ id: f.id, nome: f.name, criadoEm: new Date(f.createdTime), tamanho: f.size ? Number(f.size) : null })
    }
    paginaToken = dados.nextPageToken
  } while (paginaToken)
  return arquivos
}

/** Confere que a pasta existe e aceita arquivo novo (Testar destino). */
export async function conferirPastaDoDrive(token: TokenGetter, pastaId: string): Promise<void> {
  const acesso = await token()
  const res = await requisitar(`${URLS_DO_GOOGLE.api}/files/${encodeURIComponent(pastaId)}?fields=${encodeURIComponent('id,mimeType,trashed,capabilities(canAddChildren)')}&supportsAllDrives=true`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${acesso}` },
  })
  if (res.status !== 200) throw falhaHttp(res.status, res.texto, 'abrir a pasta')
  const pasta = JSON.parse(res.texto) as { mimeType?: string; trashed?: boolean; capabilities?: { canAddChildren?: boolean } }
  if (pasta.trashed || pasta.mimeType !== 'application/vnd.google-apps.folder') throw falha('FOLDER', 'O id informado não é uma pasta, ou ela está na lixeira.')
  if (pasta.capabilities?.canAddChildren === false) throw falha('FOLDER', 'A pasta existe, mas esta conta não pode colocar arquivos nela.')
}

/**
 * Sobe o arquivo para dentro da pasta e CONFIRMA que chegou (tamanho e lixeira). Upload retomável por fluxo (um dump de vários GB não passa pela memória). A confirmação é o que
 * autoriza a poda a apagar qualquer coisa depois.
 */
export async function enviarParaODrive(opcoes: { token: TokenGetter; pastaId: string; arquivo: string; nome: string; tamanho: number }): Promise<{ arquivoId: string }> {
  const acesso = await opcoes.token()
  const metadados = JSON.stringify({ name: opcoes.nome, parents: [opcoes.pastaId] })
  const inicio = await requisitar(`${URLS_DO_GOOGLE.upload}/files?uploadType=resumable&supportsAllDrives=true`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${acesso}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'Content-Length': String(Buffer.byteLength(metadados)),
      'X-Upload-Content-Type': 'application/octet-stream',
      'X-Upload-Content-Length': String(opcoes.tamanho),
    },
    body: metadados,
  })
  if (inicio.status !== 200) throw falhaHttp(inicio.status, inicio.texto, 'abrir o envio')
  const sessao = inicio.headers.location
  if (typeof sessao !== 'string' || !sessao) throw falha('UNKNOWN', 'O Google aceitou o envio mas não devolveu o endereço da sessão.')
  const enviado = await enviarEmFluxo(sessao, opcoes.arquivo, opcoes.tamanho)
  if (enviado.status !== 200 && enviado.status !== 201) throw falhaHttp(enviado.status, enviado.texto, 'enviar o arquivo')
  const criado = JSON.parse(enviado.texto) as { id?: string }
  if (!criado.id) throw falha('UNKNOWN', 'O Drive não devolveu o id do arquivo enviado.')
  await confirmarEnvio(acesso, criado.id, opcoes.tamanho)
  return { arquivoId: criado.id }
}

function enviarEmFluxo(url: string, arquivo: string, tamanho: number): Promise<RespostaHttp> {
  return new Promise((resolve, reject) => {
    const req = escolherCliente(url).request(url, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(tamanho) } }, (res) => {
      let texto = ''
      res.setEncoding('utf8')
      res.on('data', (pedaco: string) => {
        if (texto.length < MAX_CORPO) texto += pedaco
      })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, texto, headers: res.headers }))
    })
    req.setTimeout(TIMEOUT_TRANSFERENCIA_MS, () => req.destroy(new Error('o envio ficou parado por tempo demais')))
    req.on('error', () => reject(falha('NETWORK', 'O envio para o Drive foi interrompido.')))
    const leitor = createReadStream(arquivo)
    leitor.on('error', () => {
      req.destroy()
      reject(falha('UNKNOWN', 'Não foi possível ler o arquivo para enviar.'))
    })
    leitor.pipe(req)
  })
}

async function confirmarEnvio(acesso: string, arquivoId: string, tamanhoEsperado: number): Promise<void> {
  const res = await requisitar(`${URLS_DO_GOOGLE.api}/files/${encodeURIComponent(arquivoId)}?fields=${encodeURIComponent('id,name,size,trashed')}&supportsAllDrives=true`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${acesso}` },
  })
  if (res.status !== 200) throw falhaHttp(res.status, res.texto, 'conferir o envio')
  const arquivo = JSON.parse(res.texto) as { size?: string; trashed?: boolean }
  if (arquivo.trashed) throw falha('FOLDER', 'O arquivo foi enviado e já está na lixeira do Drive.')
  const tamanho = arquivo.size ? Number(arquivo.size) : null
  if (tamanho !== null && tamanho !== tamanhoEsperado) throw falha('NETWORK', 'O arquivo chegou ao Drive com tamanho diferente: o envio ficou pela metade.')
}

/** Apaga de vez (não manda para a lixeira, que continuaria ocupando espaço por 30 dias). Falhar a poda não derruba um backup que já subiu e foi conferido. */
export async function apagarDoDrive(token: TokenGetter, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0
  const acesso = await token()
  let apagados = 0
  for (const id of ids) {
    const res = await requisitar(`${URLS_DO_GOOGLE.api}/files/${encodeURIComponent(id)}?supportsAllDrives=true`, { method: 'DELETE', headers: { Authorization: `Bearer ${acesso}` } })
    // 404 = já não existe: o objetivo (não estar lá) foi atingido.
    if (res.status === 204 || res.status === 200 || res.status === 404) {
      apagados += 1
      continue
    }
    logger.warn({ httpStatus: res.status }, '[backup][drive] não consegui apagar uma cópia antiga')
  }
  return apagados
}

/** Baixa o arquivo para o disco em fluxo (0600). Em erro, quem chama apaga o que sobrou (a pasta temporária inteira some no `finally`). */
export async function baixarDoDrive(token: TokenGetter, arquivoId: string, destino: string): Promise<void> {
  const acesso = await token()
  const url = `${URLS_DO_GOOGLE.api}/files/${encodeURIComponent(arquivoId)}?alt=media&supportsAllDrives=true`
  await new Promise<void>((resolve, reject) => {
    const req = escolherCliente(url).request(url, { method: 'GET', headers: { Authorization: `Bearer ${acesso}` } }, (res) => {
      if (res.statusCode !== 200) {
        let texto = ''
        res.setEncoding('utf8')
        res.on('data', (pedaco: string) => {
          if (texto.length < MAX_CORPO) texto += pedaco
        })
        res.on('end', () => reject(falhaHttp(res.statusCode ?? 0, texto, 'baixar')))
        return
      }
      pipeline(res, createWriteStream(destino, { mode: 0o600 })).then(
        () => resolve(),
        () => reject(falha('NETWORK', 'O download do backup foi interrompido.')),
      )
    })
    req.setTimeout(TIMEOUT_TRANSFERENCIA_MS, () => req.destroy(new Error('o download ficou parado por tempo demais')))
    req.on('error', () => reject(falha('NETWORK', 'Não foi possível falar com o Google Drive.')))
    req.end()
  })
}
