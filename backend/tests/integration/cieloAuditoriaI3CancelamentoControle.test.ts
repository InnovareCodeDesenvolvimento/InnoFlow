import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { logger } from '../../src/lib/logger'
import { FakeAdapter } from '../../src/services/pagamentos/fakeAdapter'
import { cancelarPreAutorizacaoCartao } from '../../src/services/pagamentos/cancelarPreAutorizacaoCartao'
import { MAX_INDEFINIDOS_ATE_REVISAO, backoffSegundos, chaveLockCancelamento, limparControleCancelamento } from '../../src/services/pagamentos/controleCancelamentoPreAuth'
import { adquirirLock } from '../../src/lib/redisLock'
import { varrerPreAutorizacoesCartao } from '../../src/services/pagamentos/varrerPreAutorizacoesCartao'

// BANCO PRÓPRIO: o varredor olha TODOS os intents AUTHORIZED/CREATED do banco; no compartilhado ele varreria (e cancelaria) intents de outras suítes em paralelo. `vi.hoisted` assíncrono roda antes dos imports estáticos.
const banco = await vi.hoisted(async () => {
  const { criarBancoProprio } = await import('./helpers/bancoProprio')
  return criarBancoProprio('cielo_aud_i3')
})

/**
 * I-3 da auditoria — o cancelamento de pré-autorização que a Cielo recusa/não confirma não pode ser repetido para sempre: contador, backoff e parada por intent (Redis),
 * alerta limitado a 1x/h, lock por intent e "consulta FAILED -> só espelha". Postgres + Redis reais; a Cielo é o `FakeAdapter`.
 * Um estado `VOID_FAILED` no banco exigiria enum novo (Cronos): aqui a parada fica em Redis (30 dias) e o intent segue AUTHORIZED com alerta de revisão manual.
 */

