/**
 * Servidores falsos para os testes dos avisos ao dono (N-7): SMTP local (`smtp-server`, só devDependency) e HTTP local (webhook/Evolution).
 * Sempre em porta ALTA efêmera (listen(0)) em 127.0.0.1 — nunca porta fixa.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { SMTPServer } from 'smtp-server'

export interface EmailRecebido {
  /** Texto bruto da mensagem (cabeçalhos + corpo, quoted-printable decodificado). */
  bruto: string
  de: string
  para: string[]
}

export interface SmtpFalso {
  porta: number
  recebidos: EmailRecebido[]
  fechar(): Promise<void>
}

/** Decodifica quoted-printable (o nodemailer usa QP em linhas longas/8bit) para os testes poderem procurar texto. */
function decodificarQp(texto: string): string {
  return texto.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
}

export async function iniciarSmtpFalso(opcoes: { usuario?: string; senha?: string } = {}): Promise<SmtpFalso> {
  const recebidos: EmailRecebido[] = []
  const servidor = new SMTPServer({
    authOptional: !opcoes.usuario,
    allowInsecureAuth: true,
    disabledCommands: ['STARTTLS'],
    logger: false,
    onAuth(auth, _sessao, cb) {
      if (opcoes.usuario && auth.username === opcoes.usuario && auth.password === opcoes.senha) return cb(null, { user: auth.username })
      return cb(new Error('Invalid login'))
    },
    onData(stream, sessao, cb) {
      const partes: Buffer[] = []
      stream.on('data', (c: Buffer) => partes.push(c))
      stream.on('end', () => {
        recebidos.push({
          bruto: decodificarQp(Buffer.concat(partes).toString('utf8')),
          de: sessao.envelope.mailFrom ? sessao.envelope.mailFrom.address : '',
          para: sessao.envelope.rcptTo.map((r) => r.address),
        })
        cb()
      })
    },
  })
  await new Promise<void>((resolve) => servidor.listen(0, '127.0.0.1', resolve))
  const porta = (servidor.server.address() as AddressInfo).port
  return {
    porta,
    recebidos,
    fechar: () => new Promise<void>((resolve) => servidor.close(() => resolve())),
  }
}

export interface RequisicaoRecebida {
  metodo: string
  url: string
  cabecalhos: IncomingMessage['headers']
  corpo: string
  json: unknown
}

export interface HttpFalso {
  porta: number
  base: string
  recebidas: RequisicaoRecebida[]
  /** Muda como as próximas requisições são respondidas. */
  responder: (fn: (req: RequisicaoRecebida, res: ServerResponse) => void) => void
  fechar(): Promise<void>
}

export async function iniciarHttpFalso(padrao: (req: RequisicaoRecebida, res: ServerResponse) => void = (_r, res) => res.writeHead(201).end('{}')): Promise<HttpFalso> {
  const recebidas: RequisicaoRecebida[] = []
  let handler = padrao
  const sockets = new Set<import('node:net').Socket>()
  const servidor: Server = createServer((req, res) => {
    const partes: Buffer[] = []
    req.on('data', (c: Buffer) => partes.push(c))
    req.on('end', () => {
      const corpo = Buffer.concat(partes).toString('utf8')
      let json: unknown = null
      try {
        json = JSON.parse(corpo)
      } catch {
        /* corpo não-JSON */
      }
      const r: RequisicaoRecebida = { metodo: req.method ?? '', url: req.url ?? '', cabecalhos: req.headers, corpo, json }
      recebidas.push(r)
      handler(r, res)
    })
  })
  servidor.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  await new Promise<void>((resolve) => servidor.listen(0, '127.0.0.1', resolve))
  const porta = (servidor.address() as AddressInfo).port
  return {
    porta,
    base: `http://127.0.0.1:${porta}`,
    recebidas,
    responder: (fn) => {
      handler = fn
    },
    fechar: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy()
        servidor.close(() => resolve())
      }),
  }
}

/** Espera até `condicao()` (ou estoura): os envios são assíncronos, fora do caminho de quem chamou. */
export async function esperarAte(condicao: () => boolean, limiteMs = 5_000): Promise<void> {
  const inicio = Date.now()
  while (!condicao()) {
    if (Date.now() - inicio > limiteMs) throw new Error('esperarAte: condição não atendida no prazo')
    await new Promise((r) => setTimeout(r, 10))
  }
}
