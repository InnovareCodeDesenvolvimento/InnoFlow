import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { logger } from '../logger'
import { limparTextoSensivel } from '../logSerializers'
import { ErroDeBackup } from '../../core/backup/erros'
import { URLS_DO_GOOGLE, classificarFalhaDoDrive, type TokenGetter } from './drive'

/**
 * "Conectar com Google": backup no Drive autenticado em nome do DONO. Porte do `drive-oauth.ts` do InnoChat.
 *
 * ESCOPO `drive.file` (não sensível, sem aviso de "app não verificado"): o app só enxerga o que ele mesmo criou. Por isso a pasta de destino é SEMPRE criada por este código, nunca
 * uma que o dono colou.
 *
 * REFRESH TOKEN: app do Google Cloud em "Testing" emite refresh token que expira em 7 dias; só em "In production" ele dura. É configuração do lado do Google, fora do alcance daqui
 * (a tela avisa). `access_type=offline&prompt=consent` são obrigatórios: sem eles o Google pode nem devolver refresh token.
 *
 * O `state` do fluxo é assinado (HMAC com segredo do servidor), com prazo de 10 min e nonce de USO ÚNICO (consumido por UPDATE condicional no banco, em `googleOAuth.ts`). Sem `state`
 * válido NADA é gravado: um link forjado não pode conectar a conta Google de um atacante ao backup (o próximo dump, com os dados de todos os clientes, iria para o Drive dele).
 * O callback chega por NAVEGAÇÃO (redirecionamento do Google), sem o header Authorization da SPA: a prova de que quem iniciou é um ADMIN é o `state` (emitido só por rota ADMIN).
 */

export const ESCOPO_DO_DRIVE = 'https://www.googleapis.com/auth/drive.file'
/** Nome fixo da pasta que o app cria no Drive do dono na primeira conexão. */
export const NOME_DA_PASTA_NO_DRIVE = 'Backups InnoFlow'
export const CAMINHO_DO_CALLBACK = '/api/backup/google/callback'
const TIMEOUT_MS = 30_000
const CONTEXTO_DO_STATE = 'innoflow:backup:drive-oauth-state:v1'
const VALIDADE_DO_STATE_MS = 10 * 60 * 1000

export function redirectUriDoGoogle(baseUrlDaApi: string): string {
  return `${baseUrlDaApi.replace(/\/+$/, '')}${CAMINHO_DO_CALLBACK}`
}

export function montarUrlDeAutorizacao(opcoes: { clientId: string; redirectUri: string; state: string }): string {
  const params = new URLSearchParams({
    client_id: opcoes.clientId,
    redirect_uri: opcoes.redirectUri,
    response_type: 'code',
    scope: ESCOPO_DO_DRIVE,
    access_type: 'offline',
    prompt: 'consent',
    state: opcoes.state,
  })
  return `${URLS_DO_GOOGLE.autorizacao}?${params.toString()}`
}

async function postarFormulario(url: string, form: Record<string, string>): Promise<{ ok: boolean; status: number; texto: string }> {
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
    })
    return { ok: resp.ok, status: resp.status, texto: await resp.text().catch(() => '') }
  } catch (err) {
    logger.warn({ detalhe: limparTextoSensivel(err instanceof Error ? err.message : String(err)).slice(0, 200) }, '[backup][google] falha de rede')
    throw new ErroDeBackup('Não foi possível falar com o Google.', 'NETWORK')
  }
}

function erroDoToken(corpo: string): { erro: string; descricao: string } {
  try {
    const obj = JSON.parse(corpo) as { error?: string; error_description?: string }
    return { erro: obj.error ?? '', descricao: obj.error_description ?? '' }
  } catch {
    return { erro: '', descricao: corpo.slice(0, 300) }
  }
}

export interface TokensDoGoogle {
  accessToken: string
  refreshToken: string | null
  expiresIn: number
}

