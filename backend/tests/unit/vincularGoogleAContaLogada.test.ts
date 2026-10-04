import { describe, expect, it } from 'vitest'
import { decidirVinculoGoogle, type ContaLogada } from '../../src/core/auth/decidirVinculoGoogle'
import { vincularGoogleAContaLogada, type VinculoGoogleRepository } from '../../src/services/auth/vincularGoogleAContaLogada'

const conta = (over: Partial<ContaLogada> = {}): ContaLogada => ({ id: 'u1', role: 'DRIVER', active: true, email: 'Motorista@Example.com', googleSub: null, ...over })
const google = (over: Partial<{ sub: string; email: string; emailVerified: boolean }> = {}) => ({ sub: 'g-1', email: 'motorista@example.com', emailVerified: true, ...over })

describe('decidirVinculoGoogle (regra pura do POST /api/auth/google/link)', () => {
  it('motorista ativo, sem Google, e-mail do Google verificado e IGUAL ao da conta (sem caixa, com espaços) -> LINK', () => {
    expect(decidirVinculoGoogle(conta(), google())).toEqual({ action: 'LINK' })
    expect(decidirVinculoGoogle(conta(), google({ email: '  MOTORISTA@example.COM ' }))).toEqual({ action: 'LINK' })
  })

  it.each([
    ['conta inexistente', null, google(), 'INACTIVE'],
    ['conta inativa', conta({ active: false }), google(), 'INACTIVE'],
    ['ADMIN', conta({ role: 'ADMIN' }), google(), 'NOT_ALLOWED'],
    ['OPERATOR', conta({ role: 'OPERATOR' }), google(), 'NOT_ALLOWED'],
    ['e-mail do Google não verificado', conta(), google({ emailVerified: false }), 'EMAIL_NOT_VERIFIED'],
    ['e-mail do Google diferente do da conta', conta(), google({ email: 'outro@example.com' }), 'EMAIL_MISMATCH'],
    ['e-mail parecido (sufixo) NÃO é igual', conta(), google({ email: 'motorista@example.com.br' }), 'EMAIL_MISMATCH'],
    ['a conta já tem Google', conta({ googleSub: 'g-antigo' }), google(), 'ALREADY_LINKED'],
  ] as const)('%s -> REJECT %s', (_nome, c, g, motivo) => {
    expect(decidirVinculoGoogle(c, g)).toEqual({ action: 'REJECT', reason: motivo })
  })

  it('staff é recusado ANTES de qualquer outra coisa', () => {
    expect(decidirVinculoGoogle(conta({ role: 'ADMIN' }), google({ emailVerified: false, email: 'x@y.com' }))).toEqual({ action: 'REJECT', reason: 'NOT_ALLOWED' })
  })

  it('e-mail NÃO verificado é recusado antes de comparar e-mails (não revela se o e-mail bate)', () => {
    expect(decidirVinculoGoogle(conta(), google({ emailVerified: false, email: 'outro@example.com' }))).toEqual({ action: 'REJECT', reason: 'EMAIL_NOT_VERIFIED' })
  })
})

describe('vincularGoogleAContaLogada (serviço, repositório em memória)', () => {
  function repoEmMemoria(c: ContaLogada | null, opcoes: { gravar?: boolean } = {}) {
    const chamadas: Array<[string, string]> = []
    const repo: VinculoGoogleRepository = {
      findAccount: async () => c,
      linkSubIfFree: async (u, s) => {
        chamadas.push([u, s])
        return opcoes.gravar ?? true
      },
    }
    return { repo, chamadas }
  }

  it('token inválido: INVALID_TOKEN, sem tocar no repositório, e o erro da lib (que embute o JWT) não escapa', async () => {
    const { repo, chamadas } = repoEmMemoria(conta())
    const r = await vincularGoogleAContaLogada('u1', 'jwt-secreto', {
      verifyIdToken: async () => {
        throw new Error('Wrong number of segments in token: jwt-secreto')
      },
      repo,
    })
    expect(r).toEqual({ status: 'INVALID_TOKEN' })
    expect(JSON.stringify(r)).not.toContain('jwt-secreto')
    expect(chamadas).toEqual([])
  })

  it('caminho feliz grava o sub na conta LOGADA (userId do token)', async () => {
    const { repo, chamadas } = repoEmMemoria(conta())
    expect(await vincularGoogleAContaLogada('u1', 'c', { verifyIdToken: async () => google(), repo })).toEqual({ status: 'OK' })
    expect(chamadas).toEqual([['u1', 'g-1']])
  })

  it('recusa da decisão nunca grava', async () => {
    const { repo, chamadas } = repoEmMemoria(conta())
    expect(await vincularGoogleAContaLogada('u1', 'c', { verifyIdToken: async () => google({ email: 'outro@example.com' }), repo })).toEqual({ status: 'EMAIL_MISMATCH' })
    expect(chamadas).toEqual([])
  })

  it('o repositório diz que não gravou (corrida / Google em outra conta) -> ALREADY_LINKED', async () => {
    const { repo } = repoEmMemoria(conta(), { gravar: false })
    expect(await vincularGoogleAContaLogada('u1', 'c', { verifyIdToken: async () => google(), repo })).toEqual({ status: 'ALREADY_LINKED' })
  })
})
