import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { criarBancoProprio } from './helpers/bancoProprio'

/**
 * L1.4 + rotação de `PAYMENT_SECRETS_KEY` (F5.7): a chave Pix de devolução (`AccountDeletionRequest.refundPixKeyCiphertext`) é cifrada com a MESMA chave dos pagamentos, então a re-cifragem
 * TEM de cobri-la; e o cartão de conta excluída (token = marcador `DESTROYED`, que NÃO é ciphertext) NÃO pode contar como "ilegível" — senão a rotação nunca chegaria a "ilegíveis: 0".
 * Banco próprio (a re-cifragem varre tabelas inteiras e o singleton do gateway).
 *
 * SEQUENCIAL DE PROPÓSITO (o DRY-RUN assume rodar ANTES do APPLY no mesmo banco): NÃO rode com `--sequence.shuffle` (quebra por desenho, não é bug). A ordem de declaração dos `it` é o roteiro.
 */
const CHAVE_A = randomBytes(32) // antiga
const CHAVE_B = randomBytes(32) // atual

describe('rotação da chave cobre a chave Pix de devolução e ignora cartão destruído (L1.4)', () => {
  let banco: Awaited<ReturnType<typeof criarBancoProprio>>
  let prisma: typeof import('../../src/lib/prisma').prisma
  let redisMod: typeof import('../../src/lib/redis')
  let aes: typeof import('../../src/lib/crypto/aesGcm')
  let sec: typeof import('../../src/lib/crypto/paymentSecrets')
  let rot: typeof import('../../src/services/pagamentos/recifrarSegredos')
  const ids: { antiga?: string; atual?: string; entregue?: string } = {}

  beforeAll(async () => {
    banco = await criarBancoProprio('lgpdrot')
    process.env.PAYMENT_SECRETS_KEY = CHAVE_B.toString('base64')
    process.env.PAYMENT_SECRETS_KEY_PREVIOUS = CHAVE_A.toString('base64')
    const [p, r, a, s, ro] = await Promise.all([
      import('../../src/lib/prisma'),
      import('../../src/lib/redis'),
      import('../../src/lib/crypto/aesGcm'),
      import('../../src/lib/crypto/paymentSecrets'),
      import('../../src/services/pagamentos/recifrarSegredos'),
    ])
    prisma = p.prisma
    redisMod = r
    aes = a
    sec = s
    rot = ro

    const novoUsuario = (rotulo: string) => prisma.user.create({ data: { role: 'DRIVER', name: `Rot ${rotulo}`, email: `rot-${rotulo}-${Math.random().toString(36).slice(2, 8)}@example.com` } })
    const u1 = await novoUsuario('antiga')
    const u2 = await novoUsuario('atual')
    const u3 = await novoUsuario('destruido')
    ids.antiga = (await prisma.accountDeletionRequest.create({ data: { userId: u1.id, balanceCentsAtRequest: 1500, refundStatus: 'PENDING_REFUND', refundPixKeyCiphertext: aes.encryptAesGcmV1('chave-pix-antiga@example.com', CHAVE_A) } })).id
    ids.atual = (await prisma.accountDeletionRequest.create({ data: { userId: u2.id, balanceCentsAtRequest: 900, refundStatus: 'PENDING_REFUND', refundPixKeyCiphertext: aes.encryptAesGcmV1('chave-pix-atual@example.com', CHAVE_B) } })).id
    // cartão de conta excluída: marcador, não ciphertext
    await prisma.paymentMethod.create({ data: { userId: u3.id, cieloCardTokenCiphertext: 'DESTROYED', active: false, isDefault: false, brand: 'Visa', last4: '4242' } })
    // e um cartão comum na chave antiga, para provar que o resto da rotação segue funcionando
    await prisma.paymentMethod.create({ data: { userId: u3.id, cieloCardTokenCiphertext: aes.encryptAesGcmV1('cardtoken-comum', CHAVE_A), brand: 'Visa', last4: '1111' } })
  }, 120_000)

  afterAll(async () => {
    await prisma?.$disconnect()
    redisMod?.redis.disconnect()
    await banco?.descartar()
  })

  it('DRY-RUN conta a chave Pix da chave antiga como "a re-cifrar" e NÃO grava nada; cartão DESTROYED não entra na conta', async () => {
    const r = await rot.recifrarSegredosDePagamento({ apply: false, prisma })
    const pix = r.alvos.find((a) => a.alvo === 'AccountDeletionRequest.refundPixKeyCiphertext')!
    expect(pix).toMatchObject({ total: 2, jaNaChaveAtual: 1, aRecifrar: 1, recifrados: 0, ilegiveis: 0 })
    const cartoes = r.alvos.find((a) => a.alvo === 'PaymentMethod.cieloCardTokenCiphertext')!
    expect(cartoes).toMatchObject({ total: 1, aRecifrar: 1, ilegiveis: 0 }) // só o cartão comum; o DESTROYED fica de fora
    expect(r.totais.ilegiveis).toBe(0)
    const linha = await prisma.accountDeletionRequest.findUniqueOrThrow({ where: { id: ids.antiga! } })
    expect(sec.ciphertextEstaNaChaveAtual(linha.refundPixKeyCiphertext!)).toBe(false)
  })

  it('APPLY re-cifra a chave Pix com a chave ATUAL (o texto continua o mesmo), é idempotente e a rotação fecha com ilegíveis = 0', async () => {
    const antes = await prisma.accountDeletionRequest.findUniqueOrThrow({ where: { id: ids.antiga! } })
    const r = await rot.recifrarSegredosDePagamento({ apply: true, prisma })
    expect(r.alvos.find((a) => a.alvo === 'AccountDeletionRequest.refundPixKeyCiphertext')).toMatchObject({ recifrados: 1, ilegiveis: 0 })
    expect(r.totais.ilegiveis).toBe(0)

    const depois = await prisma.accountDeletionRequest.findUniqueOrThrow({ where: { id: ids.antiga! } })
    expect(depois.refundPixKeyCiphertext).not.toBe(antes.refundPixKeyCiphertext)
    expect(sec.ciphertextEstaNaChaveAtual(depois.refundPixKeyCiphertext!)).toBe(true)
    expect(sec.decryptPaymentSecret(depois.refundPixKeyCiphertext!)).toBe('chave-pix-antiga@example.com')
    expect(sec.decryptPaymentSecret((await prisma.accountDeletionRequest.findUniqueOrThrow({ where: { id: ids.atual! } })).refundPixKeyCiphertext!)).toBe('chave-pix-atual@example.com')

    const de_novo = await rot.recifrarSegredosDePagamento({ apply: true, prisma })
    expect(de_novo.totais).toMatchObject({ recifrados: 0, aRecifrar: 0, ilegiveis: 0 })
    expect(rot.formatarRelatorio(de_novo)).toContain('Concluído')
    expect(rot.formatarRelatorio(de_novo)).not.toContain('chave-pix')
  })
})
