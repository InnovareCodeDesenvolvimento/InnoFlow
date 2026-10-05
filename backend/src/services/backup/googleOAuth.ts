import { prisma } from '../../lib/prisma'
import { env } from '../../lib/env'
import { logger } from '../../lib/logger'
import { encryptPaymentSecret, isPaymentSecretsKeyConfigured } from '../../lib/crypto/paymentSecrets'
import { assinarEstadoDoOAuth, buscarEmailDaConta, criarPastaDeBackups, montarUrlDeAutorizacao, redirectUriDoGoogle, revogarTokenDoGoogle, trocarCodigoPorTokens, verificarEstadoDoOAuth } from '../../lib/backup/driveOAuth'
import { ErroDeBackup } from '../../core/backup/erros'
import { AppError } from '../../api/middleware/errorHandler'
import { carregarConfigDeBackup, lerSegredoDaConfig } from './configBackup'

/**
 * "Conectar com Google" (Drive por OAuth) — início (rota ADMIN com step-up), callback (rota PÚBLICA: o Google redireciona o navegador, sem o Bearer da SPA) e desconectar.
 *
 * O callback NÃO tem JWT. A prova de que quem iniciou foi um ADMIN é o `state`: assinado (HMAC com segredo do servidor), de 10 min, emitido SÓ pela rota ADMIN e com NONCE DE USO
 * ÚNICO consumido por UPDATE condicional na linha da config (`oauthStateNonce`): reapresentar o mesmo `state` (replay) ou usar um forjado/expirado/de outro admin NÃO grava nada.
 * Os motivos de falha devolvidos ao navegador são CÓDIGOS curtos — nunca a mensagem crua do Google, o `code` ou token.
 */

export type MotivoDaConexao =
  | 'invalid_state'
  | 'access_denied'
  | 'refused_by_google'
  | 'no_code'
  | 'bad_credentials'
  | 'no_refresh_token'
  | 'account_check_failed'
  | 'folder_create_failed'
  | 'secrets_key_missing'
  | 'network'
  | 'unknown'

export type ResultadoDaConexao = { ok: true } | { ok: false; motivo: MotivoDaConexao }

/** Base pública da API (para o `redirect_uri` registrado no Google): `PUBLIC_API_BASE_URL`, senão derivada da requisição do ADMIN autenticado (só ele chega aqui). */
export function baseUrlDaApi(derivadaDaRequisicao: string | null): string | null {
  return env.PUBLIC_API_BASE_URL ?? derivadaDaRequisicao
}

/** Origem do FRONTEND para onde o callback devolve o navegador. NUNCA vem de header da requisição (host header injection). `null` = sem origem utilizável. */
export function origemDoFrontend(fonteEnv: Readonly<Record<string, string | undefined>> = process.env): string | null {
  const candidatos = [fonteEnv.PUBLIC_APP_URL, ...env.CORS_ALLOWED_ORIGINS]
  for (const c of candidatos) {
    if (!c) continue
    try {
      const u = new URL(c)
      if (u.protocol !== 'https:' && !(u.protocol === 'http:' && fonteEnv.NODE_ENV !== 'production')) continue
      return u.origin
    } catch {
      continue
    }
  }
  return null
}

export async function iniciarConexaoComGoogle(params: { adminId: string; baseUrlDaApi: string | null; agora?: Date }): Promise<{ url: string }> {
  const config = await carregarConfigDeBackup()
  if (!config.driveOauthClientId || !config.driveOauthClientSecretCiphertext) {
    throw new AppError('Salve o Client ID e o Client Secret do app do Google antes de conectar.', 409, 'DRIVE_OAUTH_CREDENTIALS_MISSING')
  }
  const base = baseUrlDaApi(params.baseUrlDaApi)
  if (!base) throw new AppError('Não sei o endereço público da API. Defina PUBLIC_API_BASE_URL no ambiente.', 409, 'PUBLIC_URL_UNKNOWN')
  const agora = params.agora ?? new Date()
  const redirectUri = redirectUriDoGoogle(base)
  const { state, nonce, expiraEm } = assinarEstadoDoOAuth(params.adminId, env.JWT_SECRET, redirectUri, agora.getTime())
  // Um fluxo por vez: iniciar outro invalida o anterior (o nonce antigo deixa de existir).
  await prisma.backupConfig.update({ where: { id: 1 }, data: { oauthStateNonce: nonce, oauthStateExpiresAt: expiraEm, oauthStateAdminId: params.adminId } })
  return { url: montarUrlDeAutorizacao({ clientId: config.driveOauthClientId, redirectUri, state }) }
}

/** Consome o nonce do `state` (uso único): UPDATE condicional, quem perde a corrida (ou reapresenta) é recusado. */
async function consumirNonce(nonce: string, adminId: string, agora: Date): Promise<boolean> {
  const r = await prisma.backupConfig.updateMany({
    where: { id: 1, oauthStateNonce: nonce, oauthStateAdminId: adminId, oauthStateExpiresAt: { gt: agora } },
    data: { oauthStateNonce: null, oauthStateExpiresAt: null, oauthStateAdminId: null },
  })
  return r.count === 1
}

