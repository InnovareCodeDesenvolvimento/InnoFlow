import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { randomUUID } from 'node:crypto'

/**
 * "Cielo" FALSA de verdade (servidor HTTP em porta local, TCP real) e COM ESTADO — Íris, C1/C2 (04/10/2026).
 *
 * Os testes anteriores usavam `fetchImpl` injetado ou o `FakeAdapter`: nenhum deles passa por socket, então nenhum deles consegue provar o que
 * acontece numa QUEDA DE CONEXÃO depois que a Cielo já processou, nem num timeout de verdade. Este servidor guarda as vendas, aplica
 * captura/cancelamento de verdade e CONTA DUAS COISAS que o cliente não vê:
 *   - `chamadas`: cada requisição que chegou (rota, ordem, cabeçalhos, corpo) — para provar "nunca 2º POST / 2º PUT sem consulta antes";
 *   - `efeitos`: o que de fato aconteceu NO MUNDO DA CIELO (vendas criadas por MerchantOrderId, capturas e cancelamentos EFETIVADOS por
 *     PaymentId) — a medida real de "cobrou/cancelou duas vezes", independente do que a resposta disse.
 *
 * Diretivas (`agendar`) são consumidas uma por chamada da rota; sem diretiva, comportamento normal.
 * NENHUMA chamada sai da máquina: tudo em 127.0.0.1.
 */

export type RotaCielo = 'POST_SALE' | 'GET_BY_ORDER' | 'GET_BY_ID' | 'PUT_CAPTURE' | 'PUT_VOID' | 'GET_CARD' | 'OUTRA'

export interface ChamadaCielo {
  seq: number
  rota: RotaCielo
  metodo: string
  url: string
  headers: IncomingHttpHeaders
  corpo: unknown
  corpoBruto: string
  paymentId: string | null
  merchantOrderId: string | null
  /** `process.hrtime.bigint()` convertido para ms — só para ordenação/medida. */
  tMs: number
}

export interface Diretiva {
  /** O servidor EFETIVA a operação (grava a venda, captura, cancela) antes de decidir a resposta? Padrão: sim. `false` = a Cielo nunca viu. */
  processar?: boolean
  /** Como responde. Padrão `normal`. `travar` = nunca responde (o cliente estoura o timeout); `derrubar` = destrói o socket (ECONNRESET). */
  resposta?: 'normal' | 'travar' | 'derrubar' | { http: number; corpo?: unknown; bruto?: string }
  atrasoMs?: number
  /** Sobrescreve o que a venda passa a ser (POST_SALE) / o que a resposta de captura-cancelamento diz. */
  venda?: Partial<{ status: number; returnCode: string | number | null; tid: string | number | null; authorizationCode: string | null; proofOfSale: string | null }>
  /** Corpo de resposta CRU no lugar do gerado (útil para formatos esquisitos: sem ReturnCode, ReturnCode numérico etc.). */
  corpoRespostaCru?: unknown
}

interface VendaFalsa {
  paymentId: string
  merchantOrderId: string
  amount: number
  status: number
  returnCode: string | number | null
  capturedAmount: number | null
  tid: string | number | null
  authorizationCode: string | null
  proofOfSale: string | null
  tipo: string
  cardToken: string | null
  softDescriptor: string | null
}

export interface OpcoesCieloFalsa {
  /** `completo` = `GET ?merchantOrderId=` devolve Status/ReturnCode/Amount por pagamento (o que o adaptador ASSUME). `so_ids` = devolve só `PaymentId` + data (o que a doc que a Íris conhece descreve). */
  porPedido?: 'completo' | 'so_ids'
}

export class CieloFalsaHttp {
  private server: Server
  private sockets = new Set<Socket>()
  private agendas = new Map<RotaCielo, Diretiva[]>()
  readonly vendas = new Map<string, VendaFalsa>()
  readonly chamadas: ChamadaCielo[] = []
  readonly efeitos = {
    /** MerchantOrderId -> quantas VENDAS a Cielo criou (>1 = cobrança em dobro no mundo real). */
    vendasCriadas: new Map<string, number>(),
    /** PaymentId -> quantas capturas foram EFETIVADAS. */
    capturas: new Map<string, number>(),
    /** PaymentId -> quantos cancelamentos foram EFETIVADOS. */
    cancelamentos: new Map<string, number>(),
  }
  porPedido: 'completo' | 'so_ids'
  /** PaymentId -> data a devolver na lista por pedido (`ReceveidDate`/`ReceivedDate`). */
  readonly datasPorPedido = new Map<string, string>()
  /** Devolve a lista por pedido do MAIS RECENTE para o mais antigo (quem pega "o último do array" erra). */
  ordemInvertidaNaLista = false
  url = ''
  private seq = 0

