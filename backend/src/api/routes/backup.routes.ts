import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { exigirSenhaAtual, StepUpRateLimitedError } from '../../services/auth/stepUpSenha'
import { atualizarConfigDeBackup, carregarConfigDeBackup, exigeSenhaDoAdmin, gerarChaveDoBackup, toBackupConfigDto, toBackupStatusDto, type AtorDaConfigDeBackup, type RequisicaoDaConfigDeBackup } from '../../services/backup/configBackup'
import { buscarExecucao, listarExecucoes, solicitarBackupManual, solicitarConferenciaManual, toBackupRunDto } from '../../services/backup/pedidosDeBackup'
import { testarDestinoDeBackup } from '../../services/backup/testarDestino'
import { baseUrlDaApi, concluirConexaoComGoogle, desconectarGoogle, iniciarConexaoComGoogle, origemDoFrontend } from '../../services/backup/googleOAuth'
import { redirectUriDoGoogle } from '../../lib/backup/driveOAuth'
import { PEDIDO_ENFILEIRADO_EXPIRA_EM_MS, TRAVA_EXPIRA_EM_MS } from '../../core/backup/politica'
import { asyncHandler } from '../middleware/asyncHandler'
import { auditCtx } from '../middleware/auditTrail'
import { authenticate, requireRole } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { backupRunRateLimit, backupTestRateLimit, backupWriteRateLimit } from '../middleware/backupRateLimit'
import { validateBody, validateParams, validateQuery } from '../middleware/validate'
import { paginationMeta } from '../schemas/pagination.schema'
import {
  backupRunParamsSchema,
  emptyBodySchema,
  generateBackupKeySchema,
  listBackupRunsQuerySchema,
  stepUpOnlySchema,
  updateBackupConfigSchema,
  type GenerateBackupKeyInput,
  type ListBackupRunsQuery,
  type StepUpOnlyInput,
  type UpdateBackupConfigInput,
} from '../schemas/backup.schema'

/**
 * Backup automático do banco — `/api/admin/backup`. ADMIN-ONLY: o dump tem os dados de TODA a rede (OPERATOR e DRIVER recebem 403). Contrato LITERAL em
 * `docs/CONTRATO-BACKUP-ADMIN.md`. Formato do arquivo cifrado: `docs/BACKUP-FORMATO.md`.
 *
 *  - SEGREDOS SÃO SÓ-ESCRITA: access/secret key do S3, client secret do Google e a chave do backup NUNCA voltam em nenhuma resposta (o GET só diz se existem). A ÚNICA exceção
 *    é `POST /key`, que mostra a chave UMA vez (`Cache-Control: no-store`).
 *  - STEP-UP: PUT da config (exceto horário/frequência/alerta/desligar), gerar chave e conectar/desconectar o Google exigem a senha ATUAL do ADMIN (mesmo mecanismo do gateway,
 *    fail-closed 503 se o Redis do throttle estiver fora). Ordem de erros: 400 validação -> 403 senha -> 429 tranca -> resto.
 *  - "Fazer backup agora" e "Conferir" são ASSÍNCRONOS (202): a API cria a linha `QUEUED` e enfileira; o worker (que tem o `pg_dump`) executa. Acompanhe por `GET /status` e `GET /runs/:id`.
 *  - Restaurar NÃO existe aqui, de propósito: um botão que apaga o banco a um clique é risco desproporcional. Restaurar é por linha de comando (`docs/DEPLOY-EASYPANEL.md`, seção Backups).
 */
const router = Router()

router.use(authenticate, requireRole('ADMIN'))

function requisicaoDe(req: Request): RequisicaoDaConfigDeBackup {
  const id = (req as { id?: string | number }).id
  return { method: req.method, path: req.originalUrl.split('?')[0] as string, ipAddress: req.ip ?? null, userAgent: (req.headers['user-agent'] as string | undefined) ?? null, requestId: id != null ? String(id) : null }
}

