import { describe, expect, it } from 'vitest'
import { amostrarSerie, mascararIpDoDossie, montarDossie, tamanhoEmBytes, type EntradaDossie } from '../../src/core/estornos/dossie'
import { resumirEventoOcpp } from '../../src/services/estornos/lerDadosDoDossie'

/** Núcleo PURO do dossiê de chargeback (L1.8): amostragem, teto de tamanho, máscara de IP e redução do payload OCPP. */

const entrada = (over: Partial<EntradaDossie> = {}): EntradaDossie => ({
  geradoEm: new Date('2026-10-06T12:00:00Z'),
  chargeback: { caseReference: 'C-1', reasonCode: null, notifiedAt: new Date('2026-10-05T12:00:00Z'), responseDeadline: null, amountCents: 1000 },
  venda: { paymentIntentId: 'pi1', environment: 'PRODUCTION', status: 'CAPTURED', returnCode: '00', amountRequestedCents: 1000, amountAuthorizedCents: 1000, amountCapturedCents: 1000, authorizedAt: null, capturedAt: null, cieloPaymentId: 'pay', tid: 't', authorizationCode: 'a', proofOfSale: 'n' },
  cartao: null,
  pagador: { id: 'u1', contaCriadaEm: new Date('2026-09-01T00:00:00Z'), identidadeVerificada: true, aceites: [] },
  sessao: {
    id: 's1', ocppTransactionId: 7, status: 'STOPPED', paymentMode: 'CARD', startedAt: new Date('2026-10-01T10:00:00Z'), chargingEndedAt: null, stoppedAt: null, stopReason: null, meterStartWh: 0, meterStopWh: 1, energyDeliveredWh: 1, idleSeconds: null,
    energyCostCents: 1, timeCostCents: null, idleFeeCents: null, sessionFeeCents: null, minChargeAdjustmentCents: null, totalCostCents: 1, tariffSnapshot: { model: 'PER_KWH' }, origem: { startIp: null, startUserAgent: null },
  },
  local: { siteName: 'S', city: 'C', timezone: 'America/Sao_Paulo', chargePointIdentity: 'cp', vendor: null, model: null, connectorNumber: 1, connectorType: 'AC_TYPE2' },
  medicoes: [],
  totalDeMedicoes: 0,
  trilhaOcpp: [],
  ...over,
})

describe('amostrarSerie', () => {
  it('mantém primeiro e último, respeita o máximo e não inventa pontos', () => {
    const serie = Array.from({ length: 1000 }, (_, i) => i)
    const a = amostrarSerie(serie, 240)
    expect(a.length).toBeLessThanOrEqual(240)
    expect(a[0]).toBe(0)
    expect(a.at(-1)).toBe(999)
    expect([...a].sort((x, y) => x - y)).toEqual(a) // continua ordenada
    expect(amostrarSerie([1, 2, 3], 240)).toEqual([1, 2, 3])
    expect(amostrarSerie([], 10)).toEqual([])
  })
})

describe('mascararIpDoDossie', () => {
  it('IPv4 vira /24, IPv6 /48, IPv4-mapeado entende, lixo e ausente viram null (nunca o IP cru)', () => {
    expect(mascararIpDoDossie('203.0.113.77')).toBe('203.0.113.0/24')
    expect(mascararIpDoDossie('::ffff:203.0.113.77')).toBe('203.0.113.0/24')
    expect(mascararIpDoDossie('2001:db8:abcd:1234::1')).toBe('2001:db8:abcd::/48')
    expect(mascararIpDoDossie('não é ip')).toBeNull()
    expect(mascararIpDoDossie(null)).toBeNull()
  })
})

describe('montarDossie', () => {
  it('só leva os campos da lista explícita (allowlist) — um campo extra no objeto de entrada NÃO vaza', () => {
    const suja = entrada() as unknown as Record<string, any>
    suja.pagador.nome = 'FULANO DE TAL'
    suja.pagador.cpf = '12345678901'
    suja.sessao.idTag = 'TAGSECRETA'
    const texto = JSON.stringify(montarDossie(suja as EntradaDossie))
    for (const proibido of ['FULANO DE TAL', '12345678901', 'TAGSECRETA']) expect(texto).not.toContain(proibido)
  })

  it('estourou o teto: reamostra a curva e, no limite, descarta a trilha OCPP — nunca lança, e diz o que cortou', () => {
    const t0 = Date.UTC(2026, 9, 1, 10)
    const medicoes = Array.from({ length: 5000 }, (_, i) => ({ ts: new Date(t0 + i * 1000), measurand: 'Power.Active.Import', value: 7400.123456789, unit: 'W' }))
    const trilha = Array.from({ length: 200 }, (_, i) => ({ occurredAt: new Date(t0 + i), direction: 'INBOUND' as const, messageType: 'CALL' as const, action: 'StatusNotification', resumo: { status: 'Charging', lixo: 'x'.repeat(200) } }))
    const normal = montarDossie(entrada({ medicoes, totalDeMedicoes: 5000, trilhaOcpp: trilha }))
    expect(normal.reducoesAplicadas).toBeUndefined()
    const apertado = montarDossie(entrada({ medicoes, totalDeMedicoes: 5000, trilhaOcpp: trilha }), 8_000)
    expect(tamanhoEmBytes(apertado)).toBeLessThanOrEqual(8_000 + 2_000) // chegou perto; o que importa abaixo é que registra o que cortou
    expect(apertado.reducoesAplicadas).toEqual(expect.arrayContaining([expect.stringMatching(/curva_reamostrada_/)]))
    const impossivel = montarDossie(entrada({ medicoes, totalDeMedicoes: 5000, trilhaOcpp: trilha }), 100)
    expect(impossivel.reducoesAplicadas).toContain('trilha_ocpp_descartada')
    expect(impossivel.trilhaOcpp).toEqual([])
  })
})

describe('resumirEventoOcpp — só campos de protocolo, nunca o payload nem o idTag', () => {
  it('StopTransaction só da PRÓPRIA transação; StartTransaction/StatusNotification só do conector; idTag nunca sai', () => {
    expect(resumirEventoOcpp('StopTransaction', { transactionId: 7, meterStop: 100, reason: 'Local', idTag: 'SEGREDO' }, 1, 7)).toEqual({ transactionId: 7, meterStop: 100, reason: 'Local' })
    expect(resumirEventoOcpp('StopTransaction', { transactionId: 8, meterStop: 100 }, 1, 7)).toBeNull()
    expect(resumirEventoOcpp('StartTransaction', { connectorId: 2, meterStart: 5, idTag: 'SEGREDO' }, 1, 7)).toBeNull() // outro conector
    const start = resumirEventoOcpp('StartTransaction', { connectorId: 1, meterStart: 5, idTag: 'SEGREDO' }, 1, 7)
    expect(start).toEqual({ connectorId: 1, meterStart: 5 })
    expect(JSON.stringify(start)).not.toContain('SEGREDO')
    expect(resumirEventoOcpp('StatusNotification', { connectorId: 1, status: 'Charging', errorCode: 'NoError', info: 'texto livre do firmware' }, 1, 7)).toEqual({ connectorId: 1, status: 'Charging', errorCode: 'NoError' })
    expect(resumirEventoOcpp('Authorize', { idTag: 'SEGREDO' }, 1, 7)).toEqual({})
    expect(resumirEventoOcpp('StopTransaction', null, 1, 7)).toBeNull()
  })
})
