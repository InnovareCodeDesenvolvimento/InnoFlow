import { createServer } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FalhaDeCanal, verificarConexaoSmtp } from '../../src/lib/alertas/canais'
import { emailDeCampos } from '../../src/lib/alertas/configDb'
import { classificarFalhaDeCanal, etapaDoCodigo } from '../../src/services/comunicacao/testarCanais'
import { iniciarSmtpFalso, type SmtpFalso } from './helpers/servidoresFalsos'

/**
 * Teste de CONEXÃO SMTP (só o handshake): contra um SMTP falso de verdade (smtp-server) com o transporte REAL do nodemailer. Prova as 3 etapas de falha (CONNECT/TLS/AUTH), o
 * sucesso, que NENHUMA mensagem é enviada e que nem a senha nem a resposta crua do servidor aparecem no erro classificado.
 */

const SENHA = 'Senha#Marcador-Unico-9f3b'
const POLITICA = { producao: false, permitirRedePrivada: true }

function config(porta: number, extra: { usuario?: string | null; senha?: string; exigirTls?: boolean } = {}) {
  const avisos: string[] = []
  const cfg = emailDeCampos(
    { host: '127.0.0.1', porta, secure: false, usuario: extra.usuario ?? null, senha: extra.senha, nomeRemetente: null, emailRemetente: 'aviso@exemplo.com.br', destinatarios: [], minSeveridade: 'IMPORTANTE' },
    POLITICA,
    avisos,
  )
  if (!cfg) throw new Error(`config inválida: ${avisos.join(';')}`)
  return { ...cfg, exigirTls: extra.exigirTls ?? false }
}

async function resultado(c: ReturnType<typeof config>): Promise<{ ok: boolean; stage: string; code: string | null; motivo: string }> {
  try {
    await verificarConexaoSmtp(c)
    return { ok: true, stage: 'OK', code: null, motivo: '' }
  } catch (err) {
    const { code } = classificarFalhaDeCanal(err)
    return { ok: false, stage: etapaDoCodigo(code), code, motivo: err instanceof FalhaDeCanal ? err.motivo : 'outro' }
  }
}

describe('verificarConexaoSmtp — handshake, sem enviar mensagem', () => {
  let semAuth: SmtpFalso
  let comAuth: SmtpFalso
  beforeAll(async () => {
    semAuth = await iniciarSmtpFalso()
    comAuth = await iniciarSmtpFalso({ usuario: 'robo', senha: SENHA })
  })
  afterAll(async () => {
    await semAuth.fechar()
    await comAuth.fechar()
  })

  it('sucesso sem autenticação: stage OK e NENHUMA mensagem recebida pelo servidor', async () => {
    const r = await resultado(config(semAuth.porta))
    expect(r).toMatchObject({ ok: true, stage: 'OK', code: null })
    expect(semAuth.recebidos).toHaveLength(0)
  })

  it('sucesso autenticando com usuário e senha certos', async () => {
    const r = await resultado(config(comAuth.porta, { usuario: 'robo', senha: SENHA }))
    expect(r).toMatchObject({ ok: true, stage: 'OK' })
    expect(comAuth.recebidos).toHaveLength(0)
  })

  it('senha errada: stage AUTH, code SMTP_AUTH_FAILED, e a senha tentada não aparece no motivo', async () => {
    const r = await resultado(config(comAuth.porta, { usuario: 'robo', senha: 'senha-errada-ZZZ-123' }))
    expect(r).toMatchObject({ ok: false, stage: 'AUTH', code: 'SMTP_AUTH_FAILED' })
    expect(JSON.stringify(r)).not.toContain('senha-errada-ZZZ-123')
    expect(JSON.stringify(r)).not.toContain('Invalid login') // texto cru do servidor não passa
  })

  it('porta fechada: stage CONNECT, code SMTP_CONNECTION_FAILED', async () => {
    const livre = await new Promise<number>((resolve) => {
      const s = createServer()
      s.listen(0, '127.0.0.1', () => {
        const p = (s.address() as { port: number }).port
        s.close(() => resolve(p))
      })
    })
    const r = await resultado(config(livre))
    expect(r).toMatchObject({ ok: false, stage: 'CONNECT', code: 'SMTP_CONNECTION_FAILED' })
  })

  it('TLS exigido e o servidor não oferece STARTTLS: stage TLS, code SMTP_TLS_REQUIRED', async () => {
    const r = await resultado(config(semAuth.porta, { exigirTls: true }))
    expect(r).toMatchObject({ ok: false, stage: 'TLS', code: 'SMTP_TLS_REQUIRED' })
  })

  it('destino bloqueado (rede interna em produção) falha em CONNECT antes de abrir socket', async () => {
    const avisos: string[] = []
    const cfg = emailDeCampos({ host: '127.0.0.1', porta: semAuth.porta, secure: false, usuario: null, senha: undefined, nomeRemetente: null, emailRemetente: 'a@exemplo.com.br', destinatarios: [], minSeveridade: 'IMPORTANTE' }, { producao: false, permitirRedePrivada: true }, avisos)!
    // metadados da nuvem NUNCA passam, nem com a rede privada liberada: a checagem na hora de conectar barra
    const r = await resultado({ ...cfg, host: '169.254.169.254', politicaDeDestino: { producao: true, permitirRedePrivada: true } })
    expect(r).toMatchObject({ ok: false, stage: 'CONNECT', code: 'DESTINATION_BLOCKED' })
  })

  it('transporte sem `verify` (não deve acontecer) falha fechado, não "passa"', async () => {
    const c = config(semAuth.porta)
    await expect(verificarConexaoSmtp(c, { criarTransporte: () => ({ sendMail: async () => ({}) }) })).rejects.toBeInstanceOf(FalhaDeCanal)
  })
})
