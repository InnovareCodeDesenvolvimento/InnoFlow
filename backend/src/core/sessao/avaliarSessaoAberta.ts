/**
 * Decisão do WATCHDOG sobre uma sessão de recarga (F5.9). Função PURA: sem Prisma/Redis/logger e sem `Date.now()` — quem
 * chama passa `agora` e um snapshot, e recebe a AÇÃO decidida. Os efeitos (RemoteStop, TriggerMessage, UPDATE sob
 * `FOR UPDATE`, alertas no log) ficam na camada de serviço, que também precisa sempre reconferir a condição no UPDATE
 * (a decisão é tirada de um snapshot; o StopTransaction do carregador pode chegar no meio).
 * Desenho: `.claude/agent-memory/nova/decisoes-f59-sessao-travada.md` + o relatório da Nova de 02/10/2026.
 *
 * ---------------------------------------------------------------------------------------------------------------
 * PRINCÍPIO (causa raiz de M5, M6 e D-A): o servidor NÃO trata o próprio palpite ("o carregador esqueceu a sessão")
 * como fato. Fechar pelo servidor é PROVISÓRIO: aberta -> STOP_UNCONFIRMED (sem dinheiro) -> só depois da janela de
 * confirmação, STOPPED com a melhor prova de leitura. O OCPP 1.6 deixa o carregador enfileirar o StopTransaction offline
 * e mandá-lo depois do Boot; fechar na hora cobraria a menos justamente no incidente mais comum (queda de energia).
 * ---------------------------------------------------------------------------------------------------------------
 *
 * REGRA DOS DOIS RELÓGIOS (misturar é bug):
 *   - O WATCHDOG decide SÓ com o relógio do SERVIDOR: `agora`, `createdAt`, `lastActivityAt`, `stopRequestedAt`,
 *     `unconfirmedAt`, `cardAuthorizedAt` e, do carregador, apenas `lastSeenAt`/`disconnectedAt` (também carimbados pelo
 *     servidor ao receber a mensagem / fechar o socket). NUNCA `startedAt`, `lastSampleAt` nem `ChargePoint`-timestamp de
 *     payload: o relógio do carregador pode estar horas errado, e um poste com relógio adiantado/atrasado não pode
 *     disparar nem segurar um encerramento.
 *   - A COBRANÇA usa SÓ o relógio do carregador (timestamp do payload). Isso é com quem executa o encerramento, não aqui.
 *
 * ORDEM DE PRECEDÊNCIA em sessão ABERTA (STARTED/CHARGING/FINISHING/FAULTED); a primeira regra que casar decide:
 *   1. prazo do cartão (48 h de hold)  -> MARCAR_NAO_CONFIRMADA(MAX_DURATION)   [dinheiro em risco vence tudo]
 *   2. R1 carregador sumiu             -> MARCAR_NAO_CONFIRMADA(CHARGER_UNREACHABLE)
 *   3. R2 conector já liberado         -> MARCAR_NAO_CONFIRMADA(CONNECTOR_IDLE)
 *   4. R5 duração máxima               -> PEDIR_REMOTE_STOP; depois da janela, MARCAR_NAO_CONFIRMADA(MAX_DURATION)
 *   5. R3 stop pedido e não confirmado -> PEDIR_REMOTE_STOP (reenvio) até o teto; depois MARCAR_NAO_CONFIRMADA(STOP_NOT_CONFIRMED)
 *   6. R4 online + CHARGING + silêncio -> TENTAR_TRIGGER_MESSAGE (+ alerta); NUNCA fecha a sessão
 *   7. R6 sem amostra recente          -> REAVALIAR_GUARDA (a guarda de saldo/teto só rodava no MeterValues — defeito D-C)
 *   senão NADA.
 * Em STOP_UNCONFIRMED: U1 (reanima) > U2 (encerra pelo servidor) > ALERTAR/NADA.
 */
import { isChargePointOnline, type PresencaCarregador } from '../estacoes/disponibilidade'
import { isSessaoAberta, isSessaoNaoConfirmada, type StatusSessao } from './estadosSessao'

const MINUTO_MS = 60_000
const HORA_MS = 3_600_000