  constructor(opcoes: OpcoesCieloFalsa = {}) {
    this.porPedido = opcoes.porPedido ?? 'completo'
    this.server = createServer((req, res) => {
      const pedaços: Buffer[] = []
      req.on('data', (c: Buffer) => pedaços.push(c))
      req.on('end', () => {
        void this.tratar(req.method ?? 'GET', req.url ?? '/', req.headers, Buffer.concat(pedaços).toString('utf8'), req.socket, res)
      })
    })
    this.server.on('connection', (s) => {
      this.sockets.add(s)
      s.on('close', () => this.sockets.delete(s))
    })
  }

  async iniciar(): Promise<string> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r))
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    return this.url
  }

  async parar(): Promise<void> {
    for (const s of this.sockets) s.destroy()
    await new Promise<void>((r) => this.server.close(() => r()))
  }

  /** Enfileira diretivas para a rota (consumidas na ordem, uma por chamada). */
  agendar(rota: RotaCielo, ...diretivas: Diretiva[]): void {
    const fila = this.agendas.get(rota) ?? []
    fila.push(...diretivas)
    this.agendas.set(rota, fila)
  }

  zerarRegistro(): void {
    this.chamadas.length = 0
    this.vendas.clear()
    this.agendas.clear()
    this.efeitos.vendasCriadas.clear()
    this.efeitos.capturas.clear()
    this.efeitos.cancelamentos.clear()
  }

  contar(rota: RotaCielo, filtro?: { paymentId?: string; merchantOrderId?: string }): number {
    return this.chamadas.filter((c) => c.rota === rota && (!filtro?.paymentId || c.paymentId === filtro.paymentId) && (!filtro?.merchantOrderId || c.merchantOrderId === filtro.merchantOrderId)).length
  }

  /** Ordem em que as rotas foram chamadas (opcionalmente só as do PaymentId). */
  sequencia(filtro?: { paymentId?: string; merchantOrderId?: string }): RotaCielo[] {
    return this.chamadas.filter((c) => (!filtro?.paymentId || c.paymentId === filtro.paymentId) && (!filtro?.merchantOrderId || c.merchantOrderId === filtro.merchantOrderId)).map((c) => c.rota)
  }

  /**
   * Regra de ouro da API sem chave de idempotência: uma ESCRITA repetida nunca sai sem uma CONSULTA no meio.
   *  - 2º (3º...) POST_SALE do mesmo MerchantOrderId exige um GET_BY_ORDER depois do POST anterior;
   *  - todo PUT_CAPTURE/PUT_VOID exige um GET_BY_ID do mesmo PaymentId depois da escrita anterior sobre ele (`estrito` exige também antes da PRIMEIRA).
   * Devolve as violações (vazio = regra respeitada).
   */
  escritasSemConsultaPrevia(estrito = false): string[] {
    const violacoes: string[] = []
    const postsPorOrdem = new Map<string, number>()
    const consultouOrdem = new Set<string>()
    const escritasPorPagamento = new Map<string, number>()
    const consultouPagamento = new Set<string>()
    for (const c of this.chamadas) {
      if (c.rota === 'GET_BY_ORDER' && c.merchantOrderId) consultouOrdem.add(c.merchantOrderId)
      if (c.rota === 'GET_BY_ID' && c.paymentId) consultouPagamento.add(c.paymentId)
      if (c.rota === 'POST_SALE' && c.merchantOrderId) {
        const n = postsPorOrdem.get(c.merchantOrderId) ?? 0
        if (n >= 1 && !consultouOrdem.has(c.merchantOrderId)) violacoes.push(`#${c.seq} POST_SALE repetido para ${c.merchantOrderId} sem GET_BY_ORDER depois do POST anterior`)
        postsPorOrdem.set(c.merchantOrderId, n + 1)
        consultouOrdem.delete(c.merchantOrderId)
      }
      if ((c.rota === 'PUT_CAPTURE' || c.rota === 'PUT_VOID') && c.paymentId) {
        const n = escritasPorPagamento.get(c.paymentId) ?? 0
        if ((n >= 1 || estrito) && !consultouPagamento.has(c.paymentId)) violacoes.push(`#${c.seq} ${c.rota} para ${c.paymentId} sem GET_BY_ID antes (escrita nº ${n + 1})`)
        escritasPorPagamento.set(c.paymentId, n + 1)
        consultouPagamento.delete(c.paymentId)
      }
    }
    return violacoes
  }

  vendaPorPedido(merchantOrderId: string): VendaFalsa | undefined {
    return [...this.vendas.values()].reverse().find((v) => v.merchantOrderId === merchantOrderId)
  }

  /** Planta uma venda já existente "no mundo da Cielo" (ex.: autorizada enquanto o nosso lado perdia a resposta). */
  plantarVenda(v: Partial<VendaFalsa> & { merchantOrderId: string }): VendaFalsa {
    const venda: VendaFalsa = {
      paymentId: v.paymentId ?? randomUUID(),
      merchantOrderId: v.merchantOrderId,
      amount: v.amount ?? 1000,
      status: v.status ?? 1,
      returnCode: v.returnCode === undefined ? '4' : v.returnCode,
      capturedAmount: v.capturedAmount ?? null,
      tid: v.tid === undefined ? `TID${Math.floor(Math.random() * 1e9)}` : v.tid,
      authorizationCode: v.authorizationCode === undefined ? '123456' : v.authorizationCode,
      proofOfSale: v.proofOfSale === undefined ? '654321' : v.proofOfSale,
      tipo: v.tipo ?? 'CreditCard',
      cardToken: v.cardToken ?? null,
      softDescriptor: v.softDescriptor ?? null,
    }
    this.vendas.set(venda.paymentId, venda)
    this.efeitos.vendasCriadas.set(venda.merchantOrderId, (this.efeitos.vendasCriadas.get(venda.merchantOrderId) ?? 0) + 1)
    return venda
  }

  private corpoDaVenda(v: VendaFalsa): Record<string, unknown> {
    const base: Record<string, unknown> = {
      MerchantOrderId: v.merchantOrderId,
      Customer: { Name: 'Motorista Falso' },
      Payment: {
        ServiceTaxAmount: 0,
        Installments: 1,
        Interest: 'ByMerchant',
        Capture: false,
        Authenticate: false,
        Recurrent: false,
        CreditCard: { CardNumber: '453904******4242', Holder: 'MOTORISTA FALSO', ExpirationDate: '12/2030', SaveCard: false, Brand: 'Visa', CardToken: v.cardToken ?? undefined },
        ProofOfSale: v.proofOfSale,
        Tid: v.tid,
        AuthorizationCode: v.authorizationCode,
        SoftDescriptor: v.softDescriptor ?? undefined,
        Provider: 'Simulado',
        IsQrCode: false,
        Amount: v.amount,
        CapturedAmount: v.capturedAmount ?? undefined,
        ReceivedDate: '2026-10-04 10:00:00',
        Status: v.status,
        IsSplitted: false,
        ReturnMessage: 'Operation Successful',
        ReturnCode: v.returnCode,
        PaymentId: v.paymentId,
        Type: v.tipo,
        Currency: 'BRL',
        Country: 'BRA',
        Links: [{ Method: 'GET', Rel: 'self', Href: `${this.url}/1/sales/${v.paymentId}` }],
      },
    }
    return base
  }

  private async tratar(metodo: string, url: string, headers: IncomingHttpHeaders, corpoBruto: string, socket: Socket, res: import('node:http').ServerResponse): Promise<void> {
    const u = new URL(url, 'http://x')
    let corpo: unknown = null
    try {
      corpo = corpoBruto ? JSON.parse(corpoBruto) : null
    } catch {
      corpo = { raw: corpoBruto }
    }
    const partes = u.pathname.split('/').filter(Boolean) // ['1','sales',id,'capture']
    let rota: RotaCielo = 'OUTRA'
    let paymentId: string | null = null
    let merchantOrderId: string | null = null
    if (partes[0] === '1' && partes[1] === 'sales') {
      if (metodo === 'POST' && partes.length === 2) {
        rota = 'POST_SALE'
        merchantOrderId = (corpo as { MerchantOrderId?: string } | null)?.MerchantOrderId ?? null
      } else if (metodo === 'GET' && partes.length === 2) {
        rota = 'GET_BY_ORDER'
        merchantOrderId = u.searchParams.get('merchantOrderId')
      } else if (metodo === 'GET' && partes.length === 3) {
        rota = 'GET_BY_ID'
        paymentId = decodeURIComponent(partes[2])
      } else if (metodo === 'PUT' && partes[3] === 'capture') {
        rota = 'PUT_CAPTURE'
        paymentId = decodeURIComponent(partes[2])
      } else if (metodo === 'PUT' && partes[3] === 'void') {
        rota = 'PUT_VOID'
        paymentId = decodeURIComponent(partes[2])
      }
    } else if (partes[0] === '1' && partes[1] === 'card' && metodo === 'GET') {
      rota = 'GET_CARD'
    }
    this.chamadas.push({ seq: ++this.seq, rota, metodo, url, headers, corpo, corpoBruto, paymentId, merchantOrderId, tMs: Number(process.hrtime.bigint() / 1_000_000n) })

    const dir = this.agendas.get(rota)?.shift() ?? {}
    if (dir.atrasoMs) await new Promise((r) => setTimeout(r, dir.atrasoMs))

    const efetivar = dir.processar !== false
    let respostaPadrao: { http: number; corpo: unknown } = { http: 404, corpo: [{ Code: 0, Message: 'rota desconhecida' }] }

    switch (rota) {
      case 'POST_SALE': {
        const c = corpo as { MerchantOrderId: string; Payment: { Type: string; Amount: number; SoftDescriptor?: string; CreditCard?: { CardToken?: string } } }
        const ehPix = c.Payment?.Type === 'Pix'
        let venda: VendaFalsa
        if (efetivar) {
          venda = this.plantarVenda({
            merchantOrderId: c.MerchantOrderId,
            amount: c.Payment?.Amount ?? 0,
            status: dir.venda?.status ?? (ehPix ? 12 : 1),
            returnCode: dir.venda?.returnCode !== undefined ? dir.venda.returnCode : ehPix ? '0' : '4',
            tid: dir.venda?.tid,
            authorizationCode: dir.venda?.authorizationCode,
            proofOfSale: dir.venda?.proofOfSale,
            tipo: c.Payment?.Type ?? 'CreditCard',
            cardToken: c.Payment?.CreditCard?.CardToken ?? null,
            softDescriptor: c.Payment?.SoftDescriptor ?? null,
          })
        } else {
          venda = { paymentId: randomUUID(), merchantOrderId: c.MerchantOrderId, amount: 0, status: 1, returnCode: '4', capturedAmount: null, tid: null, authorizationCode: null, proofOfSale: null, tipo: 'CreditCard', cardToken: null, softDescriptor: null }
        }
        const corpoVenda = this.corpoDaVenda(venda)
        if (ehPix) {
          const pay = corpoVenda.Payment as Record<string, unknown>
          pay.QrCodeBase64Image = 'iVBORw0KGgoAAAANSUhEUgAAAFAAAABQ'
          pay.QrCodeString = '00020101021226830014br.gov.bcb.pix2561exemplo'
          pay.Type = 'Pix'
          delete pay.CreditCard
        }
        respostaPadrao = { http: 201, corpo: corpoVenda }
        break
      }
      case 'GET_BY_ORDER': {
        const achadas = [...this.vendas.values()].filter((v) => v.merchantOrderId === merchantOrderId)
        if (this.ordemInvertidaNaLista) achadas.reverse()
        if (this.porPedido === 'so_ids') {
          respostaPadrao = { http: 200, corpo: { ReasonCode: 0, ReasonMessage: 'Successful', Payments: achadas.map((v) => ({ PaymentId: v.paymentId, ReceveidDate: this.datasPorPedido.get(v.paymentId) ?? '2026-10-04 10:00:00' })) } }
        } else {
          respostaPadrao = { http: 200, corpo: { MerchantOrderId: merchantOrderId, Payments: achadas.map((v) => (this.corpoDaVenda(v).Payment as Record<string, unknown>)) } }
        }
        break
      }
      case 'GET_BY_ID': {
        const v = this.vendas.get(paymentId ?? '')
        respostaPadrao = v ? { http: 200, corpo: this.corpoDaVenda(v) } : { http: 404, corpo: [{ Code: 404, Message: 'Not Found' }] }
        break
      }
      case 'PUT_CAPTURE': {
        const v = this.vendas.get(paymentId ?? '')
        if (!v) {
          respostaPadrao = { http: 404, corpo: [{ Code: 404, Message: 'Not Found' }] }
        } else if (v.status !== 1) {
          respostaPadrao = { http: 400, corpo: [{ Code: 308, Message: 'Transaction not available to capture' }] }
        } else {
          const valor = u.searchParams.get('amount')
          if (efetivar) {
            v.status = dir.venda?.status ?? 2
            v.returnCode = dir.venda?.returnCode !== undefined ? dir.venda.returnCode : '6'
            v.capturedAmount = valor ? Number(valor) : v.amount
            this.efeitos.capturas.set(v.paymentId, (this.efeitos.capturas.get(v.paymentId) ?? 0) + 1)
          }
          // A captura real devolve o objeto ACHATADO (sem Payment/PaymentId/Amount).
          respostaPadrao = { http: 200, corpo: { Status: efetivar ? v.status : 1, ReasonCode: 0, ReasonMessage: 'Successful', ProviderReturnCode: '6', ProviderReturnMessage: 'Operation Successful', ReturnCode: efetivar ? v.returnCode : '4', ReturnMessage: 'Operation Successful', Links: [] } }
        }
        break
      }
      case 'PUT_VOID': {
        const v = this.vendas.get(paymentId ?? '')
        if (!v) {
          respostaPadrao = { http: 404, corpo: [{ Code: 404, Message: 'Not Found' }] }
        } else if (v.status === 10 || v.status === 11) {
          respostaPadrao = { http: 400, corpo: [{ Code: 309, Message: 'Transaction not available to void' }] }
        } else {
          if (efetivar) {
            const capturada = v.status === 2
            v.status = dir.venda?.status ?? (capturada ? 11 : 10)
            v.returnCode = dir.venda?.returnCode !== undefined ? dir.venda.returnCode : capturada ? '9' : '0'
            this.efeitos.cancelamentos.set(v.paymentId, (this.efeitos.cancelamentos.get(v.paymentId) ?? 0) + 1)
          }
          respostaPadrao = { http: 200, corpo: { Status: efetivar ? v.status : 1, ReasonCode: 0, ReasonMessage: 'Successful', ProviderReturnCode: '9', ReturnCode: efetivar ? v.returnCode : '4', ReturnMessage: 'Operation Successful', Links: [] } }
        }
        break
      }
      case 'GET_CARD':
        respostaPadrao = { http: 404, corpo: [{ Code: 404, Message: 'Not Found' }] }
        break
      default:
        break
    }

    const resp = dir.resposta ?? 'normal'
    if (resp === 'travar') return
    if (resp === 'derrubar') {
      socket.destroy()
      return
    }
    const http = resp === 'normal' ? respostaPadrao.http : resp.http
    const corpoFinal = resp === 'normal' ? (dir.corpoRespostaCru !== undefined ? dir.corpoRespostaCru : respostaPadrao.corpo) : (resp.corpo ?? null)
    res.statusCode = http
    res.setHeader('content-type', 'application/json')
    res.end(resp !== 'normal' && resp.bruto !== undefined ? resp.bruto : JSON.stringify(corpoFinal))
  }
}

