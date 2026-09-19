/**
 * Resolução das credenciais do seed (Órion C1, 2026-09-19): a senha fixa `admin123456` estava no
 * repositório e a doc de deploy mandava logar com ela — em produção isso é uma conta ADMIN com
 * senha pública. Regra:
 *
 *  - PRODUÇÃO (`NODE_ENV=production`): NUNCA cai num default. A senha vem de uma env dedicada
 *    (`SEED_ADMIN_PASSWORD` etc.) com tamanho mínimo; faltou ou é curta/conhecida -> devolve
 *    `null` e o seed PULA aquele usuário com um aviso claro.
 *  - Fora de produção: env se houver e for válida, senão o default de dev (conveniência local).
 *
 * Função pura (recebe `env`/`isProduction` por parâmetro) para ser testada sem processo/banco.
 */

export interface SeedSecretSpec {
  /** Nome da env (ex.: `SEED_ADMIN_PASSWORD`). */
  envName: string
  /** Default SÓ para desenvolvimento — ignorado em produção. */
  devDefault: string
  minLength: number
  maxLength?: number
}

export type SeedSecretResult =
  | { status: 'ok'; value: string; source: 'env' | 'dev-default' }
  | { status: 'skipped'; reason: string }

/** Valores públicos do seed antigo — recusados mesmo se alguém os puser numa env. */
const KNOWN_SEED_SECRETS = new Set(['admin123456', 'staff123456', 'driver123456', 'changeme-basic-auth-secret'])

export function resolveSeedSecret(spec: SeedSecretSpec, env: Record<string, string | undefined>, isProduction: boolean): SeedSecretResult {
  const fromEnv = env[spec.envName]

  if (fromEnv !== undefined && fromEnv !== '') {
    if (KNOWN_SEED_SECRETS.has(fromEnv)) return { status: 'skipped', reason: `${spec.envName} é um valor conhecido do seed antigo (público no repositório)` }
    if (fromEnv.length < spec.minLength) return { status: 'skipped', reason: `${spec.envName} tem menos de ${spec.minLength} caracteres` }
    if (spec.maxLength !== undefined && fromEnv.length > spec.maxLength) return { status: 'skipped', reason: `${spec.envName} tem mais de ${spec.maxLength} caracteres` }
    return { status: 'ok', value: fromEnv, source: 'env' }
  }

  if (isProduction) return { status: 'skipped', reason: `${spec.envName} não definida (em produção o seed nunca usa senha padrão)` }
  return { status: 'ok', value: spec.devDefault, source: 'dev-default' }
}
