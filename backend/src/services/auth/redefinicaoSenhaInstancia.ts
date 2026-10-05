import { prisma } from '../../lib/prisma'
import { env } from '../../lib/env'
import { logger } from '../../lib/logger'
import { redis } from '../../lib/redis'
import { FilaEmBackground } from '../../lib/filaEmBackground'
import { createLogGate } from '../../lib/rateLimitedLog'
import { resolverBaseUrlPublica } from '../../core/auth/redefinicaoSenha'
import { writeAuditLog } from '../auditoria/writeAuditLog'
import { enviarEmailTransacional } from '../comunicacao/email'
import { criarServicoDeRedefinicao, type ContaCompleta, type RepoDeContasParaRedefinicao } from './redefinicaoSenha'
import { criarTokensDeRedefinicaoRedis } from './tokensRedefinicaoRedis'

/**
 * Instâncias do processo da API para a redefinição de senha (L1.3): liga a fábrica pura (`redefinicaoSenha.ts`) ao Prisma, ao Redis e ao SMTP do painel. Separado da fábrica
 * para os testes unitários dela não importarem `env`/banco (mesmo padrão de `sessionValidatorInstance.ts`).
 */

const SELECT_CONTA = { id: true, role: true, active: true, passwordHash: true, googleSub: true, name: true, email: true, operatorId: true } as const

export const repoDeContasPrisma: RepoDeContasParaRedefinicao = {
  async buscarPorEmail(email: string): Promise<ContaCompleta | null> {
    const aparado = email.trim()
    // `User.email` é único COM caixa e o login é exato, mas o cadastro bloqueia duplicata SEM caixa: quem digita o e-mail com caixa diferente ainda deve achar a conta.
    const candidatos = await prisma.user.findMany({ where: { email: { equals: aparado, mode: 'insensitive' } }, select: SELECT_CONTA, take: 2 })
    const exato = candidatos.find((c) => c.email === aparado)
    if (exato) return exato
    return candidatos.length === 1 ? candidatos[0] : null // dois que só diferem na caixa e nenhum exato: ambíguo, não adivinha
  },

  buscarPorId: (id: string) => prisma.user.findUnique({ where: { id }, select: SELECT_CONTA }),

  async trocarSenha({ id, hashEsperado, novoHash, agora, auditoria }): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
      // O `where` repete o que foi lido (conta ativa, mesmo hash): se outra troca de senha/desativação passou no meio, `count` é 0 e nada muda.
      const r = await tx.user.updateMany({ where: { id, active: true, passwordHash: hashEsperado }, data: { passwordHash: novoHash, sessionsValidAfter: agora } })
      if (r.count !== 1) return false
      await writeAuditLog(auditoria, tx) // falhou a auditoria => a transação inteira volta (a senha NÃO muda sem registro)
      return true
    })
  },

  auditar: (entrada) => writeAuditLog(entrada),
}

const gateFilaCheia = createLogGate(60_000)
const gateFalhaDeTarefa = createLogGate(10_000)

/** Fila dos e-mails de senha (forgot e "senha alterada"): fora do caminho da resposta. */
export const filaDeEmailsDeSenha = new FilaEmBackground({
  concorrencia: 3,
  tamanhoMaximo: 100,
  aoFalhar: (err) =>
    gateFalhaDeTarefa((suprimidos) => logger.error({ err, suprimidos, event: 'password_reset_task_failed' }, '[auth] tarefa em segundo plano da redefinição de senha falhou')),
})

/** Agenda na fila; se cheia, descarta (a resposta já foi/vai ser 202) e avisa no máximo 1x por minuto. */
export function agendarEmailDeSenha(tarefa: () => Promise<void>): void {
  if (!filaDeEmailsDeSenha.agendar(tarefa)) {
    gateFilaCheia((suprimidos) => logger.warn({ suprimidos, event: 'password_reset_queue_full' }, '[auth] fila de e-mails de senha cheia — pedidos descartados'))
  }
}

/** Origem pública do frontend para os links — de configuração, NUNCA do header Host da requisição. */
export function baseUrlPublicaDosEmails(): string | null {
  return resolverBaseUrlPublica({ publicAppUrl: env.PUBLIC_APP_URL, corsOrigins: env.CORS_ALLOWED_ORIGINS, producao: env.NODE_ENV === 'production' })
}

export const servicoDeRedefinicao = criarServicoDeRedefinicao({
  contas: repoDeContasPrisma,
  tokens: criarTokensDeRedefinicaoRedis(redis),
  redis,
  enviarEmail: (msg) => enviarEmailTransacional(msg),
  baseUrl: baseUrlPublicaDosEmails,
  maxEmailsPorHora: env.PASSWORD_RESET_MAX_EMAILS_PER_HOUR,
  log: logger,
})
