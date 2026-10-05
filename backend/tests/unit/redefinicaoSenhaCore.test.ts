import { describe, expect, it } from 'vitest'
import {
  contaPodeConsumirToken,
  decidirSolicitacao,
  formatoDeTokenValido,
  gerarTokenRedefinicao,
  hashDoEmail,
  hashDoToken,
  impressaoDaSenha,
  montarLinkDeRedefinicao,
  resolverBaseUrlPublica,
  TTL_TOKEN_REDEFINICAO_SEGUNDOS,
  type ContaParaRedefinicao,
} from '../../src/core/auth/redefinicaoSenha'

/**
 * L1.3 — núcleo PURO da redefinição de senha: token forte, só o hash vale como chave, quem recebe o quê (DL1), origem do link (nunca da requisição) e o link com fragmento.
 */

const conta = (extra: Partial<ContaParaRedefinicao> = {}): ContaParaRedefinicao => ({ id: 'u1', role: 'DRIVER', active: true, passwordHash: '$2a$12$hash', googleSub: null, ...extra })

describe('token', () => {
  it('tem 256 bits (32 bytes em base64url = 43 caracteres) e nunca se repete', () => {
    const a = gerarTokenRedefinicao()
    const b = gerarTokenRedefinicao()
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(Buffer.from(a, 'base64url')).toHaveLength(32)
    expect(a).not.toBe(b)
  })

  it('o hash (sha-256 hex) não contém o token e é estável', () => {
    const t = gerarTokenRedefinicao()
    const h = hashDoToken(t)
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(h).not.toContain(t)
    expect(hashDoToken(t)).toBe(h)
    expect(hashDoToken(`${t}x`)).not.toBe(h)
  })

  it('formato: só o token real passa (barra lixo antes do Redis)', () => {
    expect(formatoDeTokenValido(gerarTokenRedefinicao())).toBe(true)
    for (const ruim of ['', 'abc', 'a'.repeat(42), 'a'.repeat(44), `${'a'.repeat(42)}!`, `${'a'.repeat(42)} `, 123, null, undefined, { $ne: 1 }]) {
      expect(formatoDeTokenValido(ruim)).toBe(false)
    }
  })

  it('TTL curto: 30 minutos', () => {
    expect(TTL_TOKEN_REDEFINICAO_SEGUNDOS).toBe(1800)
  })

  it('hash de e-mail ignora caixa e espaços (um balde por endereço, não por grafia)', () => {
    expect(hashDoEmail('  Fulano@Exemplo.COM ')).toBe(hashDoEmail('fulano@exemplo.com'))
    expect(hashDoEmail('a@x.com')).not.toBe(hashDoEmail('b@x.com'))
    expect(hashDoEmail('a@x.com')).not.toContain('a@x.com')
  })

  it('impressão da senha muda quando a senha muda e nunca contém o hash da senha', () => {
    expect(impressaoDaSenha('$2a$12$aaa')).not.toBe(impressaoDaSenha('$2a$12$bbb'))
    expect(impressaoDaSenha('$2a$12$aaa')).not.toContain('aaa')
    expect(impressaoDaSenha(null)).toBe(impressaoDaSenha(null))
  })
})

describe('decidirSolicitacao (DL1)', () => {
  it('conta inexistente: nada', () => {
    expect(decidirSolicitacao(null)).toEqual({ acao: 'NADA', motivo: 'INEXISTENTE' })
  })
  it('DRIVER e OPERATOR ativos com senha: link', () => {
    expect(decidirSolicitacao(conta())).toEqual({ acao: 'ENVIAR_LINK' })
    expect(decidirSolicitacao(conta({ role: 'OPERATOR' }))).toEqual({ acao: 'ENVIAR_LINK' })
  })
  it('ADMIN NUNCA recebe link (nem ativo, nem inativo): só pelo script', () => {
    expect(decidirSolicitacao(conta({ role: 'ADMIN' }))).toEqual({ acao: 'NADA', motivo: 'ADMIN' })
    expect(decidirSolicitacao(conta({ role: 'ADMIN', active: false }))).toEqual({ acao: 'NADA', motivo: 'ADMIN' })
  })
  it('conta inativa: nada', () => {
    expect(decidirSolicitacao(conta({ active: false }))).toEqual({ acao: 'NADA', motivo: 'INATIVA' })
  })
  it('só-Google (googleSub e sem senha): aviso SEM link', () => {
    expect(decidirSolicitacao(conta({ googleSub: 'g-1', passwordHash: null }))).toEqual({ acao: 'AVISO_GOOGLE' })
  })
  it('Google vinculado MAS com senha (vínculo pela conta logada mantém a senha): link normal', () => {
    expect(decidirSolicitacao(conta({ googleSub: 'g-1' }))).toEqual({ acao: 'ENVIAR_LINK' })
  })
})

