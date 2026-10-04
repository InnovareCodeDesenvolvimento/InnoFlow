/**
 * Processo FILHO de `logRealErroSerializadoProcessoFilho.test.ts`: usa o `logger` REAL do servidor (`src/lib/logger.ts`, com o transport
 * `pino-pretty`, `redact` e `serializers`) e loga `err` com segredos em lugares onde um erro de verdade os carrega. O PAI lê o stdout inteiro até
 * o processo sair (sem adivinhar tempo de flush). Não é um teste.
 */
import { logger } from '../../../src/lib/logger'
import { CieloHttpError } from '../../../src/services/pagamentos/cieloHttpClient'
import { PrismaClient } from '@prisma/client'

async function main(): Promise<void> {
  // CONTROLE POSITIVO: um campo que NÃO é sensível precisa aparecer — senão "não vazou" poderia ser só "o log parou de sair".
  logger.error({ err: Object.assign(new Error('controle'), { campoQualquer: 'CONTROLE-VISIVEL-NO-LOG' }) }, 'c0 controle')

  // Estilo axios/undici: Authorization e MerchantKey em `err.config.headers`, o corpo ecoado em `err.response.data`.
  logger.error(
    {
      err: Object.assign(new Error('Request failed with status code 500'), {
        config: { headers: { Authorization: 'Bearer SEG-AUTH-HEADER', MerchantKey: 'SEG-MERCHANTKEY-HEADER' } },
        response: { status: 500, data: { Payment: { CreditCard: { CardNumber: 'SEG-PAN-4111', Holder: 'SEG HOLDER' } } } },
      }),
    },
    'c1 axios-like',
  )
  // `Error.cause` como Error e como objeto, mais fundo.
  const interno = Object.assign(new Error('interno'), { merchantKey: 'SEG-MK-CAUSA-ERRO', headers: { authorization: 'SEG-AUTH-CAUSA' } })
  logger.error({ err: new Error('externo', { cause: interno }) }, 'c2 cause erro')
  logger.error({ err: new Error('externo2', { cause: { merchantKey: 'SEG-MK-CAUSA-OBJETO', n: { deep: { CardNumber: 'SEG-PAN-FUNDO' } } } }) }, 'c3 cause objeto')
  // O erro real do cliente HTTP (corpo NÃO enumerável) e um erro agregado.
  logger.error({ err: new CieloHttpError('Cielo respondeu HTTP 400', 400, { Payment: { CreditCard: { CardNumber: 'SEG-PAN-CIELOHTTPERROR' } } }) }, 'c4 CieloHttpError')
  logger.error({ err: new AggregateError([Object.assign(new Error('a'), { merchantKey: 'SEG-MK-AGREGADO' })], 'agg') }, 'c5 aggregate')
  // Os dois nomes de header que a lista de redact escreve com colchetes.
  logger.error({ err: Object.assign(new Error('h'), { response: { headers: { 'set-cookie': ['SEG-SET-COOKIE'], 'InnoFlowWebhookSecret': 'SEG-WEBHOOK-HEADER' } } }) }, 'c6 headers com colchetes')
  // Erro de validação do Prisma: a mensagem monta uma "invocação" com os VALORES dos argumentos.
  const prisma = new PrismaClient()
  try {
    await (prisma.paymentGatewayConfig as unknown as { update: (a: unknown) => Promise<unknown> }).update({ where: { id: 1 }, data: { merchantKeyCiphertext: 'SEG-CIPHERTEXT-NO-ARGUMENTO', sopClientId: 12345 } })
  } catch (err) {
    logger.error({ err }, 'c7 prisma validation')
  }
  await prisma.$disconnect()
  logger.error('FIM-DOS-LOGS-DO-FILHO')
}

main().then(() => setTimeout(() => process.exit(0), 700))
