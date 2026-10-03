import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  avaliarSessaoAberta,
  calcularConfirmDeadline,
  CONFIG_WATCHDOG_PADRAO,
  MOTIVOS_NAO_CONFIRMADA,
  PROVAS_DE_LEITURA,
  STATUS_CONECTOR_OCPP,
  type ConfigWatchdogSessao,
  type DecisaoSessao,
  type EntradaAvaliacao,
} from '../../src/core/sessao/avaliarSessaoAberta'
import {
  ESTADOS_SESSAO_ABERTA,
  ESTADOS_SESSAO_VIGIADA,
  isSessaoAberta,
  isSessaoNaoConfirmada,
  isSessaoVigiada,
  listarEstadosSessaoAberta,
  listarEstadosSessaoVigiada,
  type StatusSessao,
} from '../../src/core/sessao/estadosSessao'

/**
 * F5.9b0 — MATRIZ da decisão do watchdog (`avaliarSessaoAberta`). Cada limite de tempo é testado no limite exato (>= dispara), 1 ms antes,
 * 1 minuto antes e 1 minuto depois. `agora` é injetado: nenhum teste depende do relógio da máquina.
 */

const AGORA = new Date('2026-10-03T12:00:00.000Z')
const MIN = 60_000
const HORA = 3_600_000
const antes = (ms: number, de: Date = AGORA) => new Date(de.getTime() - ms)

type Parcial<T> = { [K in keyof T]?: T[K] }
interface Sobrescrita {
  agora?: Date
  sessao?: Parcial<EntradaAvaliacao['sessao']>
  carregador?: Parcial<EntradaAvaliacao['carregador']>
  conector?: Parcial<EntradaAvaliacao['conector']>
  provas?: Parcial<EntradaAvaliacao['provas']>
  ultimoTriggerMeterValuesEm?: Date | null
  config?: Parcial<ConfigWatchdogSessao>
}

/** Sessão SAUDÁVEL: aberta há 30 min, carregador online, conector Charging, atividade há 10 s. Sem sobrescrita => NADA. */
function entrada(o: Sobrescrita = {}): EntradaAvaliacao {
  const agora = o.agora ?? AGORA
  const createdAt = antes(30 * MIN, agora)
  return {
    agora,
    sessao: {
      status: 'CHARGING',
      paymentMode: 'WALLET',
      createdAt,
      lastActivityAt: antes(10_000, agora),
      lastMeterValuesAt: antes(10_000, agora),
      stopRequestedAt: null,
      stopAttempts: 0,
      unconfirmedAt: null,
      cardAuthorizedAt: null,
      energyAdvancedSinceStopRequest: false,
      ...o.sessao,
    },
    carregador: { lastSeenAt: antes(10_000, agora), disconnectedAt: null, ...o.carregador },
    conector: { status: 'CHARGING', statusReceivedAt: new Date(createdAt.getTime() + 1000), ...o.conector },
    provas: { stopTransactionNoLog: false, ultimaAmostra: false, ...o.provas },
    ultimoTriggerMeterValuesEm: o.ultimoTriggerMeterValuesEm ?? null,
    config: { ...CONFIG_WATCHDOG_PADRAO, ...o.config },
  }
}

/** Carregador offline desde `ha` ms atrás: socket fechado (`disconnectedAt`) depois da última mensagem. */
const offlineHa = (ha: number, agora: Date = AGORA) => ({ lastSeenAt: antes(ha + 1000, agora), disconnectedAt: antes(ha, agora) })

/** Sessão em STOP_UNCONFIRMED desde `ha` ms atrás, sem MeterValues depois, carregador online por padrão. */
function naoConfirmada(ha: number, o: Sobrescrita = {}): EntradaAvaliacao {
  const agora = o.agora ?? AGORA
  return entrada({
    ...o,
    sessao: {
      status: 'STOP_UNCONFIRMED',
      unconfirmedAt: antes(ha, agora),
      lastMeterValuesAt: antes(ha + MIN, agora), // última amostra ANTES de virar não confirmada
      lastActivityAt: antes(ha + MIN, agora),
      ...o.sessao,
    },
  })
}

const e = (d: DecisaoSessao) => d.acao
const marcou = (motivo: string) => (d: DecisaoSessao) => d.acao === 'MARCAR_NAO_CONFIRMADA' && d.motivo === motivo

/**
 * Para um limite `limiteMs` testa: 1 min antes (não), 1 ms antes (não), exatamente no limite (SIM, >=) e 1 min depois (SIM).
 * `monta(valorMs)` constrói a entrada em que o valor medido vale `valorMs`.
 */
function fronteira(nome: string, limiteMs: number, monta: (valorMs: number) => EntradaAvaliacao, dispara: (d: DecisaoSessao) => boolean): void {
  describe(nome, () => {
    it('1 minuto antes do limite: NÃO dispara', () => expect(dispara(avaliarSessaoAberta(monta(limiteMs - MIN)))).toBe(false))
    it('1 ms antes do limite: NÃO dispara', () => expect(dispara(avaliarSessaoAberta(monta(limiteMs - 1)))).toBe(false))
    it('exatamente no limite: dispara (>=)', () => expect(dispara(avaliarSessaoAberta(monta(limiteMs)))).toBe(true))
    it('1 minuto depois do limite: dispara', () => expect(dispara(avaliarSessaoAberta(monta(limiteMs + MIN)))).toBe(true))
  })
}

// ----------------------------------------------------------------------------------------------------------------------------------
describe('estadosSessao — constante única de "aberta"', () => {
  it('aberta = STARTED, CHARGING, FINISHING, FAULTED (FAULTED era o beco sem saída das 5 listas antigas)', () => {
    expect([...ESTADOS_SESSAO_ABERTA]).toEqual(['STARTED', 'CHARGING', 'FINISHING', 'FAULTED'])
    for (const s of ESTADOS_SESSAO_ABERTA) expect(isSessaoAberta(s)).toBe(true)
  })

  it('STOP_UNCONFIRMED NÃO é aberta, mas É vigiada; STOPPED não é nenhuma das duas', () => {
    expect(isSessaoAberta('STOP_UNCONFIRMED')).toBe(false)
    expect(isSessaoNaoConfirmada('STOP_UNCONFIRMED')).toBe(true)
    expect(isSessaoVigiada('STOP_UNCONFIRMED')).toBe(true)
    expect(isSessaoAberta('STOPPED')).toBe(false)
    expect(isSessaoVigiada('STOPPED')).toBe(false)
    expect(isSessaoVigiada('qualquer-coisa')).toBe(false)
    expect([...ESTADOS_SESSAO_VIGIADA]).toEqual(['STARTED', 'CHARGING', 'FINISHING', 'FAULTED', 'STOP_UNCONFIRMED'])
  })

  it('as listas para filtro Prisma são CÓPIAS: mutar uma não corrompe a constante', () => {
    const lista = listarEstadosSessaoAberta()
    lista.push('STARTED')
    lista.length = 0
    expect([...ESTADOS_SESSAO_ABERTA]).toHaveLength(4)
    expect(listarEstadosSessaoAberta()).toEqual(['STARTED', 'CHARGING', 'FINISHING', 'FAULTED'])
    expect(listarEstadosSessaoVigiada()).toHaveLength(5)
  })
})