// ------------------------------------------------------------------------------------------------ tipos de entrada

/** Política D2 (decisão do dono): o que fazer quando a sessão é encerrada pelo servidor SEM NENHUMA leitura de medidor. */
export type PoliticaSemLeitura = 'NO_CHARGE' | 'MIN_FEE'

/** Os parâmetros do watchdog (espelham as envs `SESSION_*` / `CARD_SESSION_MAX_HOLD_HOURS`; o core não importa `env.ts`). */
export interface ConfigWatchdogSessao {
  /** Cadência do job (ms). Aqui serve de "amostra velha": sem atividade há >= 1 ciclo, a guarda é reavaliada (R6). */
  watchdogIntervalMs: number
  /** R1: o carregador precisa estar offline há >= isto (minutos). */
  chargerOfflineMinutes: number
  /** R1 e R4: sem atividade do servidor há >= isto (minutos). */
  inactivityMinutes: number
  /** R2: o conector precisa estar AVAILABLE/UNAVAILABLE há >= isto (minutos). */
  connectorIdleMinutes: number
  /** R3/R5: quanto esperar o StopTransaction depois de um RemoteStop aceito (minutos). */
  stopConfirmMinutes: number
  /** R3: teto de RemoteStop (contando o 1º, o do motorista/admin/guarda). */
  stopMaxAttempts: number
  /** R5: idade máxima de uma sessão aberta (horas, relógio do servidor desde `createdAt`). */
  maxOpenHours: number
  /** U2: janela de confirmação com o carregador ONLINE agora (minutos). */
  unconfirmedGraceOnlineMinutes: number
  /** U2: janela de confirmação com o carregador OFFLINE agora (minutos) — decisão D1 do dono. */
  unconfirmedGraceOfflineMinutes: number
  /** Teto do hold da pré-autorização do cartão (horas desde `PaymentIntent.authorizedAt`). */
  cardMaxHoldHours: number
  /** R4: intervalo mínimo entre dois TriggerMessage(MeterValues) da mesma sessão (minutos). */
  meterTriggerCooldownMinutes: number
  /** Decisão D2 do dono. */
  noReadingPolicy: PoliticaSemLeitura
}

/** Defaults recomendados pela Nova. TÊM de bater com os defaults de `lib/env.ts` (teste unitário trava a igualdade). */
export const CONFIG_WATCHDOG_PADRAO: Readonly<ConfigWatchdogSessao> = Object.freeze({
  watchdogIntervalMs: 60_000,
  chargerOfflineMinutes: 10,
  inactivityMinutes: 15,
  connectorIdleMinutes: 5,
  stopConfirmMinutes: 5,
  stopMaxAttempts: 3,
  maxOpenHours: 24,
  unconfirmedGraceOnlineMinutes: 10,
  unconfirmedGraceOfflineMinutes: 120,
  cardMaxHoldHours: 48,
  meterTriggerCooldownMinutes: 15,
  noReadingPolicy: 'NO_CHARGE',
})

export type ModoPagamentoSessao = 'WALLET' | 'CARD'

/** Status do conector OCPP como o servidor o guarda (`ConnectorStatus` do schema). */
export const STATUS_CONECTOR_OCPP = ['AVAILABLE', 'PREPARING', 'CHARGING', 'SUSPENDED_EVSE', 'SUSPENDED_EV', 'FINISHING', 'RESERVED', 'UNAVAILABLE', 'FAULTED'] as const
export type StatusConectorOcpp = (typeof STATUS_CONECTOR_OCPP)[number]

/** Por que uma sessão entrou em STOP_UNCONFIRMED (espelha `StopUnconfirmedReason`). O watchdog só produz 4 deles; Boot e stop rejeitado produzem os outros 2. */
export const MOTIVOS_NAO_CONFIRMADA = ['STOP_REJECTED', 'STOP_NOT_CONFIRMED', 'CHARGER_UNREACHABLE', 'CHARGER_REBOOTED', 'CONNECTOR_IDLE', 'MAX_DURATION'] as const
export type MotivoNaoConfirmada = (typeof MOTIVOS_NAO_CONFIRMADA)[number]

