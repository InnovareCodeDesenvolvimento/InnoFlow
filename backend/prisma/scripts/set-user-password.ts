/**
 * Troca a senha de um usuário (e opcionalmente desativa contas) DIRETO no
 * banco — para rotacionar as credenciais fixas do seed em produção
 * (achado Crítico C1 do Órion, 19/09/2026: `admin123456` está no repositório).
 *
 * Uso (no terminal do serviço `api` no EasyPanel):
 *   NEW_PASSWORD='<senha forte>' npm run user:set-password -- admin@innoelektron.example.com
 *   npm run user:set-password -- staff@innoelektron-operacoes.example.com --deactivate
 *
 * A senha vem por ENV (não por argumento: argumento aparece na lista de
 * processos), NUNCA é impressa nem gravada em log. Mínimo 12 caracteres e
 * recusa as senhas conhecidas do seed. Idempotente.
 */
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()

const BCRYPT_ROUNDS = 12
const MIN_LENGTH = 12
const SEED_PASSWORDS = new Set(['admin123456', 'staff123456', 'driver123456', 'changeme-basic-auth-secret'])

async function main() {
  const args = process.argv.slice(2)
  const deactivate = args.includes('--deactivate')
  const email = args.find((a) => !a.startsWith('--'))?.trim().toLowerCase()
  if (!email) throw new Error('Informe o e-mail: npm run user:set-password -- <email> [--deactivate]')

  const user = await prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } }, select: { id: true, email: true, role: true, active: true } })
  if (!user) throw new Error(`Usuário não encontrado: ${email}`)

  if (deactivate) {
    await prisma.user.update({ where: { id: user.id }, data: { active: false, sessionsValidAfter: new Date() } })
    console.log(`[user:set-password] ${user.email} (${user.role}) DESATIVADO. Sessões abertas caem em até ~30s (cache do authenticate na API).`)
    return
  }

  const password = process.env.NEW_PASSWORD
  if (!password) throw new Error('Defina a env NEW_PASSWORD (a senha nova) — ou use --deactivate.')
  if (password.length < MIN_LENGTH) throw new Error(`Senha muito curta: mínimo ${MIN_LENGTH} caracteres.`)
  if (SEED_PASSWORDS.has(password)) throw new Error('Essa é uma senha conhecida do seed — escolha outra.')

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS)
  // `sessionsValidAfter = agora` revoga TODOS os JWT emitidos até aqui (Órion A3/M1) — é o ponto
  // da rotação: quem estiver logado com a senha antiga do seed cai. O cache do `authenticate`
  // na API vence em até ~30s (este script roda em outro processo e não consegue invalidá-lo).
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash, active: true, sessionsValidAfter: new Date() } })
  console.log(`[user:set-password] senha de ${user.email} (${user.role}) atualizada. Sessões antigas caem em até ~30s (cache do authenticate na API).`)
}

main()
  .catch((err) => {
    console.error(`[user:set-password] ERRO: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
