import type { User } from "@/types/api"

/** Barra invertida e caracteres de controle (U+0000-U+001F, inclui TAB/LF/CR, e U+007F): o navegador os trata de forma diferente do que o código lê (ver `safeRedirect`). */
function temCaractereSuspeito(valor: string): boolean {
  for (const ch of valor) {
    const c = ch.codePointAt(0) as number
    if (ch === "\\" || c <= 0x1f || c === 0x7f) return true
  }
  return false
}

/**
 * `?redirect=` só vale se for um caminho interno ("/c/CP-01/1"): começar com
 * `/` e NÃO com `//` (protocol-relative, que sairia do site). Qualquer outra
 * coisa é ignorada — o valor vem da querystring, ou seja, do atacante.
 *
 * Também recusa `\` e caracteres de controle/TAB/quebra de linha: o navegador lê `\` como `/` (então `/\evil.example` viraria `//evil.example` ao
 * normalizar) e REMOVE TAB/LF/CR de dentro de uma URL (`/<TAB>/evil.example` vira `//evil.example`). Hoje isso só chegaria a uma rota inexistente da
 * mesma origem, mas o `?redirect` hostil tem de ser ignorado como os demais, não "meio obedecido".
 */
export function safeRedirect(redirect: string | null | undefined): string | null {
  if (!redirect) return null
  if (!redirect.startsWith("/") || redirect.startsWith("//")) return null
  if (temCaractereSuspeito(redirect)) return null
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