/** Troca o `code` do callback pelos tokens. Erro sempre classificado em código; o corpo cru do Google (que pode ecoar o `code`) só vai para o log, limpo. */
export async function trocarCodigoPorTokens(opcoes: { clientId: string; clientSecret: string; code: string; redirectUri: string }): Promise<TokensDoGoogle> {
  const res = await postarFormulario(URLS_DO_GOOGLE.token, {
    grant_type: 'authorization_code',
    code: opcoes.code,
    client_id: opcoes.clientId,
    client_secret: opcoes.clientSecret,
    redirect_uri: opcoes.redirectUri,
  })
  if (!res.ok) {
    const { erro, descricao } = erroDoToken(res.texto)
    logger.warn({ httpStatus: res.status, erro, detalhe: limparTextoSensivel(descricao).slice(0, 200) }, '[backup][google] o Google recusou a troca do código')
    throw new ErroDeBackup('O Google recusou a conexão.', erro === 'invalid_grant' ? 'OAUTH_DISCONNECTED' : classificarFalhaDoDrive(res.status, res.texto))
  }
  let dados: { access_token?: string; refresh_token?: string; expires_in?: number }
  try {
    dados = JSON.parse(res.texto)
  } catch {
    throw new ErroDeBackup('O Google devolveu uma resposta ilegível.', 'UNKNOWN')
  }
  if (!dados.access_token) throw new ErroDeBackup('O Google não devolveu o acesso.', 'UNKNOWN')
  return { accessToken: dados.access_token, refreshToken: dados.refresh_token ?? null, expiresIn: dados.expires_in ?? 3600 }
}

/** Renova o acesso a partir do refresh token salvo. `invalid_grant` é um caso à parte: não é "chave digitada errada", é "a permissão foi retirada" — a única ação é reconectar. */
export async function renovarAcesso(opcoes: { clientId: string; clientSecret: string; refreshToken: string }): Promise<{ accessToken: string; expiresIn: number }> {
  const res = await postarFormulario(URLS_DO_GOOGLE.token, {
    grant_type: 'refresh_token',
    refresh_token: opcoes.refreshToken,
    client_id: opcoes.clientId,
    client_secret: opcoes.clientSecret,
  })
  if (!res.ok) {
    const { erro, descricao } = erroDoToken(res.texto)
    logger.warn({ httpStatus: res.status, erro, detalhe: limparTextoSensivel(descricao).slice(0, 200) }, '[backup][google] o Google recusou renovar o acesso')
    if (erro === 'invalid_grant') throw new ErroDeBackup('A conta Google foi desconectada.', 'OAUTH_DISCONNECTED')
    throw new ErroDeBackup('O Google recusou renovar o acesso.', classificarFalhaDoDrive(res.status, res.texto))
  }
  let dados: { access_token?: string; expires_in?: number }
  try {
    dados = JSON.parse(res.texto)
  } catch {
    throw new ErroDeBackup('O Google devolveu uma resposta ilegível ao renovar o acesso.', 'UNKNOWN')
  }
  if (!dados.access_token) throw new ErroDeBackup('O Google não devolveu o acesso ao renovar.', 'UNKNOWN')
  return { accessToken: dados.access_token, expiresIn: dados.expires_in ?? 3600 }
}

/** Cache por execução: o backup chama isto uma vez e reaproveita no upload, na listagem e na poda. */
export function tokenGetterDoOAuth(opcoes: { clientId: string; clientSecret: string; refreshToken: string }): TokenGetter {
  let cache: { token: string; expiraEm: number } | null = null
  return async () => {
    if (cache && cache.expiraEm > Date.now() + 60_000) return cache.token
    const { accessToken, expiresIn } = await renovarAcesso(opcoes)
    cache = { token: accessToken, expiraEm: Date.now() + expiresIn * 1000 }
    return accessToken
  }
}

