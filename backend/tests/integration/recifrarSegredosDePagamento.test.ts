import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { criarBancoProprio } from './helpers/bancoProprio'

/**
 * Rotação de PAYMENT_SECRETS_KEY (F5.7) contra Postgres REAL (banco próprio: toca o singleton `PaymentGatewayConfig`): o serviço de re-cifragem e o
 * SCRIPT de verdade (`backend/scripts/recifrarSegredosDePagamento.ts`, processo filho via tsx) — dry-run por padrão, `--apply` grava, idempotente, só
 * contagens na saída, ilegível nunca é apagado, auditoria sem segredo.
 *
 * Cenário: chave ANTIGA (A) gravou segredos nos dois formatos (legado sem prefixo e `v1`); a chave NOVA (B) é a atual e A é a anterior.
 *
 * SEQUENCIAL DE PROPÓSITO (dry-run -> apply -> idempotência, mesmo banco): NÃO rode com `--sequence.shuffle` (quebra por desenho, não é bug). A ordem de declaração dos `it` é o roteiro.
 */

const CHAVE_A = randomBytes(32)
const CHAVE_B = randomBytes(32)
const CHAVE_PERDIDA = randomBytes(32) // uma chave que ninguém mais tem configurada

const TOKENS = { legado: 'cardtoken-legado-aaa111', v1Antigo: 'cardtoken-v1-antigo-bbb222', v1Atual: 'cardtoken-v1-atual-ccc333', perdido: 'cardtoken-perdido-ddd444' }
const CONFIG = { merchantKey: 'MKEY-rotacao-eee555', sopClientSecret: 'SOPSECRET-rotacao-fff666', webhookHeaderSecret: 'WHSECRET-rotacao-ggg777-0123456789abcdef' }

type Mods = {
  prisma: typeof import('../../src/lib/prisma').prisma
  redis: typeof import('../../src/lib/redis').redis
  aes: typeof import('../../src/lib/crypto/aesGcm')
  sec: typeof import('../../src/lib/crypto/paymentSecrets')
  rot: typeof import('../../src/services/pagamentos/recifrarSegredos')
}

