/**
 * Apaga os bancos descartáveis que os testes de integração criam (`pgw_*` — config do gateway; `pgl_*` — log do servidor real)
 * e que ficaram para trás quando o processo do vitest morreu no meio (SIGKILL, queda de energia, Ctrl+C duplo): o `DROP DATABASE`
 * está no `afterAll`, que não roda nesses casos. Em CI o Postgres é efêmero e isto não importa; num Postgres de desenvolvimento
 * eles se acumulam (cada um tem o schema inteiro das migrations).
 *
 * Só apaga bancos SEM nenhuma sessão ativa (um teste em andamento mantém conexões abertas) — mas atenção: um arquivo de teste que
 * acabou de fazer `CREATE DATABASE` e ainda não conectou parece "sem sessão". Não rode isto durante uma execução da suíte.
 *
 * Uso (a `DATABASE_URL` precisa de um usuário com permissão de DROP DATABASE):
 *   npx tsx scripts/limparBancosOrfaosDeTeste.ts           # só lista
 *   npx tsx scripts/limparBancosOrfaosDeTeste.ts --apagar  # apaga
 */
import { PrismaClient } from '@prisma/client'

async function main(): Promise<void> {
  const apagar = process.argv.includes('--apagar')
  const prisma = new PrismaClient()
  try {
    const bancos = await prisma.$queryRaw<Array<{ datname: string; sessoes: number }>>`
      SELECT d.datname, (SELECT COUNT(*)::int FROM pg_stat_activity a WHERE a.datname = d.datname) AS sessoes
      FROM pg_database d
      WHERE d.datname ~ '^(pgw|pgl)_[a-z0-9]+$'
      ORDER BY d.datname`
    if (bancos.length === 0) {
      console.log('Nenhum banco de teste órfão.')
      return
    }
    for (const b of bancos) {
      if (b.sessoes > 0) {
        console.log(`${b.datname}: ${b.sessoes} sessão(ões) ativa(s) — em uso, não mexo.`)
        continue
      }
      if (!apagar) {
        console.log(`${b.datname}: órfão (rode com --apagar para remover).`)
        continue
      }
      // O nome já passou pela regex acima ([a-z0-9_]): seguro para interpolar (DDL não aceita parâmetro).
      await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${b.datname}" WITH (FORCE)`)
      console.log(`${b.datname}: apagado.`)
    }
  } finally {
    await prisma.$disconnect()
  }
}

void main().catch((err) => {
  console.error(err)
  process.exit(1)
})