async function atorDe(req: Request): Promise<AtorDaConfigDeBackup> {
  const u = await prisma.user.findUnique({ where: { id: req.user!.userId }, select: { email: true, name: true } })
  if (!u) throw new AppError('Token inválido ou expirado.', 401, 'UNAUTHORIZED')
  return { userId: req.user!.userId, role: req.user!.role, email: u.email, name: u.name, operatorId: req.user!.operatorId ?? null }
}

/** Step-up: a senha ATUAL do ADMIN logado. 403 `INVALID_CURRENT_PASSWORD`, 429 `RATE_LIMITED_BACKUP` (+ `Retry-After`), 503 `STEPUP_UNAVAILABLE` (fail-closed). */
async function confirmarSenha(req: Request, res: Response, senha: string, operacao: 'config' | 'key' | 'oauth-start' | 'oauth-disconnect'): Promise<void> {
  try {
    await exigirSenhaAtual({ userId: req.user!.userId, senhaInformada: senha })
  } catch (err) {
    if (err instanceof StepUpRateLimitedError) {
      res.setHeader('Retry-After', String(err.retryAfterSeconds))
      // O código do 429 do step-up é o do gateway; aqui o contrato do backup tem o seu.
      throw new AppError(err.message, 429, 'RATE_LIMITED_BACKUP')
    }
    if (err instanceof AppError && err.code === 'INVALID_CURRENT_PASSWORD') {
      auditCtx(res).describe({ action: 'UPDATE', actionDetail: `backup_${operacao}:stepup_failed`, entityType: 'BackupConfig', entityId: '1', changes: null })
    }
    throw err
  }
}

/** Base da API para o `redirect_uri` do Google: `PUBLIC_API_BASE_URL` ou derivada da requisição do ADMIN autenticado. */
function baseDaApiDe(req: Request): string | null {
  const derivada = req.get('host') ? `${req.protocol}://${req.get('host')}` : null
  return baseUrlDaApi(derivada)
}

async function configComDriveUri(req: Request) {
  const dto = toBackupConfigDto(await carregarConfigDeBackup())
  const base = baseDaApiDe(req)
  return { ...dto, drive: { ...dto.drive, redirectUri: base ? redirectUriDoGoogle(base) : null } }
}

router.get(
  '/config',
  asyncHandler(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.json(await configComDriveUri(req))
  }),
)

router.put(
  '/config',
  backupWriteRateLimit,
  validateBody(updateBackupConfigSchema),
  asyncHandler(async (req, res) => {
    const { currentPassword, ...body } = req.body as UpdateBackupConfigInput
    // A senha atual não sobrevive nem em `req.body`: o middleware de auditoria e qualquer handler de erro nunca a veem.
    delete (req.body as Partial<UpdateBackupConfigInput>).currentPassword
    if (exigeSenhaDoAdmin(body)) {
      if (!currentPassword) throw new AppError('Informe a senha atual para esta alteração.', 400, 'CURRENT_PASSWORD_REQUIRED')
      await confirmarSenha(req, res, currentPassword, 'config')
    }
    const { config } = await atualizarConfigDeBackup({ body, actor: await atorDe(req), request: requisicaoDe(req) })
    // Os segredos novos também saem do `req.body` depois de entregues ao serviço.
    req.body = {}
    // A linha de auditoria JÁ foi gravada (fail-closed, na mesma transação): `skip` evita o middleware genérico duplicar.
    auditCtx(res).describe({ skip: true })
    res.setHeader('Cache-Control', 'no-store')
    const dto = toBackupConfigDto(config)
    const base = baseDaApiDe(req)
    res.json({ ...dto, drive: { ...dto.drive, redirectUri: base ? redirectUriDoGoogle(base) : null } })
  }),
)