describe('espelho do schema Prisma — os tipos literais do core não podem derivar dos enums', () => {
  const schema = readFileSync(join(__dirname, '../../prisma/schema.prisma'), 'utf8')
  const valoresDoEnum = (nome: string, texto: string = schema): string[] => {
    // Aceita CRLF: o checkout do Windows (core.autocrlf) quebrava a leitura do schema com LF puro.
    const m = texto.match(new RegExp(`enum ${nome} \\{([\\s\\S]*?)\\r?\\n\\}`))
    if (!m) throw new Error(`enum ${nome} não achado no schema`)
    return m[1]
      .split(/\r?\n/)
      .map((l) => l.replace(/\/\/.*$/, '').trim())
      .filter((l) => /^[A-Z_]+$/.test(l))
  }

  it('o parser aceita o schema com fim de linha CRLF (checkout do Windows) — mesmo resultado do LF', () => {
    const crlfSchema = schema.replace(/\r?\n/g, '\r\n')
    expect(crlfSchema).toContain('\r\n')
    for (const nome of ['ChargingSessionStatus', 'ConnectorStatus', 'StopUnconfirmedReason', 'MeterStopSource']) {
      expect(valoresDoEnum(nome, crlfSchema)).toEqual(valoresDoEnum(nome, schema.replace(/\r\n/g, '\n')))
    }
  })

  it('ChargingSessionStatus = abertas + STOP_UNCONFIRMED + STOPPED', () => {
    const esperado: StatusSessao[] = [...ESTADOS_SESSAO_ABERTA, 'STOP_UNCONFIRMED', 'STOPPED']
    expect([...valoresDoEnum('ChargingSessionStatus')].sort()).toEqual([...esperado].sort())
  })
  it('ConnectorStatus', () => expect([...valoresDoEnum('ConnectorStatus')].sort()).toEqual([...STATUS_CONECTOR_OCPP].sort()))
  it('StopUnconfirmedReason', () => expect([...valoresDoEnum('StopUnconfirmedReason')].sort()).toEqual([...MOTIVOS_NAO_CONFIRMADA].sort()))
  it('MeterStopSource', () => expect([...valoresDoEnum('MeterStopSource')].sort()).toEqual([...PROVAS_DE_LEITURA].sort()))
})

// ----------------------------------------------------------------------------------------------------------------------------------
describe('linha de base e pureza', () => {
  it('sessão saudável => NADA, em qualquer estado aberto', () => {
    for (const status of ESTADOS_SESSAO_ABERTA) {
      expect(avaliarSessaoAberta(entrada({ sessao: { status } }))).toMatchObject({ acao: 'NADA', regra: 'NENHUMA', alertasExtras: [] })
    }
  })

  it('STOPPED (terminal) => NADA, mesmo com tudo vencido', () => {
    const vencida = entrada({ sessao: { status: 'STOPPED', createdAt: antes(100 * HORA), lastActivityAt: antes(99 * HORA) }, carregador: offlineHa(50 * HORA) })
    expect(e(avaliarSessaoAberta(vencida))).toBe('NADA')
  })

  it('não muta a entrada e é determinística', () => {
    const ent = entrada({ carregador: offlineHa(20 * MIN), sessao: { lastActivityAt: antes(20 * MIN) } })
    const congelar = <T extends object>(o: T): T => {
      Object.freeze(o)
      for (const v of Object.values(o)) if (v && typeof v === 'object' && !(v instanceof Date)) congelar(v)
      return o
    }
    congelar(ent)
    const a = avaliarSessaoAberta(ent)
    const b = avaliarSessaoAberta(ent)
    expect(a).toEqual(b)
    expect(a.acao).toBe('MARCAR_NAO_CONFIRMADA')
  })

  it('RELÓGIOS: campos do relógio do carregador (startedAt, lastSampleAt) presentes no objeto NÃO influenciam nenhuma decisão', () => {
    const casos: EntradaAvaliacao[] = [
      entrada(),
      entrada({ carregador: offlineHa(20 * MIN), sessao: { lastActivityAt: antes(20 * MIN) } }),
      entrada({ sessao: { lastActivityAt: antes(20 * MIN) } }),
      naoConfirmada(11 * MIN),
    ]
    for (const c of casos) {
      const sujo = { ...c, sessao: { ...c.sessao, startedAt: new Date('1999-01-01'), lastSampleAt: new Date('2099-01-01') } } as unknown as EntradaAvaliacao
      expect(avaliarSessaoAberta(sujo)).toEqual(avaliarSessaoAberta(c))
    }
  })

  it('lastActivityAt nulo (linha antiga) cai em createdAt, que é relógio do servidor', () => {
    // 30 min sem sinal contados desde createdAt; carregador offline => R1 dispara, sem exigir lastActivityAt
    const d = avaliarSessaoAberta(entrada({ sessao: { lastActivityAt: null }, carregador: offlineHa(11 * MIN) }))
    expect(marcou('CHARGER_UNREACHABLE')(d)).toBe(true)
  })

  it('... e a âncora do fallback é createdAt, não o epoch: sessão criada há 5 min, sem lastActivityAt e com o carregador offline há 11 min NÃO é R1', () => {
    const d = avaliarSessaoAberta(entrada({ sessao: { createdAt: antes(5 * MIN), lastActivityAt: null }, carregador: offlineHa(11 * MIN), conector: { statusReceivedAt: antes(5 * MIN - 1000) } }))
    expect(marcou('CHARGER_UNREACHABLE')(d)).toBe(false)
  })
})

