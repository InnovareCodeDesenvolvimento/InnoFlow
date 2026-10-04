import { afterAll, describe, expect, it } from 'vitest'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { creditarTopupPix } from '../../src/services/pagamentos/creditarTopupPix'
import { varrerTopupsPixExpirados } from '../../src/services/pagamentos/varrerTopupsPixExpirados'
import { FakeAdapter } from '../../src/services/pagamentos/fakeAdapter'
import { uniqueSuffix } from './helpers/fixtures'

/**
 * F5.2 (Íris, 2026-09-30) — provas que os testes do Vega (`topupPix.test.ts`,
 * `topupPixAuditFailClosed.test.ts`) NÃO cobriam: concorrência de VERDADE
 * (`Promise.all` disparando a mesma função ao mesmo tempo, não chamadas
 * sequenciais) e o caso em que a reconsulta discorda de "algo aconteceu"
 * (webhook chegou / varredor rodou) — a garantia central da decisão §3 da
 * Nova: "webhook é dica, nunca verdade".
 *
 * ACHADO durante esta rodada (reportado à parte, não corrigido aqui — está
 * fora de `creditarTopupPix.ts`): o `FakeAdapter` usado pelo singleton
 * `getPagamentoPort()` (sem `gerarId` customizado) gera IDs sequenciais
 * PREVISÍVEIS (`fake-payment-1`, `fake-payment-2`, ...) que colidem entre
 * arquivos de teste diferentes rodando em paralelo (e entre execuções
 * sucessivas contra o mesmo Postgres persistente) — `cieloPaymentId` é
 * UNIQUE no banco. Por isso este arquivo NUNCA usa o singleton para criar
 * dinheiro novo: cada `FakeAdapter` aqui tem `gerarId` com o sufixo único
 * desta suíte (`uniqueSuffix()`), e as chamadas ao `creditarTopupPix`/
 * `varrerTopupsPixExpirados` são diretas (mesmo padrão de
 * `topupPixAuditFailClosed.test.ts`) — testa o MECANISMO (lock + índice
 * único) sem depender do enfileiramento HTTP/BullMQ, que a suíte do Vega já
 * cobre (sequencialmente) para a integração ponta a ponta.
 */