router.get(
  '/status',
  asyncHandler(async (_req, res) => {
    const agora = new Date()
    const config = await carregarConfigDeBackup()
    const [ativa, ultimoBackup, ultimaConferencia] = await Promise.all([
      prisma.backupRun.findFirst({
        where: { OR: [{ status: 'RUNNING', startedAt: { gt: new Date(agora.getTime() - TRAVA_EXPIRA_EM_MS) } }, { status: 'QUEUED', createdAt: { gt: new Date(agora.getTime() - PEDIDO_ENFILEIRADO_EXPIRA_EM_MS) } }] },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.backupRun.findFirst({ where: { trigger: { not: 'VERIFY' }, status: { in: ['SUCCESS', 'FAILED'] } }, orderBy: { createdAt: 'desc' } }),
      prisma.backupRun.findFirst({ where: { trigger: 'VERIFY', status: { in: ['SUCCESS', 'FAILED'] } }, orderBy: { createdAt: 'desc' } }),
    ])
    res.setHeader('Cache-Control', 'no-store')
    res.json({ ...toBackupStatusDto(config, agora), activeRun: ativa ? toBackupRunDto(ativa) : null, lastBackupRun: ultimoBackup ? toBackupRunDto(ultimoBackup) : null, lastVerifyRun: ultimaConferencia ? toBackupRunDto(ultimaConferencia) : null })
  }),
)

router.post(
  '/key',
  backupWriteRateLimit,
  validateBody(generateBackupKeySchema),
  asyncHandler(async (req, res) => {
    const { currentPassword, replace, confirmation, expectedFingerprint } = req.body as GenerateBackupKeyInput
    req.body = {} // nem a senha nem a confirmação ficam vivas na requisição
    await confirmarSenha(req, res, currentPassword, 'key')
    const chave = await gerarChaveDoBackup({ substituir: replace === true, confirmacao: confirmation, impressaoEsperada: expectedFingerprint, actor: await atorDe(req), request: requisicaoDe(req) })
    auditCtx(res).describe({ skip: true }) // a auditoria fail-closed já foi gravada na mesma transação
    // A resposta com a chave INTEIRA: nunca em cache de proxy/navegador. É a única vez em que ela sai do servidor.
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Pragma', 'no-cache')
    res.status(201).json(chave)
  }),
)

router.post(
  '/run',
  backupRunRateLimit,
  validateBody(emptyBodySchema),
  asyncHandler(async (req, res) => {
    const run = await solicitarBackupManual({ adminId: req.user!.userId })
    auditCtx(res).describe({ action: 'CREATE', actionDetail: 'backup_run:manual', entityType: 'BackupRun', entityId: run.id, changes: null })
    res.status(202).json(run)
  }),
)

router.post(
  '/verify',
  backupRunRateLimit,
  validateBody(emptyBodySchema),
  asyncHandler(async (req, res) => {
    const run = await solicitarConferenciaManual({ adminId: req.user!.userId })
    auditCtx(res).describe({ action: 'CREATE', actionDetail: 'backup_run:verify', entityType: 'BackupRun', entityId: run.id, changes: null })
    res.status(202).json(run)
  }),
)

router.post(
  '/test-destination',
  backupTestRateLimit,
  validateBody(emptyBodySchema),
  asyncHandler(async (_req, res) => {
    const resultado = await testarDestinoDeBackup()
    // Sempre 200 com o RESULTADO do teste (`ok: false` + `error.code` não é erro da rota).
    auditCtx(res).describe({ action: 'OTHER', actionDetail: `backup_test_destination:${resultado.ok ? 'ok' : resultado.error?.code}`, entityType: 'BackupConfig', entityId: '1', changes: null })
    res.json(resultado)
  }),
)

router.get(
  '/runs',
  validateQuery(listBackupRunsQuerySchema),
  asyncHandler(async (req, res) => {
    const { page, pageSize, trigger, status } = req.query as unknown as ListBackupRunsQuery
    const { items, total } = await listarExecucoes({ page, pageSize, trigger, status })
    res.setHeader('Cache-Control', 'no-store')
    res.json({ items, meta: paginationMeta(page, pageSize, total) })
  }),
)

router.get(
  '/runs/:id',
  validateParams(backupRunParamsSchema),
  asyncHandler(async (req, res) => {
    const run = await buscarExecucao(req.params.id as string)
    if (!run) throw new AppError('Execução não encontrada.', 404, 'NOT_FOUND')
    res.setHeader('Cache-Control', 'no-store')
    res.json(run)
  }),
)

router.post(
  '/google/start',
  backupWriteRateLimit,
  validateBody(stepUpOnlySchema),
  asyncHandler(async (req, res) => {
    const { currentPassword } = req.body as StepUpOnlyInput
    req.body = {}
    await confirmarSenha(req, res, currentPassword, 'oauth-start')
    const base = baseDaApiDe(req)
    const { url } = await iniciarConexaoComGoogle({ adminId: req.user!.userId, baseUrlDaApi: base })
    auditCtx(res).describe({ action: 'OTHER', actionDetail: 'backup_google:start', entityType: 'BackupConfig', entityId: '1', changes: null })
    res.setHeader('Cache-Control', 'no-store')
    res.json({ url, redirectUri: base ? redirectUriDoGoogle(base) : null })
  }),
)

router.post(
  '/google/disconnect',
  backupWriteRateLimit,
  validateBody(stepUpOnlySchema),
  asyncHandler(async (req, res) => {
    const { currentPassword } = req.body as StepUpOnlyInput
    req.body = {}
    await confirmarSenha(req, res, currentPassword, 'oauth-disconnect')
    await desconectarGoogle(req.user!.userId)
    auditCtx(res).describe({ action: 'UPDATE', actionDetail: 'backup_google:disconnect', entityType: 'BackupConfig', entityId: '1', changes: { driveOauthRefreshToken: { changed: true } } })
    res.setHeader('Cache-Control', 'no-store')
    res.json(await configComDriveUri(req))
  }),
)

export default router

// ---------------------------------------------------------------------------------------------
// Callback do Google — PÚBLICO (sem JWT): o Google redireciona o NAVEGADOR para cá. Montado fora de `/api/admin` (ver `app.ts`).
// ---------------------------------------------------------------------------------------------

const callbackQuerySchema = z.object({ state: z.string().max(2048).optional(), code: z.string().max(2048).optional(), error: z.string().max(200).optional() })

function paginaMinima(ok: boolean): string {
  const titulo = ok ? 'Conta Google conectada ao backup.' : 'Não foi possível conectar a conta Google.'
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Backup InnoFlow</title></head><body><p>${titulo} Pode fechar esta janela e voltar ao painel.</p></body></html>`
}

export const backupGoogleCallbackRouter = Router()

backupGoogleCallbackRouter.get(
  '/callback',
  asyncHandler(async (req, res) => {
    // O `code`/`state` NUNCA vão para o Referer da página seguinte nem ficam em cache.
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Referrer-Policy', 'no-referrer')
    const q = callbackQuerySchema.safeParse(req.query)
    const resultado = q.success
      ? await concluirConexaoComGoogle({ state: q.data.state ?? null, code: q.data.code ?? null, googleError: q.data.error ?? null })
      : ({ ok: false, motivo: 'invalid_state' } as const)
    if (!resultado.ok) logger.warn({ motivo: resultado.motivo }, '[backup][google] a conexão não foi concluída')
    const origem = origemDoFrontend()
    if (origem) {
      const destino = new URL('/admin/backup', origem)
      destino.searchParams.set('google', resultado.ok ? 'ok' : 'erro')
      if (!resultado.ok) destino.searchParams.set('motivo', resultado.motivo)
      res.redirect(302, destino.toString())
      return
    }
    // Sem origem do frontend utilizável: página mínima, sem eco de nada que veio na requisição.
    res.status(resultado.ok ? 200 : 400).type('html').send(paginaMinima(resultado.ok))
  }),
)