// ----------------------------------------------------------------------------------------------------------------------------------
describe('R1— carregador offline há >= 10 min E sessão sem atividade há >= 15 min', () => {
  fronteira('eixo "offline há"', 10 * MIN, (ms) => entrada({ carregador: offlineHa(ms), sessao: { lastActivityAt: antes(20 * MIN) } }), marcou('CHARGER_UNREACHABLE'))
  fronteira('eixo "sem atividade há"', 15 * MIN, (ms) => entrada({ carregador: offlineHa(30 * MIN), sessao: { lastActivityAt: antes(ms) } }), marcou('CHARGER_UNREACHABLE'))

  it('decisão completa: motivo, regra e alerta', () => {
    expect(avaliarSessaoAberta(entrada({ carregador: offlineHa(10 * MIN), sessao: { lastActivityAt: antes(15 * MIN) } }))).toEqual({
      acao: 'MARCAR_NAO_CONFIRMADA',
      motivo: 'CHARGER_UNREACHABLE',
      regra: 'R1',
      alertasExtras: ['session_stop_unconfirmed'],
    })
  })

  it('socket que ficou MUDO sem fechar: o "offline há" conta desde lastSeenAt (a última prova de vida)', () => {
    const mudo = (ms: number) => entrada({ carregador: { lastSeenAt: antes(ms), disconnectedAt: null }, sessao: { lastActivityAt: antes(ms) } })
    expect(marcou('CHARGER_UNREACHABLE')(avaliarSessaoAberta(mudo(10 * MIN - 1)))).toBe(false)
    expect(marcou('CHARGER_UNREACHABLE')(avaliarSessaoAberta(mudo(15 * MIN)))).toBe(true)
  })

  it('carregador que fechou e RECONECTOU (lastSeenAt depois de disconnectedAt) está online: R1 não se aplica por mais velha que seja a queda', () => {
    const d = avaliarSessaoAberta(entrada({ carregador: { lastSeenAt: antes(5_000), disconnectedAt: antes(2 * HORA) }, sessao: { lastActivityAt: antes(20 * MIN) } }))
    expect(marcou('CHARGER_UNREACHABLE')(d)).toBe(false)
  })

  it('offline mas COM atividade recente (< 15 min): não fecha, só reavalia a guarda se passou de 1 ciclo', () => {
    const d = avaliarSessaoAberta(entrada({ carregador: offlineHa(30 * MIN), sessao: { lastActivityAt: antes(5 * MIN) } }))
    expect(e(d)).toBe('REAVALIAR_GUARDA')
  })

  it('carregador ONLINE com 20 min de silêncio e conector fora de Charging: R1 não se aplica (online)', () => {
    const d = avaliarSessaoAberta(entrada({ conector: { status: 'SUSPENDED_EV' }, sessao: { lastActivityAt: antes(20 * MIN) } }))
    expect(marcou('CHARGER_UNREACHABLE')(d)).toBe(false)
  })

  it('sem lastSeenAt nenhum: conta offline desde a criação da sessão (30 min => dispara)', () => {
    const d = avaliarSessaoAberta(entrada({ carregador: { lastSeenAt: null, disconnectedAt: null }, sessao: { lastActivityAt: antes(20 * MIN) } }))
    expect(marcou('CHARGER_UNREACHABLE')(d)).toBe(true)
  })

  it('vale para os 4 estados abertos, inclusive FAULTED', () => {
    for (const status of ESTADOS_SESSAO_ABERTA) {
      const d = avaliarSessaoAberta(entrada({ sessao: { status, lastActivityAt: antes(20 * MIN) }, carregador: offlineHa(20 * MIN) }))
      expect(marcou('CHARGER_UNREACHABLE')(d)).toBe(true)
    }
  })

  it('nunca pede RemoteStop a um carregador offline', () => {
    const d = avaliarSessaoAberta(entrada({ carregador: offlineHa(20 * MIN), sessao: { lastActivityAt: antes(20 * MIN), stopRequestedAt: antes(10 * MIN), stopAttempts: 1 } }))
    expect(e(d)).toBe('MARCAR_NAO_CONFIRMADA')
  })
})

// ----------------------------------------------------------------------------------------------------------------------------------
describe('R2 — conector online voltou a AVAILABLE/UNAVAILABLE depois de a sessão abrir, há >= 5 min', () => {
  for (const status of ['AVAILABLE', 'UNAVAILABLE'] as const) {
    fronteira(`conector ${status}`, 5 * MIN, (ms) => entrada({ conector: { status, statusReceivedAt: antes(ms) } }), marcou('CONNECTOR_IDLE'))
  }

  it('decisão completa', () => {
    expect(avaliarSessaoAberta(entrada({ conector: { status: 'AVAILABLE', statusReceivedAt: antes(5 * MIN) } }))).toEqual({
      acao: 'MARCAR_NAO_CONFIRMADA',
      motivo: 'CONNECTOR_IDLE',
      regra: 'R2',
      alertasExtras: ['session_stop_unconfirmed'],
    })
  })

  it('status recebido ANTES (ou no mesmo instante de) createdAt não prova nada: é de antes da sessão', () => {
    const createdAt = antes(30 * MIN)
    expect(marcou('CONNECTOR_IDLE')(avaliarSessaoAberta(entrada({ sessao: { createdAt }, conector: { status: 'AVAILABLE', statusReceivedAt: antes(31 * MIN) } })))).toBe(false)
    expect(marcou('CONNECTOR_IDLE')(avaliarSessaoAberta(entrada({ sessao: { createdAt }, conector: { status: 'AVAILABLE', statusReceivedAt: createdAt } })))).toBe(false)
    expect(marcou('CONNECTOR_IDLE')(avaliarSessaoAberta(entrada({ sessao: { createdAt }, conector: { status: 'AVAILABLE', statusReceivedAt: new Date(createdAt.getTime() + 1) } })))).toBe(true)
  })

  it('sem statusReceivedAt, ou com o carregador OFFLINE, R2 não se aplica', () => {
    expect(marcou('CONNECTOR_IDLE')(avaliarSessaoAberta(entrada({ conector: { status: 'AVAILABLE', statusReceivedAt: null } })))).toBe(false)
    const off = avaliarSessaoAberta(entrada({ conector: { status: 'AVAILABLE', statusReceivedAt: antes(20 * MIN) }, carregador: offlineHa(6 * MIN) }))
    expect(marcou('CONNECTOR_IDLE')(off)).toBe(false)
  })

  it.each(['PREPARING', 'CHARGING', 'SUSPENDED_EVSE', 'SUSPENDED_EV', 'FINISHING', 'RESERVED', 'FAULTED'] as const)('conector %s há 1 h NÃO é "liberado"', (status) => {
    expect(marcou('CONNECTOR_IDLE')(avaliarSessaoAberta(entrada({ conector: { status, statusReceivedAt: antes(HORA) } })))).toBe(false)
  })
})