/** Prova da leitura final do medidor (espelha `MeterStopSource`). */
export const PROVAS_DE_LEITURA = ['STOP_TRANSACTION', 'LAST_METER_SAMPLE', 'NO_READING'] as const
export type ProvaDeLeitura = (typeof PROVAS_DE_LEITURA)[number]

/**
 * Snapshot da sessão. TODO instante aqui é relógio do SERVIDOR. Quem monta o snapshot (job do watchdog / DTO) é responsável por isso:
 * `lastSampleAt` e `startedAt` (relógio do carregador) NÃO entram, de propósito.
 */
export interface SessaoParaAvaliar {
  /** STOPPED (ou qualquer outro) => a função devolve NADA. */
  status: StatusSessao
  paymentMode: ModoPagamentoSessao
  /** `ChargingSession.createdAt` (now() do servidor): âncora da idade (R5) e fallback de `lastActivityAt` nulo. */
  createdAt: Date
  /**
   * Última atividade OCPP útil observada para a sessão. `null` em linha antiga => cai em `createdAt` (relógio do servidor; o
   * comentário do schema fala em `startedAt`, mas esse é o relógio do carregador — não serve).
   */
  lastActivityAt: Date | null
  /**
   * Quando o servidor recebeu o ÚLTIMO MeterValues desta transação (U1). Precisa ser separado de `lastActivityAt`: um
   * StatusNotification(Finishing) também move a atividade, e NÃO prova que o carregador "continua entregando".
   */
  lastMeterValuesAt: Date | null
  stopRequestedAt: Date | null
  /** Quantos RemoteStop já foram enviados (contando o primeiro). */
  stopAttempts: number
  /** Só em STOP_UNCONFIRMED (CHECK do banco). */
  unconfirmedAt: Date | null
  /** `PaymentIntent.authorizedAt` do hold do cartão desta sessão; `null` em WALLET ou sem pré-auth. */
  cardAuthorizedAt: Date | null
  /** O medidor continuou avançando depois do `stopRequestedAt`? (R3: carregador que desobedece — `session_stop_not_obeyed`). */
  energyAdvancedSinceStopRequest: boolean
}

export interface ConectorParaAvaliar {
  status: StatusConectorOcpp
  /**
   * Quando o SERVIDOR registrou o status atual (R2). Atenção: hoje `Connector.statusUpdatedAt` guarda o timestamp do PAYLOAD
   * (`data.timestamp ?? now`, statusNotification.ts) = relógio do carregador. Não passe esse campo aqui — use uma fonte do servidor
   * (ver o relatório da fase 9b0).
   */
  statusReceivedAt: Date | null
}

/** O que existe como prova de leitura final (consultado pelo job; só importa na hora de encerrar pelo servidor). */
export interface ProvasDeLeitura {
  /** Há um StopTransaction INBOUND desta transação no log bruto `OcppMessage` (mesmo que o handler tenha falhado)? */
  stopTransactionNoLog: boolean
  /** Há ao menos uma amostra `Energy.Active.Import.Register`? */
  ultimaAmostra: boolean
}

export interface EntradaAvaliacao {
  /** Relógio do servidor, injetado. A função NUNCA lê `Date.now()`. */
  agora: Date
  sessao: SessaoParaAvaliar
  /** `ChargePoint.lastSeenAt/disconnectedAt` (carimbados pelo servidor). */
  carregador: PresencaCarregador
  conector: ConectorParaAvaliar
  provas: ProvasDeLeitura
  /** Cooldown do R4 (vive no Redis): quando o último TriggerMessage(MeterValues) desta sessão foi enviado. */
  ultimoTriggerMeterValuesEm: Date | null
  config: ConfigWatchdogSessao
}

// ------------------------------------------------------------------------------------------------ tipos de saída