describe('rotação da PAYMENT_SECRETS_KEY — re-cifragem (serviço + script) contra Postgres real', () => {
  let banco: Awaited<ReturnType<typeof criarBancoProprio>>
  let m: Mods
  const ids: Record<string, string> = {}
  let userId = ''
  let updatedAtConfig: Date

  beforeAll(async () => {
    banco = await criarBancoProprio('pgx')
    process.env.PAYMENT_SECRETS_KEY = CHAVE_B.toString('base64')
    process.env.PAYMENT_SECRETS_KEY_PREVIOUS = CHAVE_A.toString('base64')
    const [prismaMod, redisMod, aesMod, secMod, rotMod] = await Promise.all([
      import('../../src/lib/prisma'),
      import('../../src/lib/redis'),
      import('../../src/lib/crypto/aesGcm'),
      import('../../src/lib/crypto/paymentSecrets'),
      import('../../src/services/pagamentos/recifrarSegredos'),
    ])
    m = { prisma: prismaMod.prisma, redis: redisMod.redis, aes: aesMod, sec: secMod, rot: rotMod }

    const user = await m.prisma.user.create({ data: { role: 'DRIVER', name: 'Motorista Rotação', email: `rotacao-${Math.random().toString(36).slice(2, 8)}@example.com` } })
    userId = user.id
    const novoCartao = async (rotulo: string, ciphertext: string, active = true) => {
      const pm = await m.prisma.paymentMethod.create({ data: { userId, type: 'CREDIT_CARD', cieloCardTokenCiphertext: ciphertext, brand: 'Visa', last4: '4242', active } })
      ids[rotulo] = pm.id
    }
    await novoCartao('legado', m.aes.encryptAesGcm(TOKENS.legado, CHAVE_A)) // formato de antes da F5.7, chave antiga
    await novoCartao('v1Antigo', m.aes.encryptAesGcmV1(TOKENS.v1Antigo, CHAVE_A)) // v1 com a chave antiga
    await novoCartao('v1Atual', m.aes.encryptAesGcmV1(TOKENS.v1Atual, CHAVE_B)) // já na chave nova
    await novoCartao('inativo', m.aes.encryptAesGcm('cardtoken-inativo-hhh888', CHAVE_A), false) // cartão removido também é re-cifrado
    await novoCartao('perdido', m.aes.encryptAesGcmV1(TOKENS.perdido, CHAVE_PERDIDA)) // chave que ninguém tem mais

    const cfg = await m.prisma.paymentGatewayConfig.create({
      data: {
        id: 1,
        environment: 'sandbox',
        merchantId: 'mid-rotacao',
        merchantKeyCiphertext: m.aes.encryptAesGcm(CONFIG.merchantKey, CHAVE_A), // legado
        sopClientSecretCiphertext: m.aes.encryptAesGcmV1(CONFIG.sopClientSecret, CHAVE_A), // v1 antigo
        webhookHeaderSecretCiphertext: m.aes.encryptAesGcmV1(CONFIG.webhookHeaderSecret, CHAVE_B), // já na atual
        cardEnabled: false,
        pixEnabled: false,
      },
    })
    updatedAtConfig = cfg.updatedAt
  }, 120_000)

  afterAll(async () => {
    vi.restoreAllMocks()
    await m?.prisma.$disconnect()
    m?.redis.disconnect()
    await banco?.descartar()
  }, 60_000)

  const lerCartoes = async () => Object.fromEntries((await m.prisma.paymentMethod.findMany({ where: { userId } })).map((p) => [p.id, p.cieloCardTokenCiphertext]))
  const lerConfig = () => m.prisma.paymentGatewayConfig.findUniqueOrThrow({ where: { id: 1 } })
  const alvo = (r: Awaited<ReturnType<Mods['rot']['recifrarSegredosDePagamento']>>, nome: string) => r.alvos.find((a) => a.alvo === nome)!
  const todosSegredosETextosCifrados = () => [...Object.values(TOKENS), ...Object.values(CONFIG), 'cardtoken-inativo-hhh888']

  it('DRY-RUN (padrão): conta o que seria feito e NÃO grava nada — banco idêntico antes e depois', async () => {
    const cartoesAntes = await lerCartoes()
    const configAntes = await lerConfig()
    const r = await m.rot.recifrarSegredosDePagamento({ apply: false, prisma: m.prisma })
    expect(r.apply).toBe(false)
    // cartões: legado + v1Antigo + inativo precisam regravar; v1Atual já está; perdido é ilegível
    expect(alvo(r, 'PaymentMethod.cieloCardTokenCiphertext')).toMatchObject({ total: 5, jaNaChaveAtual: 1, aRecifrar: 3, recifrados: 0, ilegiveis: 1, idsIlegiveis: [ids.perdido] })
    expect(alvo(r, 'PaymentGatewayConfig.merchantKeyCiphertext')).toMatchObject({ total: 1, aRecifrar: 1, recifrados: 0 })
    expect(alvo(r, 'PaymentGatewayConfig.sopClientSecretCiphertext')).toMatchObject({ total: 1, aRecifrar: 1, recifrados: 0 })
    expect(alvo(r, 'PaymentGatewayConfig.webhookHeaderSecretCiphertext')).toMatchObject({ total: 1, jaNaChaveAtual: 1, aRecifrar: 0 })
    expect(r.totais).toMatchObject({ total: 8, aRecifrar: 5, recifrados: 0, ilegiveis: 1 })
    expect(await lerCartoes()).toEqual(cartoesAntes)
    expect(await lerConfig()).toEqual(configAntes)
    expect(await m.prisma.auditLog.count({ where: { actionDetail: 'secrets_reencrypted' } })).toBe(0)
  })

  it('o relatório (texto do terminal) tem SÓ contagens: nenhum segredo, texto de cartão nem ciphertext', async () => {
    const r = await m.rot.recifrarSegredosDePagamento({ apply: false, prisma: m.prisma })
    const texto = m.rot.formatarRelatorio(r) + JSON.stringify(r)
    for (const s of todosSegredosETextosCifrados()) expect(texto).not.toContain(s)
    for (const c of Object.values(await lerCartoes())) expect(texto).not.toContain(c)
    const cfg = await lerConfig()
    for (const c of [cfg.merchantKeyCiphertext!, cfg.sopClientSecretCiphertext!, cfg.webhookHeaderSecretCiphertext!]) expect(texto).not.toContain(c)
    expect(texto).toContain('DRY-RUN')
    expect(texto).toContain('ilegíveis: 1')
    expect(texto).toContain('NÃO remova a chave anterior')
  })

  it('--apply (serviço): re-cifra tudo o que decifra com a chave NOVA em `v1:<kid B>:`, preserva `updatedAt` da config, NUNCA toca no ilegível, e grava UMA auditoria só com contagens', async () => {
    const perdidoAntes = (await lerCartoes())[ids.perdido]
    const r = await m.rot.recifrarSegredosDePagamento({ apply: true, prisma: m.prisma })
    expect(r.totais).toMatchObject({ aRecifrar: 5, recifrados: 5, ilegiveis: 1, alteradosDuranteExecucao: 0 })

    const kidB = m.aes.keyId(CHAVE_B)
    const cartoes = await lerCartoes()
    for (const rotulo of ['legado', 'v1Antigo', 'v1Atual', 'inativo']) expect(cartoes[ids[rotulo]!]!.startsWith(`v1:${kidB}:`), rotulo).toBe(true)
    // decifram com a chave nova SOZINHA (sem a anterior): a rotação terminou para eles
    const soB = { atual: CHAVE_B }
    expect(m.aes.decryptAesGcmComChaves(cartoes[ids.legado]!, soB)).toBe(TOKENS.legado)
    expect(m.aes.decryptAesGcmComChaves(cartoes[ids.v1Antigo]!, soB)).toBe(TOKENS.v1Antigo)
    expect(m.aes.decryptAesGcmComChaves(cartoes[ids.v1Atual]!, soB)).toBe(TOKENS.v1Atual)
    // o ilegível ficou EXATAMENTE como estava (nunca apagado nem "consertado")
    expect(cartoes[ids.perdido]).toBe(perdidoAntes)

    const cfg = await lerConfig()
    expect(m.aes.decryptAesGcmComChaves(cfg.merchantKeyCiphertext!, soB)).toBe(CONFIG.merchantKey)
    expect(m.aes.decryptAesGcmComChaves(cfg.sopClientSecretCiphertext!, soB)).toBe(CONFIG.sopClientSecret)
    expect(m.aes.decryptAesGcmComChaves(cfg.webhookHeaderSecretCiphertext!, soB)).toBe(CONFIG.webhookHeaderSecret)
    expect(cfg.updatedAt.getTime()).toBe(updatedAtConfig.getTime()) // re-cifrar não é "alteração de configuração"
    expect(cfg).toMatchObject({ merchantId: 'mid-rotacao', environment: 'sandbox', cardEnabled: false, pixEnabled: false }) // nada além do ciphertext mudou

    // a aplicação (que lê com atual+anterior) continua lendo tudo
    expect(m.sec.decryptPaymentSecret(cartoes[ids.legado]!)).toBe(TOKENS.legado)

    const auditorias = await m.prisma.auditLog.findMany({ where: { actionDetail: 'secrets_reencrypted' } })
    expect(auditorias).toHaveLength(1)
    expect(auditorias[0]).toMatchObject({ actorRole: 'SYSTEM', action: 'PAYMENT_CONFIG_CHANGE', entityType: 'PaymentGatewayConfig', outcome: 'SUCCESS' })
    const textoAuditoria = JSON.stringify(auditorias)
    for (const s of todosSegredosETextosCifrados()) expect(textoAuditoria).not.toContain(s)
    for (const c of Object.values(cartoes)) expect(textoAuditoria).not.toContain(c)
  })

  it('IDEMPOTENTE: rodar --apply de novo não regrava nada (já na chave atual), sem nova auditoria', async () => {
    const antes = await lerCartoes()
    const configAntes = await lerConfig()
    const r = await m.rot.recifrarSegredosDePagamento({ apply: true, prisma: m.prisma })
    expect(r.totais).toMatchObject({ aRecifrar: 0, recifrados: 0, jaNaChaveAtual: 7, ilegiveis: 1 })
    expect(await lerCartoes()).toEqual(antes)
    expect(await lerConfig()).toEqual(configAntes)
    expect(await m.prisma.auditLog.count({ where: { actionDetail: 'secrets_reencrypted' } })).toBe(1)
  })

  it('COMPARE-AND-SET: se a API gravou um cartão ENTRE a leitura e a regravação, o script não pisa nele (conta como alterado durante a execução)', async () => {
    const velho = await m.prisma.paymentMethod.create({ data: { userId, type: 'CREDIT_CARD', cieloCardTokenCiphertext: m.aes.encryptAesGcm('cardtoken-corrida', CHAVE_A), brand: 'Visa', last4: '1111' } })
    const concorrente = m.aes.encryptAesGcmV1('cardtoken-corrida-regravado-pela-api', CHAVE_B)
    const findMany = m.prisma.paymentMethod.findMany.bind(m.prisma.paymentMethod)
    const espia = vi.spyOn(m.prisma.paymentMethod, 'findMany').mockImplementationOnce((async (...args: Parameters<typeof findMany>) => {
      const lote = await findMany(...args)
      await m.prisma.paymentMethod.update({ where: { id: velho.id }, data: { cieloCardTokenCiphertext: concorrente } }) // a "API" grava depois da leitura do script
      return lote
    }) as never)
    const r = await m.rot.recifrarSegredosDePagamento({ apply: true, prisma: m.prisma })
    espia.mockRestore()
    expect(alvo(r, 'PaymentMethod.cieloCardTokenCiphertext').alteradosDuranteExecucao).toBe(1)
    expect((await m.prisma.paymentMethod.findUniqueOrThrow({ where: { id: velho.id } })).cieloCardTokenCiphertext).toBe(concorrente) // a escrita da API sobreviveu
    expect(m.rot.formatarRelatorio(r)).toContain('rode de novo')
  })

  describe('o SCRIPT de verdade (processo filho, tsx)', () => {
    function rodar(args: string[], env: Record<string, string | undefined>) {
      const filho = spawnSync(process.execPath, [join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'scripts/recifrarSegredosDePagamento.ts', ...args], {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: banco.url, ...env },
        encoding: 'utf8',
        timeout: 90_000,
      })
      return { codigo: filho.status, saida: `${filho.stdout}${filho.stderr}` }
    }
    const chaves = { PAYMENT_SECRETS_KEY: CHAVE_B.toString('base64'), PAYMENT_SECRETS_KEY_PREVIOUS: CHAVE_A.toString('base64') }

    it('prepara um estado "ainda na chave antiga" (legado + v1 antigo) e o DRY-RUN do script não grava nada, avisa o ilegível e sai com 1', async () => {
      const c1 = await m.prisma.paymentMethod.create({ data: { userId, type: 'CREDIT_CARD', cieloCardTokenCiphertext: m.aes.encryptAesGcm('cardtoken-script-legado', CHAVE_A), brand: 'Visa', last4: '2222' } })
      const c2 = await m.prisma.paymentMethod.create({ data: { userId, type: 'CREDIT_CARD', cieloCardTokenCiphertext: m.aes.encryptAesGcmV1('cardtoken-script-v1', CHAVE_A), brand: 'Visa', last4: '3333' } })
      ids.script1 = c1.id
      ids.script2 = c2.id
      const antes = await lerCartoes()
      const r = rodar([], chaves)
      expect(r.saida).toContain('DRY-RUN')
      expect(r.saida).toContain('a re-cifrar')
      expect(r.saida).toContain(ids.perdido!) // o id do cartão ilegível aparece; o valor nunca
      expect(r.codigo).toBe(1) // há ilegível => a rotação NÃO está concluída
      expect(await lerCartoes()).toEqual(antes)
      for (const s of [...todosSegredosETextosCifrados(), 'cardtoken-script-legado', 'cardtoken-script-v1']) expect(r.saida).not.toContain(s)
      for (const c of Object.values(antes)) expect(r.saida).not.toContain(c)
    })

    it('`--apply` grava; a saída tem só contagens; com o ilegível ainda existindo o código de saída é 1', async () => {
      const r = rodar(['--apply'], chaves)
      expect(r.saida).toContain('APLICANDO')
      expect(r.saida).toContain('re-cifrados: 2') // os 2 cartões do passo anterior (o resto já foi re-cifrado nos testes de serviço)
      expect(r.codigo).toBe(1)
      const cartoes = await lerCartoes()
      const kidB = m.aes.keyId(CHAVE_B)
      expect(cartoes[ids.script1!]!.startsWith(`v1:${kidB}:`)).toBe(true)
      expect(cartoes[ids.script2!]!.startsWith(`v1:${kidB}:`)).toBe(true)
      expect(m.aes.decryptAesGcmComChaves(cartoes[ids.script1!]!, { atual: CHAVE_B })).toBe('cardtoken-script-legado')
      expect(r.saida).not.toContain('cardtoken-script')
    })

    it('sem ilegíveis e tudo na chave atual: `--apply` sai com 0 e diz que já pode remover a chave anterior; de novo é um no-op (0 re-cifrados)', async () => {
      await m.prisma.paymentMethod.delete({ where: { id: ids.perdido! } }) // o operador resolveu o cartão perdido (ex.: o motorista cadastrou outro)
      const r = rodar(['--apply'], chaves)
      expect(r.codigo, r.saida).toBe(0)
      expect(r.saida).toContain('Concluído')
      expect(r.saida).toContain('PAYMENT_SECRETS_KEY_PREVIOUS')
      const r2 = rodar(['--apply'], chaves)
      expect(r2.codigo).toBe(0)
      expect(r2.saida).toContain('re-cifrados: 0')
    })

    it('argumento desconhecido (ex.: typo `--aply`) => código 2 e NADA é executado; chave-mestra INDISPONÍVEL (override PAYMENT_SECRETS_KEY inválido; MUDANÇA DELIBERADA: ausente já não indisponibiliza, a chave vem do JWT_SECRET) => código 2 com erro claro (sem segredo)', async () => {
      expect(rodar(['--aply'], chaves).codigo).toBe(2)
      const semChave = rodar([], { PAYMENT_SECRETS_KEY: 'isto-nao-e-uma-chave-base64-de-32-bytes', PAYMENT_SECRETS_KEY_PREVIOUS: CHAVE_A.toString('base64') })
      expect(semChave.codigo).toBe(2)
      expect(semChave.saida).toContain('PAYMENT_SECRETS_KEY')
      expect(semChave.saida).not.toContain(CHAVE_A.toString('base64'))
    })
  })
})
