import { describe, expect, it } from 'vitest'
import {
  ALERTA_TRUST_PROXY_ZERO_EM_PRODUCAO,
  MENSAGEM_TRUST_PROXY_ZERO_EM_PRODUCAO,
  OCPP_MAX_PAYLOAD_BYTES,
  deveAvisarTrustProxyZeroEmProducao,
} from '../../src/core/ocpp/configGateway'

describe('aviso de boot — OCPP_TRUST_PROXY_HOPS=0 em produção', () => {
  it('avisa SÓ quando NODE_ENV=production E hops=0', () => {
    expect(deveAvisarTrustProxyZeroEmProducao('production', 0)).toBe(true)
  })

  it('não avisa com hops >= 1 em produção (a frota já aparece com o IP real)', () => {
    for (const hops of [1, 2, 5]) expect(deveAvisarTrustProxyZeroEmProducao('production', hops)).toBe(false)
  })

  it('não avisa fora de produção, mesmo com hops=0 (é o default de dev/teste)', () => {
    expect(deveAvisarTrustProxyZeroEmProducao('development', 0)).toBe(false)
    expect(deveAvisarTrustProxyZeroEmProducao('test', 0)).toBe(false)
  })

  it('o alerta tem nome estável e a mensagem explica o efeito (cota de rate limit compartilhada) sem expor segredo', () => {
    expect(ALERTA_TRUST_PROXY_ZERO_EM_PRODUCAO).toBe('ocpp_trust_proxy_hops_zero_in_production')
    expect(MENSAGEM_TRUST_PROXY_ZERO_EM_PRODUCAO).toContain('OCPP_TRUST_PROXY_HOPS=0')
    expect(MENSAGEM_TRUST_PROXY_ZERO_EM_PRODUCAO).toMatch(/cota de rate limit/)
  })
})

describe('teto de mensagem do gateway', () => {
  it('256 KiB (262144 bytes)', () => {
    expect(OCPP_MAX_PAYLOAD_BYTES).toBe(262_144)
  })
})