export type TipoAlertaSessao =
  | 'session_stop_unconfirmed'
  | 'session_closed_by_server'
  | 'session_max_duration_reached'
  | 'session_closed_without_meter_reading'
  | 'session_revived_after_unconfirmed'
  | 'session_stop_not_obeyed'
  | 'session_no_meter_values'
  | 'card_session_hold_deadline'
  // Os dois abaixo NÃO saem desta função (nascem nos handlers de StopTransaction/MeterValues depois de STOPPED); ficam no tipo
  // para a camada de log ter um vocabulário único.
  | 'session_metering_after_close'
  | 'session_late_stop_transaction'
  // ALTO-1 (Órion): o cálculo de custo lançou — a sessão NÃO é fechada de graça, fica para revisão manual.
  | 'session_cost_calculation_failed'
  // ALTO-2 (Órion): StopTransaction/MeterValues de um carregador com o transactionId de OUTRO carregador.
  | 'ocpp_foreign_transaction'

export type RegraSessao = 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R5_CARTAO' | 'R6' | 'U1' | 'U2' | 'NENHUMA'

/** Como cobrar ao encerrar pelo servidor. `NAO_COBRAR`/`TAXA_FIXA_E_MINIMO` só ocorrem com `prova = NO_READING` (decisão D2). */
export type CobrancaAoEncerrar = 'PELA_LEITURA' | 'NAO_COBRAR' | 'TAXA_FIXA_E_MINIMO'

interface DecisaoBase {
  /** Qual regra decidiu (log estruturado e testes). */
  regra: RegraSessao
  /** Alertas COMPLEMENTARES que o efeito deve emitir junto da ação (ex.: `session_stop_unconfirmed` ao marcar). Pode ser vazio. */
  alertasExtras: readonly TipoAlertaSessao[]
}

export type DecisaoSessao =
  | (DecisaoBase & { acao: 'NADA' })
  /** R6: reavaliar a guarda de saldo/teto do cartão com a última energia conhecida (o tempo/ociosidade cresce sem amostra). */
  | (DecisaoBase & { acao: 'REAVALIAR_GUARDA' })
  | (DecisaoBase & { acao: 'PEDIR_REMOTE_STOP'; solicitante: 'WATCHDOG'; tentativa: number })
  | (DecisaoBase & { acao: 'TENTAR_TRIGGER_MESSAGE'; mensagem: 'MeterValues' })
  | (DecisaoBase & { acao: 'MARCAR_NAO_CONFIRMADA'; motivo: MotivoNaoConfirmada })
  | (DecisaoBase & { acao: 'REANIMAR' })
  | (DecisaoBase & { acao: 'ENCERRAR_PELO_SERVIDOR'; prova: ProvaDeLeitura; cobranca: CobrancaAoEncerrar; forcadoPeloPrazoDoCartao: boolean })
  | (DecisaoBase & { acao: 'ALERTAR'; tipo: TipoAlertaSessao })

export type AcaoSessao = DecisaoSessao['acao']

// ------------------------------------------------------------------------------------------------ helpers

function soma(base: Date, ms: number): Date {
  return new Date(base.getTime() + ms)
}

/** Tempo decorrido em ms, nunca negativo (dois relógios de servidor/banco podem diferir por alguns ms). */
function decorrido(desde: Date, agora: Date): number {
  return Math.max(0, agora.getTime() - desde.getTime())
}

function nada(): DecisaoSessao {
  return { acao: 'NADA', regra: 'NENHUMA', alertasExtras: [] }
}

/** Instante-limite do hold do cartão (`authorizedAt + cardMaxHoldHours`); `null` quando não há cartão/pré-autorização. */
function prazoDoCartao(sessao: Pick<SessaoParaAvaliar, 'paymentMode' | 'cardAuthorizedAt'>, config: Pick<ConfigWatchdogSessao, 'cardMaxHoldHours'>): Date | null {
  if (sessao.paymentMode !== 'CARD' || !sessao.cardAuthorizedAt) return null
  return soma(sessao.cardAuthorizedAt, config.cardMaxHoldHours * HORA_MS)
}

/**
 * Desde quando o carregador está offline, pelo relógio do servidor: o fechamento do socket (`disconnectedAt`, se foi depois da
 * última mensagem) ou, num socket que ficou mudo sem fechar, a última mensagem (`lastSeenAt`). Sem nenhum sinal, conta desde a
 * criação da sessão. Só faz sentido quando `isChargePointOnline` é falso.
 */