export async function concluirConexaoComGoogle(params: { state: string | null; code: string | null; googleError: string | null; agora?: Date }): Promise<ResultadoDaConexao> {
  const agora = params.agora ?? new Date()
  const estado = params.state ? verificarEstadoDoOAuth(params.state, env.JWT_SECRET, agora.getTime()) : null
  // Ausente, forjado, expirado ou reapresentado: o mesmo código para todos, sem pistas a quem forja.
  if (!estado || !(await consumirNonce(estado.nonce, estado.adminId, agora))) return { ok: false, motivo: 'invalid_state' }

  const admin = await prisma.user.findUnique({ where: { id: estado.adminId }, select: { id: true, role: true, active: true } })
  if (!admin || admin.role !== 'ADMIN' || !admin.active) return { ok: false, motivo: 'invalid_state' }

  if (params.googleError) return { ok: false, motivo: params.googleError === 'access_denied' ? 'access_denied' : 'refused_by_google' }
  if (!params.code) return { ok: false, motivo: 'no_code' }
  if (!isPaymentSecretsKeyConfigured()) return { ok: false, motivo: 'secrets_key_missing' }

  const config = await carregarConfigDeBackup()
  if (!config.driveOauthClientId || !config.driveOauthClientSecretCiphertext) return { ok: false, motivo: 'bad_credentials' }
  let clientSecret: string | null
  try {
    clientSecret = lerSegredoDaConfig(config.driveOauthClientSecretCiphertext, 'driveClientSecret')
  } catch {
    return { ok: false, motivo: 'secrets_key_missing' }
  }
  if (!clientSecret) return { ok: false, motivo: 'bad_credentials' }

  let tokens
  try {
    tokens = await trocarCodigoPorTokens({ clientId: config.driveOauthClientId, clientSecret, code: params.code, redirectUri: estado.ru })
  } catch (err) {
    const codigo = err instanceof ErroDeBackup ? err.codigo : 'UNKNOWN'
    logger.warn({ codigo }, '[backup][google] a troca do código falhou')
    return { ok: false, motivo: codigo === 'CREDENTIAL' || codigo === 'OAUTH_DISCONNECTED' ? 'bad_credentials' : codigo === 'NETWORK' ? 'network' : 'unknown' }
  }
  // Sem refresh token a conexão morre em uma hora. Melhor recusar do que salvar uma conexão inútil.
  if (!tokens.refreshToken) return { ok: false, motivo: 'no_refresh_token' }

  let email: string
  try {
    email = await buscarEmailDaConta(tokens.accessToken)
  } catch {
    return { ok: false, motivo: 'account_check_failed' }
  }
  // A pasta é criada uma vez: reconectar reaproveita o id salvo (trocar o Client ID já o zerou).
  let pastaId = config.driveOauthFolderId
  if (!pastaId) {
    try {
      pastaId = await criarPastaDeBackups(tokens.accessToken)
    } catch {
      return { ok: false, motivo: 'folder_create_failed' }
    }
  }
  await prisma.backupConfig.update({
    where: { id: 1 },
    data: {
      driveOauthRefreshTokenCiphertext: encryptPaymentSecret(tokens.refreshToken),
      driveOauthEmail: email,
      driveOauthFolderId: pastaId,
      driveOauthConnectedAt: agora,
      driveOauthConnectedById: admin.id,
      updatedById: admin.id,
    },
  })
  // Canal contínuo e silencioso do banco inteiro para o Drive de quem clicou: merece aviso.
  logger.warn({ alert: 'backup_config_changed', escopo: 'oauth_connect', actorUserId: admin.id, trocouDeConta: config.driveOauthEmail !== null && config.driveOauthEmail !== email }, '[backup] conta Google conectada ao backup')
  return { ok: true }
}

/** Revoga no Google (melhor esforço) e limpa a conexão local. Client ID e Secret ficam, para reconectar sem digitar tudo. */
export async function desconectarGoogle(adminId: string): Promise<void> {
  const config = await carregarConfigDeBackup()
  if (config.driveOauthRefreshTokenCiphertext) {
    try {
      const token = lerSegredoDaConfig(config.driveOauthRefreshTokenCiphertext, 'driveRefreshToken')
      if (token) await revogarTokenDoGoogle(token)
    } catch {
      // Sem PAYMENT_SECRETS_KEY não dá para revogar no Google; o token local é apagado de qualquer forma.
    }
  }
  await prisma.backupConfig.update({
    where: { id: 1 },
    data: { driveOauthRefreshTokenCiphertext: null, driveOauthEmail: null, driveOauthFolderId: null, driveOauthConnectedAt: null, driveOauthConnectedById: null, updatedById: adminId },
  })
  if (config.driveOauthEmail) logger.warn({ alert: 'backup_config_changed', escopo: 'oauth_disconnect', actorUserId: adminId }, '[backup] conta Google desconectada do backup')
}
