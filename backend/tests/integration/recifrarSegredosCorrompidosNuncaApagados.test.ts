import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { criarBancoProprio } from './helpers/bancoProprio'
import { HASH_SENHA_ADMIN_TESTE } from './helpers/senhaAdmin'

/**
 * QA da Íris (F5.8, rodada Vega-4) — a rotação de `PAYMENT_SECRETS_KEY` depois da correção "decifra antes de contar como já na chave atual". O que o `it` do caso 5 da
 * rodada anterior prova é UM corpo corrompido (1 byte do auth tag). Aqui as OUTRAS formas de ilegível, o que NUNCA pode acontecer com elas e o código de saída do script real:
 *  - `v1:<kid ATUAL>:<corpo>` truncado (menor que iv+tag), com o tag adulterado, com lixo não-base64, vazio ("v1:<kid>:") e cifrado com OUTRA chave mas rotulado com o kid atual;
 *  - `v1:<kid ANTERIOR>:<corpo corrompido>`, kid DESCONHECIDO e legado (sem prefixo) truncado — os três pelo caminho "a recifrar";
 *  - NADA é apagado nem reescrito: o texto da coluna fica byte a byte igual, a linha continua existindo, o `updatedAt` da config não muda; o que decifra é regravado normalmente
 *    ao lado dos ilegíveis (um ruim não impede o resto);
 *  - o relatório diz ATENÇÃO (e NÃO "Concluído") e o script real (`npm run payments:recifrar-segredos`) sai com código 1 — o portão que o dono usa para decidir se já pode tirar a chave antiga;
 *  - rodar de novo (idempotência) não muda nada e continua acusando os mesmos ilegíveis; sem ilegíveis o script sai 0 e diz "Concluído".
 */

const CHAVE_A = randomBytes(32) // anterior
const CHAVE_B = randomBytes(32) // atual
const CHAVE_C = randomBytes(32) // nunca configurada

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
}