function offlineDesde(carregador: PresencaCarregador, criadaEm: Date): Date {
  const { lastSeenAt, disconnectedAt } = carregador
  if (!lastSeenAt) return criadaEm
  if (disconnectedAt && disconnectedAt.getTime() >= lastSeenAt.getTime()) return disconnectedAt
  return lastSeenAt
}

function janelaDeConfirmacaoMs(online: boolean, config: Pick<ConfigWatchdogSessao, 'unconfirmedGraceOnlineMinutes' | 'unconfirmedGraceOfflineMinutes'>): number {
  return (online ? config.unconfirmedGraceOnlineMinutes : config.unconfirmedGraceOfflineMinutes) * MINUTO_MS
}

function exigirUnconfirmedAt(sessao: Pick<SessaoParaAvaliar, 'unconfirmedAt'>): Date {
  // O CHECK do banco (status STOP_UNCONFIRMED exige unconfirmedAt) torna isto impossível; se acontecer, é dado corrompido e o job
  // (try/catch por sessão) precisa VER o erro em vez de a função inventar uma data e encerrar uma sessão com dinheiro.
  if (!sessao.unconfirmedAt) throw new Error('sessão STOP_UNCONFIRMED sem unconfirmedAt: viola o CHECK do schema')
  return sessao.unconfirmedAt
}

// ------------------------------------------------------------------------------------------------ confirmDeadline

export interface EntradaConfirmDeadline {
  agora: Date
  sessao: Pick<SessaoParaAvaliar, 'paymentMode' | 'cardAuthorizedAt' | 'unconfirmedAt'>
  carregador: PresencaCarregador
  config: Pick<ConfigWatchdogSessao, 'unconfirmedGraceOnlineMinutes' | 'unconfirmedGraceOfflineMinutes' | 'cardMaxHoldHours'>
}

/**
 * Até quando o servidor espera o carregador numa sessão STOP_UNCONFIRMED: `min(unconfirmedAt + janela, prazo do cartão)`.
 * A janela é G1 (online agora) ou G2 (offline agora, decisão D1). É A MESMA conta de U2 — o DTO chama esta função na leitura
 * (campo `closure.confirmDeadline`) para o motorista ver exatamente o instante em que o watchdog vai agir. Muda com o estado do
 * carregador: se ele cair, o prazo estica para G2; se voltar, encolhe para G1.
 */
export function calcularConfirmDeadline(entrada: EntradaConfirmDeadline): Date {
  const { agora, sessao, carregador, config } = entrada
  const unconfirmedAt = exigirUnconfirmedAt(sessao)
  const online = isChargePointOnline(carregador, agora)
  const prazoJanela = soma(unconfirmedAt, janelaDeConfirmacaoMs(online, config))
  const prazoCartao = prazoDoCartao(sessao, config)
  return prazoCartao && prazoCartao.getTime() < prazoJanela.getTime() ? prazoCartao : prazoJanela
}

// ------------------------------------------------------------------------------------------------ função principal

/**
 * Decide o que fazer com UMA sessão num ciclo do watchdog. Ver o cabeçalho do arquivo para a ordem de precedência.
 * Sessão `STOPPED` (terminal) e qualquer status desconhecido => `NADA`.
 */
export function avaliarSessaoAberta(entrada: EntradaAvaliacao): DecisaoSessao {
  const { sessao } = entrada
  if (isSessaoNaoConfirmada(sessao.status)) return avaliarNaoConfirmada(entrada)
  if (isSessaoAberta(sessao.status)) return avaliarAberta(entrada)
  return nada()
}

