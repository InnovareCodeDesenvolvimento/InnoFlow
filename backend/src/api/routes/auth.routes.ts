import { Router, type Request } from 'express'
import bcrypt from 'bcryptjs'
import type { Role } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { env } from '../../lib/env'
import { issueToken } from '../../lib/jwt'
import { logger } from '../../lib/logger'
import { AppError } from '../middleware/errorHandler'
import { asyncHandler } from '../middleware/asyncHandler'
import { authRateLimit, changePasswordRateLimit } from '../middleware/rateLimit'
import { authenticate } from '../middleware/auth'
import { sessionValidator } from '../lib/sessionValidatorInstance'
import { validateBody } from '../middleware/validate'
import { changePasswordSchema, googleAuthSchema, loginSchema, registerSchema, type ChangePasswordInput, type GoogleAuthInput, type LoginInput, type RegisterInput } from '../schemas/auth.schema'
import { writeAuditLog } from '../../services/auditoria/writeAuditLog'
import { autenticarComGoogle } from '../../services/auth/autenticarComGoogle'
import { createGoogleTokenVerifier } from '../../services/auth/googleTokenVerifier'
import { prismaGoogleUserRepository } from '../../services/auth/prismaGoogleUserRepository'

/**
 * Log de auditoria de LOGIN — fora do middleware genérico (`auditTrail()`,
 * montado só em `/api/admin`, e login não é uma dessas rotas). Regras
 * (Nova, decisoes-audit-log.md): só ADMIN/OPERATOR (motorista fica fora — é
 * o público majoritário do sistema, logaria toda recarga de QR code) e
 * `LOGIN_FAILED` só quando o e-mail já pertence a uma conta existente
 * (e-mail desconhecido = ruído de bot batendo na porta, não vira linha —
 * proteção contra inundação da tabela append-only).
 */
const AUDITABLE_LOGIN_ROLES = new Set<Role>(['ADMIN', 'OPERATOR'])

function requestMeta(req: Request) {
  // `req.id` do pino-http é número, não string — ver mesmo fix em
  // `api/middleware/auditTrail.ts` (achado real em produção, 17/09/2026).
  const rawId = (req as { id?: string | number }).id
  return {
    ipAddress: req.ip ?? null,
    userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    requestId: rawId != null ? String(rawId) : null,
  }
}

async function recordLoginAudit(
  req: Request,
  user: { id: string; role: Role; email: string; name: string; operatorId: string | null },
  outcome: 'LOGIN_SUCCESS' | 'LOGIN_FAILED',
  httpStatus: number,
  extra: { actionDetail?: string; path?: string } = {},
): Promise<void> {
  if (!AUDITABLE_LOGIN_ROLES.has(user.role)) return
  await writeAuditLog({
    actorUserId: user.id,
    actorRole: user.role,
    actorEmail: user.email,
    actorName: user.name,
    actorOperatorId: user.operatorId,
    action: outcome,
    actionDetail: extra.actionDetail ?? null,
    outcome: outcome === 'LOGIN_SUCCESS' ? 'SUCCESS' : 'FAILED',
    httpStatus,
    entityType: 'User',
    entityId: user.id,
    targetOperatorId: user.operatorId,
    method: 'POST',
    path: extra.path ?? '/api/auth/login',
    ...requestMeta(req),
  })
}

// 12 rounds (Órion: 10 é o piso; o custo extra só pesa em login/cadastro/troca de senha, nunca em
// request autenticada). Hashes antigos (10) continuam válidos — o custo vem embutido no hash.
const BCRYPT_ROUNDS = 12

const router = Router()

function toUserDTO(user: { id: string; name: string; email: string; role: string; operatorId: string | null; operatorName?: string | null; hasPassword: boolean }) {
  return { id: user.id, name: user.name, email: user.email, role: user.role, operatorId: user.operatorId, operatorName: user.operatorName ?? null, hasPassword: user.hasPassword }
}