/** Servidor falso da Braspag (OAuth do SOP + emissão do AccessToken) — grava cabeçalhos e corpo EXATOS de cada passo. */
export class BraspagFalsa {
  private server: Server
  url = ''
  readonly passos: Array<{ passo: 'oauth' | 'accesstoken' | 'outra'; metodo: string; url: string; headers: IncomingHttpHeaders; corpoBruto: string }> = []
  modoOauth: 'ok' | 'invalid_client' = 'ok'
  modoAccess: 'ok' | 'sem401' = 'ok'

  constructor() {
    this.server = createServer((req, res) => {
      const pedaços: Buffer[] = []
      req.on('data', (c: Buffer) => pedaços.push(c))
      req.on('end', () => {
        const corpoBruto = Buffer.concat(pedaços).toString('utf8')
        const passo = req.url?.startsWith('/oauth2/token') ? 'oauth' : req.url?.startsWith('/post/api/public/v2/accesstoken') ? 'accesstoken' : 'outra'
        this.passos.push({ passo, metodo: req.method ?? '', url: req.url ?? '', headers: req.headers, corpoBruto })
        res.setHeader('content-type', 'application/json')
        if (passo === 'oauth') {
          if (this.modoOauth === 'invalid_client') {
            res.statusCode = 400
            res.end(JSON.stringify({ error: 'invalid_client' }))
            return
          }
          res.end(JSON.stringify({ access_token: 'OAUTH-TOKEN-FALSO-PASSO-1', token_type: 'bearer', expires_in: 599 }))
          return
        }
        if (passo === 'accesstoken') {
          if (this.modoAccess === 'sem401') {
            res.statusCode = 401
            res.end()
            return
          }
          res.end(JSON.stringify({ MerchantId: 'x', AccessToken: 'ACCESS-TOKEN-FALSO-PASSO-2', Issued: '2026-10-04T10:00:00', ExpiresIn: 1200 }))
          return
        }
        res.statusCode = 404
        res.end('{}')
      })
    })
  }

  async iniciar(): Promise<string> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r))
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    return this.url
  }

  async parar(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()))
  }
}
