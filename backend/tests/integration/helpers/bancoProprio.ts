import { execSync } from 'node:child_process'
import { PrismaClient } from '@prisma/client'

/**
 * Banco PRÓPRIO por arquivo de teste (padrão de `paymentGatewayConfig.test.ts`, extraído na F5.7): `PaymentGatewayConfig` é um
 * SINGLETON GLOBAL e as suítes rodam em paralelo no MESMO Postgres — gravar credencial/flags/ambiente no banco compartilhado
 * trocaria o adaptador de pagamento (Cielo de verdade em vez do Fake) e desligaria cartão/Pix nas outras suítes no meio do teste.
 *
 * Uso: `const banco = await criarBancoProprio('xx')` no `beforeAll`, ANTES de importar os módulos da aplicação (o `env.ts`/Prisma leem
 * `DATABASE_URL` uma vez, no import — por isso o `import()` dinâmico depois); `await banco.descartar()` no `afterAll`, DEPOIS de
 * desconectar o Prisma da aplicação. Precisa de CREATEDB (o `postgres` da CI e do dev têm).
 */
export async function criarBancoProprio(prefixo: string): Promise<{ nome: string; url: string; descartar(): Promise<void> }> {
  const baseUrl = process.env.DATABASE_URL!
  const nome = `${prefixo}_${Math.random().toString(36).slice(2, 10)}`
  const url = baseUrl.replace(/\/[^/?]+(\?|$)/, `/${nome}$1`)
  const admin = new PrismaClient({ datasources: { db: { url: baseUrl } } })
  await admin.$executeRawUnsafe(`CREATE DATABASE "${nome}"`)
  execSync('npx prisma migrate deploy', { env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe', cwd: process.cwd() })
  process.env.DATABASE_URL = url
  return {
    nome,
    url,
    async descartar() {
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${nome}" WITH (FORCE)`)
      await admin.$disconnect()
    },
  }
}