router.post(
  '/register',
  authRateLimit,
  validateBody(registerSchema),
  asyncHandler(async (req, res) => {
    const { name, email, password, phone } = req.body as RegisterInput

    const existing = await prisma.user.findUnique({ where: { email } })
    if (existing) throw new AppError('Já existe uma conta com este e-mail.', 409, 'EMAIL_TAKEN')

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS)

    const user = await prisma.user.create({
      data: { name, email, phone, passwordHash, role: 'DRIVER' },
    })
    await prisma.wallet.create({ data: { userId: user.id } })

    const token = issueToken(user)
    res.status(201).json({ token, user: toUserDTO({ ...user, hasPassword: true }) })
  }),
)

router.post(
  '/login',
  authRateLimit,
  validateBody(loginSchema),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body as LoginInput

    const user = await prisma.user.findUnique({ where: { email }, include: { operator: { select: { name: true } } } })
    // E-mail desconhecido: NUNCA audita (ruído de bot — ver cabeçalho do
    // arquivo) e responde igual a qualquer outra credencial inválida (não
    // vaza se o e-mail existe ou não).
    if (!user) throw new AppError('E-mail ou senha inválidos.', 401, 'INVALID_CREDENTIALS')

    if (!user.active || !user.passwordHash) {
      void recordLoginAudit(req, { ...user, operatorId: user.operatorId }, 'LOGIN_FAILED', 401).catch((err) =>
        logger.error({ err, userId: user.id }, '[audit] falha ao gravar LOGIN_FAILED (fire-and-forget)'),
      )
      throw new AppError('E-mail ou senha inválidos.', 401, 'INVALID_CREDENTIALS')
    }

    const passwordOk = await bcrypt.compare(password, user.passwordHash)
    if (!passwordOk) {
      void recordLoginAudit(req, user, 'LOGIN_FAILED', 401).catch((err) => logger.error({ err, userId: user.id }, '[audit] falha ao gravar LOGIN_FAILED (fire-and-forget)'))
      throw new AppError('E-mail ou senha inválidos.', 401, 'INVALID_CREDENTIALS')
    }

    const token = issueToken(user)
    res.json({ token, user: toUserDTO({ ...user, operatorName: user.operator?.name, hasPassword: true }) })

    void recordLoginAudit(req, user, 'LOGIN_SUCCESS', 200).catch((err) => logger.error({ err, userId: user.id }, '[audit] falha ao gravar LOGIN_SUCCESS (fire-and-forget)'))
  }),
)

/**
 * `POST /api/auth/google` — login/cadastro de MOTORISTA com Google (Google
 * Identity Services). Toda a decisão mora em `autenticarComGoogle`/
 * `decidirAcaoGoogle` (testáveis sem banco); aqui só o mapeamento para HTTP.
 *
 * NÃO logar o `credential` (é um JWT — mesma classe de vazamento que o Órion
 * achou no pino): esta rota nunca passa o body nem o erro da lib do Google
 * para o logger. O `pino-http` também não serializa `req.body`.
 *
 * Só DRIVER entra por aqui — ADMIN/OPERATOR NUNCA (nem são vinculados): a
 * tentativa em conta de staff é sinal de segurança e grava `LOGIN_FAILED`
 * (`actionDetail: 'google_login_blocked'`). O resto (sucesso/falha de
 * motorista) não audita, mesma regra do `/login`.
 */