function avaliarAberta(entrada: EntradaAvaliacao): DecisaoSessao {
  const { agora, sessao, carregador, conector, config } = entrada
  const online = isChargePointOnline(carregador, agora)
  const ultimaAtividade = sessao.lastActivityAt ?? sessao.createdAt
  const semAtividadeMs = decorrido(ultimaAtividade, agora)

  // 1. Prazo do hold do cartão: depois dele a pré-autorização pode expirar no emissor e o dinheiro some. Vence todas as outras regras.
  const prazoCartao = prazoDoCartao(sessao, config)
  if (prazoCartao && agora.getTime() >= prazoCartao.getTime()) {
    return { acao: 'MARCAR_NAO_CONFIRMADA', motivo: 'MAX_DURATION', regra: 'R5_CARTAO', alertasExtras: ['session_stop_unconfirmed', 'card_session_hold_deadline'] }
  }

  // 2. R1 — carregador sumiu (offline há >= X) E a sessão sem sinal há >= Y. Nenhum RemoteStop: ele não chegaria.
  if (!online) {
    const offlineMs = decorrido(offlineDesde(carregador, sessao.createdAt), agora)
    if (offlineMs >= config.chargerOfflineMinutes * MINUTO_MS && semAtividadeMs >= config.inactivityMinutes * MINUTO_MS) {
      return { acao: 'MARCAR_NAO_CONFIRMADA', motivo: 'CHARGER_UNREACHABLE', regra: 'R1', alertasExtras: ['session_stop_unconfirmed'] }
    }
  }

  // 3. R2 — o carregador (online) já liberou o conector DEPOIS de a sessão abrir: ele considera a transação encerrada.
  if (online && (conector.status === 'AVAILABLE' || conector.status === 'UNAVAILABLE') && conector.statusReceivedAt) {
    const depoisDeAbrir = conector.statusReceivedAt.getTime() > sessao.createdAt.getTime()
    if (depoisDeAbrir && decorrido(conector.statusReceivedAt, agora) >= config.connectorIdleMinutes * MINUTO_MS) {
      return { acao: 'MARCAR_NAO_CONFIRMADA', motivo: 'CONNECTOR_IDLE', regra: 'R2', alertasExtras: ['session_stop_unconfirmed'] }
    }
  }

  // 4. R5 — duração máxima: primeiro pede o RemoteStop; se ele não resultar em StopTransaction na janela, marca MAX_DURATION.
  const duracaoMaximaAtingida = decorrido(sessao.createdAt, agora) >= config.maxOpenHours * HORA_MS
  if (duracaoMaximaAtingida) {
    if (!sessao.stopRequestedAt) {
      return { acao: 'PEDIR_REMOTE_STOP', solicitante: 'WATCHDOG', tentativa: sessao.stopAttempts + 1, regra: 'R5', alertasExtras: ['session_max_duration_reached'] }
    }
    if (decorrido(sessao.stopRequestedAt, agora) >= config.stopConfirmMinutes * MINUTO_MS) {
      return { acao: 'MARCAR_NAO_CONFIRMADA', motivo: 'MAX_DURATION', regra: 'R5', alertasExtras: ['session_stop_unconfirmed', 'session_max_duration_reached'] }
    }
    // Já pediu e ainda está dentro da janela de confirmação: espera (R3 não se aplica: o motivo aqui é a duração).
  } else if (sessao.stopRequestedAt && decorrido(sessao.stopRequestedAt, agora) >= config.stopConfirmMinutes * MINUTO_MS) {
    // 5. R3 — RemoteStop aceito (ou em timeout) e nenhum StopTransaction depois da janela: reenvia até o teto, depois marca.
    const desobedece: readonly TipoAlertaSessao[] = sessao.energyAdvancedSinceStopRequest ? ['session_stop_not_obeyed'] : []
    if (sessao.stopAttempts < config.stopMaxAttempts) {
      return { acao: 'PEDIR_REMOTE_STOP', solicitante: 'WATCHDOG', tentativa: sessao.stopAttempts + 1, regra: 'R3', alertasExtras: desobedece }
    }
    return { acao: 'MARCAR_NAO_CONFIRMADA', motivo: 'STOP_NOT_CONFIRMED', regra: 'R3', alertasExtras: ['session_stop_unconfirmed', ...desobedece] }
  }

  // 6. R4 — online, conector CHARGING e sem MeterValues: NÃO é sessão travada (pode ser MeterValueSampleInterval=0). Só cutuca o carregador.
  if (online && conector.status === 'CHARGING' && semAtividadeMs >= config.inactivityMinutes * MINUTO_MS) {
    const cooldownVencido = !entrada.ultimoTriggerMeterValuesEm || decorrido(entrada.ultimoTriggerMeterValuesEm, agora) >= config.meterTriggerCooldownMinutes * MINUTO_MS
    if (cooldownVencido) {
      return { acao: 'TENTAR_TRIGGER_MESSAGE', mensagem: 'MeterValues', regra: 'R4', alertasExtras: ['session_no_meter_values'] }
    }
  }

  // 7. R6 — sem atividade há >= 1 ciclo: a guarda (saldo da carteira / teto do cartão) só rodava quando chegava MeterValues, mas a
  //    tarifa por tempo/ociosidade continua crescendo sem amostra. Reavalia com a última energia conhecida.
  if (semAtividadeMs >= config.watchdogIntervalMs) {
    return { acao: 'REAVALIAR_GUARDA', regra: 'R6', alertasExtras: [] }
  }

  return nada()
}