// ----------------------------------------------------------------------------------------------------------------------------------
describe('R5 — duração máxima de sessão aberta (24 h desde createdAt)', () => {
  const longa = (ms: number, sessao: Sobrescrita['sessao'] = {}) => entrada({ sessao: { createdAt: antes(ms), ...sessao }, conector: { statusReceivedAt: antes(ms - 1000) } })

  fronteira('1º passo: pede o RemoteStop', 24 * HORA, (ms) => longa(ms), (d) => d.acao === 'PEDIR_REMOTE_STOP')

  it('decisão do 1º passo: solicitante WATCHDOG, tentativa 1, alerta de duração máxima', () => {
    expect(avaliarSessaoAberta(longa(24 * HORA))).toEqual({
      acao: 'PEDIR_REMOTE_STOP',
      solicitante: 'WATCHDOG',
      tentativa: 1,
      regra: 'R5',
      alertasExtras: ['session_max_duration_reached'],
    })
  })

  fronteira(
    '2º passo: RemoteStop pedido e sem StopTransaction depois de 5 min => MAX_DURATION',
    5 * MIN,
    (ms) => longa(25 * HORA, { stopRequestedAt: antes(ms), stopAttempts: 1 }),
    marcou('MAX_DURATION'),
  )

  it('2º passo, decisão completa (sem retentar: o motivo aqui é a duração, não a desobediência)', () => {
    expect(avaliarSessaoAberta(longa(25 * HORA, { stopRequestedAt: antes(5 * MIN), stopAttempts: 1 }))).toEqual({
      acao: 'MARCAR_NAO_CONFIRMADA',
      motivo: 'MAX_DURATION',
      regra: 'R5',
      alertasExtras: ['session_stop_unconfirmed', 'session_max_duration_reached'],
    })
  })

  it('dentro da janela do 2º passo espera (não repete o pedido)', () => {
    expect(e(avaliarSessaoAberta(longa(25 * HORA, { stopRequestedAt: antes(MIN), stopAttempts: 1 })))).toBe('NADA')
  })

  it('R5 vence R3: com stop já pedido e duração máxima, o motivo é MAX_DURATION (não STOP_NOT_CONFIRMED) mesmo com tentativas esgotadas', () => {
    const d = avaliarSessaoAberta(longa(30 * HORA, { stopRequestedAt: antes(6 * MIN), stopAttempts: 3 }))
    expect(marcou('MAX_DURATION')(d)).toBe(true)
  })
})

// ----------------------------------------------------------------------------------------------------------------------------------
describe('R3 — RemoteStop pedido e sem StopTransaction: reenvia até o teto, depois STOP_NOT_CONFIRMED', () => {
  const pedido = (ms: number, tentativas: number, avancou = false) => entrada({ sessao: { stopRequestedAt: antes(ms), stopAttempts: tentativas, energyAdvancedSinceStopRequest: avancou } })

  for (const tentativas of [1, 2]) {
    fronteira(`tentativa ${tentativas} => reenvia (a ${tentativas + 1}ª)`, 5 * MIN, (ms) => pedido(ms, tentativas), (d) => d.acao === 'PEDIR_REMOTE_STOP')
  }
  fronteira('3 tentativas esgotadas => STOP_NOT_CONFIRMED', 5 * MIN, (ms) => pedido(ms, 3), marcou('STOP_NOT_CONFIRMED'))

  it('reenvio: numera a próxima tentativa e identifica o WATCHDOG', () => {
    expect(avaliarSessaoAberta(pedido(5 * MIN, 2))).toEqual({ acao: 'PEDIR_REMOTE_STOP', solicitante: 'WATCHDOG', tentativa: 3, regra: 'R3', alertasExtras: [] })
  })

  it('tentativas ACIMA do teto (dado antigo/corrida) também marcam, nunca reenviam', () => {
    expect(marcou('STOP_NOT_CONFIRMED')(avaliarSessaoAberta(pedido(10 * MIN, 4)))).toBe(true)
  })

  it('carregador que continua entregando depois do pedido: alerta session_stop_not_obeyed em AMBOS os ramos; sem avanço, sem alerta', () => {
    expect(avaliarSessaoAberta(pedido(5 * MIN, 1, true)).alertasExtras).toEqual(['session_stop_not_obeyed'])
    expect(avaliarSessaoAberta(pedido(5 * MIN, 3, true)).alertasExtras).toEqual(['session_stop_unconfirmed', 'session_stop_not_obeyed'])
    expect(avaliarSessaoAberta(pedido(5 * MIN, 1, false)).alertasExtras).toEqual([])
    expect(avaliarSessaoAberta(pedido(5 * MIN, 3, false)).alertasExtras).toEqual(['session_stop_unconfirmed'])
  })

  it('dentro da janela de 5 min não faz nada de R3', () => {
    expect(e(avaliarSessaoAberta(pedido(4 * MIN + 59_000, 1)))).toBe('NADA')
  })
})

