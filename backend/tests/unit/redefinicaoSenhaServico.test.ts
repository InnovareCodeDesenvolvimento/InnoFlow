import bcrypt from 'bcryptjs'
import { describe, expect, it, vi } from 'vitest'
import { criarServicoDeRedefinicao, LIMITE_TOKENS_INVALIDOS_POR_IP, type ContaCompleta, type DepsDaRedefinicao, type RepoDeContasParaRedefinicao } from '../../src/services/auth/redefinicaoSenha'
import { gerarTokenRedefinicao, impressaoDaSenha } from '../../src/core/auth/redefinicaoSenha'
import type { PortaDeTokensDeRedefinicao, ValorDoToken } from '../../src/services/auth/tokensRedefinicaoRedis'

/**
 * L1.3 — lógica do serviço com TUDO falso (sem Redis/Postgres/SMTP): quem recebe o quê, limites silenciosos, auditoria do ADMIN, devolução do token em erro nosso,
 * Redis fora => INDISPONIVEL. O que depende de infraestrutura real (atomicidade do Redis, SMTP de verdade, sessões) está em `tests/integration/redefinicaoSenhaApi.test.ts`.
 */

const meta = { ip: '203.0.113.7', userAgent: 'vitest', requestId: 'r1' }

function conta(extra: Partial<ContaCompleta> = {}): ContaCompleta {
  return { id: 'u1', role: 'DRIVER', active: true, passwordHash: '$2a$04$hashantigo', googleSub: null, name: 'Maria Silva', email: 'maria@exemplo.com', operatorId: null, ...extra }
}

/** Redis falso: só `eval` (incrWithTtl), `get` e `ttl`. Contadores por chave. */
function redisFalso(inicial: Record<string, number> = {}) {
  const c = new Map<string, number>(Object.entries(inicial))
  return {
    c,
    eval: vi.fn(async (_s: string, _n: number, chave: string) => {
      c.set(chave, (c.get(chave) ?? 0) + 1)
      return c.get(chave)!
    }),
    get: vi.fn(async (chave: string) => (c.has(chave) ? String(c.get(chave)) : null)),
    ttl: vi.fn(async () => 600),
  }
}

function montar(opcoes: { conta?: ContaCompleta | null; baseUrl?: string | null; maxEmails?: number; redis?: ReturnType<typeof redisFalso>; trocarSenha?: RepoDeContasParaRedefinicao['trocarSenha']; enviarOk?: boolean } = {}) {
  const redis = opcoes.redis ?? redisFalso()
  const enviados: Array<{ to: string; subject: string; text: string; html: string }> = []
  const auditorias: unknown[] = []
  const logs: Array<{ nivel: string; dados: Record<string, unknown>; msg: string }> = []
  const emitidos: Array<{ userId: string; impressao: string; token: string }> = []
  const valores = new Map<string, ValorDoToken>()
  let devolvidos = 0

  const tokens: PortaDeTokensDeRedefinicao = {
    async emitir(userId, impressao) {
      const token = gerarTokenRedefinicao()
      emitidos.push({ userId, impressao, token })
      valores.set(token, { userId, emitidoEm: Date.now(), impressao })
      return token
    },
    async consumir(token) {
      const v = valores.get(token) ?? null
      valores.delete(token)
      return v
    },
    async devolver(token, valor) {
      devolvidos++
      valores.set(token, valor)
    },
  }
  const contaRef = opcoes.conta === undefined ? conta() : opcoes.conta
  const contas: RepoDeContasParaRedefinicao = {
    buscarPorEmail: async () => contaRef,
    buscarPorId: async () => contaRef,
    trocarSenha: opcoes.trocarSenha ?? (async () => true),
    auditar: async (e) => {
      auditorias.push(e)
    },
  }
  const log = {
    info: (dados: Record<string, unknown>, msg: string) => logs.push({ nivel: 'info', dados, msg }),
    warn: (dados: Record<string, unknown>, msg: string) => logs.push({ nivel: 'warn', dados, msg }),
    error: (dados: Record<string, unknown>, msg: string) => logs.push({ nivel: 'error', dados, msg }),
  }
  const deps: DepsDaRedefinicao = {
    contas,
    tokens,
    redis: redis as never,
    enviarEmail: async (m) => {
      enviados.push(m)
      return opcoes.enviarOk === false ? { ok: false, code: 'SMTP_UNREACHABLE' as never } : { ok: true }
    },
    baseUrl: () => (opcoes.baseUrl === undefined ? 'https://app.innoflow.test' : opcoes.baseUrl),
    maxEmailsPorHora: opcoes.maxEmails ?? 500,
    log,
  }
  return { svc: criarServicoDeRedefinicao(deps), redis, enviados, auditorias, logs, emitidos, valores, devolvidos: () => devolvidos }
}

