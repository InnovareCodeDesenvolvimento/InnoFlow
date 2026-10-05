import 'dotenv/config'
import { logger } from '../lib/logger'
import { startLiquidarSessaoWorker } from '../worker/jobs/liquidarSessaoJob'
import { startCreditarTopupPixWorker } from '../worker/jobs/creditarTopupPixJob'
import { startExpirarTopupsPixWorker, scheduleExpirarTopupsPixScan } from '../worker/jobs/expirarTopupsPixJob'
import { startPollTopupsPixWorker, schedulePollTopupsPixScan } from '../worker/jobs/pollTopupsPixJob'
import { startCapturarSessaoCartaoWorker } from '../worker/jobs/capturarSessaoCartaoJob'
import { startVarrerPreAutorizacoesCartaoWorker, scheduleVarrerPreAutorizacoesCartaoScan } from '../worker/jobs/varrerPreAutorizacoesCartaoJob'
import { startVigiarSessoesWorker, scheduleVigiarSessoesScan } from '../worker/jobs/vigiarSessoesJob'
import { startManterParticoesWorker, scheduleManterParticoes, manterParticoesNoBoot } from '../worker/jobs/manterParticoesJob'
import { startConfirmarEstornosPortalWorker, scheduleConfirmarEstornosPortal } from '../worker/jobs/confirmarEstornosPortalJob'

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

// Conta Cielo COMPARTILHADA com o Parque (04/10/2026): sem webhook do InnoFlow, o Pix pago é descoberto por POLLING (backoff por intent, ver services/pagamentos/pollTopupsPix.ts).
startPollTopupsPixWorker()
schedulePollTopupsPixScan().catch((err) => logger.error({ err }, '[worker] falha ao agendar o polling de Pix — o worker segue de pé, mas sem crédito automático por polling até reiniciar'))

// F5.4 (Vega, 2026-09-30): sessão de recarga cobrando de cartão — captura
// parcial (disparada por finalizarSessao ao marcar CAPTURE_PENDING) + rede de
// segurança da pré-autorização (ver services/pagamentos/varrerPreAutorizacoesCartao.ts).
startCapturarSessaoCartaoWorker()
startVarrerPreAutorizacoesCartaoWorker()
scheduleVarrerPreAutorizacoesCartaoScan().catch((err) =>
  logger.error({ err }, '[worker] falha ao agendar a varredura de pré-autorizações de cartão — o worker segue de pé, mas sem varredura automática até reiniciar'),
)

// F5.9 (Vega, 2026-10-03): watchdog de sessões travadas (M5/M6) — reavalia as sessões abertas/em confirmação a cada
// SESSION_WATCHDOG_INTERVAL_MS (ver services/sessao/vigiarSessoes.ts). Falhar ao agendar não derruba o worker.
startVigiarSessoesWorker()
scheduleVigiarSessoesScan().catch((err) =>
  logger.error({ err }, '[worker] falha ao agendar o watchdog de sessões — o worker segue de pé, mas sem vigilância automática até reiniciar'),
)

// N-11 (Cronos, 2026-10-05): partições mensais de MeterSample/OcppMessage (cria o que faltar, alerta horizonte curto/linhas na DEFAULT) + retenção
// (DESLIGADA por padrão — RETENTION_ENABLED). Roda já no boot e depois a cada PARTITION_MAINTENANCE_INTERVAL_MS. Ver services/manutencao/.
startManterParticoesWorker()
scheduleManterParticoes().catch((err) =>
  logger.error({ err }, '[worker] falha ao agendar a manutenção de partições — o worker segue de pé, mas sem manutenção periódica até reiniciar'),
)
void manterParticoesNoBoot()

// L1.8 (Vega, 2026-10-06): reconsulta, a cada REFUND_PORTAL_SCAN_INTERVAL_MS (30 min), as devoluções que o ADMIN registrou como feitas no PORTAL da Cielo (PENDING_CONFIRMATION) e confirma só o
// que a consulta PROVA. Só leitura na Cielo; sem credencial a rodada é pulada. Falhar ao agendar não derruba o worker.
startConfirmarEstornosPortalWorker()
scheduleConfirmarEstornosPortal().catch((err) =>
  logger.error({ err }, '[worker] falha ao agendar a confirmação das devoluções no portal — o worker segue de pé, mas sem confirmação automática até reiniciar'),
)

logger.info('worker ok')