describe('contaPodeConsumirToken (defesa em profundidade no clique)', () => {
  const imp = impressaoDaSenha('$2a$12$hash')
  it('ok quando ativa, não-ADMIN e a senha é a mesma do pedido', () => {
    expect(contaPodeConsumirToken(conta(), imp)).toBe(true)
  })
  it('recusa: sumiu, inativa, ADMIN, senha mudou depois do pedido', () => {
    expect(contaPodeConsumirToken(null, imp)).toBe(false)
    expect(contaPodeConsumirToken(conta({ active: false }), imp)).toBe(false)
    expect(contaPodeConsumirToken(conta({ role: 'ADMIN' }), imp)).toBe(false)
    expect(contaPodeConsumirToken(conta({ passwordHash: '$2a$12$outra' }), imp)).toBe(false)
    expect(contaPodeConsumirToken(conta({ passwordHash: null }), imp)).toBe(false) // virou só-Google
  })
})

describe('origem do link (configuração, nunca a requisição)', () => {
  it('PUBLIC_APP_URL vence; só a origem é usada (caminho e query descartados)', () => {
    expect(resolverBaseUrlPublica({ publicAppUrl: 'https://app.innoflow.com.br/qualquer/coisa?x=1', corsOrigins: ['https://outra.com'], producao: true })).toBe('https://app.innoflow.com.br')
  })
  it('sem PUBLIC_APP_URL: primeira origem do CORS', () => {
    expect(resolverBaseUrlPublica({ corsOrigins: ['https://front.innoflow.com.br', 'https://x.com'], producao: true })).toBe('https://front.innoflow.com.br')
  })
  it('em produção recusa http e localhost (configuração esquecida) — sem destino confiável', () => {
    expect(resolverBaseUrlPublica({ corsOrigins: ['http://localhost:5173'], producao: true })).toBeNull()
    expect(resolverBaseUrlPublica({ publicAppUrl: 'http://app.innoflow.com.br', corsOrigins: [], producao: true })).toBeNull()
    expect(resolverBaseUrlPublica({ publicAppUrl: 'https://localhost', corsOrigins: [], producao: true })).toBeNull()
    expect(resolverBaseUrlPublica({ publicAppUrl: 'https://127.0.0.1', corsOrigins: [], producao: true })).toBeNull()
  })
  it('fora de produção aceita localhost (dev)', () => {
    expect(resolverBaseUrlPublica({ corsOrigins: ['http://localhost:5173'], producao: false })).toBe('http://localhost:5173')
  })
  it('lixo/esquema estranho => null', () => {
    expect(resolverBaseUrlPublica({ publicAppUrl: 'javascript:alert(1)', corsOrigins: [], producao: false })).toBeNull()
    expect(resolverBaseUrlPublica({ publicAppUrl: 'não é url', corsOrigins: [], producao: false })).toBeNull()
    expect(resolverBaseUrlPublica({ corsOrigins: [], producao: false })).toBeNull()
  })
})

describe('link', () => {
  it('o token vai no FRAGMENTO (#t=), nunca em query nem path', () => {
    const t = gerarTokenRedefinicao()
    const link = montarLinkDeRedefinicao('https://app.innoflow.com.br/', t)
    expect(link).toBe(`https://app.innoflow.com.br/redefinir-senha#t=${t}`)
    const u = new URL(link)
    expect(u.search).toBe('')
    expect(u.pathname).toBe('/redefinir-senha')
    expect(u.hash).toBe(`#t=${t}`)
  })
})
