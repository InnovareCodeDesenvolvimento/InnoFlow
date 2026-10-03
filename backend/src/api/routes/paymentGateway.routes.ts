import { Router, type Request } from 'express'
import { prisma } from '../../lib/prisma'
import { env } from '../../lib/env'
import { atualizarConfigGateway } from '../../services/pagamentos/atualizarConfigGateway'
import { getConfigEfetiva, isSandboxRestrito, verificarSegredosDecifraveis } from '../../services/pagamentos/gatewayConfig'
import { toPaymentGatewayConfigDto } from '../../services/pagamentos/gatewayConfigDto'
import { ConfiguracaoGatewayIndisponivelError } from '../../core/pagamentos/erros'
import { asyncHandler } from '../middleware/asyncHandler'
import { auditCtx } from '../middleware/auditTrail'
import { authenticate, requireRole } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { paymentGatewayWriteRateLimit } from '../middleware/rateLimit'
import { validateBody } from '../middleware/validate'
import { updatePaymentGatewayConfigSchema, type UpdatePaymentGatewayConfigInput } from '../schemas/paymentGateway.schema'
import { exigirSenhaAtual, StepUpRateLimitedError } from '../../services/auth/stepUpSenha'

/**
 * Configuração do gateway de pagamento (F5.5) — `GET`/`PUT /api/admin/payment-gateway`. ADMIN-ONLY: a conta
 * Cielo é ÚNICA da plataforma (decisão D2: a carteira é da rede), então OPERATOR e DRIVER recebem 403.
 * Contrato LITERAL: `PaymentGatewayConfigDTO` / `UpdatePaymentGatewayConfigRequest` / `PaymentGatewayConfigErrorCode`
 * em `frontend/src/types/api.ts`. SEGREDOS NUNCA VOLTAM (só `...Set`), nunca vão para log nem para a auditoria.
 */
const router = Router()

router.use(authenticate, requireRole('ADMIN'))

/**
 * URL pública da API para montar `webhookUrl`: `PUBLIC_API_BASE_URL` (env explícita) ganha; senão deriva do
 * próprio request — `req.protocol`/`req.get('host')` já respeitam `X-Forwarded-*` com `trust proxy`
 * (`TRUST_PROXY_HOPS`). Só o ADMIN vê o resultado, então um `Host` forjado só afeta quem forjou.
 */
function urlPublicaDaApi(req: Request): string | null {
  if (env.PUBLIC_API_BASE_URL) return env.PUBLIC_API_BASE_URL
  const host = req.get('host')
  return host ? `${req.protocol}://${host}` : null
}

async function lerConfigOu503() {
  try {
    return await getConfigEfetiva()
  } catch (err) {
    if (err instanceof ConfiguracaoGatewayIndisponivelError) throw new AppError('Não foi possível ler a configuração do gateway agora.', 503, 'PAYMENT_GATEWAY_UNAVAILABLE')
    throw err
  }
}

/**
 * DTO da config efetiva. `secretsDecryptable` (M3) tenta decifrar os segredos salvos e NUNCA lança: o GET precisa continuar respondendo mesmo com o gateway em
 * 503 (chave trocada/perdida) — é por aqui que o admin enxerga o problema e reenvia os segredos.
 */
async function dtoDaConfigAtual(req: Request) {
  const config = await lerConfigOu503()
  return toPaymentGatewayConfigDto(config, urlPublicaDaApi(req), { secretsDecryptable: verificarSegredosDecifraveis(config.linha), sandboxRestricted: isSandboxRestrito(config.estado) })
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(await dtoDaConfigAtual(req))
  }),
)

router.put(
  '/',
  paymentGatewayWriteRateLimit,
  validateBody(updatePaymentGatewayConfigSchema),
  asyncHandler(async (req, res) => {
    const { currentPassword, ...body } = req.body as UpdatePaymentGatewayConfigInput
    // A senha não sobrevive nem em `req.body`: o middleware de auditoria (que lê o corpo ao fim da resposta) e qualquer handler de erro nunca a veem.
    delete (req.body as Partial<UpdatePaymentGatewayConfigInput>).currentPassword

    // STEP-UP (M2): ANTES de qualquer outra regra de negócio e antes de tocar na configuração. Ordem de erros do PUT: 400 validação -> 403 senha -> resto.
    try {
      await exigirSenhaAtual({ userId: req.user!.userId, senhaInformada: currentPassword })
    } catch (err) {
      if (err instanceof StepUpRateLimitedError) res.setHeader('Retry-After', String(err.retryAfterSeconds))
      // Senha errada é sinal de segurança: grava DENIED na auditoria (o middleware genérico traduz o 403), sem corpo — nem os nomes dos campos.
      if (err instanceof AppError && err.code === 'INVALID_CURRENT_PASSWORD') auditCtx(res).describe({ action: 'PAYMENT_CONFIG_CHANGE', actionDetail: 'stepup_failed', changes: null })
      throw err
    }

    // Ator completo (email/name — o JWT só carrega userId/role/operatorId), mesmo padrão do ajuste de saldo.
    const actor = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.userId }, select: { email: true, name: true } })

    await atualizarConfigGateway({
      body,
      actor: { userId: req.user!.userId, role: req.user!.role, email: actor.email, name: actor.name, operatorId: req.user!.operatorId ?? null },
      request: {
        method: req.method,
        path: req.originalUrl.split('?')[0],
        ipAddress: req.ip ?? null,
        userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
        // `req.id` do pino-http é NÚMERO, `AuditLog.requestId` é `String?` — ver `drivers.routes.ts` (mesmo bug já corrigido lá).
        requestId: (req as { id?: string | number }).id != null ? String((req as { id?: string | number }).id) : null,
      },
    })

    // A linha de auditoria JÁ foi gravada (fail-closed, dentro da MESMA transação da config) — `skip` evita o middleware genérico duplicar.
    auditCtx(res).describe({ skip: true })

    res.json(await dtoDaConfigAtual(req))
  }),
)

export default router
