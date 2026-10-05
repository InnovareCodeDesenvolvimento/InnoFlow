import { Router } from 'express'
import { prisma } from '../../lib/prisma'
import { isPaymentSecretsKeyConfigured } from '../../lib/crypto/paymentSecrets'
import { atualizarConfigComunicacao } from '../../services/comunicacao/atualizarConfigComunicacao'
import { toCommunicationSettingsDto } from '../../services/comunicacao/comunicacaoDto'
import { getConfigComunicacaoEstrita, verificarSegredosDecifraveis } from '../../services/comunicacao/configComunicacao'
import { testarConexaoSmtp, testarEmail, testarWhatsapp } from '../../services/comunicacao/testarCanais'
import { resolvedorTxtDoSistema, verificarDominioRemetente } from '../../services/comunicacao/verificarDominio'
import { getDadosLegais } from '../../services/legal/dadosLegais'
import { exigirSenhaAtual, StepUpRateLimitedError } from '../../services/auth/stepUpSenha'
import { asyncHandler } from '../middleware/asyncHandler'
import { auditCtx } from '../middleware/auditTrail'
import { authenticate, requireRole } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { communicationSettingsTestRateLimit, communicationSettingsWriteRateLimit, domainCheckRateLimit } from '../middleware/rateLimit'
import { validateBody, validateQuery } from '../middleware/validate'
import {
  domainCheckQuerySchema,
  testEmailSchema,
  testSmtpConnectionSchema,
  testWhatsappSchema,
  updateCommunicationSettingsSchema,
  type DomainCheckQuery,
  type TestEmailInput,
  type TestSmtpConnectionInput,
  type TestWhatsappInput,
  type UpdateCommunicationSettingsInput,
} from '../schemas/communicationSettings.schema'

/**
 * Configuração de comunicação (e-mail SMTP + WhatsApp/Evolution API dos avisos ao dono) — `/api/admin/communication-settings`. ADMIN-ONLY: o destino dos alertas
 * financeiros e de segurança é do dono da plataforma (OPERATOR e DRIVER recebem 403). Contrato LITERAL em `docs/CONTRATO-COMUNICACAO-ADMIN.md`.
 * SEGREDOS NUNCA VOLTAM (só `passwordSet`/`apiKeySet`), nunca vão para log nem para a auditoria. O PUT exige a senha atual (step-up, fail-closed 503 se o Redis do
 * throttle estiver fora), como o PUT do gateway.
 */
const router = Router()

router.use(authenticate, requireRole('ADMIN'))

async function dtoAtual() {
  const efetiva = await getConfigComunicacaoEstrita()
  return toCommunicationSettingsDto(efetiva, {
    secretsKeyConfigured: isPaymentSecretsKeyConfigured(),
    secretsDecryptable: verificarSegredosDecifraveis(efetiva.linha),
    fonteEnv: process.env,
  })
}

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(await dtoAtual())
  }),
)

router.put(
  '/',
  communicationSettingsWriteRateLimit,
  validateBody(updateCommunicationSettingsSchema),
  asyncHandler(async (req, res) => {
    const { currentPassword, ...body } = req.body as UpdateCommunicationSettingsInput
    // A senha atual não sobrevive nem em `req.body`: o middleware de auditoria e qualquer handler de erro nunca a veem. Os segredos novos (password/apiKey) também
    // saem de `req.body` DEPOIS de entregues ao serviço — o middleware genérico de auditoria não grava corpo, mas o objeto não precisa ficar vivo na requisição.
    delete (req.body as Partial<UpdateCommunicationSettingsInput>).currentPassword

    // STEP-UP: ANTES de qualquer outra regra e antes de tocar na configuração. Ordem de erros: 400 validação -> 403 senha -> resto.
    try {
      await exigirSenhaAtual({ userId: req.user!.userId, senhaInformada: currentPassword })
    } catch (err) {
      if (err instanceof StepUpRateLimitedError) res.setHeader('Retry-After', String(err.retryAfterSeconds))
      if (err instanceof AppError && err.code === 'INVALID_CURRENT_PASSWORD') auditCtx(res).describe({ action: 'UPDATE', actionDetail: 'communication_settings:stepup_failed', changes: null })
      throw err
    }

    const actor = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.userId }, select: { email: true, name: true } })
    await atualizarConfigComunicacao({
      body,
      actor: { userId: req.user!.userId, role: req.user!.role, email: actor.email, name: actor.name, operatorId: req.user!.operatorId ?? null },
      request: {
        method: req.method,
        path: req.originalUrl.split('?')[0],
        ipAddress: req.ip ?? null,
        userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
        requestId: (req as { id?: string | number }).id != null ? String((req as { id?: string | number }).id) : null,
      },
    })
    req.body = {}
    // A linha de auditoria JÁ foi gravada (fail-closed, na mesma transação): `skip` evita o middleware genérico duplicar.
    auditCtx(res).describe({ skip: true })
    res.json(await dtoAtual())
  }),
)

