/**
 * Versões VIGENTES dos termos nos testes (L1.9) — as mesmas que `vitest.config.mts` põe em `LEGAL_TERMS_VERSION`/`LEGAL_PRIVACY_VERSION`. Todo teste que cadastra motorista
 * (`POST /api/auth/register`) ou cria conta pelo Google (`POST /api/auth/google`) manda `acceptedTermsVersion` = `TERMOS_VIGENTES`.
 */
export const TERMOS_VIGENTES = 'termos-teste-1'
export const PRIVACIDADE_VIGENTE = 'privacidade-teste-1'
