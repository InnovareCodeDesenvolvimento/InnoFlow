/**
 * Dossiê de defesa de um chargeback (L1.8) — um SNAPSHOT montado NO MOMENTO do registro e gravado na própria linha (`PaymentReversal.dossierSnapshot`, imutável):
 * a partição de medição que o N-11 apaga depois, e a janela de 3 meses da consulta Cielo, não o alcançam. Puro: sem Prisma/relógio/rede.
 *
 * LGPD (decisão do plano, "só o necessário"): o dossiê NÃO leva nome, e-mail, CPF, telefone, `idTag` nem token de cartão. O pagador é só o id interno (pseudônimo).
 * A origem do início da sessão leva o IP MASCARADO (/24 no IPv4, /48 no IPv6 — mostra "mesma rede/região" sem identificar a casa) e o User-Agent truncado.
 * A montagem é por LISTA EXPLÍCITA de campos (allowlist): um campo novo no banco nunca entra aqui por acidente.
 */

export const VERSAO_DO_DOSSIE = 1

/** Teto do JSON (o CHECK do banco é 4 MiB; guardamos folga para o resto da linha). */
export const DOSSIE_TAMANHO_MAXIMO_BYTES = 3 * 1024 * 1024
const PONTOS_POR_SERIE = 240
const USER_AGENT_MAX = 120

export interface PontoDeMedicao {
  ts: Date
  measurand: string
  value: number
  unit: string | null
}

export interface EventoOcpp {
  occurredAt: Date
  direction: 'INBOUND' | 'OUTBOUND'
  messageType: 'CALL' | 'CALL_RESULT' | 'CALL_ERROR'
  action: string | null
  /** Só campos de protocolo já reduzidos (meterStart, meterStop, reason, status, connectorId...). NUNCA o payload inteiro. */
  resumo: Record<string, string | number | null>
}

export interface EntradaDossie {
  geradoEm: Date
  chargeback: { id?: string; caseReference: string; reasonCode: string | null; notifiedAt: Date; responseDeadline: Date | null; amountCents: number }
  venda: {
    paymentIntentId: string
    environment: string
    status: string
    returnCode: string | null
    amountRequestedCents: number
    amountAuthorizedCents: number | null
    amountCapturedCents: number | null
    authorizedAt: Date | null
    capturedAt: Date | null
    cieloPaymentId: string | null
    tid: string | null
    authorizationCode: string | null
    proofOfSale: string | null
  }
  cartao: { brand: string | null; last4: string | null; expiryMonth: number | null; expiryYear: number | null; cadastradoEm: Date } | null
  pagador: { id: string; contaCriadaEm: Date; identidadeVerificada: boolean; aceites: Array<{ kind: string; version: string; acceptedAt: Date; source: string }> }
  sessao: {
    id: string
    ocppTransactionId: number
    status: string
    paymentMode: string
    startedAt: Date
    chargingEndedAt: Date | null
    stoppedAt: Date | null
    stopReason: string | null
    meterStartWh: number
    meterStopWh: number | null
    energyDeliveredWh: number | null
    idleSeconds: number | null
    energyCostCents: number | null
    timeCostCents: number | null
    idleFeeCents: number | null
    sessionFeeCents: number | null
    minChargeAdjustmentCents: number | null
    totalCostCents: number | null
    tariffSnapshot: unknown
    origem: { startIp: string | null; startUserAgent: string | null }
  }
  local: { siteName: string; city: string; timezone: string; chargePointIdentity: string; vendor: string | null; model: string | null; connectorNumber: number; connectorType: string }
  medicoes: PontoDeMedicao[]
  totalDeMedicoes: number
  trilhaOcpp: EventoOcpp[]
}

/** `a.b.c.d` -> `a.b.c.0/24`; IPv6 -> 3 primeiros grupos `/48`; ausente/ilegível -> `null`. */
export function mascararIpDoDossie(ip: string | null | undefined): string | null {
  if (!ip) return null
  const v4 = ip.replace(/^::ffff:/i, '')
  const m = /^([0-9]{1,3})[.]([0-9]{1,3})[.]([0-9]{1,3})[.][0-9]{1,3}$/.exec(v4)
  if (m) return `${m[1]}.${m[2]}.${m[3]}.0/24`
  if (v4.includes(':')) return `${v4.split(':').slice(0, 3).join(':')}::/48`
  return null
}

