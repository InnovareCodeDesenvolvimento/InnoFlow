import { authRateLimitMessage } from "@/lib/authErrors"
import type { PublicClientConfig } from "@/types/api"

/**
 * Lógica PURA do login com Google (sem DOM/rede) — separada do componente
 * (`components/auth/GoogleAuthSection.tsx`) e do carregador do script
 * (`lib/googleIdentity.ts`) pra poder ser testada sem navegador.
 */

/**
 * O botão (e o divisor "ou continue com e-mail") só existem quando o backend
 * devolveu um Client ID de verdade. `null`/vazio/config que falhou = feature
 * desligada neste ambiente (nasce assim até o dono configurar o Client ID):
 * a tela cai no formulário normal, sem botão quebrado.
 */
export function shouldShowGoogleButton(config: PublicClientConfig | undefined): boolean {
  return typeof config?.googleClientId === "string" && config.googleClientId.trim().length > 0
}

/** Larguras aceitas pelo botão do Google (px): mínimo 200, máximo 400 (regra do GIS, não nossa). */
export const GOOGLE_BUTTON_MIN_WIDTH = 200
export const GOOGLE_BUTTON_MAX_WIDTH = 400

/** Largura medida do container → largura válida pro `renderButton` (inteiro dentro da faixa do GIS). */
export function clampGoogleButtonWidth(measured: number): number {
  return Math.min(GOOGLE_BUTTON_MAX_WIDTH, Math.max(GOOGLE_BUTTON_MIN_WIDTH, Math.floor(measured)))
}

/**
 * Códigos de erro do `POST /api/auth/google` (ver `GoogleAuthRequest` em
 * `types/api.ts`) → mensagem em português. Trata por `code`, nunca pelo texto
 * do backend. Limite de tentativas (429) tem texto próprio, compartilhado com o
 * login (`lib/authErrors.ts`) — por isso o `status` opcional: um 429 sem `code`
 * (proxy na frente) também cai lá. Qualquer outro caso (rede, 5xx, código novo)
 * cai no genérico.
 */
export function googleErrorMessageForCode(code: string | undefined, status?: number): string {
  const rateLimited = authRateLimitMessage(status, code)
  if (rateLimited) return rateLimited
  switch (code) {
    case "GOOGLE_LOGIN_NOT_ALLOWED":
      return "Esta conta é de operação/administração e não pode entrar com o Google — use e-mail e senha."
    case "GOOGLE_EMAIL_NOT_VERIFIED":
      return "O Google informou que o e-mail desta conta ainda não foi verificado. Verifique-o na sua conta Google ou entre com e-mail e senha."
    case "INVALID_GOOGLE_TOKEN":
      return "Não foi possível validar o login com o Google. Tente novamente."
    case "GOOGLE_NOT_CONFIGURED":
      return "O login com o Google está indisponível no momento. Use e-mail e senha."
    default:
      return "Não foi possível entrar com o Google. Tente novamente ou use e-mail e senha."
  }
}

/**
 * Dica local de que o servidor TEM o login com Google ligado (gravada quando a config responde). Existe só para o primeiro
 * quadro da tela de Login/Cadastro: reservar o espaço do botão ANTES da config chegar quando a última resposta foi "ligado", e
 * NÃO reservar quando foi "desligado" ou desconhecido — assim a seção nunca nasce e some (o salto que o Lighthouse media como
 * CLS 0,041 em `/login`). A verdade continua sendo a config; a dica errada custa, no máximo, um ajuste de layout.
 */
export const GOOGLE_ENABLED_HINT_KEY = "innoflow:google-enabled"

export function readGoogleEnabledHint(): boolean {
  try {
    return localStorage.getItem(GOOGLE_ENABLED_HINT_KEY) === "1"
  } catch {
    return false
  }
}

export function writeGoogleEnabledHint(enabled: boolean): void {
  try {
    if (enabled) localStorage.setItem(GOOGLE_ENABLED_HINT_KEY, "1")
    else localStorage.removeItem(GOOGLE_ENABLED_HINT_KEY)
  } catch {
    // modo privado/armazenamento bloqueado: sem dica, comportamento padrão (não reserva)
  }
}