describe('solicitar (em segundo plano)', () => {
  it('DRIVER ativo com senha: emite 1 token, envia 1 e-mail com o link (#t=) e o impresso da senha vigente', async () => {
    const t = montar()
    await t.svc.solicitar('maria@exemplo.com', meta)
    expect(t.emitidos).toHaveLength(1)
    expect(t.emitidos[0].impressao).toBe(impressaoDaSenha('$2a$04$hashantigo'))
    expect(t.enviados).toHaveLength(1)
    expect(t.enviados[0].to).toBe('maria@exemplo.com')
    expect(t.enviados[0].text).toContain(`https://app.innoflow.test/redefinir-senha#t=${t.emitidos[0].token}`)
  })

  it('OPERATOR também recebe (DL1)', async () => {
    const t = montar({ conta: conta({ role: 'OPERATOR', operatorId: 'op1' }) })
    await t.svc.solicitar('x@y.com', meta)
    expect(t.enviados).toHaveLength(1)
  })

  it('ADMIN: NÃO emite token, NÃO envia e-mail e AUDITA a tentativa (DENIED) sem token/senha', async () => {
    const t = montar({ conta: conta({ role: 'ADMIN', id: 'adm1', email: 'adm@exemplo.com' }) })
    await t.svc.solicitar('adm@exemplo.com', meta)
    expect(t.emitidos).toHaveLength(0)
    expect(t.enviados).toHaveLength(0)
    expect(t.auditorias).toHaveLength(1)
    expect(t.auditorias[0]).toMatchObject({ actorUserId: 'adm1', actorRole: 'ADMIN', action: 'PASSWORD_RESET', outcome: 'DENIED', actionDetail: 'password_reset_denied_admin', httpStatus: 202, ipAddress: meta.ip })
    expect(JSON.stringify(t.auditorias)).not.toMatch(/token|senha|password"/i)
  })

  it('inexistente e inativa: nada (sem e-mail, sem token, sem auditoria)', async () => {
    for (const c of [null, conta({ active: false })]) {
      const t = montar({ conta: c })
      await t.svc.solicitar('x@y.com', meta)
      expect(t.emitidos).toHaveLength(0)
      expect(t.enviados).toHaveLength(0)
      expect(t.auditorias).toHaveLength(0)
    }
  })

  it('só-Google: e-mail de AVISO sem token e sem link de redefinição', async () => {
    const t = montar({ conta: conta({ googleSub: 'g1', passwordHash: null }) })
    await t.svc.solicitar('x@y.com', meta)
    expect(t.emitidos).toHaveLength(0)
    expect(t.enviados).toHaveLength(1)
    expect(t.enviados[0].subject).toBe('Sua conta InnoFlow entra com o Google')
    expect(t.enviados[0].text).not.toContain('redefinir-senha')
  })

  it('limite POR E-MAIL (3/h) é silencioso: o 4º pedido não emite nem envia (e conta também e-mail inexistente)', async () => {
    const t = montar()
    for (let i = 0; i < 5; i++) await t.svc.solicitar('maria@exemplo.com', meta)
    expect(t.enviados).toHaveLength(3)
    expect(t.emitidos).toHaveLength(3)
    const inexistente = montar({ conta: null })
    for (let i = 0; i < 5; i++) await inexistente.svc.solicitar('ninguem@exemplo.com', meta)
    // o contador sobe para e-mail inexistente também: 5 chamadas => 5 incrementos (mesmo comportamento observável de um e-mail real)
    const chave = [...inexistente.redis.c.keys()].find((k) => k.startsWith('pwdreset:rl:email:'))!
    expect(inexistente.redis.c.get(chave)).toBe(5)
    expect(chave).not.toContain('ninguem')
  })

  it('teto GLOBAL de envios/h: estourou, descarta e registra erro (SMTP do dono não vira relé)', async () => {
    const t = montar({ redis: redisFalso({ 'pwdreset:rl:global': 2 }), maxEmails: 2 })
    await t.svc.solicitar('maria@exemplo.com', meta)
    expect(t.enviados).toHaveLength(0)
    expect(t.emitidos).toHaveLength(0)
    expect(t.logs.some((l) => l.nivel === 'error' && l.dados.event === 'password_reset_global_cap_reached')).toBe(true)
  })

  it('sem origem pública confiável: NÃO emite token nem envia; erro logado', async () => {
    const t = montar({ baseUrl: null })
    await t.svc.solicitar('maria@exemplo.com', meta)
    expect(t.emitidos).toHaveLength(0)
    expect(t.enviados).toHaveLength(0)
    expect(t.logs.some((l) => l.dados.event === 'password_reset_base_url_missing')).toBe(true)
  })

  it('SMTP falhou: loga warn com o CÓDIGO (sem e-mail/token) e não lança', async () => {
    const t = montar({ enviarOk: false })
    await expect(t.svc.solicitar('maria@exemplo.com', meta)).resolves.toBeUndefined()
    const falha = t.logs.find((l) => l.dados.event === 'password_reset_email_failed')!
    expect(falha.nivel).toBe('warn')
    expect(JSON.stringify(t.logs)).not.toContain('maria@exemplo.com')
    expect(JSON.stringify(t.logs)).not.toContain(t.emitidos[0].token)
  })

  it('NUNCA lança, mesmo com o banco explodindo', async () => {
    const quebrado = criarServicoDeRedefinicao({
      contas: { buscarPorEmail: async () => { throw new Error('banco fora') }, buscarPorId: async () => null, trocarSenha: async () => false, auditar: async () => undefined },
      tokens: {} as never,
      redis: redisFalso() as never,
      enviarEmail: async () => ({ ok: true }),
      baseUrl: () => 'https://x.com',
      maxEmailsPorHora: 5,
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    })
    await expect(quebrado.solicitar('a@b.com', meta)).resolves.toBeUndefined()
  })

  it('os logs do fluxo feliz não contêm o e-mail nem o token', async () => {
    const t = montar()
    await t.svc.solicitar('maria@exemplo.com', meta)
    const tudo = JSON.stringify(t.logs)
    expect(tudo).not.toContain('maria@exemplo.com')
    expect(tudo).not.toContain(t.emitidos[0].token)
  })
})

describe('redefinir', () => {
  async function comTokenValido(opcoes: Parameters<typeof montar>[0] = {}) {
    const t = montar(opcoes)
    const token = await (async () => {
      await t.svc.solicitar('maria@exemplo.com', meta)
      return t.emitidos[0].token
    })()
    return { t, token }
  }

  it('token válido: troca a senha (hash bcrypt 12), audita PASSWORD_RESET/SUCCESS sem token/senha e devolve OK', async () => {
    const trocas: Array<Parameters<RepoDeContasParaRedefinicao['trocarSenha']>[0]> = []
    const { t, token } = await comTokenValido({ trocarSenha: async (a) => { trocas.push(a); return true } })
    const r = await t.svc.redefinir({ token, novaSenha: 'SenhaNova#12345' }, meta)
    expect(r).toMatchObject({ status: 'OK', userId: 'u1' })
    expect(trocas).toHaveLength(1)
    expect(trocas[0].hashEsperado).toBe('$2a$04$hashantigo')
    expect(await bcrypt.compare('SenhaNova#12345', trocas[0].novoHash)).toBe(true)
    expect(trocas[0].novoHash).toMatch(/^\$2[aby]\$12\$/)
    expect(trocas[0].auditoria).toMatchObject({ action: 'PASSWORD_RESET', outcome: 'SUCCESS', actionDetail: 'password_reset_by_email', actorUserId: 'u1', httpStatus: 204 })
    expect(JSON.stringify(trocas[0].auditoria)).not.toContain(token)
    expect(JSON.stringify(trocas[0].auditoria)).not.toContain('SenhaNova')
    expect(JSON.stringify(t.logs)).not.toContain(token)
    expect(JSON.stringify(t.logs)).not.toContain('SenhaNova')
  })

  it('uso único: o mesmo token na 2ª vez é TOKEN_INVALIDO', async () => {
    const { t, token } = await comTokenValido()
    expect((await t.svc.redefinir({ token, novaSenha: 'SenhaNova#12345' }, meta)).status).toBe('OK')
    expect((await t.svc.redefinir({ token, novaSenha: 'SenhaNova#12345' }, meta)).status).toBe('TOKEN_INVALIDO')
  })

  it('token malformado/desconhecido: TOKEN_INVALIDO e CONTA no contador do IP', async () => {
    const t = montar()
    expect((await t.svc.redefinir({ token: 'lixo', novaSenha: 'SenhaNova#12345' }, meta)).status).toBe('TOKEN_INVALIDO')
    expect((await t.svc.redefinir({ token: gerarTokenRedefinicao(), novaSenha: 'SenhaNova#12345' }, meta)).status).toBe('TOKEN_INVALIDO')
    const chave = [...t.redis.c.keys()].find((k) => k.startsWith('pwdreset:bad:ip:'))!
    expect(t.redis.c.get(chave)).toBe(2)
    expect(chave).not.toContain(meta.ip) // o IP cru não vira chave
  })

  it('IP com muitos tokens inválidos: BLOQUEADO com Retry-After, SEM consumir token (nem o válido)', async () => {
    const { t, token } = await comTokenValido()
    // enche o contador do IP
    for (let i = 0; i < LIMITE_TOKENS_INVALIDOS_POR_IP; i++) await t.svc.redefinir({ token: 'lixo', novaSenha: 'SenhaNova#12345' }, meta)
    const r = await t.svc.redefinir({ token, novaSenha: 'SenhaNova#12345' }, meta)
    expect(r).toEqual({ status: 'BLOQUEADO', retryAfterSeconds: 600 })
    expect(t.valores.has(token)).toBe(true) // o token válido NÃO foi gasto pelo bloqueio
  })

  it('conta virou inativa/ADMIN/mudou a senha depois do pedido: TOKEN_INVALIDO e nada é trocado', async () => {
    for (const mudanca of [{ active: false }, { role: 'ADMIN' as const }, { passwordHash: '$2a$04$outra' }]) {
      const trocar = vi.fn(async () => true)
      const { t, token } = await comTokenValido({ trocarSenha: trocar })
      // a "conta de hoje" difere da do pedido
      const base = conta(mudanca)
      const svc = criarServicoDeRedefinicao({
        contas: { buscarPorEmail: async () => base, buscarPorId: async () => base, trocarSenha: trocar, auditar: async () => undefined },
        tokens: { emitir: async () => '', consumir: async () => ({ userId: 'u1', emitidoEm: Date.now(), impressao: impressaoDaSenha('$2a$04$hashantigo') }), devolver: async () => undefined },
        redis: t.redis as never,
        enviarEmail: async () => ({ ok: true }),
        baseUrl: () => 'https://x.com',
        maxEmailsPorHora: 5,
        log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      })
      expect((await svc.redefinir({ token, novaSenha: 'SenhaNova#12345' }, meta)).status).toBe('TOKEN_INVALIDO')
      expect(trocar).not.toHaveBeenCalled()
    }
  })

  it('a troca condicional não bateu (outra troca no meio): TOKEN_INVALIDO', async () => {
    const { t, token } = await comTokenValido({ trocarSenha: async () => false })
    expect((await t.svc.redefinir({ token, novaSenha: 'SenhaNova#12345' }, meta)).status).toBe('TOKEN_INVALIDO')
  })

  it('erro NOSSO ao gravar (banco/auditoria): o token é DEVOLVIDO (o link segue valendo) e o erro propaga', async () => {
    const { t, token } = await comTokenValido({ trocarSenha: async () => { throw new Error('banco fora') } })
    await expect(t.svc.redefinir({ token, novaSenha: 'SenhaNova#12345' }, meta)).rejects.toThrow('banco fora')
    expect(t.devolvidos()).toBe(1)
    expect(t.valores.has(token)).toBe(true)
  })

  it('Redis fora (consumir/ler contador falha): INDISPONIVEL, sem trocar nada', async () => {
    const trocar = vi.fn(async () => true)
    const redis = redisFalso()
    redis.get.mockRejectedValue(new Error('redis fora'))
    const t = montar({ redis, trocarSenha: trocar })
    expect((await t.svc.redefinir({ token: gerarTokenRedefinicao(), novaSenha: 'SenhaNova#12345' }, meta)).status).toBe('INDISPONIVEL')
    expect(trocar).not.toHaveBeenCalled()
  })
})

describe('avisarSenhaAlterada', () => {
  it('envia o e-mail de segurança com o link "esqueci-senha" da origem configurada; nunca lança', async () => {
    const t = montar()
    await t.svc.avisarSenhaAlterada({ nome: 'Maria', email: 'maria@exemplo.com' })
    expect(t.enviados).toHaveLength(1)
    expect(t.enviados[0].subject).toBe('Sua senha do InnoFlow foi alterada')
    expect(t.enviados[0].text).toContain('https://app.innoflow.test/esqueci-senha')
    const falha = montar({ enviarOk: false })
    await expect(falha.svc.avisarSenhaAlterada({ nome: 'M', email: 'm@x.com' })).resolves.toBeUndefined()
  })
})
