/** Constantes do harness visual. Nada aqui depende de código de produção. */

export const VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
] as const

export const TIMEZONE = "America/Sao_Paulo"
export const LOCALE = "pt-BR"

/** "Agora" de todas as capturas: 2026-10-04 15:00 (America/Sao_Paulo). Todo dado relativo do mock (últimos 30 dias, "há 4 min"…) parte daqui. */
export const T0 = new Date("2026-10-04T18:00:00.000Z")

export const SENHA = "senha1234"

export const PERSONAS = {
  driver: { email: "motorista@innoelektron.com", arquivo: "driver" },
  admin: { email: "admin@innoelektron.com", arquivo: "admin" },
  /** OPERATOR do operador A: vê o painel SEM as telas só-ADMIN (Tokens, Auditoria, Gateway) — elas mostram "Acesso restrito". */
  operator: { email: "operador@innoelektron.com", arquivo: "operator" },
  /** Motorista com recibos pré-semeados (F5.9) — é o único com histórico no mock recém-carregado. */
  travado: { email: "travado@innoelektron.com", arquivo: "travado" },
} as const

export type PersonaComLogin = keyof typeof PERSONAS
export type Persona = PersonaComLogin | "anon"

export const PASTA_AUTH = "e2e-visual/.auth"

/**
 * Interruptor do APARELHO que desliga o tour automático do mascote e o card "Primeiros passos" (`ONBOARDING_OFF_KEY` em `src/components/onboarding/onboardingStorage.ts`). Todo login de mock é uma 1ª visita,
 * então sem esta chave o tour abriria por cima de CADA captura. O `global-setup` o grava no `storageState` de cada persona e o `playwright.visual.config.ts` o usa como padrão dos contextos novos
 * (specs que fazem login pela UI). As capturas do próprio onboarding (`onboarding.visual.ts`) o desligam de propósito.
 */
export const ONBOARDING_OFF = { name: "innoflow:onboarding:off", value: "1" } as const
