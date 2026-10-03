import type Redis from 'ioredis'
import { prisma } from '../../lib/prisma'
import { env } from '../../lib/env'
import { logger } from '../../lib/logger'
import { redis as redisPadrao } from '../../lib/redis'
import { DeadlineExceededError, withDeadline } from '../../lib/withDeadline'
import { avaliarSessaoAberta, type ConfigWatchdogSessao, type DecisaoSessao, type EntradaAvaliacao, type ProvasDeLeitura, type StatusConectorOcpp, type TipoAlertaSessao } from '../../core/sessao/avaliarSessaoAberta'
import { listarEstadosSessaoVigiada, isSessaoAberta, isSessaoNaoConfirmada } from '../../core/sessao/estadosSessao'
import { dispararTriggerMeterValues, chaveTriggerMeterValues, reservarVagaDeComando, comandosEmVooAgora } from './triggerMeterValues'
import { estimarIntervaloAmostragemMs } from './intervaloAmostragem'
import { alertarSessao, alertarSessaoLimitado, chaveAlertaLimitado } from './alertasSessao'
import { configWatchdogDoEnv } from './configWatchdog'
import { avaliarGuardaDeSaldo, carregarSessaoParaGuarda, ultimaEnergiaConhecida } from './guardaDeSaldo'
import { marcarSessaoNaoConfirmada, chaveEnergiaNaMarcacao } from './marcarSessaoNaoConfirmada'
import { chaveEnergiaNoPedidoDeParada, pedirParadaSessao } from './pedirParadaSessao'
import { reanimarSessao } from './reanimarSessao'
import { encerrarSessaoPeloServidor } from './encerrarSessaoPeloServidor'
import { buscarStopTransactionNoLog, buscarUltimaAmostra } from './resolverLeituraFinal'
import type { FotoDaSessao } from './travarSessao'

/**
 * WATCHDOG de sessões de recarga (F5.9, 9b1) — a parte com EFEITOS. A decisão é do núcleo puro (`core/sessao/avaliarSessaoAberta.ts`);
 * aqui se monta o snapshot com os relógios do SERVIDOR, se executa a ação decidida e se contam os resultados.
 *
 * Garantias:
 *  - cada sessão num try/catch próprio (uma falha não derruba o ciclo nem o worker);
 *  - toda ação que MUDA estado reconfere a decisão SOB `FOR UPDATE` (a foto do snapshot vai junto — compare-and-swap): o StopTransaction
 *    do carregador que chega no meio vence, nunca há cobrança dupla nem dois fechamentos;
 *  - lote: varre `SESSION_WATCHDOG_BATCH_SIZE` sessões por página, paginando por chave (id) até esgotar (teto de páginas por ciclo — sem
 *    inanição: as páginas cobrem TODAS as vigiadas, não só as 100 primeiras);
 *  - cooldowns de RemoteStop e de TriggerMessage no Redis (falha de Redis nunca derruba o ciclo: o TriggerMessage fica sem enviar,
 *    o RemoteStop segue protegido pelo espaçamento por `stopRequestedAt` do banco);
 *  - comandos OCPP (até 35 s cada) rodam em segundo plano, com teto de comandos em voo, para um carregador mudo não segurar o ciclo.
 */

const MAX_PAGINAS_POR_CICLO = 20
const REDIS_PRAZO_MS = 3_000
/** A guarda lê o Redis (dedupe do auto-stop): com o Redis fora o ioredis NÃO rejeita (fica na fila) e travaria o ciclo inteiro numa sessão. */
const GUARDA_PRAZO_MS = 8_000

export { chaveTriggerMeterValues, chaveAlertaLimitado }

/**
 * Estado de UM ciclo. M8 (Órion): com o Redis fora, cada sessão pagava o prazo da guarda (R6) em sequência — 100 sessões = ciclo de 25 min e o R1-U2 das
 * outras atrasados. Disjuntor por ciclo: a PRIMEIRA chamada ao Redis que estoura/falha marca `redisInstavel` e o R6 (que depende dele) é pulado no resto do ciclo.
 */
interface CicloWatchdog {
  redisInstavel: boolean
  guardaPrazoMs: number
}

