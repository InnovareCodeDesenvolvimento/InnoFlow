import type { Prisma } from '@prisma/client'

/**
 * Serializa as escritas nos cartões de UM motorista (N-9, Órion 05/10/2026).
 *
 * O problema: o teto de cartões ativos (5) e o "um padrão por motorista/ambiente" são regras de APLICAÇÃO (o banco não as garante). O cadastro fazia
 * `count` -> `create` dentro de uma transação READ COMMITTED: N requisições paralelas do mesmo motorista liam a MESMA contagem (ex.: 4), todas passavam
 * e todas inseriam — 4 + N cartões. O mesmo vale para dois "tornar padrão"/cadastro com `makeDefault` ao mesmo tempo (dois padrões).
 *
 * A correção: um LOCK CONSULTIVO de transação por motorista, a PRIMEIRA coisa nas transações que escrevem cartão (cadastro, tornar padrão, remover).
 * A 2ª transação espera a 1ª commitar e, como cada comando de READ COMMITTED enxerga o que já foi commitado, o `count` dela já inclui o cartão novo.
 *
 * Por que lock consultivo e não `SELECT ... FOR UPDATE` numa linha:
 *  - na `User`, o `FOR UPDATE` conflita com o `FOR KEY SHARE` de qualquer INSERT que referencie o usuário (sessão, carteira, intent...) — travaria muito mais que o cadastro de cartão;
 *  - na `Wallet`, serializaria o cadastro com TODO débito/crédito do motorista (e a carteira pode nem existir ainda).
 *  O lock consultivo só atrapalha quem escreve cartão do MESMO motorista (rajada de cadastros — exatamente o caso a conter).
 *
 * Chave: a forma de DOIS inteiros (`int4`, `int4`) — (namespace fixo, hash do userId). É outro espaço de chaves que o lock de UM argumento do gateway
 * (`criarIntentNoAmbiente.ts`), então não colide com ele. Colisão de hash entre dois motoristas só os serializaria sem necessidade (inofensivo).
 * `userId` vai como parâmetro do Prisma (nunca concatenado). Sem deadlock: é o primeiro e único lock consultivo destas transações.
 */
export async function travarCartoesDoUsuario(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('payment_method_user'), hashtext(${userId}))`
}