// ----------------------------------------------------------------------------------------------------------------------------------
describe('R4 — online + conector Charging + sem MeterValues: pede amostra, NUNCA fecha', () => {
  const mudo = (ms: number, extra: Sobrescrita = {}) => entrada({ ...extra, sessao: { lastActivityAt: antes(ms), ...extra.sessao } })

  fronteira('silêncio >= 15 min', 15 * MIN, (ms) => mudo(ms), (d) => d.acao === 'TENTAR_TRIGGER_MESSAGE')

  it('decisão completa', () => {
    expect(avaliarSessaoAberta(mudo(15 * MIN))).toEqual({ acao: 'TENTAR_TRIGGER_MESSAGE', mensagem: 'MeterValues', regra: 'R4', alertasExtras: ['session_no_meter_values'] })
  })

  fronteira('cooldown de 15 min entre dois TriggerMessage', 15 * MIN, (ms) => mudo(20 * MIN, { ultimoTriggerMeterValuesEm: antes(ms) }), (d) => d.acao === 'TENTAR_TRIGGER_MESSAGE')

  it('dentro do cooldown cai na guarda (R6), não repete o trigger e não fecha', () => {
    expect(e(avaliarSessaoAberta(mudo(20 * MIN, { ultimoTriggerMeterValuesEm: antes(MIN) })))).toBe('REAVALIAR_GUARDA')
  })

  it('NUNCA fecha: 20 h de silêncio com o carregador online e Charging só gera trigger/guarda (nenhuma ação de fechamento)', () => {
    for (const ms of [30 * MIN, HORA, 5 * HORA, 20 * HORA]) {
      for (const cooldown of [null, antes(MIN)]) {
        const d = avaliarSessaoAberta(mudo(ms, { ultimoTriggerMeterValuesEm: cooldown, sessao: { createdAt: antes(21 * HORA) }, conector: { statusReceivedAt: antes(21 * HORA - 1000) } }))
        expect(['TENTAR_TRIGGER_MESSAGE', 'REAVALIAR_GUARDA']).toContain(d.acao)
      }
    }
  })

  it('conector que NÃO está em Charging (ex.: SuspendedEV, carro cheio) não é "mudo": sem trigger', () => {
    expect(e(avaliarSessaoAberta(mudo(HORA, { conector: { status: 'SUSPENDED_EV' } })))).toBe('REAVALIAR_GUARDA')
  })

  it('carregador offline (mas ainda < 10 min) não recebe trigger', () => {
    const d = avaliarSessaoAberta(mudo(20 * MIN, { carregador: offlineHa(6 * MIN) }))
    expect(e(d)).toBe('REAVALIAR_GUARDA')
  })
})

// ----------------------------------------------------------------------------------------------------------------------------------
describe('R6 — guarda reavaliada quando a sessão passa de 1 ciclo do watchdog sem amostra', () => {
  fronteira('sem atividade >= 60 s', 60_000, (ms) => entrada({ conector: { status: 'SUSPENDED_EV' }, sessao: { lastActivityAt: antes(ms) } }), (d) => d.acao === 'REAVALIAR_GUARDA')

  it('decisão completa', () => {
    expect(avaliarSessaoAberta(entrada({ conector: { status: 'SUSPENDED_EV' }, sessao: { lastActivityAt: antes(60_000) } }))).toEqual({ acao: 'REAVALIAR_GUARDA', regra: 'R6', alertasExtras: [] })
  })

  it('vale para todos os estados abertos', () => {
    for (const status of ESTADOS_SESSAO_ABERTA) {
      const d = avaliarSessaoAberta(entrada({ sessao: { status, lastActivityAt: antes(2 * MIN) }, conector: { status: 'SUSPENDED_EV' } }))
      expect(e(d)).toBe('REAVALIAR_GUARDA')
    }
  })

  it('acompanha o intervalo configurado do watchdog', () => {
    const d = (cfg: number, ms: number) => e(avaliarSessaoAberta(entrada({ conector: { status: 'SUSPENDED_EV' }, sessao: { lastActivityAt: antes(ms) }, config: { watchdogIntervalMs: cfg } })))
    expect(d(5 * MIN, 5 * MIN - 1)).toBe('NADA')
    expect(d(5 * MIN, 5 * MIN)).toBe('REAVALIAR_GUARDA')
  })
})

// ----------------------------------------------------------------------------------------------------------------------------------
describe('prazo do hold do cartão (48 h desde PaymentIntent.authorizedAt)', () => {
  const cartao = (ms: number, extra: Sobrescrita = {}) => entrada({ ...extra, sessao: { paymentMode: 'CARD', cardAuthorizedAt: antes(ms), ...extra.sessao } })

  fronteira('sessão aberta de cartão', 48 * HORA, (ms) => cartao(ms), marcou('MAX_DURATION'))

  it('decisão completa, com o alerta card_session_hold_deadline', () => {
    expect(avaliarSessaoAberta(cartao(48 * HORA))).toEqual({
      acao: 'MARCAR_NAO_CONFIRMADA',
      motivo: 'MAX_DURATION',
      regra: 'R5_CARTAO',
      alertasExtras: ['session_stop_unconfirmed', 'card_session_hold_deadline'],
    })
  })

  it('só vale para CARD com pré-autorização: WALLET e CARD sem authorizedAt ignoram o prazo', () => {
    expect(e(avaliarSessaoAberta(entrada({ sessao: { paymentMode: 'WALLET', cardAuthorizedAt: antes(100 * HORA) } })))).toBe('NADA')
    expect(e(avaliarSessaoAberta(entrada({ sessao: { paymentMode: 'CARD', cardAuthorizedAt: null } })))).toBe('NADA')
  })

  it('dinheiro em risco vence as outras regras: carregador offline há 1 h e hold vencido => MAX_DURATION, não CHARGER_UNREACHABLE', () => {
    const d = avaliarSessaoAberta(cartao(49 * HORA, { carregador: offlineHa(HORA), sessao: { lastActivityAt: antes(HORA) } }))
    expect(marcou('MAX_DURATION')(d)).toBe(true)
  })

  it('o prazo é configurável', () => {
    expect(marcou('MAX_DURATION')(avaliarSessaoAberta(cartao(7 * HORA, { config: { cardMaxHoldHours: 8 } })))).toBe(false)
    expect(marcou('MAX_DURATION')(avaliarSessaoAberta(cartao(8 * HORA, { config: { cardMaxHoldHours: 8 } })))).toBe(true)
  })
})