export interface VigiarSessoesDeps {
  agora?: Date
  redis?: Redis
  config?: ConfigWatchdogSessao
  batchSize?: number
  /** Só para teste: espera os comandos OCPP (RemoteStop/TriggerMessage) terminarem. Em produção ficam em segundo plano. */
  aguardarComandos?: boolean
  /** Só para teste: ignora o kill-switch `SESSION_WATCHDOG_ENABLED` (os testes de integração ligam a chave explicitamente; isto existe para o teste do próprio kill-switch). */
  habilitado?: boolean
  /** Só teste: prazo da guarda de saldo (R6) por sessão (default 8 s) — o disjuntor de Redis do ciclo (M8) precisa ser provado sem esperar 8 s. */
  guardaPrazoMs?: number
  /** Restringe o ciclo a estes carregadores (uso pontual/operacional e testes que dividem o banco com outras suítes). Omitido = todas as sessões vigiadas. */
  chargePointIds?: readonly string[]
}

export interface VigiarSessoesResultado {
  avaliadas: number
  porAcao: Record<string, number>
  falhas: number
  /** `true` quando o teto de páginas do ciclo cortou a varredura (há mais sessões vigiadas do que o ciclo alcança). */
  truncada: boolean
  /** `true` quando o kill-switch (`SESSION_WATCHDOG_ENABLED=false`) impediu o ciclo. */
  desligado?: boolean
}

const SELECT_VIGIADA = {
  id: true,
  status: true,
  paymentMode: true,
  createdAt: true,
  startedAt: true,
  lastActivityAt: true,
  lastMeterValuesAt: true,
  stopRequestedAt: true,
  stopAttempts: true,
  unconfirmedAt: true,
  chargePointId: true,
  ocppTransactionId: true,
  chargePoint: { select: { lastSeenAt: true, disconnectedAt: true } },
  connector: { select: { connectorId: true, status: true, statusReceivedAt: true } },
  paymentIntents: { where: { purpose: 'SESSION_CARD_CAPTURE' as const, status: 'AUTHORIZED' as const }, select: { authorizedAt: true }, take: 1 },
} as const

