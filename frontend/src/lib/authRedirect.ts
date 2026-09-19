import type { User } from "@/types/api"

/**
 * `?redirect=` só vale se for um caminho interno ("/c/CP-01/1"): começar com
 * `/` e NÃO com `//` (protocol-relative, que sairia do site). Qualquer outra
 * coisa é ignorada — o valor vem da querystring, ou seja, do atacante.
 */
export function safeRedirect(redirect: string | null | undefined): string | null {
  if (!redirect) return null
  if (!redirect.startsWith("/") || redirect.startsWith("//")) return null
  return redirect
}

/**
 * Para onde mandar depois de autenticar (login normal ou Google): o
 * `?redirect=` (fluxo do QR `/c/:ocppIdentity` — motorista escaneia, cai no
 * login, entra e VOLTA pro carregador) tem prioridade; sem ele, cada papel vai
 * pra própria casa (ADMIN/OPERATOR → painel, DRIVER → app do motorista).
 */
export function resolvePostAuthPath(user: Pick<User, "role">, redirect: string | null | undefined): string {
  const safe = safeRedirect(redirect)
  if (safe) return safe
  if (user.role === "ADMIN" || user.role === "OPERATOR") return "/admin"
  return "/app"
}