/** Melhor esforço: falha aqui (rede, token já revogado) não impede o Desconectar de limpar o que é local. */
export async function revogarTokenDoGoogle(token: string): Promise<void> {
  try {
    await fetch(`${URLS_DO_GOOGLE.revogar}?${new URLSearchParams({ token }).toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
    })
  } catch {
    // Não acionável: o chamador apaga o token local de qualquer forma.
  }
}

/** E-mail da conta conectada, para o dono confirmar que é a conta dele. */
export async function buscarEmailDaConta(accessToken: string): Promise<string> {
  let resp: Response
  try {
    resp = await fetch(`${URLS_DO_GOOGLE.api}/about?fields=${encodeURIComponent('user(emailAddress)')}`, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' })
  } catch {
    throw new ErroDeBackup('Não foi possível confirmar a conta conectada.', 'NETWORK')
  }
  const texto = await resp.text().catch(() => '')
  if (!resp.ok) throw new ErroDeBackup('O Google recusou confirmar a conta conectada.', classificarFalhaDoDrive(resp.status, texto))
  const dados = JSON.parse(texto) as { user?: { emailAddress?: string } }
  if (!dados.user?.emailAddress) throw new ErroDeBackup('O Google não informou o e-mail da conta conectada.', 'UNKNOWN')
  return dados.user.emailAddress
}

/** Cria a pasta de backups no Drive do dono. Só quando ainda não existe uma: reconectar não cria outra. */
export async function criarPastaDeBackups(accessToken: string): Promise<string> {
  let resp: Response
  try {
    resp = await fetch(`${URLS_DO_GOOGLE.api}/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: NOME_DA_PASTA_NO_DRIVE, mimeType: 'application/vnd.google-apps.folder' }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
    })
  } catch {
    throw new ErroDeBackup('Não foi possível criar a pasta de backups no Drive.', 'NETWORK')
  }
  const texto = await resp.text().catch(() => '')
  if (!resp.ok) throw new ErroDeBackup('O Google recusou criar a pasta de backups.', classificarFalhaDoDrive(resp.status, texto))
  const dados = JSON.parse(texto) as { id?: string }
  if (!dados.id) throw new ErroDeBackup('O Google criou a pasta mas não devolveu o id dela.', 'UNKNOWN')
  return dados.id
}

// ---------------------------------------------------------------------------------------------
// `state` assinado
// ---------------------------------------------------------------------------------------------

export interface EstadoDoOAuth {
  adminId: string
  nonce: string
  /** O redirect_uri usado na ida: o callback o REUSA na troca do código (o Google exige o mesmo valor), sem recalcular a partir de um header da requisição. */
  ru: string
  iat: number
  exp: number
}

function chaveDoState(segredo: string): Buffer {
  if (!segredo || segredo.length < 16) throw new Error('Segredo ausente ou curto demais para assinar o estado do OAuth.')
  return createHash('sha256').update(`${CONTEXTO_DO_STATE}:${segredo}`).digest()
}

export function assinarEstadoDoOAuth(adminId: string, segredo: string, redirectUri: string, agora: number = Date.now()): { state: string; nonce: string; expiraEm: Date } {
  const nonce = randomBytes(16).toString('hex')
  const payload: EstadoDoOAuth = { adminId, nonce, ru: redirectUri, iat: agora, exp: agora + VALIDADE_DO_STATE_MS }
  const corpo = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const assinatura = createHmac('sha256', chaveDoState(segredo)).update(corpo).digest('base64url')
  return { state: `${corpo}.${assinatura}`, nonce, expiraEm: new Date(payload.exp) }
}

/** Nunca lança: `state` inválido é o caminho normal de um ataque. Não confere o nonce (isso é do banco). */
export function verificarEstadoDoOAuth(state: string, segredo: string, agora: number = Date.now()): EstadoDoOAuth | null {
  const partes = state.split('.')
  if (partes.length !== 2) return null
  const [corpo, assinatura] = partes as [string, string]
  let esperado: Buffer
  try {
    esperado = createHmac('sha256', chaveDoState(segredo)).update(corpo).digest()
  } catch {
    return null
  }
  const recebido = Buffer.from(assinatura, 'base64url')
  if (recebido.length !== esperado.length || !timingSafeEqual(recebido, esperado)) return null
  let payload: EstadoDoOAuth
  try {
    payload = JSON.parse(Buffer.from(corpo, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (typeof payload.adminId !== 'string' || !payload.adminId || typeof payload.nonce !== 'string' || !payload.nonce || typeof payload.ru !== 'string' || typeof payload.exp !== 'number') return null
  if (payload.exp < agora) return null
  return payload
}