export async function vigiarSessoes(deps: VigiarSessoesDeps = {}): Promise<VigiarSessoesResultado> {
  const redis = deps.redis ?? redisPadrao
  const config = deps.config ?? configWatchdogDoEnv()
  const batchSize = deps.batchSize ?? env.SESSION_WATCHDOG_BATCH_SIZE
  const resultado: VigiarSessoesResultado = { avaliadas: 0, porAcao: {}, falhas: 0, truncada: false }
  const ciclo: CicloWatchdog = { redisInstavel: false, guardaPrazoMs: deps.guardaPrazoMs ?? GUARDA_PRAZO_MS }
  if (!(deps.habilitado ?? env.SESSION_WATCHDOG_ENABLED)) return { ...resultado, desligado: true } // kill-switch (M4): nenhum efeito, nem leitura

  // Paginação por CHAVE (`id > último`), não por `cursor`+`skip`: processar uma sessão a tira do filtro (vira STOPPED), e o cursor do Prisma
  // sobre uma linha que já não casa com o `where` faz o `skip: 1` pular uma sessão VÁLIDA (achado dos testes: 4 de 5 processadas).
  let ultimoId: string | undefined
  for (let pagina = 0; pagina < MAX_PAGINAS_POR_CICLO; pagina++) {
    // `status IN (...)` é o predicado do índice parcial `ix_charging_session_watchdog`.
    const sessoes = await prisma.chargingSession.findMany({
      where: {
        status: { in: listarEstadosSessaoVigiada() },
        ...(deps.chargePointIds ? { chargePointId: { in: [...deps.chargePointIds] } } : {}),
        ...(ultimoId ? { id: { gt: ultimoId } } : {}),
      },
      orderBy: { id: 'asc' },
      take: batchSize,
      select: SELECT_VIGIADA,
    })
    if (sessoes.length === 0) break

    for (const sessao of sessoes) {
      // `agora` por sessão (não por ciclo): um ciclo longo não pode avaliar a sessão 90 com o relógio da sessão 1.
      const agora = deps.agora ?? new Date()
      try {
        const acao = await processarSessao(sessao, agora, config, redis, deps.aguardarComandos ?? false, ciclo)
        resultado.avaliadas++
        resultado.porAcao[acao] = (resultado.porAcao[acao] ?? 0) + 1
      } catch (err) {
        resultado.falhas++
        logger.error({ err, sessionId: sessao.id }, '[watchdog] falha ao processar esta sessão — seguindo para as demais; reavalia no próximo ciclo')
      }
    }

    if (sessoes.length < batchSize) break
    ultimoId = sessoes[sessoes.length - 1]!.id
    if (pagina === MAX_PAGINAS_POR_CICLO - 1) resultado.truncada = true
  }

  if (ciclo.redisInstavel) {
    logger.warn({ alert: 'session_watchdog_redis_unstable', skippedBalanceGuard: resultado.porAcao.REAVALIAR_GUARDA_PULADA ?? 0 }, '[watchdog] Redis instável neste ciclo — a guarda de saldo (R6) foi pulada para as demais sessões; o resto da vigilância seguiu')
  }
  if (resultado.truncada) {
    logger.warn({ alert: 'session_watchdog_scan_truncated', evaluated: resultado.avaliadas, batchSize, maxPages: MAX_PAGINAS_POR_CICLO }, '[watchdog] o ciclo atingiu o teto de páginas — há mais sessões vigiadas do que ele alcança')
  }
  // REAVALIAR_GUARDA (R6) é rotina — roda a cada ciclo para toda sessão sem amostra recente — e não vira linha de log; o resto (marcar, pedir
  // parada, reanimar, encerrar, alertar) e qualquer falha sim.
  const relevante = Object.keys(resultado.porAcao).some((acao) => acao !== 'NADA' && acao !== 'REAVALIAR_GUARDA')
  if (relevante || resultado.falhas > 0) logger.info({ ...resultado }, '[watchdog] ciclo concluído')
  return resultado
}

type SessaoVigiada = Awaited<ReturnType<typeof prisma.chargingSession.findMany<{ select: typeof SELECT_VIGIADA }>>>[number]

