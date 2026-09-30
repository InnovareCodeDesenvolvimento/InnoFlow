import 'dotenv/config'
import { logger } from '../lib/logger'
import { startLiquidarSessaoWorker } from '../worker/jobs/liquidarSessaoJob'
import { startCreditarTopupPixWorker } from '../worker/jobs/creditarTopupPixJob'
import { startExpirarTopupsPixWorker, scheduleExpirarTopupsPixScan } from '../worker/jobs/expirarTopupsPixJob'
import { startCapturarSessaoCartaoWorker } from '../worker/jobs/capturarSessaoCartaoJob'
import { startVarrerPreAutorizacoesCartaoWorker, scheduleVarrerPreAutorizacoesCartaoScan } from '../worker/jobs/varrerPreAutorizacoesCartaoJob'

// F4 (Vega, 2026-09-17): primeira fila de negócio real — retry de liquidação
// financeira do StopTransaction (ver services/carteira/liquidarSessao.ts).
startLiquidarSessaoWorker()

// F5.2 (Vega, 2026-09-30): crédito de recarga Pix (webhook da Cielo, ver
// services/pagamentos/creditarTopupPix.ts) + varredor periódico de
// expiração (rede de segurança — reconsulta antes de expirar, nunca expira
// só por decurso de prazo).
startCreditarTopupPixWorker()
startExpirarTopupsPixWorker()
scheduleExpirarTopupsPixScan().catch((err) => logger.error({ err }, '[worker] falha ao agendar a varredura de expiração de Pix — o worker segue de pé, mas sem varredura automática até reiniciar'))

// F5.4 (Vega, 2026-09-30): sessão de recarga cobrando de cartão — captura
// parcial (disparada por finalizarSessao ao marcar CAPTURE_PENDING) + rede de
// segurança da pré-autorização (ver services/pagamentos/varrerPreAutorizacoesCartao.ts).
startCapturarSessaoCartaoWorker()
startVarrerPreAutorizacoesCartaoWorker()
scheduleVarrerPreAutorizacoesCartaoScan().catch((err) =>
  logger.error({ err }, '[worker] falha ao agendar a varredura de pré-autorizações de cartão — o worker segue de pé, mas sem varredura automática até reiniciar'),
)

logger.info('worker ok')
