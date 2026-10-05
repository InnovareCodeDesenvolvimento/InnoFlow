/**
 * Google Drive por OAuth (`src/lib/backup/drive.ts` + `driveOAuth.ts`): `state` assinado (forja, expiração, segredo errado), classificação de falhas, e o fluxo inteiro contra o
 * "Google" FALSO local (`tests/helpers/googleFalso.ts`). Prova o NOSSO código; NÃO prova o Google real (cotas, revogação, tela de consentimento).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ErroDeBackup } from '../../src/core/backup/erros'
import { apagarDoDrive, baixarDoDrive, classificarFalhaDoDrive, conferirPastaDoDrive, consultaDosDumps, definirUrlsDoGoogleParaTeste, enviarParaODrive, listarDumpsDoDrive } from '../../src/lib/backup/drive'
import {
  assinarEstadoDoOAuth,
  buscarEmailDaConta,
  criarPastaDeBackups,
  montarUrlDeAutorizacao,
  redirectUriDoGoogle,
  renovarAcesso,
  revogarTokenDoGoogle,
  tokenGetterDoOAuth,
  trocarCodigoPorTokens,
  verificarEstadoDoOAuth,
} from '../../src/lib/backup/driveOAuth'
import { iniciarGoogleFalso, type GoogleFalso } from '../helpers/googleFalso'

const SEGREDO = 'segredo-do-servidor-com-mais-de-16-caracteres'
const RU = 'https://api.exemplo.com/api/backup/google/callback'

describe('state do OAuth: assinado, de uso único (nonce), com prazo', () => {
  it('ida e volta: devolve o admin, o nonce e o redirect_uri assinados', () => {
    const { state, nonce } = assinarEstadoDoOAuth('admin-1', SEGREDO, RU)
    const v = verificarEstadoDoOAuth(state, SEGREDO)
    expect(v).toMatchObject({ adminId: 'admin-1', nonce, ru: RU })
  })
  it('recusa: segredo diferente, assinatura trocada, corpo adulterado (outro admin), formato lixo, expirado', () => {
    const { state } = assinarEstadoDoOAuth('admin-1', SEGREDO, RU, 1_000_000)
    expect(verificarEstadoDoOAuth(state, 'outro-segredo-com-mais-de-16-caracteres', 1_000_001)).toBeNull()
    const [corpo, assinatura] = state.split('.') as [string, string]
    expect(verificarEstadoDoOAuth(`${corpo}.${assinatura.slice(0, -2)}xx`, SEGREDO, 1_000_001)).toBeNull()
    const adulterado = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(corpo, 'base64url').toString()), adminId: 'atacante' })).toString('base64url')
    expect(verificarEstadoDoOAuth(`${adulterado}.${assinatura}`, SEGREDO, 1_000_001)).toBeNull()
    for (const lixo of ['', 'abc', 'a.b.c', '.', 'a.b']) expect(verificarEstadoDoOAuth(lixo, SEGREDO)).toBeNull()
    expect(verificarEstadoDoOAuth(state, SEGREDO, 1_000_000 + 10 * 60 * 1000 + 1)).toBeNull() // 10 min + 1 ms
    expect(verificarEstadoDoOAuth(state, SEGREDO, 1_000_000 + 10 * 60 * 1000 - 1)).not.toBeNull()
  })
  it('segredo curto demais não assina (nunca assina com segredo fraco/vazio)', () => {
    expect(() => assinarEstadoDoOAuth('a', '', RU)).toThrow()
    expect(() => assinarEstadoDoOAuth('a', 'curto', RU)).toThrow()
    expect(verificarEstadoDoOAuth('x.y', '')).toBeNull()
  })
  it('dois estados do mesmo admin têm nonces diferentes', () => {
    expect(assinarEstadoDoOAuth('a', SEGREDO, RU).nonce).not.toBe(assinarEstadoDoOAuth('a', SEGREDO, RU).nonce)
  })
})

describe('URL de autorização e classificação de falhas', () => {
  it('pede acesso OFFLINE com consentimento (sem isso o Google não devolve refresh token) e só o escopo drive.file', () => {
    const u = new URL(montarUrlDeAutorizacao({ clientId: 'cid', redirectUri: RU, state: 'st' }))
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(u.searchParams.get('access_type')).toBe('offline')
    expect(u.searchParams.get('prompt')).toBe('consent')
    expect(u.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/drive.file')
    expect(u.searchParams.get('response_type')).toBe('code')
    expect(u.searchParams.get('redirect_uri')).toBe(RU)
    expect(u.searchParams.get('state')).toBe('st')
    expect(redirectUriDoGoogle('https://api.exemplo.com/')).toBe(RU)
  })
  it('classifica status+corpo em CÓDIGO acionável (cota antes de permissão; invalid_grant é desconexão)', () => {
    const corpo = (reason: string, message = '') => JSON.stringify({ error: { code: 403, message, errors: [{ reason, message }] } })
    expect(classificarFalhaDoDrive(403, corpo('storageQuotaExceeded', 'The user storage quota has been exceeded'))).toBe('QUOTA')
    expect(classificarFalhaDoDrive(400, JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }))).toBe('OAUTH_DISCONNECTED')
    expect(classificarFalhaDoDrive(401, '{}')).toBe('CREDENTIAL')
    expect(classificarFalhaDoDrive(401, JSON.stringify({ error: 'invalid_client' }))).toBe('CREDENTIAL')
    expect(classificarFalhaDoDrive(404, corpo('notFound'))).toBe('FOLDER')
    expect(classificarFalhaDoDrive(403, corpo('forbidden', 'The caller does not have permission'))).toBe('FOLDER')
    expect(classificarFalhaDoDrive(503, '{}')).toBe('NETWORK')
    expect(classificarFalhaDoDrive(429, '{}')).toBe('NETWORK')
    expect(classificarFalhaDoDrive(418, 'texto qualquer')).toBe('UNKNOWN')
  })
  it('a consulta dos dumps escapa o id da pasta (aspa/barra não fecham a string da query)', () => {
    expect(consultaDosDumps("abc'def\\")).toBe("'abc\\'def\\\\' in parents and trashed = false and name contains 'backup-'")
  })
})

describe('fluxo completo contra o Google FALSO', () => {
  let g: GoogleFalso
  let restaurar: () => void
  let dir: string
  const cred = { clientId: 'cliente-123.apps.googleusercontent.com', clientSecret: 'segredo-do-app-do-google' }

  beforeAll(async () => {
    g = await iniciarGoogleFalso({ ...cred, email: 'dono@exemplo.com' })
    restaurar = definirUrlsDoGoogleParaTeste({ api: `${g.base}/drive/v3`, upload: `${g.base}/upload/drive/v3`, token: `${g.base}/token`, revogar: `${g.base}/revoke` })
    dir = mkdtempSync(join(tmpdir(), 'backupdrive-'))
  })
  afterAll(async () => {
    restaurar()
    await g.fechar()
    rmSync(dir, { recursive: true, force: true })
  })

  async function codigo(p: Promise<unknown>): Promise<string> {
    try {
      await p
    } catch (e) {
      if (e instanceof ErroDeBackup) return e.codigo
      throw e
    }
    return 'NAO_FALHOU'
  }

  it('troca o código pelos tokens, confirma a conta e cria a pasta (uma vez)', async () => {
    const t = await trocarCodigoPorTokens({ ...cred, code: g.codigoValido, redirectUri: RU })
    expect(t.refreshToken).toBe(g.refreshTokenEmitido)
    expect(await buscarEmailDaConta(t.accessToken)).toBe('dono@exemplo.com')
    const pasta = await criarPastaDeBackups(t.accessToken)
    expect(g.arquivos.get(pasta)?.name).toBe('Backups InnoFlow')
    expect(g.arquivos.get(pasta)?.mimeType).toBe('application/vnd.google-apps.folder')
  })

  it('credencial do app errada => CREDENTIAL; código inválido => OAUTH_DISCONNECTED; nada do corpo do Google vaza na mensagem', async () => {
    try {
      await trocarCodigoPorTokens({ ...cred, clientSecret: 'errado', code: g.codigoValido, redirectUri: RU })
      expect.unreachable()
    } catch (e) {
      expect((e as ErroDeBackup).codigo).toBe('CREDENTIAL')
      expect((e as Error).message).not.toContain('credenciais do app erradas')
    }
    expect(await codigo(trocarCodigoPorTokens({ ...cred, code: 'codigo-forjado', redirectUri: RU }))).toBe('OAUTH_DISCONNECTED')
  })

  it('o token getter faz UMA renovação para várias chamadas (cache por execução)', async () => {
    const antes = g.requisicoes.filter((r) => r === 'POST /token').length
    const getToken = tokenGetterDoOAuth({ ...cred, refreshToken: g.refreshTokenEmitido })
    const [a, b, c] = await Promise.all([getToken(), getToken(), getToken()])
    expect(a).toBeTruthy()
    // Chamadas simultâneas podem renovar mais de uma vez; sequenciais NÃO.
    const depoisParalelo = g.requisicoes.filter((r) => r === 'POST /token').length
    await getToken()
    await getToken()
    expect(g.requisicoes.filter((r) => r === 'POST /token').length).toBe(depoisParalelo)
    expect(depoisParalelo - antes).toBeGreaterThanOrEqual(1)
    expect([a, b, c].every(Boolean)).toBe(true)
  })

  it('envia (com conferência de tamanho), lista paginando só o que é backup, baixa idêntico e apaga (404 conta como apagado)', async () => {
    const getToken = tokenGetterDoOAuth({ ...cred, refreshToken: g.refreshTokenEmitido })
    const pastaId = await criarPastaDeBackups(await getToken())
    const conteudo = Buffer.alloc(200_000, 9)
    const arq = join(dir, 'x.enc')
    writeFileSync(arq, conteudo)
    const ids: string[] = []
    for (let i = 1; i <= 5; i += 1) {
      const { arquivoId } = await enviarParaODrive({ token: getToken, pastaId, arquivo: arq, nome: `backup-innoflow-2026-10-0${i}-03h00m00s.dump.enc`, tamanho: conteudo.length })
      ids.push(arquivoId)
    }
    // Um arquivo que NÃO é nosso (nome) na mesma pasta: ignorado pela listagem.
    g.arquivos.set('alheio', { id: 'alheio', name: 'backup-de-outra-coisa.txt', parents: [pastaId], mimeType: 'text/plain', corpo: Buffer.from('x'), criadoEm: new Date(), trashed: false })

    const lista = await listarDumpsDoDrive(getToken, pastaId)
    expect(lista.map((f) => f.id).sort()).toEqual([...ids].sort()) // 5 itens, 2 por página => 3 páginas
    expect(lista.every((f) => f.tamanho === conteudo.length)).toBe(true)

    const destino = join(dir, 'baixado.bin')
    await baixarDoDrive(getToken, ids[0]!, destino)
    expect(readFileSync(destino).equals(conteudo)).toBe(true)

    expect(await apagarDoDrive(getToken, [ids[0]!, ids[1]!, 'id-que-nao-existe'])).toBe(3)
    expect(g.arquivos.has(ids[0]!)).toBe(false)
    expect((await listarDumpsDoDrive(getToken, pastaId)).map((f) => f.id).sort()).toEqual(ids.slice(2).sort())
    await conferirPastaDoDrive(getToken, pastaId)
    expect(await codigo(conferirPastaDoDrive(getToken, 'pasta-que-nao-existe'))).toBe('FOLDER')
    expect(await codigo(conferirPastaDoDrive(getToken, ids[2]!))).toBe('FOLDER') // é arquivo, não pasta
  })

  it('erro do Drive no envio vira código (503 => NETWORK) e não ecoa o corpo do Google', async () => {
    const getToken = tokenGetterDoOAuth({ ...cred, refreshToken: g.refreshTokenEmitido })
    const pastaId = await criarPastaDeBackups(await getToken())
    const arq = join(dir, 'y.enc')
    writeFileSync(arq, 'dados')
    g.falharProximosEnvios(1, 503, '{"error":{"code":503,"message":"MENSAGEM-INTERNA-DO-GOOGLE"}}')
    try {
      await enviarParaODrive({ token: getToken, pastaId, arquivo: arq, nome: 'backup-y.dump.enc', tamanho: 5 })
      expect.unreachable()
    } catch (e) {
      expect((e as ErroDeBackup).codigo).toBe('NETWORK')
      expect((e as Error).message).not.toContain('MENSAGEM-INTERNA-DO-GOOGLE')
    }
  })

  it('acesso revogado: renovar => OAUTH_DISCONNECTED (o código que manda reconectar); revogar é melhor esforço', async () => {
    const g2 = await iniciarGoogleFalso({ ...cred, email: 'x@exemplo.com' })
    const r2 = definirUrlsDoGoogleParaTeste({ token: `${g2.base}/token`, revogar: `${g2.base}/revoke` })
    try {
      g2.revogarAcesso()
      expect(await codigo(renovarAcesso({ ...cred, refreshToken: g2.refreshTokenEmitido }))).toBe('OAUTH_DISCONNECTED')
      await revogarTokenDoGoogle('qualquer') // não lança
      expect(g2.requisicoes).toContain('POST /revoke')
    } finally {
      r2()
      await g2.fechar()
    }
  })

  it('sem refresh_token na resposta, a troca devolve null (quem chama recusa a conexão)', async () => {
    g.semRefreshTokenNaProximaTroca = true
    const t = await trocarCodigoPorTokens({ ...cred, code: g.codigoValido, redirectUri: RU })
    expect(t.refreshToken).toBeNull()
  })
})
