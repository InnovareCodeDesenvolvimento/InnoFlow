/**
 * IP do cliente no handshake do gateway OCPP, com o MESMO raciocínio de "hops" do `trust proxy`
 * do Express (`proxy-addr`): a cadeia é `[endereço do socket, ...X-Forwarded-For da direita para
 * a esquerda]` e o cliente é o elemento de índice `hops`. `hops = 0` = confia só no socket
 * (correto quando a porta é exposta direto, sem proxy — nesse caso o X-Forwarded-For é
 * forjável e é IGNORADO). Cadeia mais curta que `hops + 1` devolve o elemento mais à esquerda
 * (o que o proxy mais externo viu).
 *
 * Por que não reutilizar `TRUST_PROXY_HOPS` (API = 2, borda EasyPanel + nginx do frontend): a
 * porta do gateway (9000) tem OUTRO caminho até a internet. Hops a MAIS que o real deixa o cliente
 * forjar o próprio IP (basta mandar um X-Forwarded-For) e fugir do limite por IP — por isso o
 * gateway tem env própria (`OCPP_TRUST_PROXY_HOPS`, default 0 = seguro).
 *
 * Função pura (sem rede/relógio) — testável sem gateway.
 */

function stripIpv4Mapped(address: string): string {
  return address.startsWith('::ffff:') && address.includes('.') ? address.slice('::ffff:'.length) : address
}

export function resolveHandshakeIp(remoteAddress: string | undefined, forwardedFor: string | string[] | undefined, hops: number): string {
  const socketAddress = stripIpv4Mapped(remoteAddress ?? 'unknown')
  if (hops <= 0) return socketAddress

  const header = Array.isArray(forwardedFor) ? forwardedFor.join(',') : (forwardedFor ?? '')
  const forwarded = header
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map(stripIpv4Mapped)
    .reverse() // da direita (o que o proxy mais próximo viu) para a esquerda

  const chain = [socketAddress, ...forwarded]
  return chain[Math.min(hops, chain.length - 1)]
}
