/**
 * Script de PROCESSO (Íris, 04/10/2026): roda UM fluxo do módulo de pagamentos da Cielo num processo Node de verdade (tsx), com o `pino-pretty` real e
 * `NODE_ENV=production`, para o teste poder ler o STDOUT/STDERR cru — a única prova de que nenhum segredo/corpo cru chega ao log do EasyPanel (mesma ideia de
 * `leitorConfigGatewayProcesso.ts`). Uso: `tsx cieloFluxoProcesso.ts <acao> [argumento]`.
 *
 *   capturar <intentId>        capturarSessaoCartao
 *   cancelar <intentId>        cancelarPreAutorizacaoCartao
 *   varrer                     varrerPreAutorizacoesCartao
 *   consultarCartao <token>    PagamentoPort.consultarCartaoTokenizado (GET /1/card/{token})
 *   sessaoTokenizacao          PagamentoPort.sessaoTokenizacao (OAuth + accesstoken)
 *   testarConexao              testarConexaoGateway
 *
 * Termina com uma linha sentinela no log e `process.exit` depois de dar tempo ao transport de descarregar.
 */
import { prisma } from '../../../src/lib/prisma'
import { redis } from '../../../src/lib/redis'
import { logger } from '../../../src/lib/logger'
import { capturarSessaoCartao } from '../../../src/services/pagamentos/capturarSessaoCartao'
import { cancelarPreAutorizacaoCartao } from '../../../src/services/pagamentos/cancelarPreAutorizacaoCartao'
import { varrerPreAutorizacoesCartao } from '../../../src/services/pagamentos/varrerPreAutorizacoesCartao'
import { getPagamentoPort } from '../../../src/services/pagamentos/pagamentoPortInstance'
import { testarConexaoGateway } from '../../../src/services/pagamentos/testarConexaoGateway'

async function main(): Promise<void> {
  const [acao, argumento] = process.argv.slice(2)
  try {
    switch (acao) {
      case 'capturar':
        await capturarSessaoCartao(argumento)
        break
      case 'cancelar':
        await cancelarPreAutorizacaoCartao(argumento)
        break
      case 'varrer':
        await varrerPreAutorizacoesCartao()
        break
      case 'consultarCartao':
        await (await getPagamentoPort()).consultarCartaoTokenizado(argumento)
        break
      case 'sessaoTokenizacao':
        await (await getPagamentoPort()).sessaoTokenizacao()
        break
      case 'testarConexao':
        await testarConexaoGateway()
        break
      default:
        throw new Error(`ação desconhecida: ${acao}`)
    }
  } catch (err) {
    logger.error({ err }, '[fluxo-processo] erro propagado pelo fluxo')
  }
  logger.info(`[fluxo-processo] SENTINELA-FIM-${acao}`)
  await prisma.$disconnect()
  redis.disconnect()
  setTimeout(() => process.exit(0), 2500)
}

void main()