/**
 * `POST .../test-email` e `.../test-whatsapp`: enviam UMA mensagem de teste com a config salva (ou a do corpo, ainda não salva — nada é persistido). Sempre 200 com o
 * RESULTADO (`ok: false` + `error.code` é o resultado do teste, não erro da rota); 503 só se a config está ilegível; 400 `SECRET_REQUIRED_FOR_NEW_DESTINATION` quando o corpo
 * troca o destino sem reenviar o segredo. Sem step-up (não grava nada, não revela segredo; pedir a senha a cada clique tornaria o diagnóstico inutilizável) — o balde de 5/min e a
 * auditoria (uma linha `OTHER` com o resultado, sem destinatário nem segredo) cobrem o abuso.
 */
router.post(
  '/test-email',
  communicationSettingsTestRateLimit,
  validateBody(testEmailSchema),
  asyncHandler(async (req, res) => {
    const input = req.body as TestEmailInput
    const resultado = await testarEmail(input)
    // O corpo (que pode ter a senha de teste) não fica vivo na requisição nem entra na auditoria.
    req.body = {}
    auditCtx(res).describe({ action: 'OTHER', actionDetail: `test_email:${resultado.ok ? 'ok' : resultado.error?.code}`, changes: null })
    res.json(resultado)
  }),
)

/**
 * `POST .../test-smtp-connection`: só o HANDSHAKE SMTP (conectar, TLS, autenticar) — NÃO envia mensagem. Mesmas proteções do `test-email` (balde de 5/min, anti-SSRF, anti-exfiltração,
 * `config` não salva opcional). Sempre 200 com o RESULTADO (`ok`, `stage`, `code`); 400 `SECRET_REQUIRED_FOR_NEW_DESTINATION` quando o corpo troca o destino sem reenviar a senha.
 */
router.post(
  '/test-smtp-connection',
  communicationSettingsTestRateLimit,
  validateBody(testSmtpConnectionSchema),
  asyncHandler(async (req, res) => {
    const input = req.body as TestSmtpConnectionInput
    const resultado = await testarConexaoSmtp(input)
    req.body = {} // a senha de teste (se veio) não fica viva na requisição nem entra na auditoria
    auditCtx(res).describe({ action: 'OTHER', actionDetail: `test_smtp_connection:${resultado.ok ? 'ok' : resultado.code}`, changes: null })
    res.json(resultado)
  }),
)

/**
 * `GET .../domain-check?selector=`: diagnóstico de SPF / DKIM / DMARC do domínio do e-mail REMETENTE configurado (painel > env). O domínio NUNCA vem do cliente; só o seletor DKIM (validado).
 * Só consulta TXT públicos; falha de DNS vira `ERRO` no registro (200), nunca derruba. Balde de 6/min por ADMIN.
 */
router.get(
  '/domain-check',
  domainCheckRateLimit,
  validateQuery(domainCheckQuerySchema),
  asyncHandler(async (req, res) => {
    const { selector } = req.query as unknown as DomainCheckQuery
    const dto = await dtoAtual()
    const legal = await getDadosLegais()
    res.setHeader('Cache-Control', 'no-store')
    res.json(await verificarDominioRemetente({ remetente: dto.email.fromAddress, smtpHost: dto.email.host, suporteEmail: legal.empresa.supportEmail, seletor: selector ?? null, resolverTxt: resolvedorTxtDoSistema }))
  }),
)

router.post(
  '/test-whatsapp',
  communicationSettingsTestRateLimit,
  validateBody(testWhatsappSchema),
  asyncHandler(async (req, res) => {
    const input = req.body as TestWhatsappInput
    const resultado = await testarWhatsapp(input)
    req.body = {}
    auditCtx(res).describe({ action: 'OTHER', actionDetail: `test_whatsapp:${resultado.ok ? 'ok' : resultado.error?.code}`, changes: null })
    res.json(resultado)
  }),
)

export default router
