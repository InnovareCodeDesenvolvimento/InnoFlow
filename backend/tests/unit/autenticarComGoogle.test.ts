import { describe, expect, it, vi } from 'vitest'
import type { IdentidadeGoogle } from '../../src/core/auth/decidirAcaoGoogle'
import { autenticarComGoogle, UniqueViolationError, type GoogleAuthDeps, type GoogleUserRepository, type UsuarioGoogle } from '../../src/services/auth/autenticarComGoogle'

const identity: IdentidadeGoogle = { sub: 'google-sub-1', email: 'motorista@gmail.com', emailVerified: true, name: 'Motorista Google' }

const usuario = (over: Partial<UsuarioGoogle> = {}): UsuarioGoogle => ({
  id: 'u-1',
  name: 'Motorista',
  email: 'motorista@gmail.com',
  role: 'DRIVER',
  operatorId: null,
  active: true,
  googleSub: null,
  ...over,
})

/** Repositório em memória — registra TODA escrita para provar "não gravou nada" nos cenários de recusa. */
function fakeRepo(state: { bySub?: UsuarioGoogle | null; byEmail?: UsuarioGoogle[] } = {}) {
  const repo = {
    findBySub: vi.fn(async () => state.bySub ?? null),
    findManyByEmail: vi.fn(async () => state.byEmail ?? []),
    linkGoogleSub: vi.fn(async (userId: string, sub: string) => usuario({ id: userId, googleSub: sub })),
    createDriverWithWallet: vi.fn(async (input: { name: string; email: string; googleSub: string }) =>
      usuario({ id: 'u-new', name: input.name, email: input.email, googleSub: input.googleSub }),
    ),
  } satisfies GoogleUserRepository
  return repo
}

const okVerifier = (id: IdentidadeGoogle = identity): GoogleAuthDeps['verifyIdToken'] => vi.fn(async () => id)