describe('rotação de PAYMENT_SECRETS_KEY — valores corrompidos viram ilegíveis e NUNCA são apagados — Postgres real, banco próprio', () => {
  let banco: Awaited<ReturnType<typeof criarBancoProprio>>
  let m: Mods
  let userId = ''
  let n = 0

  beforeAll(async () => {
    banco = await criarBancoProprio('pgz')
    process.env.PAYMENT_SECRETS_KEY = CHAVE_B.toString('base64')
    process.env.PAYMENT_SECRETS_KEY_PREVIOUS = CHAVE_A.toString('base64')
    const [appMod, prismaMod, redisMod, envMod, jwtMod, aesMod, secMod, rotMod, cfgMod] = await Promise.all([
      import('../../src/api/app'),
      import('../../src/lib/prisma'),
      import('../../src/lib/redis'),
      import('../../src/lib/env'),
      import('../../src/lib/jwt'),
      import('../../src/lib/crypto/aesGcm'),
      import('../../src/lib/crypto/paymentSecrets'),
      import('../../src/services/pagamentos/recifrarSegredos'),
      import('../../src/services/pagamentos/gatewayConfig'),
    ])
    m = { createApp: appMod.createApp, prisma: prismaMod.prisma, redis: redisMod.redis, env: envMod.env as unknown as Record<string, unknown>, issueToken: jwtMod.issueToken, aes: aesMod, sec: secMod, rot: rotMod, cfg: cfgMod }
    const user = await m.prisma.user.create({ data: { role: 'DRIVER', name: 'Motorista Rotação Corrompidos', email: `rot-corr-${Math.random().toString(36).slice(2, 8)}@example.com` } })
    userId = user.id
    m.env.PAYMENT_SECRETS_KEY = CHAVE_B.toString('base64')
    m.env.PAYMENT_SECRETS_KEY_PREVIOUS = CHAVE_A.toString('base64')
    m.sec.resetPaymentSecretsKeyCacheParaTeste()
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
  /** Gera os valores corrompidos; cada um com um rótulo. */
  function corrompidos() {
    const kidAtual = m.aes.keyId(CHAVE_B)
    const kidAnterior = m.aes.keyId(CHAVE_A)
    const bomAtual = m.aes.encryptAesGcm('tok-corrompido', CHAVE_B) // base64 de iv||tag||ct
    const buf = Buffer.from(bomAtual, 'base64')
    const tagQuebrada = Buffer.from(buf)
    tagQuebrada[14] = tagQuebrada[14]! ^ 0x55 // dentro do auth tag
    const ctQuebrado = Buffer.from(buf)
    ctQuebrado[ctQuebrado.length - 1] = ctQuebrado[ctQuebrado.length - 1]! ^ 0xff
    const outraChave = m.aes.encryptAesGcm('tok-outra-chave', CHAVE_C)
    const bomAnterior = Buffer.from(m.aes.encryptAesGcm('tok-anterior', CHAVE_A), 'base64')
    bomAnterior[bomAnterior.length - 1] = bomAnterior[bomAnterior.length - 1]! ^ 0xff
    const legado = Buffer.from(m.aes.encryptAesGcm('tok-legado', CHAVE_A), 'base64')
    return {
      'v1 atual: corpo truncado (< iv+tag)': `v1:${kidAtual}:${buf.subarray(0, 20).toString('base64')}`,
      'v1 atual: truncado no meio do ciphertext': `v1:${kidAtual}:${buf.subarray(0, buf.length - 2).toString('base64')}`,
      'v1 atual: auth tag adulterado': `v1:${kidAtual}:${tagQuebrada.toString('base64')}`,
      'v1 atual: ciphertext adulterado': `v1:${kidAtual}:${ctQuebrado.toString('base64')}`,
      'v1 atual: lixo não-base64': `v1:${kidAtual}:@@@@!!!!####`,
      'v1 atual: corpo vazio': `v1:${kidAtual}:`,
      'v1 atual: cifrado com OUTRA chave (rótulo mentiroso)': `v1:${kidAtual}:${outraChave}`,
      'v1 anterior: corpo corrompido': `v1:${kidAnterior}:${bomAnterior.toString('base64')}`,
      'v1: kid DESCONHECIDO': `v1:${m.aes.keyId(CHAVE_C)}:${bomAtual}`,
      'v1: versão desconhecida (v2)': `v2:${kidAtual}:${bomAtual}`,
      'legado: truncado': legado.subarray(0, legado.length - 3).toString('base64'),
      'legado: cifrado com chave perdida': outraChave,
    } as Record<string, string>
  }

  it('cada forma de valor corrompido é contada como ILEGÍVEL (nunca "já na chave atual"), em dry-run e em apply, e o relatório NÃO diz "Concluído"', async () => {
    await limparTudo()
    const casos = corrompidos()
    const ids = new Map<string, string>()
    for (const [rotulo, texto] of Object.entries(casos)) ids.set(rotulo, (await cartao(texto)).id)
    for (const apply of [false, true]) {
      const rel = await m.rot.recifrarSegredosDePagamento({ apply, prisma: m.prisma })
      expect(rel.alvos[0], `apply=${apply}`).toMatchObject({ total: Object.keys(casos).length, ilegiveis: Object.keys(casos).length, jaNaChaveAtual: 0, aRecifrar: 0, recifrados: 0 })
      expect([...rel.alvos[0]!.idsIlegiveis].sort()).toEqual([...ids.values()].sort().slice(0, 20))
      const texto = m.rot.formatarRelatorio(rel)
      expect(texto).toContain('ATENÇÃO')
      expect(texto).not.toContain('Concluído')
      expect(texto).not.toContain('Nada a re-cifrar')
      for (const valor of Object.values(casos)) expect(texto, 'o relatório nunca imprime ciphertext').not.toContain(valor)
    }
  })

  it('NADA é apagado nem reescrito: depois de dry-run e de 2 applies o texto de cada coluna corrompida está byte a byte igual e a linha continua lá; o que decifra é regravado ao lado dos ruins', async () => {
    await limparTudo()
    const casos = corrompidos()
    const antes = new Map<string, string>()
    for (const texto of Object.values(casos)) antes.set((await cartao(texto)).id, texto)
    const bom = await cartao(m.aes.encryptAesGcm('tok-bom-legado', CHAVE_A)) // decifra com a anterior: será regravado
    const jaAtual = await cartao(m.aes.encryptAesGcmV1('tok-bom-atual', CHAVE_B)) // v1 atual que decifra: fica
    const jaAtualAntes = (await m.prisma.paymentMethod.findUniqueOrThrow({ where: { id: jaAtual.id } })).cieloCardTokenCiphertext

    await m.rot.recifrarSegredosDePagamento({ apply: false, prisma: m.prisma })
    const r1 = await m.rot.recifrarSegredosDePagamento({ apply: true, prisma: m.prisma })
    const r2 = await m.rot.recifrarSegredosDePagamento({ apply: true, prisma: m.prisma })
    expect(r1.alvos[0]).toMatchObject({ total: antes.size + 2, ilegiveis: antes.size, recifrados: 1, jaNaChaveAtual: 1 })
    expect(r2.alvos[0]).toMatchObject({ total: antes.size + 2, ilegiveis: antes.size, recifrados: 0, jaNaChaveAtual: 2 }) // idempotente: o bom já está na atual; os ruins continuam acusados

    expect(await m.prisma.paymentMethod.count()).toBe(antes.size + 2)
    for (const [id, texto] of antes) {
      const linha = await m.prisma.paymentMethod.findUnique({ where: { id } })
      expect(linha, 'a linha do cartão ilegível não pode sumir').not.toBeNull()
      expect(linha!.cieloCardTokenCiphertext, 'o texto da coluna ilegível não pode ser reescrito').toBe(texto)
    }
    expect((await m.prisma.paymentMethod.findUniqueOrThrow({ where: { id: jaAtual.id } })).cieloCardTokenCiphertext).toBe(jaAtualAntes)
    const regravado = (await m.prisma.paymentMethod.findUniqueOrThrow({ where: { id: bom.id } })).cieloCardTokenCiphertext
    expect(regravado).toMatch(/^v1:[0-9a-f]{8}:/)
    expect(m.sec.decryptPaymentSecret(regravado)).toBe('tok-bom-legado')
  })

  it('config do gateway: coluna `v1:<kid atual>:<corpo truncado>` é ilegível, não é pisada e o `updatedAt` não muda; as colunas boas ao lado são regravadas', async () => {
    await limparTudo()
    const kid = m.aes.keyId(CHAVE_B)
    const truncado = `v1:${kid}:${Buffer.from(m.aes.encryptAesGcm('MKEY', CHAVE_B), 'base64').subarray(0, 18).toString('base64')}`
    const criada = await m.prisma.paymentGatewayConfig.create({
      data: { id: 1, environment: 'sandbox', merchantId: 'mid-corr', merchantKeyCiphertext: truncado, sopClientSecretCiphertext: m.aes.encryptAesGcm('SOP-legado', CHAVE_A), webhookHeaderSecretCiphertext: m.aes.encryptAesGcmV1('WH-atual', CHAVE_B), cardEnabled: false, pixEnabled: false },
    })
    const rel = await m.rot.recifrarSegredosDePagamento({ apply: true, prisma: m.prisma })
    const por = (alvo: string) => rel.alvos.find((a) => a.alvo === alvo)!
    expect(por('PaymentGatewayConfig.merchantKeyCiphertext')).toMatchObject({ total: 1, ilegiveis: 1, recifrados: 0, jaNaChaveAtual: 0 })
    expect(por('PaymentGatewayConfig.sopClientSecretCiphertext')).toMatchObject({ total: 1, recifrados: 1, ilegiveis: 0 })
    expect(por('PaymentGatewayConfig.webhookHeaderSecretCiphertext')).toMatchObject({ total: 1, jaNaChaveAtual: 1, ilegiveis: 0 })
    const depois = await m.prisma.paymentGatewayConfig.findUniqueOrThrow({ where: { id: 1 } })
    expect(depois.merchantKeyCiphertext).toBe(truncado)
    expect(depois.updatedAt.getTime()).toBe(criada.updatedAt.getTime())
    expect(m.sec.decryptPaymentSecret(depois.sopClientSecretCiphertext!)).toBe('SOP-legado')
    expect(m.rot.formatarRelatorio(rel)).toContain('ATENÇÃO')
  })

  it('GET /api/admin/payment-gateway acusa secretsDecryptable=false quando um segredo é `v1:<kid atual>:<corpo corrompido>` (o mesmo critério do script: decifrar, não olhar o prefixo)', async () => {
    await limparTudo()
    const kid = m.aes.keyId(CHAVE_B)
    await m.prisma.paymentGatewayConfig.create({
      data: { id: 1, environment: 'sandbox', merchantId: 'mid-get', merchantKeyCiphertext: `v1:${kid}:${Buffer.from(m.aes.encryptAesGcm('MKEY', CHAVE_B), 'base64').subarray(0, 18).toString('base64')}`, cardEnabled: false, pixEnabled: false },
    })
    m.cfg.invalidarCacheConfigGateway()
    const admin = await m.prisma.user.create({ data: { role: 'ADMIN', name: 'Admin Rot Corr', email: `admin-rot-corr-${Math.random().toString(36).slice(2, 8)}@example.com`, passwordHash: HASH_SENHA_ADMIN_TESTE } })
    const res = await request(m.createApp()).get('/api/admin/payment-gateway').set({ Authorization: `Bearer ${m.issueToken({ id: admin.id, role: 'ADMIN', operatorId: null })}` })
    expect(res.status).toBe(200)
    expect(res.body.secretsDecryptable).toBe(false)
  })

  it('SCRIPT REAL (processo filho, banco real): com um corrompido sai com código 1 e imprime ATENÇÃO sem "Concluído" nem ciphertext; sem ilegíveis sai 0 e diz "Concluído"; nada é apagado nos dois', async () => {
    await limparTudo()
    const casos = corrompidos()
    const ruim = casos['v1 atual: auth tag adulterado']!
    const cRuim = await cartao(ruim)
    const cBom = await cartao(m.aes.encryptAesGcm('tok-script-bom', CHAVE_A))
    const rodar = (...args: string[]) =>
      spawnSync(process.execPath, [join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'scripts/recifrarSegredosDePagamento.ts', ...args], {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: banco.url, PAYMENT_SECRETS_KEY: CHAVE_B.toString('base64'), PAYMENT_SECRETS_KEY_PREVIOUS: CHAVE_A.toString('base64'), LOG_LEVEL: 'error' },
        encoding: 'utf8',
        timeout: 60_000,
      })

    const dry = rodar()
    expect(dry.status, `${dry.stdout}\n${dry.stderr}`).toBe(1)
    expect(dry.stdout).toContain('ATENÇÃO')
    expect(dry.stdout).not.toContain('Concluído')
    expect(dry.stdout).not.toContain(ruim)
    expect(dry.stdout).toContain(cRuim.id) // o id (não segredo) do ilegível é listado

    const apply = rodar('--apply')
    expect(apply.status, `${apply.stdout}\n${apply.stderr}`).toBe(1)
    expect(apply.stdout).toContain('ATENÇÃO')
    expect(apply.stdout).not.toContain('Concluído: tudo está na chave atual')
    expect((await m.prisma.paymentMethod.findUniqueOrThrow({ where: { id: cRuim.id } })).cieloCardTokenCiphertext).toBe(ruim)
    expect(m.sec.decryptPaymentSecret((await m.prisma.paymentMethod.findUniqueOrThrow({ where: { id: cBom.id } })).cieloCardTokenCiphertext)).toBe('tok-script-bom')

    // resolvido o ruim (o dono recadastra o cartão) => o script passa a sair 0 e dizer Concluído
    await m.prisma.paymentMethod.delete({ where: { id: cRuim.id } })
    const limpo = rodar('--apply')
    expect(limpo.status, `${limpo.stdout}\n${limpo.stderr}`).toBe(0)
    expect(limpo.stdout).toContain('Concluído')
    expect(await m.prisma.paymentMethod.count({ where: { id: cBom.id } })).toBe(1)
  }, 180_000)
})
