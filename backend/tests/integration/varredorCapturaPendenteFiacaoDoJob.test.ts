import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Worker } from 'bullmq'

/**
 * Íris (02/10/2026) — a FIAÇÃO do job periódico do varredor (`varrerPreAutorizacoesCartaoJob.ts`) com a rede de segurança da captura.
 *
 * Por que existe: `reenfileirarCapturasPendentes` tem testes de comportamento (`capturaCartaoSemRedeDeSeguranca.test.ts`), mas todos CHAMAM a função
 * direto. Nenhum passava pelo job — e é o job que o worker de produção executa a cada rodada. Apagar a chamada no job (ou perder o `gatewayDisponivel`,
 * ou deixar um erro da varredura A/B bloquear a rede de segurança) mantinha a suíte inteira verde e devolvia o ALTO-1 (intent preso em CAPTURE_PENDING).
 *
 * BullMQ + Redis REAIS (worker real, fila real). O que é substituído são só as três dependências do job, para a rodada ser HERMÉTICA: o varredor real olha
 * TODO `CAPTURE_PENDING` velho do banco compartilhado (e a suíte roda em paralelo) — aqui só interessa QUEM o job chama e COM QUÊ.
 */

const { reenfileirarMock, varrerMock, disponivelMock } = vi.hoisted(() => ({
  reenfileirarMock: vi.fn(async (_deps?: unknown) => ({ reenfileiradas: 0, jaEmAndamento: 0, tetoAtingido: 0, semGateway: 0, falhas: 0 })),
  varrerMock: vi.fn(async (_port?: unknown) => ({ canceladasAbandonadas: 0, resolvidasCreated: 0 })),
  disponivelMock: vi.fn(async () => true),
}))
vi.mock('../../src/services/pagamentos/reenfileirarCapturasPendentes', () => ({ reenfileirarCapturasPendentes: reenfileirarMock }))
vi.mock('../../src/services/pagamentos/varrerPreAutorizacoesCartao', () => ({ varrerPreAutorizacoesCartao: varrerMock }))
vi.mock('../../src/services/pagamentos/pagamentoPortInstance', () => ({ isPagamentoDisponivel: disponivelMock, getPagamentoPort: vi.fn(async () => ({ marcador: 'porta-de-teste' })) }))

import { startVarrerPreAutorizacoesCartaoWorker } from '../../src/worker/jobs/varrerPreAutorizacoesCartaoJob'
import { createQueue, VARRER_PREAUTORIZACOES_CARTAO_QUEUE_NAME } from '../../src/worker/queues'
import { waitFor } from './helpers/fixtures'

describe('job do varredor de pré-autorizações — a rede de segurança da captura roda SEMPRE', () => {
  const queue = createQueue(VARRER_PREAUTORIZACOES_CARTAO_QUEUE_NAME)
  let worker: Worker
  const terminados: Array<{ ok: boolean; mensagem?: string }> = []

  beforeAll(async () => {
    await queue.obliterate({ force: true }).catch(() => {}) // fila de nome FIXO (a do worker real): começa limpa
    worker = startVarrerPreAutorizacoesCartaoWorker()
    worker.on('error', () => {})
    worker.on('completed', () => terminados.push({ ok: true }))
    worker.on('failed', (_job, err) => terminados.push({ ok: false, mensagem: err.message }))
  })

  beforeEach(() => {
    reenfileirarMock.mockClear()
    varrerMock.mockReset().mockResolvedValue({ canceladasAbandonadas: 0, resolvidasCreated: 0 })
    disponivelMock.mockReset().mockResolvedValue(true)
    terminados.length = 0
  })

  afterEach(async () => {
    await queue.obliterate({ force: true }).catch(() => {})
  })

  afterAll(async () => {
    await worker.close(true).catch(() => {})
    await queue.obliterate({ force: true }).catch(() => {})
    await queue.close().catch(() => {})
  })

  /** Dispara UMA rodada do varredor pelo caminho de produção (job na fila, worker real) e espera ela terminar. */
  async function rodada(): Promise<{ ok: boolean; mensagem?: string }> {
    await queue.add('scan', {})
    await waitFor(async () => terminados.length > 0, { timeoutMs: 15_000, what: 'a rodada do varredor terminar' })
    return terminados[0]
  }

  it('gateway disponível: varre os intents de pré-autorização E reenfileira as capturas pendentes (gatewayDisponivel: true)', async () => {
    const r = await rodada()

    expect(r.ok).toBe(true)
    expect(varrerMock).toHaveBeenCalledTimes(1)
    expect(reenfileirarMock).toHaveBeenCalledTimes(1)
    expect(reenfileirarMock).toHaveBeenCalledWith({ gatewayDisponivel: true })
  })

  it('gateway INDISPONÍVEL (produção sem credencial / config ilegível): a rodada NÃO chama a Cielo (não varre) mas a rede de segurança roda e só alerta (gatewayDisponivel: false)', async () => {
    disponivelMock.mockResolvedValue(false)

    const r = await rodada()

    expect(r.ok).toBe(true) // não falha a rodada (não vira retry em loop)
    expect(varrerMock).not.toHaveBeenCalled()
    expect(reenfileirarMock).toHaveBeenCalledTimes(1)
    expect(reenfileirarMock).toHaveBeenCalledWith({ gatewayDisponivel: false })
  })

  it('a varredura de pré-autorizações FALHAR não impede a rede de segurança da captura de rodar — e o erro continua visível (a rodada falha)', async () => {
    varrerMock.mockRejectedValue(new Error('Cielo fora do ar na varredura A/B'))

    const r = await rodada()

    expect(reenfileirarMock).toHaveBeenCalledTimes(1)
    expect(reenfileirarMock).toHaveBeenCalledWith({ gatewayDisponivel: true })
    expect(r.ok).toBe(false)
    expect(r.mensagem).toContain('Cielo fora do ar na varredura A/B')
  })
})