describe('autenticarComGoogle', () => {
  it('token inválido -> INVALID_TOKEN, sem tocar o banco (e sem repassar o erro da lib)', async () => {
    const repo = fakeRepo()
    const verifyIdToken = vi.fn(async () => {
      throw new Error('Wrong number of segments in token: eyJ.secreto.jwt') // a lib do Google embute o JWT na mensagem
    })

    const resultado = await autenticarComGoogle('eyJ.secreto.jwt', { verifyIdToken, users: repo })

    expect(resultado).toEqual({ status: 'INVALID_TOKEN' })
    expect(JSON.stringify(resultado)).not.toContain('secreto')
    expect(repo.findBySub).not.toHaveBeenCalled()
    expect(repo.findManyByEmail).not.toHaveBeenCalled()
  })

  it('e-mail não verificado -> EMAIL_NOT_VERIFIED, sem consultar nem gravar nada', async () => {
    const repo = fakeRepo({ byEmail: [usuario({ role: 'ADMIN' })] })

    const resultado = await autenticarComGoogle('jwt', { verifyIdToken: okVerifier({ ...identity, emailVerified: false }), users: repo })

    expect(resultado).toEqual({ status: 'EMAIL_NOT_VERIFIED' })
    expect(repo.findBySub).not.toHaveBeenCalled()
    expect(repo.findManyByEmail).not.toHaveBeenCalled()
    expect(repo.linkGoogleSub).not.toHaveBeenCalled()
    expect(repo.createDriverWithWallet).not.toHaveBeenCalled()
  })

  it('sub conhecido -> entra (200, created=false), sem gravar', async () => {
    const existente = usuario({ googleSub: identity.sub })
    const repo = fakeRepo({ bySub: existente })

    const resultado = await autenticarComGoogle('jwt', { verifyIdToken: okVerifier(), users: repo })

    expect(resultado).toEqual({ status: 'OK', user: existente, created: false, linked: false })
    expect(repo.findManyByEmail).not.toHaveBeenCalled() // achou pelo sub, nem olha o e-mail
    expect(repo.linkGoogleSub).not.toHaveBeenCalled()
    expect(repo.createDriverWithWallet).not.toHaveBeenCalled()
  })

  it('e-mail de DRIVER existente -> VINCULA o googleSub e entra (created=false, linked=true)', async () => {
    const repo = fakeRepo({ byEmail: [usuario({ id: 'u-driver' })] })

    const resultado = await autenticarComGoogle('jwt', { verifyIdToken: okVerifier(), users: repo })

    expect(repo.linkGoogleSub).toHaveBeenCalledWith('u-driver', identity.sub)
    expect(resultado).toMatchObject({ status: 'OK', created: false, linked: true, user: { id: 'u-driver', googleSub: identity.sub } })
    expect(repo.createDriverWithWallet).not.toHaveBeenCalled()
  })

  it.each(['ADMIN', 'OPERATOR'] as const)('e-mail de %s -> STAFF_NOT_ALLOWED e NÃO grava nada (nem vincula, nem cria)', async (role) => {
    const staff = usuario({ id: `u-${role}`, role, operatorId: role === 'OPERATOR' ? 'op-1' : null })
    const repo = fakeRepo({ byEmail: [staff] })

    const resultado = await autenticarComGoogle('jwt', { verifyIdToken: okVerifier(), users: repo })

    expect(resultado).toEqual({ status: 'STAFF_NOT_ALLOWED', staff }) // a rota usa `staff` para gravar LOGIN_FAILED
    expect(repo.linkGoogleSub).not.toHaveBeenCalled()
    expect(repo.createDriverWithWallet).not.toHaveBeenCalled()
  })

  it('e-mail de staff com caixa diferente ("Admin@x.com" no banco) também bloqueia — a busca é case-insensitive', async () => {
    const staff = usuario({ id: 'u-admin', role: 'ADMIN', email: 'Motorista@Gmail.com' })
    const repo = fakeRepo({ byEmail: [staff] }) // o repositório real já devolve casamentos insensíveis à caixa

    const resultado = await autenticarComGoogle('jwt', { verifyIdToken: okVerifier(), users: repo })

    expect(resultado.status).toBe('STAFF_NOT_ALLOWED')
    expect(repo.createDriverWithWallet).not.toHaveBeenCalled()
  })

  it('conta nova -> cria DRIVER + wallet (created=true) com nome/e-mail/sub SÓ do payload verificado', async () => {
    const repo = fakeRepo()

    const resultado = await autenticarComGoogle('jwt', { verifyIdToken: okVerifier(), users: repo })

    expect(repo.createDriverWithWallet).toHaveBeenCalledWith({ name: 'Motorista Google', email: 'motorista@gmail.com', googleSub: 'google-sub-1' })
    expect(resultado).toMatchObject({ status: 'OK', created: true, linked: false, user: { id: 'u-new', role: 'DRIVER' } })
  })

  it('conta nova sem `name` no payload -> usa a parte local do e-mail (e respeita o teto de 120 caracteres)', async () => {
    const repo = fakeRepo()
    await autenticarComGoogle('jwt', { verifyIdToken: okVerifier({ ...identity, name: null }), users: repo })
    expect(repo.createDriverWithWallet).toHaveBeenCalledWith(expect.objectContaining({ name: 'motorista' }))

    const repoLongo = fakeRepo()
    await autenticarComGoogle('jwt', { verifyIdToken: okVerifier({ ...identity, name: 'x'.repeat(300) }), users: repoLongo })
    const chamada = repoLongo.createDriverWithWallet.mock.calls[0][0]
    expect(chamada.name).toHaveLength(120)
  })

  it('conta desativada -> INACTIVE, sem vincular', async () => {
    const repo = fakeRepo({ byEmail: [usuario({ active: false })] })
    expect(await autenticarComGoogle('jwt', { verifyIdToken: okVerifier(), users: repo })).toEqual({ status: 'INACTIVE' })
    expect(repo.linkGoogleSub).not.toHaveBeenCalled()
  })

  it('DRIVER do e-mail já vinculado a OUTRO Google -> ACCOUNT_MISMATCH, sem sobrescrever', async () => {
    const repo = fakeRepo({ byEmail: [usuario({ googleSub: 'sub-de-outra-pessoa' })] })
    expect(await autenticarComGoogle('jwt', { verifyIdToken: okVerifier(), users: repo })).toEqual({ status: 'ACCOUNT_MISMATCH' })
    expect(repo.linkGoogleSub).not.toHaveBeenCalled()
  })

  it('CORRIDA: dois requests criando o mesmo motorista — o perdedor pega UniqueViolation, relê e entra (nunca 500)', async () => {
    const vencedor = usuario({ id: 'u-venceu', googleSub: identity.sub })
    // 1ª leitura: ninguém. Depois do conflito, a releitura já enxerga o vencedor.
    const findBySub = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(vencedor)
    const repo: GoogleUserRepository = {
      findBySub,
      findManyByEmail: vi.fn(async () => []),
      linkGoogleSub: vi.fn(),
      createDriverWithWallet: vi.fn(async () => {
        throw new UniqueViolationError('P2002')
      }),
    }

    const resultado = await autenticarComGoogle('jwt', { verifyIdToken: okVerifier(), users: repo })

    expect(resultado).toEqual({ status: 'OK', user: vencedor, created: false, linked: false })
    expect(repo.createDriverWithWallet).toHaveBeenCalledTimes(1)
    expect(findBySub).toHaveBeenCalledTimes(2)
  })

  it('CORRIDA no vínculo: conflito de unique ao vincular também refaz a busca', async () => {
    const jaVinculado = usuario({ id: 'u-driver', googleSub: identity.sub })
    const findManyByEmail = vi.fn().mockResolvedValueOnce([usuario({ id: 'u-driver' })]).mockResolvedValueOnce([jaVinculado])
    const repo: GoogleUserRepository = {
      findBySub: vi.fn(async () => null),
      findManyByEmail,
      linkGoogleSub: vi.fn(async () => {
        throw new UniqueViolationError('P2002')
      }),
      createDriverWithWallet: vi.fn(),
    }

    const resultado = await autenticarComGoogle('jwt', { verifyIdToken: okVerifier(), users: repo })

    expect(resultado).toMatchObject({ status: 'OK', created: false, user: { id: 'u-driver' } })
  })

  it('duas colisões seguidas NÃO giram em loop — propaga o erro (patológico, não corrida normal)', async () => {
    const repo: GoogleUserRepository = {
      findBySub: vi.fn(async () => null),
      findManyByEmail: vi.fn(async () => []),
      linkGoogleSub: vi.fn(),
      createDriverWithWallet: vi.fn(async () => {
        throw new UniqueViolationError('P2002')
      }),
    }

    await expect(autenticarComGoogle('jwt', { verifyIdToken: okVerifier(), users: repo })).rejects.toBeInstanceOf(UniqueViolationError)
    expect(repo.createDriverWithWallet).toHaveBeenCalledTimes(2)
  })

  it('erro que NÃO é colisão de unique (ex.: banco fora) propaga sem retry', async () => {
    const repo: GoogleUserRepository = {
      findBySub: vi.fn(async () => null),
      findManyByEmail: vi.fn(async () => []),
      linkGoogleSub: vi.fn(),
      createDriverWithWallet: vi.fn(async () => {
        throw new Error('conexão perdida')
      }),
    }

    await expect(autenticarComGoogle('jwt', { verifyIdToken: okVerifier(), users: repo })).rejects.toThrow('conexão perdida')
    expect(repo.createDriverWithWallet).toHaveBeenCalledTimes(1)
  })
})
