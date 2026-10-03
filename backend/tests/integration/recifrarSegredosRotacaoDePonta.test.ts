import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { criarBancoProprio } from './helpers/bancoProprio'
import { HASH_SENHA_ADMIN_TESTE } from './helpers/senhaAdmin'

/**
 * QA da Íris (F5.8, rodada Vega-2) — a rotação de `PAYMENT_SECRETS_KEY` de PONTA A PONTA e nas bordas que o teste do Vega não toca:
 *  1) depois de `--apply` e de REMOVER `PAYMENT_SECRETS_KEY_PREVIOUS`, o que importa continua funcionando pelos caminhos REAIS da aplicação: o
 *     cartão decifra (o mesmo `decryptPaymentSecret` do uso em sessão), `GET /api/admin/payment-gateway` diz `secretsDecryptable: true` e os 3
 *     segredos do gateway decifram — não só `decryptAesGcmComChaves` chamado à mão;
 *  2) paginação: o script lê os cartões de 200 em 200 (`take: PAGINA` + cursor) — 450 cartões legados são TODOS re-cifrados (sem pular nem repetir);
 *  3) legado que nenhuma chave decifra é "ilegível" (exit 1), nunca apagado nem tratado como "já na chave atual";
 *  4) `PAYMENT_SECRETS_KEY_PREVIOUS` lixo não impede re-cifrar o que a chave anterior VÁLIDA... (aqui: o que a atual decifra segue valendo, o
 *     resto vira ilegível — nada lança);
 *  6) COMPARE-AND-SET da CONFIG do gateway (mutante R3b sobreviveu: o teste do Vega só exercita o CAS dos cartões): uma gravação do admin ENTRE a leitura
 *     e a regravação do script não é pisada;
 *  5) ACHADO (`it.fails`): `v1:<kid ATUAL>:<corpo corrompido>` é contado como "já na chave atual" SEM decifrar — o relatório diz "ilegíveis: 0" e
 *     "Concluído" para um valor que NÃO decifra (a idempotência confia no prefixo).
 */

const CHAVE_A = randomBytes(32)
const CHAVE_B = randomBytes(32)

type Mods = {
  createApp: typeof import('../../src/api/app').createApp
  prisma: typeof import('../../src/lib/prisma').prisma
  redis: typeof import('../../src/lib/redis').redis
  env: Record<string, unknown>
  issueToken: typeof import('../../src/lib/jwt').issueToken
  aes: typeof import('../../src/lib/crypto/aesGcm')
  sec: typeof import('../../src/lib/crypto/paymentSecrets')
  rot: typeof import('../../src/services/pagamentos/recifrarSegredos')
  cfg: typeof import('../../src/services/pagamentos/gatewayConfig')
  webhookSecrets: typeof import('../../src/services/pagamentos/webhookCieloSecrets')
}

