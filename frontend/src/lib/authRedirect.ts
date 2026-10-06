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
 * O destino de retorno só vale se for um caminho interno ("/c/CP-01/1"): começar com
 * `/` e NÃO com `//` (protocol-relative, que sairia do site). Qualquer outra
 * coisa é ignorada — o valor pode vir da querystring de um link antigo (`/login?redirect=`), ou seja, do atacante.
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
 * Para onde mandar depois de autenticar (login normal ou Google): o destino de
 * retorno (`consumeReturnTo()` — fluxo do QR `/c/:ocppIdentity`: motorista
 * escaneia, cai no login, entra e VOLTA pro carregador; ou a rota protegida que
 * mandou para o login) tem prioridade; sem ele, cada papel vai pra própria casa
 * (ADMIN/OPERATOR → painel, DRIVER → app do motorista).
 */
export function resolvePostAuthPath(user: Pick<User, "role">, redirect: string | null | undefined): string {
  const safe = safeRedirect(redirect)
  if (safe) return safe
  if (user.role === "ADMIN" || user.role === "OPERATOR") return "/admin"
  return "/app"
}

/**
 * Destino de retorno guardado em `sessionStorage` (por aba): a URL do login fica LIMPA (`/login`), sem `?redirect=`, e mesmo assim a pessoa volta para onde
 * ia depois de entrar. O `sessionStorage` (e não estado de rota) porque o interceptor 401 de `services/api.ts` faz hard redirect, que perde o estado da SPA, e
 * porque o destino precisa sobreviver à ida e volta Login ↔ Cadastro e a um F5 na tela de login.
 *
 * Validado NA GRAVAÇÃO e NA LEITURA com `safeRedirect` (o storage é gravável por qualquer script da origem). Vale 30 min. Todo acesso ao storage está em
 * try/catch: em modo privado/bloqueado o app segue funcionando, só sem o retorno (cai na casa do papel).
 */
export const RETURN_TO_STORAGE_KEY = "innoflow:return-to"
export const RETURN_TO_TTL_MS = 30 * 60 * 1000

/** Telas de acesso: voltar para elas depois de entrar deixaria a pessoa parada no login. */
function ehTelaDeAcesso(path: string): boolean {
  return /^\/(login|cadastro)(?:[/?#]|$)/.test(path)
}

/** Guarda o destino para depois do login. Valor inválido/hostil, ou de tela de acesso, é ignorado (o destino anterior, se houver, fica como estava). */
export function rememberReturnTo(path: string | null | undefined): void {
  const safe = safeRedirect(path)
  if (!safe || ehTelaDeAcesso(safe)) return
  try {
    sessionStorage.setItem(RETURN_TO_STORAGE_KEY, JSON.stringify({ path: safe, at: Date.now() }))
  } catch {
    // sessionStorage indisponível (modo privado, bloqueado, cota): segue sem o retorno.
  }
}

function lerReturnTo(): string | null {
  try {
    const raw = sessionStorage.getItem(RETURN_TO_STORAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null) return null
    const { path, at } = parsed as { path?: unknown; at?: unknown }
    if (typeof path !== "string" || typeof at !== "number" || !Number.isFinite(at)) return null
    const idade = Date.now() - at
    // Relógio que andou para trás (idade negativa) também não é confiável.
    if (idade < 0 || idade > RETURN_TO_TTL_MS) return null
    const safe = safeRedirect(path)
    return safe && !ehTelaDeAcesso(safe) ? safe : null
  } catch {
    return null
  }
}

/** Lê o destino de retorno sem apagá-lo (`null` se não há, expirou ou é inválido). */
export function peekReturnTo(): string | null {
  return lerReturnTo()
}

/** Lê o destino de retorno e o apaga (uso único). Apaga também um valor expirado/inválido. */
export function consumeReturnTo(): string | null {
  const path = lerReturnTo()
  clearReturnTo()
  return path
}

export function clearReturnTo(): void {
  try {
    sessionStorage.removeItem(RETURN_TO_STORAGE_KEY)
  } catch {
    // idem: sem storage não há o que apagar.
  }
}
