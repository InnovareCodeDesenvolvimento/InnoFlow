/**
 * Regras puras da configuração do gateway OCPP (sem rede, sem relógio, sem logger) — testáveis sem subir nada.
 */

/**
 * Teto de tamanho de UMA mensagem WebSocket do gateway: 256 KiB (`wssOptions.maxPayload` do `ws`, repassado pelo `RPCServer`).
 * Acima disso o `ws` fecha a conexão com o código 1009 ("message too big") sem entregar a mensagem ao `ocpp-rpc`. Sem teto, o
 * default do `ws` é 100 MiB — um carregador (ou quem tem a senha dele) conseguiria fazer o processo alocar centenas de MiB por frame.
 * OCPP 1.6-J tem mensagens pequenas; um `MeterValues` em lote offline com centenas de amostras fica na casa das dezenas de KiB.
 */
export const OCPP_MAX_PAYLOAD_BYTES = 256 * 1024

/** `alert` do aviso de boot (campo estruturado do log, para o plantão filtrar). */
export const ALERTA_TRUST_PROXY_ZERO_EM_PRODUCAO = 'ocpp_trust_proxy_hops_zero_in_production'

/**
 * Produção com `OCPP_TRUST_PROXY_HOPS=0`: com o gateway atrás de proxy (EasyPanel/wss), o IP do socket é sempre o do proxy,
 * então a frota inteira divide UMA cota de rate limit por IP (`resolveHandshakeIp` ignora o X-Forwarded-For com 0 saltos).
 * É só aviso: 0 também é a configuração CORRETA quando a porta é exposta direto, e o boot nunca cai por isto.
 */
export function deveAvisarTrustProxyZeroEmProducao(nodeEnv: string, ocppTrustProxyHops: number): boolean {
  return nodeEnv === 'production' && ocppTrustProxyHops === 0
}

export const MENSAGEM_TRUST_PROXY_ZERO_EM_PRODUCAO =
  '[ocpp] AVISO: OCPP_TRUST_PROXY_HOPS=0 em produção — atrás de proxy (wss no EasyPanel) toda a frota aparece com o IP do proxy e divide uma única cota de rate limit por IP; meça os saltos reais (docs/DEPLOY-EASYPANEL.md §4) e ajuste. Se a porta é exposta direto, ignore.'