router.post(
  '/google',
  authRateLimit,
  validateBody(googleAuthSchema),
  asyncHandler(async (req, res) => {
    const clientId = env.GOOGLE_CLIENT_ID
    if (!clientId) throw new AppError('Login com Google não está configurado.', 503, 'GOOGLE_NOT_CONFIGURED')

    const { credential } = req.body as GoogleAuthInput
    const resultado = await autenticarComGoogle(credential, { verifyIdToken: createGoogleTokenVerifier(clientId), users: prismaGoogleUserRepository })

    switch (resultado.status) {
      case 'INVALID_TOKEN':
        throw new AppError('Token do Google inválido.', 401, 'INVALID_GOOGLE_TOKEN')
      case 'EMAIL_NOT_VERIFIED':
        throw new AppError('O e-mail da conta Google não está verificado.', 403, 'GOOGLE_EMAIL_NOT_VERIFIED')
      case 'STAFF_NOT_ALLOWED': {
        const staff = resultado.staff
        void recordLoginAudit(req, staff, 'LOGIN_FAILED', 403, { actionDetail: 'google_login_blocked', path: '/api/auth/google' }).catch((err) =>
          logger.error({ err, userId: staff.id }, '[audit] falha ao gravar LOGIN_FAILED do Google (fire-and-forget)'),
        )
        throw new AppError('Esta conta não pode entrar com Google.', 403, 'GOOGLE_LOGIN_NOT_ALLOWED')
      }
      case 'ACCOUNT_MISMATCH':
        // Contrato só tem `GOOGLE_LOGIN_NOT_ALLOWED` para "esta conta não pode
        // entrar por Google" — reaproveitado (nenhum código novo inventado).
        throw new AppError('Esta conta não pode entrar com Google.', 403, 'GOOGLE_LOGIN_NOT_ALLOWED')
      case 'INACTIVE':
        // Mesma resposta que `/login` dá para conta inativa.
        throw new AppError('E-mail ou senha inválidos.', 401, 'INVALID_CREDENTIALS')
      case 'OK':
        // Vínculo zerou a senha e bumpou `sessionsValidAfter` — o cache de sessão deste processo
        // tem que soltar o usuário JÁ, senão as sessões antigas valeriam até 30s (ver sessionValidator).
        if (resultado.linked) sessionValidator.invalidate(resultado.user.id)
        res.status(resultado.created ? 201 : 200).json({ token: issueToken(resultado.user), user: toUserDTO({ ...resultado.user, operatorName: null }) })
        return
    }
  }),
)

/**
 * `POST /api/auth/password` — troca/definição da PRÓPRIA senha (qualquer papel). Autenticada +
 * limite por USUÁRIO. Conta COM senha exige a atual; conta só-Google (sem `passwordHash`, ver
 * o vínculo em `prismaGoogleUserRepository`) define a primeira sem a atual. Sucesso: hash novo
 * (12 rounds), `sessionsValidAfter = agora` (mata TODAS as sessões anteriores, inclusive a que
 * fez a chamada) e um TOKEN NOVO na resposta. NUNCA loga/audita o corpo (senhas); só o EVENTO
 * é auditado para ADMIN/OPERATOR (`action=OTHER`, `actionDetail=password_changed`).
 * Senha atual errada = 403 (não 401: o interceptor do frontend deslogaria por 401).
 */
router.post(
  '/password',
  authenticate,
  changePasswordRateLimit,
  validateBody(changePasswordSchema),
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body as ChangePasswordInput

    const user = await prisma.user.findUnique({ where: { id: req.user!.userId }, include: { operator: { select: { name: true } } } })
    if (!user) throw new AppError('Token inválido ou expirado.', 401, 'UNAUTHORIZED')

    if (user.passwordHash) {
      if (!currentPassword) throw new AppError('Informe a senha atual.', 400, 'CURRENT_PASSWORD_REQUIRED')
      const ok = await bcrypt.compare(currentPassword, user.passwordHash)
      if (!ok) throw new AppError('Senha atual incorreta.', 403, 'INVALID_CURRENT_PASSWORD')
      if (currentPassword === newPassword) throw new AppError('A nova senha precisa ser diferente da atual.', 400, 'PASSWORD_UNCHANGED')
    }

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS)
    const updated = await prisma.user.update({ where: { id: user.id }, data: { passwordHash, sessionsValidAfter: new Date() } })
    sessionValidator.invalidate(user.id)

    const token = issueToken(updated)
    res.json({ token, user: toUserDTO({ ...updated, operatorName: user.operator?.name, hasPassword: true }) })

    if (AUDITABLE_LOGIN_ROLES.has(updated.role)) {
      void writeAuditLog({
        actorUserId: updated.id,
        actorRole: updated.role,
        actorEmail: updated.email,
        actorName: updated.name,
        actorOperatorId: updated.operatorId,
        action: 'OTHER',
        actionDetail: 'password_changed',
        outcome: 'SUCCESS',
        httpStatus: 200,
        entityType: 'User',
        entityId: updated.id,
        targetOperatorId: updated.operatorId,
        method: 'POST',
        path: '/api/auth/password',
        ...requestMeta(req),
      }).catch((err) => logger.error({ err, userId: updated.id }, '[audit] falha ao gravar password_changed (fire-and-forget)'))
    }
  }),
)

export default router
