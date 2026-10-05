import type { Role } from '@prisma/client'
import { AppError } from '../../api/middleware/errorHandler'

/** Quem executa (o ADMIN logado) e de onde veio a requisição — vão para a linha de auditoria FAIL-CLOSED gravada na mesma transação do dinheiro. */
export interface AtorEstorno {
  userId: string
  role: Role
  email: string
  name: string
  operatorId: string | null
}

export interface RequisicaoEstorno {
  method: string
  path: string
  ipAddress: string | null
  userAgent: string | null
  requestId: string | null
}

/**
 * O trigger `payment_reversal_before_insert` (Cronos) é a rede de segurança por baixo da regra da aplicação: se uma corrida ou um bug deixar passar um valor
 * acima do teto, é ELE que recusa — com a mensagem começando pelo código do contrato. Traduz para o 409 estruturado em vez de um 500.
 * (`prisma.create()` devolve esse RAISE como erro desconhecido do Prisma com o texto do Postgres na mensagem.)
 */
export function traduzirErroDoBancoDeEstorno(err: unknown): AppError | null {
  const mensagem = err instanceof Error ? err.message : ''
  if (mensagem.includes('AMOUNT_EXCEEDS_REFUNDABLE')) return new AppError('O valor passa do que ainda pode ser estornado nesta sessão.', 409, 'AMOUNT_EXCEEDS_REFUNDABLE')
  if (mensagem.includes('SESSION_NOT_BILLED')) return new AppError('Esta sessão não foi cobrada: não há o que estornar.', 409, 'SESSION_NOT_BILLED')
  return null
}