// ----------------------------------------------------------------------------------------------------------------------------------
describe('U1 — STOP_UNCONFIRMED: o carregador voltou a mandar MeterValues => reanima', () => {
  it('MeterValues DEPOIS de unconfirmedAt => REANIMAR + alerta de erro', () => {
    const d = avaliarSessaoAberta(naoConfirmada(3 * MIN, { sessao: { lastMeterValuesAt: antes(5_000) } }))
    expect(d).toEqual({ acao: 'REANIMAR', regra: 'U1', alertasExtras: ['session_revived_after_unconfirmed'] })
  })

  it('borda estrita: no MESMO instante de unconfirmedAt não reanima; 1 ms depois reanima', () => {
    const unconfirmedAt = antes(3 * MIN)
    const base = { unconfirmedAt }
    expect(e(avaliarSessaoAberta(naoConfirmada(3 * MIN, { sessao: { ...base, lastMeterValuesAt: unconfirmedAt } })))).toBe('NADA')
    expect(e(avaliarSessaoAberta(naoConfirmada(3 * MIN, { sessao: { ...base, lastMeterValuesAt: new Date(unconfirmedAt.getTime() + 1) } })))).toBe('REANIMAR')
    expect(e(avaliarSessaoAberta(naoConfirmada(3 * MIN, { sessao: { ...base, lastMeterValuesAt: null } })))).toBe('NADA')
  })

  it('atividade que NÃO é MeterValues (lastActivityAt mexido por StatusNotification) não reanima', () => {
    const d = avaliarSessaoAberta(naoConfirmada(3 * MIN, { sessao: { lastActivityAt: antes(1000), lastMeterValuesAt: antes(5 * MIN) } }))
    expect(e(d)).toBe('NADA')
  })

  it('reanimar vem ANTES de encerrar: janela vencida + MeterValues depois => reanima (a prova mais forte é o carregador vivo)', () => {
    expect(e(avaliarSessaoAberta(naoConfirmada(30 * MIN, { sessao: { lastMeterValuesAt: antes(MIN) } })))).toBe('REANIMAR')
  })

  describe('anti vai-e-vem: se reanimar só faria R3/R5/cartão marcar de novo no ciclo seguinte, NÃO reanima', () => {
    it('RemoteStop já esgotados (3/3) + carregador entregando: alerta session_stop_not_obeyed e segue em confirmação até a janela', () => {
      const d = avaliarSessaoAberta(naoConfirmada(3 * MIN, { sessao: { lastMeterValuesAt: antes(5_000), stopAttempts: 3 } }))
      expect(d).toEqual({ acao: 'ALERTAR', tipo: 'session_stop_not_obeyed', regra: 'U1', alertasExtras: [] })
    })
    it('2/3 ainda reanima (há tentativa sobrando)', () => {
      expect(e(avaliarSessaoAberta(naoConfirmada(3 * MIN, { sessao: { lastMeterValuesAt: antes(5_000), stopAttempts: 2 } })))).toBe('REANIMAR')
    })
    it('duração máxima já vencida: não reanima', () => {
      const d = avaliarSessaoAberta(naoConfirmada(3 * MIN, { sessao: { createdAt: antes(25 * HORA), lastMeterValuesAt: antes(5_000) } }))
      expect(e(d)).toBe('ALERTAR')
    })
    it('prazo do cartão já vencido: não reanima e ENCERRA (dinheiro em risco)', () => {
      const d = avaliarSessaoAberta(naoConfirmada(3 * MIN, { sessao: { paymentMode: 'CARD', cardAuthorizedAt: antes(48 * HORA), lastMeterValuesAt: antes(5_000) }, provas: { ultimaAmostra: true } }))
      expect(e(d)).toBe('ENCERRAR_PELO_SERVIDOR')
    })
    it('bloqueada e janela vencida: encerra (não fica alertando para sempre)', () => {
      const d = avaliarSessaoAberta(naoConfirmada(11 * MIN, { sessao: { lastMeterValuesAt: antes(5_000), stopAttempts: 3 }, provas: { ultimaAmostra: true } }))
      expect(d).toMatchObject({ acao: 'ENCERRAR_PELO_SERVIDOR', prova: 'LAST_METER_SAMPLE' })
    })
  })
})

