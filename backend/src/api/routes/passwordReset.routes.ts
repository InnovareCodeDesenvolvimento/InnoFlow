import { Router, type Request } from 'express'
import { AppError } from '../middleware/errorHandler'
import { asyncHandler } from '../middleware/asyncHandler'
import { forgotPasswordRateLimit, resetPasswordRateLimit } from '../middleware/rateLimit'
import { validateBody } from '../middleware/validate'
import { forgotPasswordSchema, resetPasswordSchema, type ForgotPasswordInput, type ResetPasswordInput } from '../schemas/auth.schema'
import { sessionValidator } from '../lib/sessionValidatorInstance'
import { agendarEmailDeSenha, servicoDeRedefinicao } from '../../services/auth/redefinicaoSenhaInstancia'
import type { MetaDaRequisicao } from '../../services/auth/redefinicaoSenha'

/**
 * `/api/auth/password/forgot` e `/api/auth/password/reset` (L1.3) — redefinição de senha por e-mail, rotas PÚBLICAS (sem JWT). Contrato: `ForgotPasswordRequest`/`ResetPasswordRequest`
 * em `frontend/src/types/api.ts`. Toda a regra mora em `services/auth/redefinicaoSenha.ts` (+ núcleo puro em `core/auth/redefinicaoSenha.ts`); aqui só o mapeamento para HTTP.
 *
 * Montado em `/api/auth/password` (ver `app.ts`); o `POST /api/auth/password` autenticado (troca da própria senha) continua em `auth.routes.ts` e não conflita (caminho exato).
 */
const router = Router()

function metaDaRequisicao(req: Request): MetaDaRequisicao {
  const rawId = (req as { id?: string | number }).id
  return { ip: req.ip ?? null, userAgent: (req.headers['user-agent'] as string | undefined) ?? null, requestId: rawId != null ? String(rawId) : null }
}

/**
 * SEMPRE 202 `{ ok: true }` para e-mail BEM FORMADO — exista a conta ou não, ativa ou não, ADMIN ou não: nada na resposta (corpo, status, tempo) muda. O motivo do tempo ser igual
 * é estrutural, não "ajustado": a rota só valida e ENFILEIRA; consulta ao banco, Redis e SMTP rodam depois da resposta (`agendarEmailDeSenha`). O endereço do link vem de configuração
 * (`PUBLIC_APP_URL`), nunca do header `Host`. O e-mail do pedido não é logado.
 */
router.post('/forgot', forgotPasswordRateLimit, validateBody(forgotPasswordSchema), (req, res) => {
  const { email } = req.body as ForgotPasswordInput
  const meta = metaDaRequisicao(req)
  agendarEmailDeSenha(() => servicoDeRedefinicao.solicitar(email, meta))
  res.status(202).json({ ok: true })
})

/**
 * 204 sem corpo. Token no CORPO (nunca na URL). Um código só (`RESET_TOKEN_INVALID`) para expirado/usado/inexistente/malformado/conta que não pode redefinir. Sem auto-login.
 * A resposta NÃO devolve token de sessão: a pessoa entra de novo, com a senha nova.
 */
router.post(
  '/reset',
  resetPasswordRateLimit,
  validateBody(resetPasswordSchema),
  asyncHandler(async (req, res) => {
    const { token, newPassword } = req.body as ResetPasswordInput
    const resultado = await servicoDeRedefinicao.redefinir({ token, novaSenha: newPassword }, metaDaRequisicao(req))

    switch (resultado.status) {
      case 'BLOQUEADO':
        res.setHeader('Retry-After', String(resultado.retryAfterSeconds))
        throw new AppError('Muitas tentativas com link inválido. Tente novamente mais tarde.', 429, 'RATE_LIMITED_AUTH')
      case 'INDISPONIVEL':
        throw new AppError('Serviço temporariamente indisponível. Tente novamente em instantes.', 503, 'SERVICE_UNAVAILABLE')
      case 'TOKEN_INVALIDO':
        throw new AppError('Este link de redefinição é inválido ou expirou. Peça um novo.', 400, 'RESET_TOKEN_INVALID')
      case 'OK':
        // As sessões foram revogadas no banco (`sessionsValidAfter`); o cache de ~30 s do validador neste processo solta o usuário JÁ.
        sessionValidator.invalidate(resultado.userId)
        res.status(204).end()
        agendarEmailDeSenha(() => servicoDeRedefinicao.avisarSenhaAlterada({ nome: resultado.nome, email: resultado.email }))
        return
    }
  }),
)

export default router