async function processarSessao(sessao: SessaoVigiada, agora: Date, config: ConfigWatchdogSessao, redis: Redis, aguardarComandos: boolean, ciclo: CicloWatchdog): Promise<string> {
  const foto: FotoDaSessao = {
    status: sessao.status,
    lastActivityAt: sessao.lastActivityAt,
    lastMeterValuesAt: sessao.lastMeterValuesAt,
    stopRequestedAt: sessao.stopRequestedAt,
    stopAttempts: sessao.stopAttempts,
    unconfirmedAt: sessao.unconfirmedAt,
  }
  const conectorStatus = sessao.connector.status as StatusConectorOcpp

  // Provas de leitura: só interessam para quem pode ser encerrado (STOP_UNCONFIRMED).
  let provas: ProvasDeLeitura = { stopTransactionNoLog: false, ultimaAmostra: false }
  let intervaloAmostragemMs: number | null = null
  let energiaAvancouDesdeAMarcacao: boolean | null = null
  if (isSessaoNaoConfirmada(sessao.status)) {
    const [stopNoLog, amostra, intervalo] = await Promise.all([
      buscarStopTransactionNoLog(prisma, sessao),
      buscarUltimaAmostra(prisma, sessao.id, sessao.chargePointId),
      estimarIntervaloAmostragemMs(prisma, sessao.id, sessao.chargePointId),
    ])
    provas = { stopTransactionNoLog: stopNoLog !== null, ultimaAmostra: amostra !== null }
    intervaloAmostragemMs = intervalo
    // M7: energia da amostra mais recente x energia NA MARCAÇÃO (guardada no Redis ao marcar). Chave perdida ou sem amostra => null (desconhecido: comportamento antigo).
    const naMarcacao = await redisSeguro(() => redis.get(chaveEnergiaNaMarcacao(sessao.id)), 'energia na marcação', ciclo)
    if (naMarcacao !== null && naMarcacao !== undefined && amostra !== null) energiaAvancouDesdeAMarcacao = amostra.meterWh > Number(naMarcacao)
  }

  // R3: o medidor continuou subindo depois do pedido de parada? A energia no momento do pedido foi guardada no Redis (`pedirParadaSessao`).
  let energyAdvancedSinceStopRequest = false
  if (isSessaoAberta(sessao.status) && sessao.stopRequestedAt) {
    const guardada = await redisSeguro(() => redis.get(chaveEnergiaNoPedidoDeParada(sessao.id)), 'energia no pedido de parada', ciclo)
    if (guardada !== null && guardada !== undefined) {
      const amostra = await buscarUltimaAmostra(prisma, sessao.id, sessao.chargePointId)
      energyAdvancedSinceStopRequest = amostra !== null && amostra.meterWh > Number(guardada)
    }
  }

  // R4: cooldown do TriggerMessage vive no Redis. Só consulta quando a regra pode disparar (conector carregando).
  let ultimoTriggerMeterValuesEm: Date | null = null
  if (isSessaoAberta(sessao.status) && conectorStatus === 'CHARGING') {
    const valor = await redisSeguro(() => redis.get(chaveTriggerMeterValues(sessao.id)), 'cooldown do TriggerMessage', ciclo)
    if (valor) ultimoTriggerMeterValuesEm = new Date(Number(valor))
  }

  const entrada: EntradaAvaliacao = {
    agora,
    sessao: {
      status: sessao.status,
      paymentMode: sessao.paymentMode,
      createdAt: sessao.createdAt,
      lastActivityAt: sessao.lastActivityAt,
      lastMeterValuesAt: sessao.lastMeterValuesAt,
      stopRequestedAt: sessao.stopRequestedAt,
      stopAttempts: sessao.stopAttempts,
      unconfirmedAt: sessao.unconfirmedAt,
      cardAuthorizedAt: sessao.paymentMode === 'CARD' ? (sessao.paymentIntents[0]?.authorizedAt ?? null) : null,
      energyAdvancedSinceStopRequest,
      energiaAvancouDesdeAMarcacao,
    },
    carregador: { lastSeenAt: sessao.chargePoint.lastSeenAt, disconnectedAt: sessao.chargePoint.disconnectedAt },
    conector: { status: conectorStatus, statusReceivedAt: sessao.connector.statusReceivedAt },
    provas,
    ultimoTriggerMeterValuesEm,
    intervaloAmostragemMs,
    config,
  }

  const decisao = avaliarSessaoAberta(entrada)
  if (decisao.acao !== 'NADA' && decisao.acao !== 'REAVALIAR_GUARDA') {
    logger.info({ sessionId: sessao.id, chargePointId: sessao.chargePointId, rule: decisao.regra, action: decisao.acao, status: sessao.status }, '[watchdog] decisão')
  }
  await executar(decisao, sessao, foto, config, redis, aguardarComandos, ciclo)
  return decisao.acao
}