// ----------------------------------------------------------------------------------------------------------------------------------
describe('U2 — fim da janela de confirmação => encerra pelo servidor', () => {
  fronteira('carregador ONLINE: janela de 10 min (G1)', 10 * MIN, (ms) => naoConfirmada(ms), (d) => d.acao === 'ENCERRAR_PELO_SERVIDOR')
  fronteira('carregador OFFLINE: janela de 120 min (G2)', 120 * MIN, (ms) => naoConfirmada(ms, { carregador: offlineHa(ms + MIN) }), (d) => d.acao === 'ENCERRAR_PELO_SERVIDOR')

  it('offline NÃO usa a janela curta: 11 min offline => ainda espera; voltando online, os mesmos 11 min já vencem a janela G1', () => {
    expect(e(avaliarSessaoAberta(naoConfirmada(11 * MIN, { carregador: offlineHa(8 * MIN) })))).toBe('NADA')
    expect(e(avaliarSessaoAberta(naoConfirmada(11 * MIN)))).toBe('ENCERRAR_PELO_SERVIDOR')
  })

  describe('prova de leitura final: StopTransaction no log > última amostra > sem leitura', () => {
    const vencida = (provas: Sobrescrita['provas'], config: Sobrescrita['config'] = {}) => avaliarSessaoAberta(naoConfirmada(10 * MIN, { provas, config }))

    it('StopTransaction no log vence a amostra (mesmo havendo as duas)', () => {
      expect(vencida({ stopTransactionNoLog: true, ultimaAmostra: true })).toEqual({
        acao: 'ENCERRAR_PELO_SERVIDOR',
        prova: 'STOP_TRANSACTION',
        cobranca: 'PELA_LEITURA',
        forcadoPeloPrazoDoCartao: false,
        regra: 'U2',
        alertasExtras: ['session_closed_by_server'],
      })
    })
    it('só StopTransaction no log (sem nenhuma amostra) também é prova', () => {
      expect(vencida({ stopTransactionNoLog: true, ultimaAmostra: false })).toMatchObject({ prova: 'STOP_TRANSACTION', cobranca: 'PELA_LEITURA' })
    })
    it('sem Stop, com amostra => LAST_METER_SAMPLE', () => {
      expect(vencida({ stopTransactionNoLog: false, ultimaAmostra: true })).toMatchObject({ prova: 'LAST_METER_SAMPLE', cobranca: 'PELA_LEITURA', alertasExtras: ['session_closed_by_server'] })
    })

    describe('D2 — sem NENHUMA leitura (NO_READING)', () => {
      it('política NO_CHARGE (padrão, D2a): não cobra, e o alerta de erro pede revisão manual', () => {
        expect(vencida({}, { noReadingPolicy: 'NO_CHARGE' })).toEqual({
          acao: 'ENCERRAR_PELO_SERVIDOR',
          prova: 'NO_READING',
          cobranca: 'NAO_COBRAR',
          forcadoPeloPrazoDoCartao: false,
          regra: 'U2',
          alertasExtras: ['session_closed_by_server', 'session_closed_without_meter_reading'],
        })
      })
      it('política MIN_FEE (D2b): cobra taxa fixa + mínimo (comportamento de hoje), com o mesmo alerta', () => {
        expect(vencida({}, { noReadingPolicy: 'MIN_FEE' })).toMatchObject({ prova: 'NO_READING', cobranca: 'TAXA_FIXA_E_MINIMO', alertasExtras: ['session_closed_by_server', 'session_closed_without_meter_reading'] })
      })
      it('o padrão da configuração é NO_CHARGE', () => expect(CONFIG_WATCHDOG_PADRAO.noReadingPolicy).toBe('NO_CHARGE'))
      it('a política só importa SEM leitura: com prova, as duas cobram pela leitura', () => {
        for (const noReadingPolicy of ['NO_CHARGE', 'MIN_FEE'] as const) {
          expect(vencida({ ultimaAmostra: true }, { noReadingPolicy })).toMatchObject({ prova: 'LAST_METER_SAMPLE', cobranca: 'PELA_LEITURA' })
          expect(vencida({ stopTransactionNoLog: true }, { noReadingPolicy })).toMatchObject({ prova: 'STOP_TRANSACTION', cobranca: 'PELA_LEITURA' })
        }
      })
    })
  })

  describe('prazo do cartão limita a janela ("encerra mesmo dentro da janela")', () => {
    // cartão autorizado há 48 h - 5 min => o hold vence daqui a 5 min; a janela G1 (10 min) venceria só daqui a 9 min (unconfirmed há 1 min)
    const cenario = (agora: Date) =>
      naoConfirmada(MIN, { agora, sessao: { paymentMode: 'CARD', cardAuthorizedAt: antes(48 * HORA - 5 * MIN, AGORA) }, provas: { ultimaAmostra: true } })

    it('1 minuto antes do prazo do cartão: ainda espera', () => {
      expect(e(avaliarSessaoAberta(cenario(new Date(AGORA.getTime() + 4 * MIN))))).toBe('NADA')
    })
    it('no prazo do cartão: encerra, marcado como forçado, com o alerta do hold', () => {
      const agora = new Date(AGORA.getTime() + 5 * MIN)
      const ent = cenario(agora)
      // `naoConfirmada` ancora unconfirmedAt em `agora`, então refaz a âncora para que o unconfirmedAt seja o mesmo (AGORA - 1 min)
      ent.sessao.unconfirmedAt = antes(MIN, AGORA)
      ent.sessao.lastMeterValuesAt = antes(2 * MIN, AGORA)
      expect(avaliarSessaoAberta(ent)).toMatchObject({
        acao: 'ENCERRAR_PELO_SERVIDOR',
        forcadoPeloPrazoDoCartao: true,
        alertasExtras: ['session_closed_by_server', 'card_session_hold_deadline'],
      })
    })
    it('prazo do cartão MAIS LONGE que a janela: a janela manda e o encerramento não é "forçado"', () => {
      const d = avaliarSessaoAberta(naoConfirmada(10 * MIN, { sessao: { paymentMode: 'CARD', cardAuthorizedAt: antes(HORA) }, provas: { ultimaAmostra: true } }))
      expect(d).toMatchObject({ acao: 'ENCERRAR_PELO_SERVIDOR', forcadoPeloPrazoDoCartao: false, alertasExtras: ['session_closed_by_server'] })
    })
  })

  it('STOP_UNCONFIRMED sem unconfirmedAt viola o CHECK do banco: a função recusa em vez de inventar uma data', () => {
    expect(() => avaliarSessaoAberta(naoConfirmada(10 * MIN, { sessao: { unconfirmedAt: null } }))).toThrow(/unconfirmedAt/)
  })
})

// ----------------------------------------------------------------------------------------------------------------------------------
describe('calcularConfirmDeadline — a MESMA conta do U2, para o DTO', () => {
  const configJanela = { unconfirmedGraceOnlineMinutes: 10, unconfirmedGraceOfflineMinutes: 120, cardMaxHoldHours: 48 }
  const unconfirmedAt = new Date('2026-10-03T11:55:00.000Z')

  it('online => unconfirmedAt + 10 min; offline => unconfirmedAt + 120 min', () => {
    const sessao = { paymentMode: 'WALLET' as const, cardAuthorizedAt: null, unconfirmedAt }
    expect(calcularConfirmDeadline({ agora: AGORA, sessao, carregador: { lastSeenAt: antes(5_000), disconnectedAt: null }, config: configJanela }).toISOString()).toBe('2026-10-03T12:05:00.000Z')
    expect(calcularConfirmDeadline({ agora: AGORA, sessao, carregador: offlineHa(8 * MIN), config: configJanela }).toISOString()).toBe('2026-10-03T13:55:00.000Z')
  })

  it('cartão: o prazo do hold limita (min dos dois)', () => {
    const sessao = { paymentMode: 'CARD' as const, cardAuthorizedAt: new Date(AGORA.getTime() - 48 * HORA + 3 * MIN), unconfirmedAt }
    expect(calcularConfirmDeadline({ agora: AGORA, sessao, carregador: offlineHa(8 * MIN), config: configJanela }).toISOString()).toBe('2026-10-03T12:03:00.000Z')
    // hold longe: manda a janela
    const longe = { ...sessao, cardAuthorizedAt: antes(HORA) }
    expect(calcularConfirmDeadline({ agora: AGORA, sessao: longe, carregador: { lastSeenAt: antes(1000), disconnectedAt: null }, config: configJanela }).toISOString()).toBe('2026-10-03T12:05:00.000Z')
  })

  it('CONSISTÊNCIA: o instante devolvido É o instante em que avaliarSessaoAberta passa a encerrar (1 ms antes não; no instante sim) — online, offline e cartão', () => {
    const cenarios: Array<{ nome: string; ent: (agora: Date) => EntradaAvaliacao }> = [
      { nome: 'online', ent: (agora) => naoConfirmada(0, { agora, sessao: { unconfirmedAt } }) },
      { nome: 'offline', ent: (agora) => naoConfirmada(0, { agora, sessao: { unconfirmedAt }, carregador: offlineHa(8 * MIN, agora) }) },
      { nome: 'cartão com hold curto', ent: (agora) => naoConfirmada(0, { agora, sessao: { unconfirmedAt, paymentMode: 'CARD', cardAuthorizedAt: new Date(AGORA.getTime() - 48 * HORA + 3 * MIN) }, carregador: offlineHa(8 * MIN, agora) }) },
    ]
    for (const c of cenarios) {
      const ref = c.ent(AGORA)
      const prazo = calcularConfirmDeadline({ agora: AGORA, sessao: ref.sessao, carregador: ref.carregador, config: ref.config })
      // Reavalia no instante-limite mantendo o MESMO estado do carregador (online/offline) e a mesma sessão
      const reavaliar = (agora: Date): EntradaAvaliacao => {
        const ent = c.ent(agora)
        return { ...ent, sessao: { ...ent.sessao, unconfirmedAt: ref.sessao.unconfirmedAt, lastMeterValuesAt: antes(10 * MIN, unconfirmedAt), lastActivityAt: antes(10 * MIN, unconfirmedAt) } }
      }
      expect(e(avaliarSessaoAberta(reavaliar(new Date(prazo.getTime() - 1)))), `${c.nome}: 1 ms antes`).not.toBe('ENCERRAR_PELO_SERVIDOR')
      expect(e(avaliarSessaoAberta(reavaliar(prazo))), `${c.nome}: no instante`).toBe('ENCERRAR_PELO_SERVIDOR')
    }
  })

  it('sem unconfirmedAt recusa', () => {
    expect(() => calcularConfirmDeadline({ agora: AGORA, sessao: { paymentMode: 'WALLET', cardAuthorizedAt: null, unconfirmedAt: null }, carregador: { lastSeenAt: null }, config: configJanela })).toThrow(/unconfirmedAt/)
  })
})

