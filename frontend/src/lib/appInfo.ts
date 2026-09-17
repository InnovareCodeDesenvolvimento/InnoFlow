/**
 * Identificação do sistema: qual versão está no ar e quem o desenvolveu.
 *
 * A versão vem de `frontend/package.json` — fonte única, injetada no build
 * (ver `buildInfo.ts`). Deixá-la visível não é enfeite: sem ela, um chamado
 * de suporte não consegue dizer qual build o usuário estava usando.
 *
 * Mesmo padrão do projeto irmão ParquedasFeiras (`frontend/src/lib/appInfo.ts`
 * lá) — para publicar uma nova versão, basta alterar o `version` do
 * `package.json`.
 */

/** Empresa desenvolvedora. */
export const DESENVOLVEDORA = "InnovareCode"
export const DESENVOLVEDORA_URL = "https://innovarecode.com.br"

/** Versão semântica do sistema, vinda do package.json. */
export const APP_VERSION = __APP_VERSION__

/** Data em que este bundle foi compilado (UTC, AAAA-MM-DD). */
export const BUILD_DATE = __BUILD_DATE__

/** "v0.1.0" — formato usado na interface. */
export const VERSAO_EXIBIDA = `v${APP_VERSION}`