describe('I-3 — controle de repetição do cancelamento de pré-autorização', () => {
  afterEach(() => vi.restoreAllMocks())
  afterAll(async () => {
    await prisma.$disconnect()
    redis.disconnect()
    await banco.descartar()
  })

  async function preAutorizacao(f: FakeAdapter, opcoes: { cardToken?: string } = {}) {
    const user = await prisma.user.create({ data: { role: 'DRIVER', name: `Driver i3 ${randomUUID().slice(0, 6)}`, email: `i3-${randomUUID()}@example.com` } })
    const intent = await prisma.paymentIntent.create({
      data: { purpose: 'SESSION_CARD_CAPTURE', provider: 'CIELO_CARD', userId: user.id, amountRequestedCents: 1_000, status: 'CREATED', environment: 'SANDBOX' },
    })
    const aut = await f.autorizar({ merchantOrderId: intent.id, amountRequestedCents: 1_000, cartao: { cardToken: opcoes.cardToken ?? 'tok' }, cliente: { name: 'N' } })
    const authToken = await prisma.authToken.create({ data: { idTag: `V${randomUUID().replace(/-/g, '')}`.slice(0, 20), type: 'VIRTUAL', userId: user.id, status: 'ACCEPTED' } })
    await prisma.paymentIntent.update({
      where: { id: intent.id },
      data: { status: 'AUTHORIZED', cieloPaymentId: aut.providerPaymentId, returnCode: '00', amountAuthorizedCents: 1_000, authorizedAt: new Date(Date.now() - 3600_000), authTokenId: authToken.id },
    })
    return { intentId: intent.id, authTokenId: authToken.id, paymentId: aut.providerPaymentId }
  }
  const estado = (id: string) => prisma.paymentIntent.findUniqueOrThrow({ where: { id } })
  const alertasDe = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls.map((c) => (c[0] as { alert?: string }).alert)

  it('RECUSADO definitivo: alerta payment_void_refused + payment_void_manual_review UMA vez, PARA de repetir (nenhuma nova chamada à Cielo) e o intent segue AUTHORIZED', async () => {
    const f = new FakeAdapter({ modoCancelamento: 'RECUSADO' })
    const p = await preAutorizacao(f)
    const erro = vi.spyOn(logger, 'error')

    expect(await cancelarPreAutorizacaoCartao(p.intentId, f)).toBe(false)
    expect(f.contagemCancelar(p.paymentId)).toBe(1)
    expect(alertasDe(erro)).toEqual(expect.arrayContaining(['payment_void_refused', 'payment_void_manual_review']))
    expect(await redis.exists(`card-void:stop:${p.intentId}`)).toBe(1)

    // varreduras seguintes: nenhuma chamada à Cielo (nem consulta), nenhum alerta novo
    erro.mockClear()
    const consultas = vi.spyOn(f, 'consultar')
    for (let i = 0; i < 3; i++) expect(await cancelarPreAutorizacaoCartao(p.intentId, f)).toBe(false)
    expect(f.contagemCancelar(p.paymentId)).toBe(1)
    expect(consultas).not.toHaveBeenCalled()
    expect(alertasDe(erro)).toEqual([])
    expect((await estado(p.intentId)).status).toBe('AUTHORIZED')
    expect(await prisma.authToken.findUniqueOrThrow({ where: { id: p.authTokenId } }).then((t) => t.status)).toBe('ACCEPTED')
  })

  it('o intent PARADO não gasta o lote do varredor: o varredor pula sem chamar a Cielo e ainda processa os outros', async () => {
    const f = new FakeAdapter({ modoCancelamento: 'RECUSADO' })
    const parado = await preAutorizacao(f)
    await cancelarPreAutorizacaoCartao(parado.intentId, f) // para
    f.definirModoCancelamento('NORMAL')
    const normal = await preAutorizacao(f)
    const r = await varrerPreAutorizacoesCartao(f)
    expect(r.canceladasAbandonadas).toBeGreaterThanOrEqual(1)
    expect((await estado(normal.intentId)).status).toBe('VOIDED')
    expect((await estado(parado.intentId)).status).toBe('AUTHORIZED')
    expect(f.contagemCancelar(parado.paymentId)).toBe(1)
  })

  it('EM_ANDAMENTO: backoff crescente — a rodada seguinte NÃO chama a Cielo; depois do backoff consulta e, se já cancelada lá, só espelha', async () => {
    const f = new FakeAdapter({ modoCancelamento: 'EM_ANDAMENTO' })
    const p = await preAutorizacao(f)
    expect(await cancelarPreAutorizacaoCartao(p.intentId, f)).toBe(false)
    expect(f.contagemCancelar(p.paymentId)).toBe(1)
    expect(await redis.ttl(`card-void:next:${p.intentId}`)).toBeGreaterThan(0)

    // dentro do backoff: nada
    expect(await cancelarPreAutorizacaoCartao(p.intentId, f)).toBe(false)
    expect(f.contagemCancelar(p.paymentId)).toBe(1)

    // o cancelamento "em andamento" conclui lá; o backoff vence -> a consulta vê VOIDED e só espelha, SEM novo void
    f.definirModoCancelamento('NORMAL')
    await f.cancelar(p.paymentId)
    expect(f.contagemCancelar(p.paymentId)).toBe(2)
    await redis.del(`card-void:next:${p.intentId}`)
    expect(await cancelarPreAutorizacaoCartao(p.intentId, f)).toBe(true)
    expect(f.contagemCancelar(p.paymentId)).toBe(2)
    expect((await estado(p.intentId)).status).toBe('VOIDED')
  })

  it('backoff: 60 s, 120 s, 240 s... com teto de 3600 s', () => {
    expect([1, 2, 3, 4].map(backoffSegundos)).toEqual([60, 120, 240, 480])
    expect(backoffSegundos(20)).toBe(3_600)
  })

  it('INDEFINIDO repetido: depois de MAX_INDEFINIDOS_ATE_REVISAO desfechos seguidos vira revisão manual e para', async () => {
    const f = new FakeAdapter({ modoCancelamento: 'INDEFINIDO' })
    const p = await preAutorizacao(f)
    const erro = vi.spyOn(logger, 'error')
    for (let i = 1; i <= MAX_INDEFINIDOS_ATE_REVISAO; i++) {
      await redis.del(`card-void:next:${p.intentId}`) // simula o backoff vencido
      await cancelarPreAutorizacaoCartao(p.intentId, f)
      expect(f.contagemCancelar(p.paymentId)).toBe(i)
    }
    expect(alertasDe(erro)).toContain('payment_void_manual_review')
    expect(await redis.exists(`card-void:stop:${p.intentId}`)).toBe(1)
    await cancelarPreAutorizacaoCartao(p.intentId, f)
    expect(f.contagemCancelar(p.paymentId)).toBe(MAX_INDEFINIDOS_ATE_REVISAO) // parou
  })

  it('o alerta payment_void_refused sai NO MÁXIMO 1x/hora por intent (mesmo reativando as tentativas)', async () => {
    const f = new FakeAdapter({ modoCancelamento: 'RECUSADO' })
    const p = await preAutorizacao(f)
    const erro = vi.spyOn(logger, 'error')
    await cancelarPreAutorizacaoCartao(p.intentId, f)
    await redis.del(`card-void:stop:${p.intentId}`) // alguém liberou a parada: tenta de novo
    await cancelarPreAutorizacaoCartao(p.intentId, f)
    expect(f.contagemCancelar(p.paymentId)).toBe(2)
    expect(alertasDe(erro).filter((a) => a === 'payment_void_refused')).toHaveLength(1)
  })

  it('consulta FAILED (a Cielo diz negada/abortada): NÃO tenta void, só espelha — intent FAILED e idTag expirado', async () => {
    const f = new FakeAdapter({ cardTokensNegados: ['negado'] })
    const p = await preAutorizacao(f, { cardToken: 'negado' }) // o Fake guarda a venda como FAILED
    expect(await cancelarPreAutorizacaoCartao(p.intentId, f)).toBe(false)
    expect(f.contagemCancelar(p.paymentId)).toBe(0)
    expect((await estado(p.intentId)).status).toBe('FAILED')
    expect(await prisma.authToken.findUniqueOrThrow({ where: { id: p.authTokenId } }).then((t) => t.status)).toBe('EXPIRED')
  })

  it('LOCK por intent: duas execuções simultâneas (varredor A x finalizarSessao) fazem UM só cancelamento; a segunda desiste sem chamar a Cielo', async () => {
    const f = new FakeAdapter()
    const p = await preAutorizacao(f)
    const real = f.consultar.bind(f)
    vi.spyOn(f, 'consultar').mockImplementation(async (id) => {
      await new Promise((r) => setTimeout(r, 120)) // segura o 1º dentro do lock
      return real(id)
    })
    const [a, b] = await Promise.all([cancelarPreAutorizacaoCartao(p.intentId, f), cancelarPreAutorizacaoCartao(p.intentId, f)])
    expect([a, b].sort()).toEqual([false, true])
    expect(f.contagemCancelar(p.paymentId)).toBe(1)
    expect((await estado(p.intentId)).status).toBe('VOIDED')
    expect(await redis.exists(chaveLockCancelamento(p.intentId))).toBe(0) // lock liberado
  })

  it('lock já tomado por outro dono: não chama a Cielo (nem consulta) e devolve false', async () => {
    const f = new FakeAdapter()
    const p = await preAutorizacao(f)
    const token = await adquirirLock(redis, chaveLockCancelamento(p.intentId), 30_000)
    expect(token).not.toBeNull()
    const consultas = vi.spyOn(f, 'consultar')
    expect(await cancelarPreAutorizacaoCartao(p.intentId, f)).toBe(false)
    expect(consultas).not.toHaveBeenCalled()
    await redis.del(chaveLockCancelamento(p.intentId))
    await limparControleCancelamento(p.intentId)
  })
})