describe('creditarTopupPix — concorrência real e reconsulta-sempre (Íris)', () => {
  const suffix = uniqueSuffix()
  let n = 0

  function novoAdapter(): FakeAdapter {
    return new FakeAdapter({ gerarId: () => `fake-iris-${suffix}-${++n}` })
  }

  afterAll(async () => {
    await prisma.$disconnect()
    redis.disconnect()
  })

  async function novoMotorista(label: string) {
    const user = await prisma.user.create({ data: { role: 'DRIVER', name: `Driver ${label} ${suffix}`, email: `driver-${label}-${suffix}@example.com` } })
    const wallet = await prisma.wallet.create({ data: { userId: user.id } })
    return { id: user.id, walletId: wallet.id }
  }

  async function saldo(walletId: string): Promise<number> {
    const last = await prisma.walletEntry.findFirst({ where: { walletId }, orderBy: { createdAt: 'desc' }, select: { balanceAfterCents: true } })
    return last?.balanceAfterCents ?? 0
  }

  async function novoIntentPago(adapter: FakeAdapter, driver: { id: string; walletId: string }, amountCents: number) {
    const pix = await adapter.criarPix({ merchantOrderId: 'placeholder', amountRequestedCents: amountCents, cliente: { name: 'Motorista Teste' } })
    adapter.marcarPixComoPago(pix.providerPaymentId)
    const intent = await prisma.paymentIntent.create({
      data: {
        purpose: 'WALLET_TOPUP_PIX',
        provider: 'CIELO_PIX',
        userId: driver.id,
        walletId: driver.walletId,
        amountRequestedCents: amountCents,
        status: 'PENDING',
        cieloPaymentId: pix.providerPaymentId,
        pixQrCode: pix.qrCodeString,
        pixExpiresAt: pix.expiresAt,
      },
    })
    adapter.associarPixAoPedido(pix.providerPaymentId, intent.id) // I-6: o crédito confere o MerchantOrderId da consulta com o intent
    return intent
  }

  // ---------------------------------------------------------------------------
  describe('idempotência sob corrida DE VERDADE (Promise.all, não sequencial)', () => {
    it('10 chamadas concorrentes de creditarTopupPix para o MESMO PaymentIntent creditam a carteira UMA ÚNICA vez', async () => {
      const adapter = novoAdapter()
      const driver = await novoMotorista('corrida-10x')
      const intent = await novoIntentPago(adapter, driver, 7_000)

      const resultados = await Promise.all(Array.from({ length: 10 }, () => creditarTopupPix(intent.id, adapter)))

      const naoNulos = resultados.filter((r) => r !== null)
      expect(naoNulos, 'exatamente 1 das 10 chamadas concorrentes deveria "vencer" e devolver o resultado — as outras 9 devem ver o crédito já feito e devolver null').toHaveLength(1)

      expect(await saldo(driver.walletId)).toBe(7_000)
      expect(await prisma.walletEntry.count({ where: { walletId: driver.walletId, type: 'TOPUP_PIX' } })).toBe(1)
      expect((await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe('PAID')
    })

    it('webhook e varredor disparando ao MESMO TEMPO para o mesmo intent (dois CAMINHOS diferentes) creditam só uma vez', async () => {
      // Mesma classe de corrida citada no comentário de creditarTopupPix.ts:
      // "webhook chegou 2x, ou webhook + varredor quase ao mesmo tempo" — aqui
      // simulamos literalmente os DOIS CAMINHOS (chamada direta representando
      // o worker do webhook + `varrerTopupsPixExpirados` representando o
      // varredor) disputando o mesmo PaymentIntent ao mesmo tempo.
      const adapter = novoAdapter()
      const driver = await novoMotorista('corrida-webhook-varredor')
      const intent = await novoIntentPago(adapter, driver, 3_300)
      // O varredor só pega intents com pixExpiresAt vencido — força o vencimento
      // (o dinheiro já está pago do lado da Cielo; o varredor só ainda não sabia).
      await prisma.paymentIntent.update({ where: { id: intent.id }, data: { pixExpiresAt: new Date(Date.now() - 1_000) } })

      const [resultadoDireto, resultadoVarredor] = await Promise.all([creditarTopupPix(intent.id, adapter), varrerTopupsPixExpirados(adapter)])

      // Um dos dois caminhos creditou (não necessariamente o "direto" — corrida de verdade, a ordem não é garantida).
      const algumCreditou = resultadoDireto !== null || resultadoVarredor.creditados === 1
      expect(algumCreditou, JSON.stringify({ resultadoDireto, resultadoVarredor })).toBe(true)

      expect(await saldo(driver.walletId)).toBe(3_300)
      expect(await prisma.walletEntry.count({ where: { walletId: driver.walletId, type: 'TOPUP_PIX' } })).toBe(1)
    })

    it('30 disparos concorrentes vindos de 3 "processos" lógicos diferentes (10 cada) — 1 único crédito, prova o índice único como rede de segurança final', async () => {
      const adapter = novoAdapter()
      const driver = await novoMotorista('corrida-30x')
      const intent = await novoIntentPago(adapter, driver, 1_234)

      // 3 "grupos" simulando webhook (retry), webhook (2ª notificação) e varredor
      // disparando juntos — cada grupo com 10 chamadas próprias, todas ao MESMO
      // tempo (nenhum `await` sequencial entre grupos).
      const grupoWebhook1 = Array.from({ length: 10 }, () => creditarTopupPix(intent.id, adapter))
      const grupoWebhook2 = Array.from({ length: 10 }, () => creditarTopupPix(intent.id, adapter))
      const grupoVarredor = Array.from({ length: 10 }, () => creditarTopupPix(intent.id, adapter))

      const resultados = await Promise.all([...grupoWebhook1, ...grupoWebhook2, ...grupoVarredor])
      expect(resultados.filter((r) => r !== null)).toHaveLength(1)
      expect(await saldo(driver.walletId)).toBe(1_234)
      expect(await prisma.walletEntry.count({ where: { walletId: driver.walletId, type: 'TOPUP_PIX' } })).toBe(1)
    })
  })

  // ---------------------------------------------------------------------------
  describe('reconsulta-sempre — webhook (ou varredor) rodando NÃO é suficiente, só a reconsulta manda', () => {
    it('processamento disparado enquanto a reconsulta ainda diz PENDING não credita nada — nem WalletEntry, nem mudança de status', async () => {
      const adapter = novoAdapter()
      const driver = await novoMotorista('reconsulta-pendente')
      const pix = await adapter.criarPix({ merchantOrderId: 'placeholder', amountRequestedCents: 4_500, cliente: { name: 'Motorista Teste' } })
      // Propositalmente NÃO chama marcarPixComoPago — simula o QR ainda não pago
      // do lado da Cielo, mesmo que "algo" (webhook malicioso, replay, varredor
      // adiantado) dispare o processamento deste intent agora.
      const intent = await prisma.paymentIntent.create({
        data: {
          purpose: 'WALLET_TOPUP_PIX',
          provider: 'CIELO_PIX',
          userId: driver.id,
          walletId: driver.walletId,
          amountRequestedCents: 4_500,
          status: 'PENDING',
          cieloPaymentId: pix.providerPaymentId,
          pixQrCode: pix.qrCodeString,
          pixExpiresAt: pix.expiresAt,
        },
      })

      adapter.associarPixAoPedido(pix.providerPaymentId, intent.id) // I-6: o crédito confere o MerchantOrderId da consulta com o intent
      const resultado = await creditarTopupPix(intent.id, adapter)
      expect(resultado).toBeNull()
      expect(await saldo(driver.walletId)).toBe(0)
      expect(await prisma.walletEntry.count({ where: { walletId: driver.walletId } })).toBe(0)
      expect((await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe('PENDING')

      // Agora a Cielo confirma de verdade (o motorista pagou agora) — só A PARTIR
      // DAQUI o crédito acontece, na PRÓXIMA reconsulta, nunca antes dela.
      adapter.marcarPixComoPago(pix.providerPaymentId)
      const resultadoDepois = await creditarTopupPix(intent.id, adapter)
      expect(resultadoDepois).not.toBeNull()
      expect(await saldo(driver.walletId)).toBe(4_500)
    })

    it('reconsulta diz EXPIRED (não PAID) — creditarTopupPix não credita, mesmo chamado diretamente', async () => {
      const adapter = novoAdapter()
      const driver = await novoMotorista('reconsulta-expirado')
      const pix = await adapter.criarPix({ merchantOrderId: 'placeholder', amountRequestedCents: 800, cliente: { name: 'Motorista Teste' } })
      adapter.marcarPixComoExpirado(pix.providerPaymentId)
      const intent = await prisma.paymentIntent.create({
        data: {
          purpose: 'WALLET_TOPUP_PIX',
          provider: 'CIELO_PIX',
          userId: driver.id,
          walletId: driver.walletId,
          amountRequestedCents: 800,
          status: 'PENDING',
          cieloPaymentId: pix.providerPaymentId,
          pixQrCode: pix.qrCodeString,
          pixExpiresAt: pix.expiresAt,
        },
      })

      const resultado = await creditarTopupPix(intent.id, adapter)
      expect(resultado).toBeNull()
      expect(await saldo(driver.walletId)).toBe(0)
      expect((await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe('PENDING') // creditarTopupPix não expira — só o varredor faz isso
    })
  })
})
