import { describe, expect, it } from 'vitest'
import { FakeAdapter } from '../../src/services/pagamentos/fakeAdapter'
import type { PedidoAutorizacaoCartao, PedidoPix } from '../../src/core/pagamentos/tipos'

function pedidoCartao(overrides: Partial<PedidoAutorizacaoCartao> = {}): PedidoAutorizacaoCartao {
  return {
    merchantOrderId: 'intent-1',
    amountRequestedCents: 5000,
    cartao: { cardToken: 'card-token-abc' },
    cliente: { name: 'Motorista Teste' },
    ...overrides,
  }
}

describe('FakeAdapter', () => {
  it('autorizar -> AUTHORIZED por padrão', async () => {
    const adapter = new FakeAdapter()
    const resultado = await adapter.autorizar(pedidoCartao())
    expect(resultado.status).toBe('AUTHORIZED')
    expect(resultado.amountAuthorizedCents).toBe(5000)
    expect(resultado.providerPaymentId).toBeTruthy()
  })

  it('autorizar com cardToken na lista de negados -> FAILED', async () => {
    const adapter = new FakeAdapter({ cardTokensNegados: ['card-token-negado'] })
    const resultado = await adapter.autorizar(pedidoCartao({ cartao: { cardToken: 'card-token-negado' } }))
    expect(resultado.status).toBe('FAILED')
    expect(resultado.amountAuthorizedCents).toBeNull()
  })

  it('ciclo completo autorizar -> capturar -> consultar', async () => {
    const adapter = new FakeAdapter()
    const auth = await adapter.autorizar(pedidoCartao())
    const captura = await adapter.capturar(auth.providerPaymentId, 4500)
    expect(captura.status).toBe('CAPTURED')
    expect(captura.amountCapturedCents).toBe(4500)

    const consulta = await adapter.consultar(auth.providerPaymentId)
    expect(consulta.status).toBe('CAPTURED')
    expect(consulta.amountCapturedCents).toBe(4500)
  })

  it('capturar sem autorizar antes -> lança erro (não pula estado)', async () => {
    const adapter = new FakeAdapter()
    await expect(adapter.capturar('id-inexistente', 100)).rejects.toThrow(/desconhecido/)
  })

  it('capturar duas vezes -> segunda chamada lança (já não está mais AUTHORIZED)', async () => {
    const adapter = new FakeAdapter()
    const auth = await adapter.autorizar(pedidoCartao())
    await adapter.capturar(auth.providerPaymentId, 5000)
    await expect(adapter.capturar(auth.providerPaymentId, 5000)).rejects.toThrow(/CAPTURED/)
  })

  it('cancelar -> VOIDED', async () => {
    const adapter = new FakeAdapter()
    const auth = await adapter.autorizar(pedidoCartao())
    const cancelamento = await adapter.cancelar(auth.providerPaymentId)
    expect(cancelamento.status).toBe('VOIDED')
  })

  it('consultarPorPedido encontra pelo merchantOrderId (reconciliação pós-timeout)', async () => {
    const adapter = new FakeAdapter()
    const auth = await adapter.autorizar(pedidoCartao({ merchantOrderId: 'intent-xyz' }))
    const consulta = await adapter.consultarPorPedido('intent-xyz')
    expect(consulta?.providerPaymentId).toBe(auth.providerPaymentId)
  })

  it('consultarPorPedido devolve null para merchantOrderId desconhecido (nunca lança)', async () => {
    const adapter = new FakeAdapter()
    const consulta = await adapter.consultarPorPedido('nunca-existiu')
    expect(consulta).toBeNull()
  })

  it('criarPix -> PENDING com QR determinístico', async () => {
    const adapter = new FakeAdapter()
    const pedido: PedidoPix = { merchantOrderId: 'pix-1', amountRequestedCents: 2000, cliente: { name: 'Motorista Pix' } }
    const resultado = await adapter.criarPix(pedido)
    expect(resultado.status).toBe('PENDING')
    expect(resultado.qrCodeString).toContain(resultado.providerPaymentId)
    expect(resultado.expiresAt.getTime()).toBeGreaterThan(Date.now())
  })

  it('sessaoTokenizacao devolve config fake sem exigir credencial', async () => {
    const adapter = new FakeAdapter()
    const sessao = await adapter.sessaoTokenizacao()
    expect(sessao.environment).toBe('sandbox')
    expect(sessao.merchantId).toBeTruthy()
    expect(sessao.accessToken).toBeTruthy()
    expect(sessao.expiresAt.getTime()).toBeGreaterThan(Date.now())
    // Marcador `mock-sop` — contrato coordenado com `pagamento-cartao/sopClient.ts`
    // (Lyra): sem ele, a página isolada tentaria carregar um script real
    // inexistente em vez de cair no mock local. Ver comentário de `sessaoTokenizacao`.
    expect(sessao.scriptUrl).toContain('mock-sop')
  })

  describe('consultarCartaoTokenizado (F5.3)', () => {
    it('token desconhecido -> dados determinísticos (brand/last4/holder/validade)', async () => {
      const adapter = new FakeAdapter()
      const resultado = await adapter.consultarCartaoTokenizado('card-token-1234')
      expect(resultado.cardToken).toBe('card-token-1234')
      expect(resultado.last4).toBe('1234')
      expect(resultado.brand).toBeTruthy()
      expect(resultado.expiryMonth).toBe(12)
      expect(resultado.expiryYear).toBe(2030)
    })

    it('token no formato mocktok.* (gerado por pagamento-cartao/sopClient.ts) -> decodifica last4/validade/nome reais, brand null', async () => {
      const adapter = new FakeAdapter()
      const holderB64 = Buffer.from('Fulano de Tal', 'utf8').toString('base64')
      const mockToken = `mocktok.4242.122029.${holderB64}.17591234561`
      const resultado = await adapter.consultarCartaoTokenizado(mockToken)
      expect(resultado).toEqual({ cardToken: mockToken, brand: null, last4: '4242', holderName: 'Fulano de Tal', expiryMonth: 12, expiryYear: 2029 })
    })

    it('cardToken na lista de inválidos -> CartaoTokenInvalidoError', async () => {
      const adapter = new FakeAdapter({ cardTokensInvalidos: ['card-token-ruim'] })
      await expect(adapter.consultarCartaoTokenizado('card-token-ruim')).rejects.toThrow(/inválido/)
    })
  })

  it('gerarId customizado é usado como providerPaymentId (para asserção determinística em outros times)', async () => {
    let n = 0
    const adapter = new FakeAdapter({ gerarId: () => `id-${++n}` })
    const resultado = await adapter.autorizar(pedidoCartao())
    expect(resultado.providerPaymentId).toBe('id-1')
  })

  describe('Pix — consultarPix (F5.2)', () => {
    function pedidoPix(overrides: Partial<PedidoPix> = {}): PedidoPix {
      return { merchantOrderId: 'pix-intent-1', amountRequestedCents: 5000, cliente: { name: 'Motorista Pix' }, ...overrides }
    }

    it('consultarPix logo após criarPix devolve PENDING (ainda não foi "pago")', async () => {
      const adapter = new FakeAdapter()
      const criado = await adapter.criarPix(pedidoPix())
      const consulta = await adapter.consultarPix(criado.providerPaymentId)
      expect(consulta.status).toBe('PENDING')
      expect(consulta.amountCents).toBeNull()
    })

    it('marcarPixComoPago (helper SÓ de teste) faz consultarPix devolver PAID com o valor', async () => {
      const adapter = new FakeAdapter()
      const criado = await adapter.criarPix(pedidoPix({ amountRequestedCents: 3500 }))
      adapter.marcarPixComoPago(criado.providerPaymentId)
      const consulta = await adapter.consultarPix(criado.providerPaymentId)
      expect(consulta.status).toBe('PAID')
      expect(consulta.amountCents).toBe(3500)
      expect(consulta.merchantOrderId).toBe('pix-intent-1')
    })

    it('marcarPixComoExpirado faz consultarPix devolver EXPIRED', async () => {
      const adapter = new FakeAdapter()
      const criado = await adapter.criarPix(pedidoPix())
      adapter.marcarPixComoExpirado(criado.providerPaymentId)
      const consulta = await adapter.consultarPix(criado.providerPaymentId)
      expect(consulta.status).toBe('EXPIRED')
    })

    it('consultarPix com providerPaymentId desconhecido lança (nunca inventa um resultado)', async () => {
      const adapter = new FakeAdapter()
      await expect(adapter.consultarPix('nunca-existiu')).rejects.toThrow(/desconhecido/)
    })

    it('marcarPixComoPago em providerPaymentId desconhecido lança (protege o teste de um erro de digitação silencioso)', () => {
      const adapter = new FakeAdapter()
      expect(() => adapter.marcarPixComoPago('nunca-existiu')).toThrow(/desconhecido/)
    })
  })
})