/** Reduz uma série ordenada a no máximo `max` pontos, igualmente espaçados, SEMPRE mantendo o primeiro e o último (início e fim da curva são a prova). */
export function amostrarSerie<T>(serie: readonly T[], max: number): T[] {
  if (serie.length <= max) return [...serie]
  if (max <= 1) return serie.length > 0 ? [serie[0]] : []
  const saida: T[] = []
  const passo = (serie.length - 1) / (max - 1)
  let ultimo = -1
  for (let i = 0; i < max; i++) {
    const idx = Math.round(i * passo)
    if (idx !== ultimo) saida.push(serie[idx])
    ultimo = idx
  }
  return saida
}

function nomeDaSerie(measurand: string): 'energia' | 'potencia' | 'soc' | null {
  if (measurand === 'Energy.Active.Import.Register') return 'energia'
  if (measurand === 'Power.Active.Import') return 'potencia'
  if (measurand === 'SoC') return 'soc'
  return null
}

function montarCurva(medicoes: readonly PontoDeMedicao[], pontosPorSerie: number) {
  const series: Record<'energia' | 'potencia' | 'soc', PontoDeMedicao[]> = { energia: [], potencia: [], soc: [] }
  for (const p of medicoes) {
    const nome = nomeDaSerie(p.measurand)
    if (nome) series[nome].push(p)
  }
  const saida: Record<string, { measurand: string; unit: string | null; totalDePontos: number; pontos: Array<[string, number]> }> = {}
  for (const nome of ['energia', 'potencia', 'soc'] as const) {
    const ordenada = [...series[nome]].sort((a, b) => a.ts.getTime() - b.ts.getTime())
    if (ordenada.length === 0) continue
    saida[nome] = {
      measurand: ordenada[0].measurand,
      unit: ordenada[0].unit,
      totalDePontos: ordenada.length,
      pontos: amostrarSerie(ordenada, pontosPorSerie).map((p) => [p.ts.toISOString(), p.value] as [string, number]),
    }
  }
  return saida
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null)

