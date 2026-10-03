import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * F5.9b1 — `pedirParadaSessao` (ÚNICO ponto de RemoteStop): a CLASSIFICAÇÃO do que fazer com a resposta do carregador, sem banco nem Redis.
 * Regra do desenho: Accepted = nada mais; Rejected / erro de transporte => STOP_UNCONFIRMED (nunca fecha com dinheiro); timeout SÓ registra.
 * A prova com Postgres+Redis reais (lock, contadores, gateway de mentira pelo barramento) está em `sessaoTravadaPedirParada.test.ts`.
 */

const { sendCommandMock, marcarMock, travarMock, updateManyMock, redisSetMock, loggerFake, FakeTimeout } = vi.hoisted(() => ({
  sendCommandMock: vi.fn(),
  marcarMock: vi.fn(),
  travarMock: vi.fn(),
  updateManyMock: vi.fn(),
  redisSetMock: vi.fn(),
  loggerFake: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  FakeTimeout: class FakeTimeout extends Error {},
}))

vi.mock('../../src/lib/logger', () => ({ logger: loggerFake }))
vi.mock('../../src/lib/redis', () => ({ redis: { set: redisSetMock } }))
vi.mock('../../src/lib/prisma', () => ({
  prisma: {
    $transaction: async (fn: (tx: unknown) => unknown) => fn({ chargingSession: { updateMany: updateManyMock } }),
    meterSample: { findFirst: vi.fn().mockResolvedValue(null) },
  },
}))
vi.mock('../../src/ocpp/commands', () => ({ sendCommand: sendCommandMock, OcppCommandTimeoutError: FakeTimeout }))
vi.mock('../../src/services/sessao/marcarSessaoNaoConfirmada', () => ({ marcarSessaoNaoConfirmada: marcarMock }))
vi.mock('../../src/services/sessao/travarSessao', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../src/services/sessao/travarSessao')>()), travarSessao: travarMock }))

import { pedirParadaSessao } from '../../src/services/sessao/pedirParadaSessao'

const sessaoAberta = { id: 's1', status: 'CHARGING', chargePointId: 'cp1', ocppTransactionId: 77, stopAttempts: 0, stopRequestedBy: null, lastActivityAt: null, lastMeterValuesAt: null, stopRequestedAt: null, unconfirmedAt: null }

beforeEach(() => {
  vi.clearAllMocks()
  redisSetMock.mockResolvedValue('OK')
  travarMock.mockResolvedValue(sessaoAberta)
  updateManyMock.mockResolvedValue({ count: 1 })
  marcarMock.mockResolvedValue('MARCADA')
})

describe('pedirParadaSessao — classificação da resposta do carregador', () => {
  it('Accepted: registra o pedido, manda o comando com o transactionId e NÃO marca a sessão', async () => {
    sendCommandMock.mockResolvedValue({ status: 'Accepted' })
    const r = await pedirParadaSessao({ sessionId: 's1', solicitante: 'DRIVER' })
    // MUDANÇA DELIBERADA (M6 do Órion): pedido de DRIVER/ADMIN não conta para o teto de tentativas do servidor — `stopAttempts` fica 0 (só GUARD/WATCHDOG contam).
    expect(r).toEqual({ registrado: true, tentativa: 0, comando: 'ACCEPTED', marcacao: null })
    expect(sendCommandMock).toHaveBeenCalledWith('cp1', 'RemoteStopTransaction', { transactionId: 77 }, expect.objectContaining({ timeoutMs: 35_000 }))
    expect(marcarMock).not.toHaveBeenCalled()
  })

  it('Rejected: sessão vira STOP_UNCONFIRMED(STOP_REJECTED) — nunca fecha com dinheiro', async () => {
    sendCommandMock.mockResolvedValue({ status: 'Rejected' })
    const r = await pedirParadaSessao({ sessionId: 's1', solicitante: 'ADMIN' })
    expect(r).toMatchObject({ registrado: true, comando: 'REJECTED', marcacao: 'MARCADA' })
    expect(marcarMock).toHaveBeenCalledWith({ sessionId: 's1', motivo: 'STOP_REJECTED' })
  })

  it('erro de transporte que NÃO é timeout: STOP_UNCONFIRMED(CHARGER_UNREACHABLE)', async () => {
    sendCommandMock.mockRejectedValue(new Error('socket fechado'))
    const r = await pedirParadaSessao({ sessionId: 's1', solicitante: 'GUARD' })
    expect(r).toMatchObject({ registrado: true, comando: 'UNREACHABLE', marcacao: 'MARCADA' })
    expect(marcarMock).toHaveBeenCalledWith({ sessionId: 's1', motivo: 'CHARGER_UNREACHABLE' })
  })

  it('timeout é ambíguo (carregador lento): SÓ registra — quem decide é o R3 do watchdog', async () => {
    sendCommandMock.mockRejectedValue(new FakeTimeout('35s'))
    const r = await pedirParadaSessao({ sessionId: 's1', solicitante: 'DRIVER' })
    // MUDANÇA DELIBERADA (M6 do Órion): pedido de DRIVER/ADMIN não conta para o teto de tentativas do servidor — `stopAttempts` fica 0 (só GUARD/WATCHDOG contam).
    expect(r).toEqual({ registrado: true, tentativa: 0, comando: 'TIMEOUT', marcacao: null })
    expect(marcarMock).not.toHaveBeenCalled()
  })

  it('falha ao marcar não derruba o pedido (o watchdog reavalia no ciclo seguinte)', async () => {
    sendCommandMock.mockResolvedValue({ status: 'Rejected' })
    marcarMock.mockRejectedValue(new Error('deadlock'))
    const r = await pedirParadaSessao({ sessionId: 's1', solicitante: 'DRIVER' })
    expect(r).toMatchObject({ registrado: true, comando: 'REJECTED', marcacao: null })
  })
})

describe('pedirParadaSessao — o que NÃO chega a mandar comando', () => {
  it('cooldown ativo (duplo toque): EM_COOLDOWN, nada gravado, nada enviado', async () => {
    redisSetMock.mockResolvedValue(null)
    expect(await pedirParadaSessao({ sessionId: 's1', solicitante: 'DRIVER' })).toEqual({ registrado: false, motivo: 'EM_COOLDOWN' })
    expect(updateManyMock).not.toHaveBeenCalled()
    expect(sendCommandMock).not.toHaveBeenCalled()
  })

  it('Redis fora (cooldown lança): o pedido de um humano segue SEM o cooldown', async () => {
    redisSetMock.mockRejectedValue(new Error('ECONNREFUSED'))
    sendCommandMock.mockResolvedValue({ status: 'Accepted' })
    expect(await pedirParadaSessao({ sessionId: 's1', solicitante: 'DRIVER' })).toMatchObject({ registrado: true, comando: 'ACCEPTED' })
  })

  it.each(['STOPPED', 'STOP_UNCONFIRMED'])('sessão %s: NAO_ABERTA — não grava pedido nem manda comando', async (status) => {
    travarMock.mockResolvedValue({ ...sessaoAberta, status })
    expect(await pedirParadaSessao({ sessionId: 's1', solicitante: 'DRIVER' })).toEqual({ registrado: false, motivo: 'NAO_ABERTA' })
    expect(updateManyMock).not.toHaveBeenCalled()
    expect(sendCommandMock).not.toHaveBeenCalled()
  })

  it('FAULTED conta como aberta (constante única)', async () => {
    travarMock.mockResolvedValue({ ...sessaoAberta, status: 'FAULTED' })
    sendCommandMock.mockResolvedValue({ status: 'Accepted' })
    expect(await pedirParadaSessao({ sessionId: 's1', solicitante: 'ADMIN' })).toMatchObject({ registrado: true })
  })

  it('foto do watchdog que mudou sob o lock: CONDICAO_MUDOU, nada enviado', async () => {
    const foto = { status: 'CHARGING' as const, lastActivityAt: null, lastMeterValuesAt: null, stopRequestedAt: null, stopAttempts: 0, unconfirmedAt: null }
    travarMock.mockResolvedValue({ ...sessaoAberta, stopAttempts: 1 })
    expect(await pedirParadaSessao({ sessionId: 's1', solicitante: 'WATCHDOG', fotoEsperada: foto })).toEqual({ registrado: false, motivo: 'CONDICAO_MUDOU' })
    expect(sendCommandMock).not.toHaveBeenCalled()
  })

  it('o update condicional que não altera ninguém (a sessão fechou entre o lock e o update) também é NAO_ABERTA', async () => {
    updateManyMock.mockResolvedValue({ count: 0 })
    expect(await pedirParadaSessao({ sessionId: 's1', solicitante: 'DRIVER' })).toEqual({ registrado: false, motivo: 'NAO_ABERTA' })
    expect(sendCommandMock).not.toHaveBeenCalled()
  })
})

describe('pedirParadaSessao — quem pediu e quantas vezes', () => {
  it('incrementa stopAttempts e re-carimba stopRequestedAt a cada tentativa', async () => {
    sendCommandMock.mockResolvedValue({ status: 'Accepted' })
    travarMock.mockResolvedValue({ ...sessaoAberta, stopAttempts: 2 })
    const r = await pedirParadaSessao({ sessionId: 's1', solicitante: 'WATCHDOG' })
    expect(r).toMatchObject({ registrado: true, tentativa: 3 })
    const dados = updateManyMock.mock.calls[0]![0].data
    expect(dados.stopAttempts).toEqual({ increment: 1 })
    expect(dados.stopRequestedAt).toBeInstanceOf(Date)
  })

  it('o 1º solicitante vence nas repetições automáticas; um humano sempre assume', async () => {
    sendCommandMock.mockResolvedValue({ status: 'Accepted' })
    travarMock.mockResolvedValue({ ...sessaoAberta, stopRequestedBy: 'GUARD' })
    await pedirParadaSessao({ sessionId: 's1', solicitante: 'WATCHDOG' })
    expect(updateManyMock.mock.calls[0]![0].data.stopRequestedBy).toBe('GUARD')
    await pedirParadaSessao({ sessionId: 's1', solicitante: 'DRIVER' })
    expect(updateManyMock.mock.calls[1]![0].data.stopRequestedBy).toBe('DRIVER')
  })

  it('onRegistrado roda DEPOIS de gravar e ANTES do comando (o watchdog emite os alertas aí, sem esperar 35 s)', async () => {
    const ordem: string[] = []
    updateManyMock.mockImplementation(async () => {
      ordem.push('gravou')
      return { count: 1 }
    })
    sendCommandMock.mockImplementation(async () => {
      ordem.push('comando')
      return { status: 'Accepted' }
    })
    await pedirParadaSessao({ sessionId: 's1', solicitante: 'WATCHDOG', onRegistrado: () => ordem.push('onRegistrado') })
    expect(ordem).toEqual(['gravou', 'onRegistrado', 'comando'])
  })
})