// ----------------------------------------------------------------------------------------------------------------------------------
describe('precedência entre regras (sessão aberta)', () => {
  it('R1 decide sozinha quando o carregador está offline (R2 exige online)', () => {
    const d = avaliarSessaoAberta(entrada({ carregador: offlineHa(20 * MIN), sessao: { lastActivityAt: antes(20 * MIN) }, conector: { status: 'AVAILABLE', statusReceivedAt: antes(20 * MIN) } }))
    expect(marcou('CHARGER_UNREACHABLE')(d)).toBe(true)
  })
  it('R2 vence R5: conector liberado há 6 min numa sessão de 25 h => CONNECTOR_IDLE (não pede RemoteStop a quem já parou)', () => {
    const d = avaliarSessaoAberta(entrada({ sessao: { createdAt: antes(25 * HORA) }, conector: { status: 'AVAILABLE', statusReceivedAt: antes(6 * MIN) } }))
    expect(marcou('CONNECTOR_IDLE')(d)).toBe(true)
  })
  it('R5 vence R4: sessão de 25 h em silêncio, online e Charging => pede o RemoteStop antes de cutucar o medidor', () => {
    const d = avaliarSessaoAberta(entrada({ sessao: { createdAt: antes(25 * HORA), lastActivityAt: antes(HORA) }, conector: { statusReceivedAt: antes(25 * HORA - 1000) } }))
    expect(e(d)).toBe('PEDIR_REMOTE_STOP')
  })
  it('R3 vence R4: stop pedido há 6 min e silêncio de 20 min => reenvia o stop', () => {
    const d = avaliarSessaoAberta(entrada({ sessao: { stopRequestedAt: antes(6 * MIN), stopAttempts: 1, lastActivityAt: antes(20 * MIN) } }))
    expect(e(d)).toBe('PEDIR_REMOTE_STOP')
  })
})

describe('configuração', () => {
  it('os defaults recomendados da Nova', () => {
    expect(CONFIG_WATCHDOG_PADRAO).toEqual({
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
  })
  it('é imutável (um teste/serviço não pode corrompê-la por engano)', () => {
    expect(Object.isFrozen(CONFIG_WATCHDOG_PADRAO)).toBe(true)
  })
  it('todos os limites respondem à configuração (não há número mágico escondido)', () => {
    const dobrado = (c: Parcial<ConfigWatchdogSessao>, monta: () => Sobrescrita, dispara: (d: DecisaoSessao) => boolean) => {
      expect(dispara(avaliarSessaoAberta(entrada(monta())))).toBe(false)
      expect(dispara(avaliarSessaoAberta(entrada({ ...monta(), config: c })))).toBe(true)
    }
    dobrado({ chargerOfflineMinutes: 5 }, () => ({ carregador: offlineHa(7 * MIN), sessao: { lastActivityAt: antes(20 * MIN) } }), marcou('CHARGER_UNREACHABLE'))
    dobrado({ inactivityMinutes: 3 }, () => ({ carregador: offlineHa(20 * MIN), sessao: { lastActivityAt: antes(4 * MIN) } }), marcou('CHARGER_UNREACHABLE'))
    dobrado({ connectorIdleMinutes: 1 }, () => ({ conector: { status: 'AVAILABLE', statusReceivedAt: antes(2 * MIN) } }), marcou('CONNECTOR_IDLE'))
    dobrado({ maxOpenHours: 1 }, () => ({ sessao: { createdAt: antes(2 * HORA) }, conector: { statusReceivedAt: antes(2 * HORA - 1000) } }), (d) => d.acao === 'PEDIR_REMOTE_STOP')
    dobrado({ stopConfirmMinutes: 1 }, () => ({ sessao: { stopRequestedAt: antes(2 * MIN), stopAttempts: 1 } }), (d) => d.acao === 'PEDIR_REMOTE_STOP')
    dobrado({ stopMaxAttempts: 1 }, () => ({ sessao: { stopRequestedAt: antes(6 * MIN), stopAttempts: 1 } }), marcou('STOP_NOT_CONFIRMED'))
    dobrado({ inactivityMinutes: 5 }, () => ({ sessao: { lastActivityAt: antes(6 * MIN) } }), (d) => d.acao === 'TENTAR_TRIGGER_MESSAGE')
    dobrado({ meterTriggerCooldownMinutes: 1 }, () => ({ sessao: { lastActivityAt: antes(20 * MIN) }, ultimoTriggerMeterValuesEm: antes(2 * MIN) }), (d) => d.acao === 'TENTAR_TRIGGER_MESSAGE')
  })
})
