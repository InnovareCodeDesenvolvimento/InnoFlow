import { describe, expect, it } from 'vitest'
import pino from 'pino'
import pinoHttp from 'pino-http'
import { createServer } from 'node:http'
import { Writable } from 'node:stream'
import { REDACT_PATHS } from '../../src/lib/logRedactPaths'
import { LINHA_REJEITADA_OMITIDA, LOG_SERIALIZERS, limparTextoSensivel, varrerSensivel } from '../../src/lib/logSerializers'
import { CieloHttpError } from '../../src/services/pagamentos/cieloHttpClient'

/**
 * F5.7 (B5/B6) — o `err` serializado NÃO vaza. PROVADO na saída real do pino (mesma config de `logger.ts`: `redact` com a
 * `REDACT_PATHS` real + `serializers: LOG_SERIALIZERS`), não só na lista: o `fast-redact` só casa 1 nível e é case-sensitive, e
 * o `err` carrega propriedades a 2+ níveis de profundidade. `timestamp:false`/`base:null`: sem número variável na saída (um valor
 * curto de teste não pode ser substring do `time`).
 */

function logarCom(opcoes: pino.LoggerOptions, objeto: Record<string, unknown>): string {
  const chunks: string[] = []
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString())
      cb()
    },
  })
  pino({ timestamp: false, base: null, ...opcoes }, stream).error(objeto, 'falha (teste)')
  return chunks.join('')
}

const loggerDoServidor = { serializers: LOG_SERIALIZERS, redact: { paths: REDACT_PATHS, censor: '[redacted]' } }
const saida = (objeto: Record<string, unknown>) => logarCom(loggerDoServidor, objeto)

// Corpo de erro da Cielo que ECOA o payload enviado — o cenário do B5. Campos sensíveis em 3-4 níveis de profundidade.
const PAN = '4111111111111111'
const CVV = '98765'
const CPF = '39053344705'
const TITULAR = 'MARIA DA SILVA SAURO'
const CARD_TOKEN = 'cardtoken-eco-da-cielo-0001'
const QR = '00020126-qrcode-copia-e-cola-eco'
const corpoEcoDaCielo = () => ({
  MerchantOrderId: 'order-1',
  Customer: { Name: 'Maria', Identity: CPF, IdentityType: 'CPF' },
  Payment: { Type: 'CreditCard', Amount: 1000, CreditCard: { CardNumber: PAN, Holder: TITULAR, SecurityCode: CVV, CardToken: CARD_TOKEN }, QrCodeString: QR },
})
const SENSIVEIS = [PAN, CVV, CPF, TITULAR, CARD_TOKEN, QR]

