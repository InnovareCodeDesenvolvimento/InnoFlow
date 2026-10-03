/**
 * Escolha PURA da leitura final do medidor quando o SERVIDOR encerra uma sessão sem StopTransaction processado (F5.9, 9b1).
 * Sem Prisma/Redis/relógio: quem chama passa o que achou no banco e recebe a prova escolhida.
 *
 * Ordem de prova (desenho da Nova, §1): 1. StopTransaction INBOUND no log bruto `OcppMessage` (o carregador DISSE a leitura;
 * vale mesmo que o handler tenha falhado); 2. última amostra `Energy.Active.Import.Register` (`LAST_METER_SAMPLE`);
 * 3. nenhuma leitura (`NO_READING`). NUNCA se estima energia por potência x tempo.
 *
 * Relógio: a COBRANÇA usa o relógio do CARREGADOR — o instante final é o do payload do Stop / o `ts` da amostra; sem nenhuma
 * leitura, `startedAt` (também do carregador). O relógio do servidor não entra aqui.
 *
 * ALTO-1 (Órion): o instante final é `max(instante da prova, chargingEndedAt, startedAt)`. O carro pode ter terminado de carregar DEPOIS da última
 * amostra (`chargingEndedAt > ts`), e um Stop com o RTC resetado pode vir ANTES do início; com os instantes fora de ordem `calcularCustoSessao` lançava e a
 * sessão fechava de graça. Isto só garante a ordem — não inventa energia (a leitura do medidor segue sendo a prova).
 */
import type { ProvaDeLeitura, PoliticaSemLeitura } from './avaliarSessaoAberta'

export interface LeituraStopNoLog {
  meterStopWh: number
  /** `timestamp` do payload do StopTransaction (relógio do carregador). */
  timestamp: Date
  /** `reason` do payload em PascalCase do protocolo (ex.: `PowerLoss`), ou `null`. O serviço mapeia para o enum. */
  reason: string | null
}

export interface LeituraAmostra {
  meterWh: number
  /** `MeterSample.ts` (relógio do carregador). */
  timestamp: Date
}

export interface EntradaEscolherLeituraFinal {
  stopNoLog: LeituraStopNoLog | null
  ultimaAmostra: LeituraAmostra | null
  meterStartWh: number
  /** `ChargingSession.startedAt` (relógio do carregador). */
  startedAt: Date
  /** `ChargingSession.chargingEndedAt` (relógio do carregador): início da janela de ociosidade, se já aberta. */
  chargingEndedAt?: Date | null
}

export interface LeituraFinal {
  prova: ProvaDeLeitura
  meterStopWh: number
  timestamp: Date
  /** Só preenchido quando a prova é o Stop do log. */
  reason: string | null
}

function instanteFinal(prova: Date, startedAt: Date, chargingEndedAt: Date | null | undefined): Date {
  const t = Math.max(prova.getTime(), startedAt.getTime(), chargingEndedAt?.getTime() ?? Number.NEGATIVE_INFINITY)
  return t === prova.getTime() ? prova : new Date(t)
}

export function escolherLeituraFinal(entrada: EntradaEscolherLeituraFinal): LeituraFinal {
  const { stopNoLog, ultimaAmostra, meterStartWh, startedAt, chargingEndedAt } = entrada
  if (stopNoLog) return { prova: 'STOP_TRANSACTION', meterStopWh: stopNoLog.meterStopWh, timestamp: instanteFinal(stopNoLog.timestamp, startedAt, chargingEndedAt), reason: stopNoLog.reason }
  if (ultimaAmostra) return { prova: 'LAST_METER_SAMPLE', meterStopWh: Math.round(ultimaAmostra.meterWh), timestamp: instanteFinal(ultimaAmostra.timestamp, startedAt, chargingEndedAt), reason: null }
  // Sem nenhuma leitura: energia entregue = 0 (meterStop = meterStart) e horário = início. A decisão de cobrar ou não é da política D2.
  return { prova: 'NO_READING', meterStopWh: meterStartWh, timestamp: instanteFinal(startedAt, startedAt, chargingEndedAt), reason: null }
}

/**
 * Política D2 do dono: com `NO_READING` e `NO_CHARGE` o custo é ZERO (nem taxa fixa nem mínimo — "não cobra, alerta e revisão manual");
 * com `MIN_FEE` volta ao comportamento antigo (`calcularCustoSessao` com energia 0, que ainda cobra taxa fixa/mínimo).
 * Qualquer prova com leitura real é cobrada pela fórmula normal, em qualquer política.
 */
export function deveZerarCusto(prova: ProvaDeLeitura, politica: PoliticaSemLeitura): boolean {
  return prova === 'NO_READING' && politica === 'NO_CHARGE'
}