function montarUmaVez(e: EntradaDossie, pontosPorSerie: number, incluirTrilha: boolean): Record<string, unknown> {
  return {
    versaoDoDossie: VERSAO_DO_DOSSIE,
    geradoEm: e.geradoEm.toISOString(),
    chargeback: {
      caseReference: e.chargeback.caseReference,
      reasonCode: e.chargeback.reasonCode,
      notifiedAt: e.chargeback.notifiedAt.toISOString(),
      responseDeadline: iso(e.chargeback.responseDeadline),
      amountCents: e.chargeback.amountCents,
    },
    venda: {
      paymentIntentId: e.venda.paymentIntentId,
      environment: e.venda.environment,
      status: e.venda.status,
      returnCode: e.venda.returnCode,
      amountRequestedCents: e.venda.amountRequestedCents,
      amountAuthorizedCents: e.venda.amountAuthorizedCents,
      amountCapturedCents: e.venda.amountCapturedCents,
      authorizedAt: iso(e.venda.authorizedAt),
      capturedAt: iso(e.venda.capturedAt),
      adquirente: { paymentId: e.venda.cieloPaymentId, tid: e.venda.tid, authorizationCode: e.venda.authorizationCode, proofOfSale: e.venda.proofOfSale },
    },
    cartao: e.cartao ? { brand: e.cartao.brand, last4: e.cartao.last4, expiryMonth: e.cartao.expiryMonth, expiryYear: e.cartao.expiryYear, cadastradoEm: e.cartao.cadastradoEm.toISOString() } : null,
    pagador: {
      id: e.pagador.id,
      contaCriadaEm: e.pagador.contaCriadaEm.toISOString(),
      idadeDaContaDias: Math.max(0, Math.floor((e.sessao.startedAt.getTime() - e.pagador.contaCriadaEm.getTime()) / 86_400_000)),
      identidadeVerificada: e.pagador.identidadeVerificada,
      aceites: e.pagador.aceites.map((a) => ({ kind: a.kind, version: a.version, acceptedAt: a.acceptedAt.toISOString(), source: a.source })),
    },
    sessao: {
      id: e.sessao.id,
      ocppTransactionId: e.sessao.ocppTransactionId,
      status: e.sessao.status,
      paymentMode: e.sessao.paymentMode,
      startedAt: e.sessao.startedAt.toISOString(),
      chargingEndedAt: iso(e.sessao.chargingEndedAt),
      stoppedAt: iso(e.sessao.stoppedAt),
      stopReason: e.sessao.stopReason,
      meterStartWh: e.sessao.meterStartWh,
      meterStopWh: e.sessao.meterStopWh,
      energyDeliveredWh: e.sessao.energyDeliveredWh,
      idleSeconds: e.sessao.idleSeconds,
      custo: {
        energyCostCents: e.sessao.energyCostCents,
        timeCostCents: e.sessao.timeCostCents,
        idleFeeCents: e.sessao.idleFeeCents,
        sessionFeeCents: e.sessao.sessionFeeCents,
        minChargeAdjustmentCents: e.sessao.minChargeAdjustmentCents,
        totalCostCents: e.sessao.totalCostCents,
      },
      tarifa: e.sessao.tariffSnapshot,
      // Origem do início pelo app (prova de que foi o app do titular da conta). IP MASCARADO; só sessões iniciadas pelo app têm.
      origemDoInicio: { ipMascarado: mascararIpDoDossie(e.sessao.origem.startIp), userAgent: e.sessao.origem.startUserAgent ? e.sessao.origem.startUserAgent.slice(0, USER_AGENT_MAX) : null },
    },
    local: {
      site: e.local.siteName,
      cidade: e.local.city,
      timezone: e.local.timezone,
      carregador: e.local.chargePointIdentity,
      fabricante: e.local.vendor,
      modelo: e.local.model,
      conector: { numero: e.local.connectorNumber, tipo: e.local.connectorType },
    },
    curvaDeMedicao: { totalDeAmostrasLidas: e.totalDeMedicoes, series: montarCurva(e.medicoes, pontosPorSerie) },
    trilhaOcpp: incluirTrilha
      ? e.trilhaOcpp.map((ev) => ({ t: ev.occurredAt.toISOString(), direcao: ev.direction, tipo: ev.messageType, acao: ev.action, resumo: ev.resumo }))
      : [],
  }
}

export function tamanhoEmBytes(valor: unknown): number {
  return Buffer.byteLength(JSON.stringify(valor), 'utf8')
}

/**
 * Monta o dossiê e GARANTE o teto de tamanho: se passar, reamostra a curva com cada vez menos pontos e, no limite, descarta a trilha OCPP. Nunca lança por tamanho
 * (um chargeback com prazo correndo precisa ser registrado) — o que foi cortado fica dito em `reducoesAplicadas`.
 */
export function montarDossie(entrada: EntradaDossie, maxBytes: number = DOSSIE_TAMANHO_MAXIMO_BYTES): Record<string, unknown> {
  let pontos = PONTOS_POR_SERIE
  let dossie = montarUmaVez(entrada, pontos, true)
  const reducoes: string[] = []
  while (tamanhoEmBytes(dossie) > maxBytes && pontos > 2) {
    pontos = Math.max(2, Math.floor(pontos / 2))
    reducoes.push(`curva_reamostrada_${pontos}_pontos`)
    dossie = montarUmaVez(entrada, pontos, true)
  }
  if (tamanhoEmBytes(dossie) > maxBytes) {
    reducoes.push('trilha_ocpp_descartada')
    dossie = montarUmaVez(entrada, pontos, false)
  }
  if (reducoes.length > 0) dossie.reducoesAplicadas = reducoes
  return dossie
}
