import type { LoginGate, LoginThrottle } from './loginThrottle'

/**
 * Núcleo PURO do step-up de senha (F5.7, M2): decide "senha atual confere?" com rate limit por usuário, sem Prisma, sem bcrypt,
 * sem Redis e sem logger — tudo entra por `PortasStepUp` (testável com tudo falso). O serviço (`services/auth/stepUpSenha.ts`)
 * liga as portas e traduz o resultado para HTTP.
 *
 * Regras:
 *  - RESERVA a vaga de tentativa ANTES do trabalho caro (mesma lição do login: sem isso, uma rajada paralela passa toda pelo portão
 *    lendo "0 falhas"). Trancado/cheio => recusa SEM tocar o banco nem o bcrypt, mesmo com a senha certa;
 *  - só senha ERRADA conta falha (erro nosso devolve a vaga; sucesso zera);
 *  - conta SEM senha (`passwordHash` nulo, p.ex. só-Google) nunca confere — conta como erro (e não gasta um compare);
 *  - FAIL-CLOSED na RESERVA (F5.8, decisão do Atlas): se o Redis do throttle não responde, devolve `THROTTLE_INDISPONIVEL` SEM buscar a senha nem rodar o bcrypt
 *    (antes caía no limite por minuto em memória da rota: 10 erradas/min em vez de 5 por 15 min — janela de adivinhação da senha do ADMIN por quem tem só um token roubado).
 *    Só a RESERVA é fail-closed: depois dela, falha ao registrar/devolver/zerar continua fail-open (a vaga já foi gasta; não vale trancar o admin por isso).
 * A senha informada só é repassada a `compare` — nunca a `log`, nunca devolvida.
 */

export type ResultadoStepUp =
  | { resultado: 'OK' }
  | { resultado: 'SENHA_INCORRETA' }
  | { resultado: 'LIMITE_DE_TENTATIVAS'; retryAfterSeconds: number }
  | { resultado: 'USUARIO_INEXISTENTE' }
  | { resultado: 'THROTTLE_INDISPONIVEL' }

export interface PortasStepUp {
  throttle: LoginThrottle
  /** `undefined` = usuário não existe; `null` = existe e NÃO tem senha. */
  buscarPasswordHash(userId: string): Promise<string | null | undefined>
  compare(senha: string, hash: string): Promise<boolean>
  /** Falha/lentidão do Redis viram o `fallback` — o adaptador loga. Na RESERVA o fallback é `null` (fail-closed); nos demais passos é o valor neutro (fail-open). */
  comTimeout<T>(acao: () => Promise<T>, fallback: T): Promise<T>
  /** Só NOMES e ids — nunca a senha. */
  alertar(alerta: 'payment_gateway_stepup_failed' | 'payment_gateway_stepup_locked' | 'payment_gateway_stepup_unavailable', campos: { actorUserId: string; lockSeconds?: number }): void
}

const chaveDoUsuario = (userId: string): string => `stepup:${userId}`

export async function executarStepUp(params: { userId: string; senhaInformada: string }, p: PortasStepUp): Promise<ResultadoStepUp> {
  const { userId, senhaInformada } = params
  const chave = chaveDoUsuario(userId)

  const portao = await p.comTimeout<LoginGate | null>(() => p.throttle.reserveAttempt(chave), null)
  if (portao === null) {
    p.alertar('payment_gateway_stepup_unavailable', { actorUserId: userId })
    return { resultado: 'THROTTLE_INDISPONIVEL' }
  }
  if (!portao.allowed) {
    p.alertar('payment_gateway_stepup_locked', { actorUserId: userId })
    return { resultado: 'LIMITE_DE_TENTATIVAS', retryAfterSeconds: portao.retryAfterSeconds }
  }
  const devolverVaga = (): void => {
    if (portao.failures !== undefined) void p.comTimeout(() => p.throttle.release(chave), undefined)
  }

  let hash: string | null | undefined
  let ok: boolean
  try {
    hash = await p.buscarPasswordHash(userId)
    ok = typeof hash === 'string' && hash.length > 0 && (await p.compare(senhaInformada, hash))
  } catch (err) {
    devolverVaga() // erro NOSSO (banco fora do ar), não falha do usuário
    throw err
  }

  if (hash === undefined) {
    devolverVaga()
    return { resultado: 'USUARIO_INEXISTENTE' }
  }

  if (!ok) {
    const falha = await p.comTimeout(() => p.throttle.registerFailure(chave, portao.failures), null)
    p.alertar('payment_gateway_stepup_failed', { actorUserId: userId })
    if (falha?.lockedNow) p.alertar('payment_gateway_stepup_locked', { actorUserId: userId, lockSeconds: falha.lockSeconds })
    return { resultado: 'SENHA_INCORRETA' }
  }

  void p.comTimeout(() => p.throttle.registerSuccess(chave), undefined)
  return { resultado: 'OK' }
}
