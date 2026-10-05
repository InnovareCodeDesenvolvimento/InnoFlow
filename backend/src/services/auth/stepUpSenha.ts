import bcrypt from 'bcryptjs'
import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { AppError } from '../../api/middleware/errorHandler'
import { stepUpThrottle } from '../../api/lib/loginThrottleInstance'
import { executarStepUp, type PortasStepUp } from '../../core/auth/stepUp'

/**
 * Step-up de senha (F5.7, M2 do portão do Órion): operações de ALTO IMPACTO do ADMIN (hoje: trocar a conta Cielo que recebe o
 * dinheiro de toda a plataforma) exigem a senha ATUAL do próprio usuário logado, mesmo com JWT válido — quem rouba um token de
 * 12 h não redireciona o dinheiro sem saber a senha. Regras em `core/auth/stepUp.ts`; aqui só a ligação com banco/bcrypt/Redis/log.
 *
 * Contrato de erro (literal de `PaymentGatewayConfigErrorCode`): senha errada ou conta sem senha -> 403 `INVALID_CURRENT_PASSWORD`
 * (403 e NÃO 401: o interceptor do frontend desloga em 401); tentativas erradas demais -> 429 `RATE_LIMITED_PAYMENT_GATEWAY`
 * (mesmo código do limite por minuto do PUT — não criei código novo, o contrato já o lista) com `Retry-After`.
 * Redis do throttle fora do ar (ou mudo além de 500 ms) -> 503 `STEPUP_UNAVAILABLE` (F5.8, fail-closed): SEM tentar a senha e SEM gravar nada. Código NOVO — o
 * frontend ainda não o conhece (cai no tratamento genérico de 503 até a Lyra tipá-lo).
 * A senha NUNCA vai para log, auditoria, erro ou resposta.
 */

const THROTTLE_TIMEOUT_MS = 500

export class StepUpRateLimitedError extends AppError {
  /** `codigoDeLimite`: o 429 do gateway é `RATE_LIMITED_PAYMENT_GATEWAY` (padrão); a exclusão de conta/devolução do saldo (L1.4) usa `RATE_LIMITED_ACCOUNT_DELETION` (contrato do frontend). */
  constructor(public readonly retryAfterSeconds: number, codigoDeLimite = 'RATE_LIMITED_PAYMENT_GATEWAY') {
    super('Muitas tentativas de confirmação de senha. Tente novamente mais tarde.', 429, codigoDeLimite)
    this.name = 'StepUpRateLimitedError'
  }
}

export class StepUpIndisponivelError extends AppError {
  constructor() {
    super('Não foi possível confirmar sua senha agora. Tente novamente em instantes.', 503, 'STEPUP_UNAVAILABLE')
    this.name = 'StepUpIndisponivelError'
  }
}

const portasReais: PortasStepUp = {
  throttle: stepUpThrottle,
  buscarPasswordHash: async (userId) => (await prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } }))?.passwordHash,
  compare: (senha, hash) => bcrypt.compare(senha, hash),
  async comTimeout(acao, fallback) {
    try {
      // ioredis ENFILEIRA comando com o Redis fora do ar (exigência do BullMQ) — sem o timeout a rota penduraria junto.
      return await Promise.race([acao(), new Promise<never>((_, rejeitar) => setTimeout(() => rejeitar(new Error('timeout consultando o Redis')), THROTTLE_TIMEOUT_MS).unref())])
    } catch (err) {
      // Na RESERVA isto vira 503 (fail-closed, ver `core/auth/stepUp.ts`); nos passos seguintes (registrar/devolver/zerar) segue sem o throttle.
      logger.error({ err }, '[stepup] throttle por usuário indisponível (Redis)')
      return fallback
    }
  },
  alertar(alerta, campos) {
    if (alerta === 'payment_gateway_stepup_unavailable') {
      logger.error({ alert: alerta, ...campos }, '[stepup] throttle do step-up indisponível (Redis) — alteração da config do gateway RECUSADA com 503 (fail-closed), senha não avaliada')
      return
    }
    if (alerta === 'payment_gateway_stepup_late_reservation_released') {
      logger.warn({ alert: alerta, ...campos }, '[stepup] reserva abandonada por timeout executou tarde no Redis — vaga devolvida (a tentativa já tinha sido recusada com 503)')
      return
    }
    logger.warn({ alert: alerta, ...campos }, alerta === 'payment_gateway_stepup_failed' ? '[stepup] senha atual errada na confirmação da config do gateway' : '[stepup] step-up da config do gateway recusado/trancado por tentativas erradas')
  },
}

/**
 * Lança `AppError` (403/429/401) se a senha não conferir; devolve normalmente se confere.
 * `codigoDeLimite`: código do 429 (padrão: o do gateway) — ver `StepUpRateLimitedError`.
 */
export async function exigirSenhaAtual(params: { userId: string; senhaInformada: string }, portas: PortasStepUp = portasReais, codigoDeLimite?: string): Promise<void> {
  const r = await executarStepUp(params, portas)
  switch (r.resultado) {
    case 'OK':
      return
    case 'SENHA_INCORRETA':
      throw new AppError('Senha atual incorreta.', 403, 'INVALID_CURRENT_PASSWORD')
    case 'LIMITE_DE_TENTATIVAS':
      throw new StepUpRateLimitedError(r.retryAfterSeconds, codigoDeLimite)
    case 'THROTTLE_INDISPONIVEL':
      throw new StepUpIndisponivelError()
    case 'USUARIO_INEXISTENTE':
      throw new AppError('Token inválido ou expirado.', 401, 'UNAUTHORIZED')
  }
}

/**
 * Portas do step-up do TITULAR (motorista) na exclusão da própria conta (L1.4). Mesmo núcleo, mesmo Redis, mesma tranca — mas com alertas PRÓPRIOS: os `payment_gateway_stepup_*`
 * são IMPORTANTES (e-mail ao dono: "alguém errou a senha do ADMIN na config do gateway") e um motorista digitando a senha errada não é um aviso ao dono. Aqui só o nome do alerta
 * muda (classificados como INFO em `core/alertas/severidade.ts`); nunca a senha nem o hash.
 */
const portasDoTitular: PortasStepUp = {
  ...portasReais,
  alertar(alerta, campos) {
    const nome = alerta === 'payment_gateway_stepup_failed' ? 'login_deletion_stepup_failed' : alerta === 'payment_gateway_stepup_locked' ? 'login_deletion_stepup_locked' : alerta === 'payment_gateway_stepup_unavailable' ? 'login_deletion_stepup_unavailable' : null
    if (nome === null) return // reserva tardia devolvida: sem ruído para o titular
    logger.warn({ alert: nome, ...campos }, '[stepup] confirmação de senha na exclusão de conta recusada')
  },
}

/** Confere a senha ATUAL do próprio titular (exclusão de conta): 403 `INVALID_CURRENT_PASSWORD`, 429 `RATE_LIMITED_ACCOUNT_DELETION` (+ `Retry-After` na rota), 503 `STEPUP_UNAVAILABLE` (fail-closed). */
export function exigirSenhaDoTitular(params: { userId: string; senhaInformada: string }): Promise<void> {
  return exigirSenhaAtual(params, portasDoTitular, 'RATE_LIMITED_ACCOUNT_DELETION')
}