async function executar(decisao: DecisaoSessao, sessao: SessaoVigiada, foto: FotoDaSessao, config: ConfigWatchdogSessao, redis: Redis, aguardarComandos: boolean, ciclo: CicloWatchdog): Promise<void> {
  const campos = { sessionId: sessao.id, chargePointId: sessao.chargePointId }

  switch (decisao.acao) {
    case 'NADA':
      return

    case 'REAVALIAR_GUARDA': {
      await reavaliarGuarda(sessao.id, aguardarComandos, ciclo)
      return
    }

    case 'PEDIR_REMOTE_STOP': {
      const liberar = reservarVagaDeComando()
      if (!liberar) {
        logger.warn({ ...campos, inFlight: comandosEmVooAgora() }, '[watchdog] teto de comandos em voo atingido — RemoteStop fica para o próximo ciclo')
        return
      }
      const execucao = pedirParadaSessao({
        sessionId: sessao.id,
        solicitante: decisao.solicitante,
        fotoEsperada: foto,
        redis,
        onRegistrado: ({ tentativa }) => emitirAlertas(decisao.alertasExtras, { ...campos, attempt: tentativa }, `RemoteStop pedido pelo watchdog (${decisao.regra})`),
      })
        .catch((err) => logger.error({ err, ...campos }, '[watchdog] pedido de parada falhou'))
        .finally(liberar)
      if (aguardarComandos) await execucao
      return
    }

    case 'TENTAR_TRIGGER_MESSAGE': {
      const r = await dispararTriggerMeterValues({ sessionId: sessao.id, chargePointId: sessao.chargePointId, connectorNumber: sessao.connector.connectorId, cooldownMinutes: config.meterTriggerCooldownMinutes, redis, aguardar: aguardarComandos, origem: 'R4' })
      if (r === 'ENVIADO' || r === 'SEM_VAGA') emitirAlertas(decisao.alertasExtras, campos, 'sessão em CHARGING sem MeterValues — pedindo MeterValues ao carregador (TriggerMessage); NÃO é motivo para encerrar')
      return
    }

    case 'MARCAR_NAO_CONFIRMADA':
      await marcarSessaoNaoConfirmada({ sessionId: sessao.id, motivo: decisao.motivo, fotoEsperada: foto, alertasExtras: decisao.alertasExtras })
      return

    case 'REANIMAR': {
      const reanimada = await reanimarSessao({ sessionId: sessao.id, fotoEsperada: foto, redis })
      if (reanimada === 'REANIMADA') {
        // Voltou a ser "aberta": a guarda de saldo precisa olhar de novo (ficou fora do ar enquanto estava em confirmação).
        await reavaliarGuarda(sessao.id, aguardarComandos, ciclo)
      }
      return
    }

    case 'ENCERRAR_PELO_SERVIDOR':
      await encerrarSessaoPeloServidor({ sessionId: sessao.id, fotoEsperada: foto, forcadoPeloPrazoDoCartao: decisao.forcadoPeloPrazoDoCartao })
      return

    case 'ALERTAR': {
      // Condição persistente (ex.: carregador que não obedece o stop): sem o limite sairia 1 alerta de erro por minuto.
      await alertarSessaoLimitado(decisao.tipo, campos, `condição persistente (${decisao.regra})`, { redis })
      return
    }
  }
}

/** R6: a guarda de saldo com a última energia conhecida (sem amostra, energia entregue 0 — o que cresce é o custo por tempo). Com prazo: ver `GUARDA_PRAZO_MS`. */
async function reavaliarGuarda(sessionId: string, aguardarComandos: boolean, ciclo: CicloWatchdog): Promise<void> {
  // M8: Redis já instável neste ciclo => pula (não paga o prazo de novo a cada sessão). A próxima rodada tenta de novo.
  if (ciclo.redisInstavel) return
  const guarda = await carregarSessaoParaGuarda(sessionId)
  const energia = await ultimaEnergiaConhecida(sessionId, guarda.chargePointId, guarda.meterStartWh)
  try {
    await withDeadline(avaliarGuardaDeSaldo(guarda, energia, { aguardarComando: aguardarComandos }), ciclo.guardaPrazoMs, 'guarda de saldo')
  } catch (err) {
    if (err instanceof DeadlineExceededError) ciclo.redisInstavel = true // a guarda só trava assim quando o Redis não responde
    throw err
  }
}

function emitirAlertas(tipos: readonly TipoAlertaSessao[], campos: { sessionId: string; chargePointId: string; [k: string]: unknown }, mensagem: string): void {
  for (const tipo of tipos) alertarSessao(tipo, campos, mensagem)
}

/** Redis com prazo e sem derrubar o ciclo: falha/prazo => `null` (e um aviso). */
async function redisSeguro<T>(operacao: () => Promise<T>, rotulo: string, ciclo?: CicloWatchdog): Promise<T | null> {
  if (ciclo?.redisInstavel) return null // M8: já sabemos que o Redis não responde neste ciclo
  try {
    return await withDeadline(operacao(), REDIS_PRAZO_MS, rotulo)
  } catch (err) {
    if (ciclo) ciclo.redisInstavel = true
    logger.warn({ err, label: rotulo }, '[watchdog] Redis indisponível para esta consulta — seguindo sem ela')
    return null
  }
}