function avaliarNaoConfirmada(entrada: EntradaAvaliacao): DecisaoSessao {
  const { agora, sessao, carregador, provas, config } = entrada
  const unconfirmedAt = exigirUnconfirmedAt(sessao)
  const online = isChargePointOnline(carregador, agora)
  const prazoCartao = prazoDoCartao(sessao, config)
  const cartaoNoLimite = prazoCartao !== null && agora.getTime() >= prazoCartao.getTime()

  // U1 — o carregador voltou a mandar MeterValues DEPOIS de entrarmos em STOP_UNCONFIRMED: ele continua entregando. Reanima... a menos que
  // isso vire vai-e-vem: se já esgotamos os RemoteStop, se a duração máxima/o prazo do cartão já venceram, reanimar só faria a regra
  // R3/R5 marcar de novo no ciclo seguinte (alerta de erro a cada minuto). Nesses casos a sessão segue em confirmação, o alerta
  // `session_stop_not_obeyed` avisa o plantão e U2 encerra no fim da janela (com as amostras que chegaram até lá como prova).
  const entregandoDepois = sessao.lastMeterValuesAt !== null && sessao.lastMeterValuesAt.getTime() > unconfirmedAt.getTime()
  const reanimacaoBloqueada =
    sessao.stopAttempts >= config.stopMaxAttempts || decorrido(sessao.createdAt, agora) >= config.maxOpenHours * HORA_MS || cartaoNoLimite
  if (entregandoDepois && !reanimacaoBloqueada) {
    return { acao: 'REANIMAR', regra: 'U1', alertasExtras: ['session_revived_after_unconfirmed'] }
  }

  // U2 — fim da janela de confirmação (G1 online / G2 offline), limitada pelo prazo do cartão: encerra com a melhor prova.
  const prazoJanela = soma(unconfirmedAt, janelaDeConfirmacaoMs(online, config))
  const prazoEfetivo = prazoCartao && prazoCartao.getTime() < prazoJanela.getTime() ? prazoCartao : prazoJanela
  if (agora.getTime() >= prazoEfetivo.getTime()) {
    const prova: ProvaDeLeitura = provas.stopTransactionNoLog ? 'STOP_TRANSACTION' : provas.ultimaAmostra ? 'LAST_METER_SAMPLE' : 'NO_READING'
    const cobranca: CobrancaAoEncerrar = prova !== 'NO_READING' ? 'PELA_LEITURA' : config.noReadingPolicy === 'MIN_FEE' ? 'TAXA_FIXA_E_MINIMO' : 'NAO_COBRAR'
    const alertas: TipoAlertaSessao[] = ['session_closed_by_server']
    if (prova === 'NO_READING') alertas.push('session_closed_without_meter_reading')
    if (cartaoNoLimite) alertas.push('card_session_hold_deadline')
    return {
      acao: 'ENCERRAR_PELO_SERVIDOR',
      prova,
      cobranca,
      forcadoPeloPrazoDoCartao: prazoCartao !== null && prazoCartao.getTime() < prazoJanela.getTime(),
      regra: 'U2',
      alertasExtras: alertas,
    }
  }

  if (entregandoDepois) return { acao: 'ALERTAR', tipo: 'session_stop_not_obeyed', regra: 'U1', alertasExtras: [] }
  return nada()
}