describe('B5 — o `err` serializado não vaza o corpo de erro da Cielo', () => {
  it('CIELOHTTPERROR: `body` é NÃO enumerável (some do log) mas continua legível por `err.body` para o adaptador', () => {
    const err = new CieloHttpError('Cielo respondeu HTTP 400', 400, corpoEcoDaCielo())
    expect(Object.keys(err)).not.toContain('body')
    expect(JSON.stringify(err)).not.toContain(PAN)
    expect((err.body as { Payment: { CreditCard: { CardNumber: string } } }).Payment.CreditCard.CardNumber).toBe(PAN) // o código que lê `err.body` segue funcionando
    const s = saida({ err })
    for (const v of SENSIVEIS) expect(s).not.toContain(v)
    expect(s).toContain('Cielo respondeu HTTP 400') // a mensagem útil continua
  })

  it('MESMO se alguma classe de erro expuser o corpo como propriedade ENUMERÁVEL, o serializer varre em profundidade (2+ níveis) — onde o `redact` sozinho não vê', () => {
    class ErroComCorpo extends Error {
      constructor(public payload: unknown) {
        super('erro com corpo enumerável')
      }
    }
    const err = new ErroComCorpo(corpoEcoDaCielo())
    const s = saida({ err })
    for (const v of SENSIVEIS) expect(s, `vazou ${v}`).not.toContain(v)
    expect(s).toContain('[redacted]')
    expect(s).toContain('MerchantOrderId') // só os campos sensíveis somem, o resto do diagnóstico fica
  })

  it('CONTROLE POSITIVO: só com o `redact` (sem o serializer) o mesmo erro VAZA — o teste enxerga o vazamento de verdade', () => {
    class ErroComCorpo extends Error {
      constructor(public payload: unknown) {
        super('erro com corpo enumerável')
      }
    }
    const s = logarCom({ redact: { paths: REDACT_PATHS, censor: '[redacted]' } }, { err: new ErroComCorpo(corpoEcoDaCielo()) })
    expect(s).toContain(PAN)
    expect(s).toContain(CPF)
  })

  it('não diferencia maiúsculas/minúsculas no NOME do campo (`cardnumber`, `CARDNUMBER`, `identity`)', () => {
    const err = Object.assign(new Error('x'), { dados: { deep: { cardnumber: PAN, CARDNUMBER: PAN, identity: CPF } } })
    const s = saida({ err })
    expect(s).not.toContain(PAN)
    expect(s).not.toContain(CPF)
  })

  it('erro encadeado (`cause`) e arrays também são varridos', () => {
    const causa = Object.assign(new Error('causa'), { corpo: [{ Payment: { CreditCard: { CardNumber: PAN } } }] })
    const err = new Error('externo', { cause: causa })
    const s = saida({ err })
    expect(s).not.toContain(PAN)
  })

  it('referência circular e objeto profundo demais não derrubam o log nem estouram a pilha', () => {
    const a: Record<string, unknown> = { nome: 'a' }
    a.self = a
    const err = Object.assign(new Error('circular'), { a })
    expect(() => saida({ err })).not.toThrow()
    let fundo: Record<string, unknown> = { CardNumber: PAN }
    for (let i = 0; i < 30; i++) fundo = { filho: fundo }
    expect(saida({ err: Object.assign(new Error('fundo'), { fundo }) })).not.toContain(PAN)
  })

  it('o caminho do pino-http (`res.err`) usa o MESMO serializer — o pino-http sobrescreve o `err` do logger se isso não for repassado', async () => {
    const chunks: string[] = []
    const stream = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk.toString())
        cb()
      },
    })
    const logger = pino({ timestamp: false, base: null, ...loggerDoServidor }, stream)
    const comSerializer = pinoHttp({ logger, serializers: LOG_SERIALIZERS })
    const semSerializer = pinoHttp({ logger })
    const erro = Object.assign(new Error('boom'), { payload: corpoEcoDaCielo() })

    async function requisitar(mw: typeof comSerializer): Promise<string> {
      chunks.length = 0
      const srv = createServer((req, res) => {
        mw(req, res)
        ;(res as unknown as { err: Error }).err = erro
        res.statusCode = 500
        res.end('x')
      })
      await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve))
      const porta = (srv.address() as { port: number }).port
      await fetch(`http://127.0.0.1:${porta}/`)
      await new Promise((r) => setTimeout(r, 50))
      srv.close()
      return chunks.join('')
    }

    const limpo = await requisitar(comSerializer)
    expect(limpo).toContain('"statusCode":500')
    for (const v of SENSIVEIS) expect(limpo, `vazou ${v}`).not.toContain(v)
    // controle: sem repassar o serializer ao pino-http o vazamento acontece (é por isso que `app.ts` repassa)
    expect(await requisitar(semSerializer)).toContain(PAN)
  })
})

describe('B3 — texto: `Failing row contains (...)` do Postgres não vai para o log', () => {
  const DETALHE = 'Failing row contains (cmabc, cmuser, 9fA+ciphertext-truncado-64-chars==, (com parênteses), 2026-10-02 12:00:00+00).'

  it('limparTextoSensivel troca o DETAIL inteiro (mesmo com parênteses dentro) e some a frase', () => {
    const msg = `Invalid prisma.paymentGatewayConfig.update() invocation: new row violates check constraint "x"\nDETAIL: ${DETALHE}\nresto`
    const limpo = limparTextoSensivel(msg)
    expect(limpo).not.toContain('Failing row contains')
    expect(limpo).not.toContain('ciphertext-truncado')
    expect(limpo).toContain(LINHA_REJEITADA_OMITIDA)
    expect(limpo).toContain('check constraint "x"') // a causa útil (qual constraint) permanece
    expect(limpo).toContain('resto')
  })

  it('no `err` serializado: vale para `message` E `stack`', () => {
    const err = new Error(`violação\nDETAIL: ${DETALHE}`)
    const s = saida({ err })
    expect(s).not.toContain('Failing row contains')
    expect(s).not.toContain('ciphertext-truncado')
  })
})

describe('B6 — novos campos no redact (soltos e um nível), em objetos que NÃO são `err`', () => {
  it.each(['Identity', 'Holder', 'holderName', 'QrCodeString', 'pixQrCode'])('%s some da saída solto na raiz e aninhado um nível', (campo) => {
    expect(saida({ [campo]: 'valor-secreto-xyz' })).not.toContain('valor-secreto-xyz')
    expect(saida({ cielo: { [campo]: 'valor-secreto-xyz' } })).not.toContain('valor-secreto-xyz')
  })

  it('varrerSensivel é puro e não muta o original', () => {
    const original = { a: { CardNumber: PAN } }
    const copia = varrerSensivel(original) as { a: { CardNumber: string } }
    expect(copia.a.CardNumber).toBe('[redacted]')
    expect(original.a.CardNumber).toBe(PAN)
  })
})
