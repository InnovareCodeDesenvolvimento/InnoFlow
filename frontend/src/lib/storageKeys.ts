/**
 * Chaves de localStorage em módulo próprio e minúsculo: o `authStore` (que a landing importa) precisa da chave do token
 * sem arrastar `services/api` (axios) para o caminho crítico. `services/api.ts` a reexporta.
 */
export const TOKEN_STORAGE_KEY = "innoelektron_token"