describe('rotação de PAYMENT_SECRETS_KEY — ponta a ponta e bordas — Postgres real, banco próprio', () => {
  let banco: Awaited<ReturnType<typeof criarBancoProprio>>
  let m: Mods
  let userId = ''
  let n = 0

  beforeAll(async () => {
    banco = await criarBancoProprio('pgq')
    process.env.PAYMENT_SECRETS_KEY = CHAVE_B.toString('base64')
    process.env.PAYMENT_SECRETS_KEY_PREVIOUS = CHAVE_A.toString('base64')
    const [appMod, prismaMod, redisMod, envMod, jwtMod, aesMod, secMod, rotMod, cfgMod, whMod] = await Promise.all([
      import('../../src/api/app'),
      import('../../src/lib/prisma'),
      import('../../src/lib/redis'),
      import('../../src/lib/env'),
      import('../../src/lib/jwt'),
      import('../../src/lib/crypto/aesGcm'),
      import('../../src/lib/crypto/paymentSecrets'),
      import('../../src/services/pagamentos/recifrarSegredos'),
      import('../../src/services/pagamentos/gatewayConfig'),
      import('../../src/services/pagamentos/webhookCieloSecrets'),
    ])
    m = { createApp: appMod.createApp, prisma: prismaMod.prisma, redis: redisMod.redis, env: envMod.env as unknown as Record<string, unknown>, issueToken: jwtMod.issueToken, aes: aesMod, sec: secMod, rot: rotMod, cfg: cfgMod, webhookSecrets: whMod }
    const user = await m.prisma.user.create({ data: { role: 'DRIVER', name: 'Motorista Rotação Ponta', email: `rot-ponta-${Math.random().toString(36).slice(2, 8)}@example.com` } })
    userId = user.id
  }, 120_000)

  afterAll(async () => {
    await m?.prisma.$disconnect()
    m?.redis.disconnect()
    await banco?.descartar()
  }, 60_000)

  const cartao = (ciphertext: string) => m.prisma.paymentMethod.create({ data: { userId, type: 'CREDIT_CARD', cieloCardTokenCiphertext: ciphertext, brand: 'Visa', last4: String(1000 + (n += 1)).slice(-4) } })
  const limparTudo = async () => {
    await m.prisma.paymentMethod.deleteMany()
    await m.prisma.paymentGatewayConfig.deleteMany()
    m.cfg.invalidarCacheConfigGateway()
  }
  function chaves(atual: Buffer, anterior: Buffer | undefined | string) {
    m.env.PAYMENT_SECRETS_KEY = atual.toString('base64')
    m.env.PAYMENT_SECRETS_KEY_PREVIOUS = anterior === undefined ? undefined : typeof anterior === 'string' ? anterior : anterior.toString('base64')
    m.sec.resetPaymentSecretsKeyCacheParaTeste()
  }

  it('1) depois de --apply e SEM a chave anterior: o cartão decifra, secretsDecryptable=true no GET do admin e os 3 segredos do gateway decifram (caminhos reais, não o decifrador chamado à mão)', async () => {
    await limparTudo()
    chaves(CHAVE_B, CHAVE_A)
    const SEG = { merchantKey: 'MKEY-ponta-aaa111', sopClientSecret: 'SOP-ponta-bbb222', webhook: 'WHSECRET-ponta-ccc333-0123456789abcdef' }
    const c = await cartao(m.aes.encryptAesGcm('cardtoken-ponta-ddd444', CHAVE_A)) // legado na chave antiga
    await m.prisma.paymentGatewayConfig.create({
      data: {
        id: 1,
        environment: 'sandbox',
        merchantId: 'mid-ponta',
        merchantKeyCiphertext: m.aes.encryptAesGcm(SEG.merchantKey, CHAVE_A),
        sopClientSecretCiphertext: m.aes.encryptAesGcmV1(SEG.sopClientSecret, CHAVE_A),
        webhookHeaderSecretCiphertext: m.aes.encryptAesGcmV1(SEG.webhook, CHAVE_A),
        cardEnabled: false,
        pixEnabled: false,
      },
    })
    m.cfg.invalidarCacheConfigGateway()

    // ANTES da rotação o GET diz que decifra (a anterior ainda está configurada)
    const admin = await m.prisma.user.create({ data: { role: 'ADMIN', name: 'Admin Rot', email: `admin-rot-${Math.random().toString(36).slice(2, 8)}@example.com`, passwordHash: HASH_SENHA_ADMIN_TESTE } })
    const app = m.createApp()
    const get = () => request(app).get('/api/admin/payment-gateway').set({ Authorization: `Bearer ${m.issueToken({ id: admin.id, role: 'ADMIN', operatorId: null })}` })
    expect((await get()).body.secretsDecryptable).toBe(true)

    const rel = await m.rot.recifrarSegredosDePagamento({ apply: true, prisma: m.prisma })
    expect(rel.totais.ilegiveis).toBe(0)
    expect(rel.totais.recifrados).toBe(4) // 1 cartão + 3 segredos

    // o dono REMOVE a chave anterior e reinicia (novo cache de chaves)
    chaves(CHAVE_B, undefined)
    m.cfg.invalidarCacheConfigGateway()
    expect(m.sec.decryptPaymentSecret((await m.prisma.paymentMethod.findUniqueOrThrow({ where: { id: c.id } })).cieloCardTokenCiphertext)).toBe('cardtoken-ponta-ddd444')
    const gw = await get()
    expect(gw.status).toBe(200)
    expect(gw.body.secretsDecryptable, 'depois da rotação, só com a chave NOVA, os segredos do gateway têm que decifrar').toBe(true)
    const linha = await m.prisma.paymentGatewayConfig.findUniqueOrThrow({ where: { id: 1 } })
    expect(m.sec.decryptPaymentSecret(linha.merchantKeyCiphertext!)).toBe(SEG.merchantKey)
    expect(m.sec.decryptPaymentSecret(linha.sopClientSecretCiphertext!)).toBe(SEG.sopClientSecret)
    expect(m.sec.decryptPaymentSecret(linha.webhookHeaderSecretCiphertext!)).toBe(SEG.webhook)
    // o webhook (outra leitura dos segredos, com o cache da config) também enxerga o segredo
    expect(await m.webhookSecrets.getCieloWebhookHeaderSecret()).toBe(SEG.webhook)
  })

  it('2) paginação: 450 cartões legados (3 páginas de 200) são TODOS re-cifrados — nenhum pulado, nenhum duplicado — e todos decifram só com a chave nova', async () => {
    await limparTudo()
    chaves(CHAVE_B, CHAVE_A)
    const total = 450
    await m.prisma.paymentMethod.createMany({
      data: Array.from({ length: total }, (_, i) => ({ userId, type: 'CREDIT_CARD' as const, cieloCardTokenCiphertext: m.aes.encryptAesGcm(`tok-pag-${i}`, CHAVE_A), brand: 'Visa', last4: '0000' })),
    })
    const dry = await m.rot.recifrarSegredosDePagamento({ apply: false, prisma: m.prisma })
    expect(dry.alvos[0]).toMatchObject({ total, aRecifrar: total, recifrados: 0, ilegiveis: 0 })
    const rel = await m.rot.recifrarSegredosDePagamento({ apply: true, prisma: m.prisma })
    expect(rel.alvos[0]).toMatchObject({ total, recifrados: total, ilegiveis: 0, alteradosDuranteExecucao: 0 })
    const depois = await m.rot.recifrarSegredosDePagamento({ apply: false, prisma: m.prisma })
    expect(depois.alvos[0]).toMatchObject({ total, jaNaChaveAtual: total, aRecifrar: 0 })

    chaves(CHAVE_B, undefined) // sem a anterior
    const linhas = await m.prisma.paymentMethod.findMany()
    const claros = new Set(linhas.map((l) => m.sec.decryptPaymentSecret(l.cieloCardTokenCiphertext)))
    expect(claros.size).toBe(total) // todos distintos e todos decifráveis
  }, 60_000)

  it('3) legado que NENHUMA chave decifra é "ilegível": contado, listado por id, deixado como está — nunca apagado nem "já na chave atual"', async () => {
    await limparTudo()
    chaves(CHAVE_B, CHAVE_A)
    const perdida = randomBytes(32)
    const original = m.aes.encryptAesGcm('tok-legado-perdido', perdida)
    const c = await cartao(original)
    const rel = await m.rot.recifrarSegredosDePagamento({ apply: true, prisma: m.prisma })
    expect(rel.alvos[0]).toMatchObject({ total: 1, ilegiveis: 1, recifrados: 0, jaNaChaveAtual: 0, idsIlegiveis: [c.id] })
    expect((await m.prisma.paymentMethod.findUniqueOrThrow({ where: { id: c.id } })).cieloCardTokenCiphertext).toBe(original)
  })

  it('4) PAYMENT_SECRETS_KEY_PREVIOUS inválida (lixo): não lança nem derruba o que a chave ATUAL decifra; o que dependia da anterior vira ilegível', async () => {
    await limparTudo()
    chaves(CHAVE_B, 'isto-nao-e-uma-chave-de-32-bytes')
    const atual = await cartao(m.aes.encryptAesGcmV1('tok-atual-lixo', CHAVE_B))
    const antigo = await cartao(m.aes.encryptAesGcm('tok-antigo-lixo', CHAVE_A))
    const rel = await m.rot.recifrarSegredosDePagamento({ apply: true, prisma: m.prisma })
    expect(rel.alvos[0]).toMatchObject({ total: 2, jaNaChaveAtual: 1, ilegiveis: 1, recifrados: 0 })
    expect(rel.alvos[0]!.idsIlegiveis).toEqual([antigo.id])
    expect(m.sec.decryptPaymentSecret((await m.prisma.paymentMethod.findUniqueOrThrow({ where: { id: atual.id } })).cieloCardTokenCiphertext)).toBe('tok-atual-lixo')
  })

  // ACHADO (severidade baixa, NÃO corrigido): `avaliar()` em `recifrarSegredos.ts` decide "JA_NA_ATUAL" olhando só o PREFIXO (`ciphertextEstaNaChaveAtual`
  // compara o `kid`), sem decifrar. Um `v1:<kid atual>:<corpo corrompido/truncado>` entra como "já na chave atual": `ilegíveis: 0`, exit 0 e a frase
  // "Concluído: tudo está na chave atual" — para um valor que NÃO decifra. O script é justamente o portão que o dono usa para decidir se já pode remover a chave
  // anterior; ele deveria acusar esse valor como ilegível (decifrar uma vez custa 1 AES-GCM). Se for corrigido, trocar `it.fails` por `it`.
  it.fails('5) ACHADO: `v1:<kid atual>:<corpo corrompido>` deveria ser contado como ILEGÍVEL (hoje é "já na chave atual" e o script diz Concluído)', async () => {
    await limparTudo()
    chaves(CHAVE_B, CHAVE_A)
    const bom = m.aes.encryptAesGcmV1('tok-vai-corromper', CHAVE_B)
    const [prefixoV, kid, corpo] = bom.split(':') as [string, string, string]
    const buf = Buffer.from(corpo, 'base64')
    buf[buf.length - 1] = buf[buf.length - 1]! ^ 0xff // quebra o auth tag do GCM
    const c = await cartao(`${prefixoV}:${kid}:${buf.toString('base64')}`)
    const rel = await m.rot.recifrarSegredosDePagamento({ apply: true, prisma: m.prisma })
    expect(rel.alvos[0]).toMatchObject({ total: 1, ilegiveis: 1, idsIlegiveis: [c.id] })
  })

  it('6) COMPARE-AND-SET da config do gateway: o admin troca um segredo ENTRE a leitura e a regravação do script — o script não pisa nele (alterado durante a execução) e o valor novo sobrevive', async () => {
    await limparTudo()
    chaves(CHAVE_B, CHAVE_A)
    await m.prisma.paymentGatewayConfig.create({
      data: { id: 1, environment: 'sandbox', merchantId: 'mid-cas', merchantKeyCiphertext: m.aes.encryptAesGcm('MKEY-velha', CHAVE_A), cardEnabled: false, pixEnabled: false },
    })
    const concorrente = m.aes.encryptAesGcmV1('MKEY-NOVA-gravada-pelo-admin', CHAVE_B)
    const findUnique = m.prisma.paymentGatewayConfig.findUnique.bind(m.prisma.paymentGatewayConfig)
    const espia = vi.spyOn(m.prisma.paymentGatewayConfig, 'findUnique').mockImplementationOnce((async (...args: Parameters<typeof findUnique>) => {
      const linha = await findUnique(...args)
      await m.prisma.paymentGatewayConfig.update({ where: { id: 1 }, data: { merchantKeyCiphertext: concorrente } }) // o PUT do admin grava depois da leitura do script
      return linha
    }) as never)
    const r = await m.rot.recifrarSegredosDePagamento({ apply: true, prisma: m.prisma })
    espia.mockRestore()
    const alvo = r.alvos.find((a) => a.alvo === 'PaymentGatewayConfig.merchantKeyCiphertext')!
    expect(alvo).toMatchObject({ aRecifrar: 1, recifrados: 0, alteradosDuranteExecucao: 1 })
    expect((await m.prisma.paymentGatewayConfig.findUniqueOrThrow({ where: { id: 1 } })).merchantKeyCiphertext).toBe(concorrente)
    expect(m.rot.formatarRelatorio(r)).toContain('rode de novo')
  })
})
