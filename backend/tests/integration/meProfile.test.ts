import { afterAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/api/app'
import { prisma } from '../../src/lib/prisma'
import { redis } from '../../src/lib/redis'
import { createTenant, createUser, settle, uniqueSuffix, waitFor } from './helpers/fixtures'

/**
 * L1.2 — `GET/PATCH /api/me/profile` contra Postgres + Redis REAIS. Foco: o dono do perfil é SEMPRE o token (IDOR), o corpo é estrito (e-mail/papel/googleSub não passam),
 * CPF duplicado vira 409 sem corrida, e a auditoria leva só NOMES de campos.
 */
describe('/api/me/profile (L1.2)', () => {
  const app = createApp()
  const suffix = uniqueSuffix()
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` })

  // CPFs válidos GERADOS a cada execução (o índice único de CPF é global e o banco de teste persiste entre rodadas): 9 dígitos aleatórios + 2 verificadores.
  function gerarCpf(): string {
    const base = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10))
    if (base.every((d) => d === base[0])) base[8] = (base[8]! + 1) % 10
    const dv = (digs: number[]) => {
      const soma = digs.reduce((acc, d, i) => acc + d * (digs.length + 1 - i), 0)
      const r = (soma * 10) % 11
      return r === 10 ? 0 : r
    }
    const d1 = dv(base)
    const d2 = dv([...base, d1])
    return [...base, d1, d2].join('')
  }
  const CPFS = Array.from({ length: 7 }, gerarCpf)
  const cpfDe = (n: number) => CPFS[n]!
  const comPontos = (c: string) => `${c.slice(0, 3)}.${c.slice(3, 6)}.${c.slice(6, 9)}-${c.slice(9)}`

  afterAll(async () => {
    await prisma.$disconnect()
    redis.disconnect()
  })

  it('GET devolve o DTO do PRÓPRIO motorista e nunca o CPF inteiro, o hash da senha ou o googleSub', async () => {
    const u = await createUser({ role: 'DRIVER', label: 'prof-get', suffix, passwordHash: 'hash-secreto-nao-vaza' })
    await prisma.user.update({ where: { id: u.id }, data: { cpf: cpfDe(0), phone: '(11) 91234-5678', googleSub: `g-${suffix}-get` } })

    const res = await request(app).get('/api/me/profile').set(auth(u.token))
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body).toEqual({
      id: u.id,
      name: u.name,
      email: u.email,
      phone: '(11) 91234-5678',
      cpfMasked: `***.${cpfDe(0).slice(3, 6)}.${cpfDe(0).slice(6, 9)}-**`,
      hasPassword: true,
      googleLinked: true,
      identityVerified: true,
      createdAt: expect.any(String),
    })
    const texto = JSON.stringify(res.body)
    expect(texto).not.toContain(cpfDe(0)) // CPF inteiro nunca
    expect(texto).not.toContain('hash-secreto-nao-vaza')
    expect(texto).not.toContain(`g-${suffix}-get`)
  })

  it('conta só-senha, sem CPF/telefone: hasPassword=true, googleLinked=false, identityVerified=false, nulos explícitos', async () => {
    const u = await createUser({ role: 'DRIVER', label: 'prof-so-senha', suffix, passwordHash: 'x' })
    const res = await request(app).get('/api/me/profile').set(auth(u.token))
    expect(res.body).toMatchObject({ phone: null, cpfMasked: null, hasPassword: true, googleLinked: false, identityVerified: false })
  })

  it('PATCH altera nome, telefone e CPF (com pontuação): o banco guarda só os 11 dígitos e a resposta já vem atualizada e mascarada', async () => {
    const u = await createUser({ role: 'DRIVER', label: 'prof-patch', suffix })
    const res = await request(app).patch('/api/me/profile').set(auth(u.token)).send({ name: '  Maria da Silva  ', phone: '+55 (11) 91234-5678', cpf: comPontos(cpfDe(1)) })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.name).toBe('Maria da Silva')
    expect(res.body.phone).toBe('+55 (11) 91234-5678')
    expect(res.body.cpfMasked).toBe(`***.${cpfDe(1).slice(3, 6)}.${cpfDe(1).slice(6, 9)}-**`)
    const db = await prisma.user.findUniqueOrThrow({ where: { id: u.id } })
    expect(db.cpf).toBe(cpfDe(1))
    expect(db.name).toBe('Maria da Silva')
    expect(db.email).toBe(u.email) // e-mail intocado

    // GET seguinte reflete (o cabeçalho do PWA atualiza sem relogar)
    expect((await request(app).get('/api/me/profile').set(auth(u.token))).body.name).toBe('Maria da Silva')
  })

  it('PATCH com null apaga telefone e CPF; campo ausente não mexe', async () => {
    const u = await createUser({ role: 'DRIVER', label: 'prof-null', suffix })
    await prisma.user.update({ where: { id: u.id }, data: { cpf: cpfDe(2), phone: '11912345678' } })
    const res = await request(app).patch('/api/me/profile').set(auth(u.token)).send({ phone: null })
    expect(res.status).toBe(200)
    expect(res.body.phone).toBeNull()
    expect(res.body.cpfMasked).not.toBeNull() // CPF não foi pedido: continua
    const res2 = await request(app).patch('/api/me/profile').set(auth(u.token)).send({ cpf: null })
    expect(res2.status).toBe(200)
    expect(res2.body.cpfMasked).toBeNull()
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).cpf).toBeNull()
  })

  it('validação por campo: nome vazio/enorme, telefone com letras/curto, CPF com dígito verificador errado ou sequência repetida -> 400 VALIDATION_ERROR com o path do campo', async () => {
    const u = await createUser({ role: 'DRIVER', label: 'prof-valida', suffix })
    const casos: Array<[Record<string, unknown>, string]> = [
      [{ name: '   ' }, 'name'],
      [{ name: 'x'.repeat(121) }, 'name'],
      [{ phone: 'abc12345678' }, 'phone'],
      [{ phone: '1234567' }, 'phone'],
      [{ phone: '1'.repeat(31) }, 'phone'],
      [{ cpf: '12345678900' }, 'cpf'],
      [{ cpf: '11111111111' }, 'cpf'],
      [{ cpf: 'abc' }, 'cpf'],
      [{ name: 42 }, 'name'],
    ]
    for (const [body, campo] of casos) {
      const res = await request(app).patch('/api/me/profile').set(auth(u.token)).send(body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(res.body.code).toBe('VALIDATION_ERROR')
      expect(JSON.stringify(res.body.details)).toContain(campo)
    }
    // nada disso gravou
    const db = await prisma.user.findUniqueOrThrow({ where: { id: u.id } })
    expect(db.name).toBe(u.name)
    expect(db.cpf).toBeNull()
  })

  it('corpo ESTRITO: e-mail, userId, role, googleSub, passwordHash e campos desconhecidos -> 400, e NADA é gravado (nem o campo válido que veio junto)', async () => {
    const u = await createUser({ role: 'DRIVER', label: 'prof-strict', suffix })
    const outro = await createUser({ role: 'DRIVER', label: 'prof-strict-outro', suffix })
    for (const extra of [{ email: 'novo@example.com' }, { userId: outro.id }, { role: 'ADMIN' }, { googleSub: 'g-x' }, { passwordHash: 'x' }, { operatorId: 'x' }, { qualquer: 1 }]) {
      const res = await request(app).patch('/api/me/profile').set(auth(u.token)).send({ name: 'Nome Novo', ...extra })
      expect(res.status, JSON.stringify(extra)).toBe(400)
    }
    const db = await prisma.user.findUniqueOrThrow({ where: { id: u.id } })
    expect(db.name).toBe(u.name)
    expect(db.email).toBe(u.email)
    expect(db.role).toBe('DRIVER')
    expect((await prisma.user.findUniqueOrThrow({ where: { id: outro.id } })).name).toBe(outro.name)

    // corpo vazio e {} também não passam
    expect((await request(app).patch('/api/me/profile').set(auth(u.token)).send({})).status).toBe(400)
  })

  it('IDOR: o perfil alterado/lido é SEMPRE o do token — motorista B nunca lê nem altera o de A, mesmo mandando o id de A', async () => {
    const a = await createUser({ role: 'DRIVER', label: 'prof-idor-a', suffix })
    const b = await createUser({ role: 'DRIVER', label: 'prof-idor-b', suffix })

    // GET: sem como apontar para A — nem por query nem por path
    const get = await request(app).get(`/api/me/profile?userId=${a.id}&id=${a.id}`).set(auth(b.token))
    expect(get.body.id).toBe(b.id)
    expect((await request(app).get(`/api/me/profile/${a.id}`).set(auth(b.token))).status).toBe(404)

    // PATCH: querystring/param ignorados; o corpo com userId é recusado
    const patch = await request(app).patch(`/api/me/profile?userId=${a.id}`).set(auth(b.token)).send({ name: 'Nome do B' })
    expect(patch.status).toBe(200)
    expect(patch.body.id).toBe(b.id)
    expect((await prisma.user.findUniqueOrThrow({ where: { id: a.id } })).name).toBe(a.name) // A intocado
    expect((await prisma.user.findUniqueOrThrow({ where: { id: b.id } })).name).toBe('Nome do B')
    expect((await request(app).patch('/api/me/profile').set(auth(b.token)).send({ userId: a.id, name: 'Invasão' })).status).toBe(400)
    expect((await prisma.user.findUniqueOrThrow({ where: { id: a.id } })).name).toBe(a.name)
  })

  it('só DRIVER: sem token 401; ADMIN e OPERATOR 403 (GET e PATCH)', async () => {
    const tenant = await createTenant({ suffix, label: 'prof-papel', withCharger: false })
    const admin = await createUser({ role: 'ADMIN', label: 'prof-admin', suffix })
    expect((await request(app).get('/api/me/profile')).status).toBe(401)
    expect((await request(app).patch('/api/me/profile').send({ name: 'x' })).status).toBe(401)
    for (const t of [tenant.staff.token, admin.token]) {
      expect((await request(app).get('/api/me/profile').set(auth(t))).status).toBe(403)
      expect((await request(app).patch('/api/me/profile').set(auth(t)).send({ name: 'Xx' })).status).toBe(403)
    }
  })

  it('CPF de OUTRA conta -> 409 CPF_IN_USE (código próprio, não o DUPLICATE genérico); o mesmo CPF na própria conta é idempotente (200)', async () => {
    const dono = await createUser({ role: 'DRIVER', label: 'prof-cpf-dono', suffix })
    const intruso = await createUser({ role: 'DRIVER', label: 'prof-cpf-intruso', suffix })
    expect((await request(app).patch('/api/me/profile').set(auth(dono.token)).send({ cpf: cpfDe(3) })).status).toBe(200)

    const res = await request(app).patch('/api/me/profile').set(auth(intruso.token)).send({ cpf: comPontos(cpfDe(3)), name: 'Intruso Novo' })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('CPF_IN_USE')
    expect(JSON.stringify(res.body)).not.toContain(dono.id) // não aponta de quem é
    const dbIntruso = await prisma.user.findUniqueOrThrow({ where: { id: intruso.id } })
    expect(dbIntruso.cpf).toBeNull()
    expect(dbIntruso.name).toBe(intruso.name) // o UPDATE é um só: o nome também não foi gravado

    expect((await request(app).patch('/api/me/profile').set(auth(dono.token)).send({ cpf: cpfDe(3) })).status).toBe(200)
  })

  it('CORRIDA: duas contas pedem o MESMO CPF ao mesmo tempo -> exatamente uma 200 e uma 409 CPF_IN_USE', async () => {
    const a = await createUser({ role: 'DRIVER', label: 'prof-corrida-a', suffix })
    const b = await createUser({ role: 'DRIVER', label: 'prof-corrida-b', suffix })
    const [ra, rb] = await Promise.all([
      request(app).patch('/api/me/profile').set(auth(a.token)).send({ cpf: cpfDe(4) }),
      request(app).patch('/api/me/profile').set(auth(b.token)).send({ cpf: cpfDe(4) }),
    ])
    expect([ra.status, rb.status].sort()).toEqual([200, 409])
    expect([ra, rb].find((r) => r.status === 409)!.body.code).toBe('CPF_IN_USE')
    expect(await prisma.user.count({ where: { cpf: cpfDe(4) } })).toBe(1)
  })

  it('auditoria: UMA linha UPDATE por mudança, com só os NOMES dos campos (nunca valores); pedido sem mudança real não audita', async () => {
    const u = await createUser({ role: 'DRIVER', label: 'prof-audit', suffix })
    const res = await request(app).patch('/api/me/profile').set(auth(u.token)).send({ name: 'Nome Auditado Segredo', phone: '11987654321', cpf: cpfDe(5) })
    expect(res.status).toBe(200)

    const linha = await waitFor(() => prisma.auditLog.findFirst({ where: { actorUserId: u.id, actionDetail: 'profile_updated' } }))
    expect(linha.action).toBe('UPDATE')
    expect(linha.actorRole).toBe('DRIVER')
    expect(linha.outcome).toBe('SUCCESS')
    expect(linha.entityType).toBe('User')
    expect(linha.entityId).toBe(u.id)
    expect(linha.path).toBe('/api/me/profile')
    expect(linha.changes).toEqual({ fieldNamesOnly: ['name', 'phone', 'cpf'] })
    // o snapshot do ATOR (actorName/actorEmail) existe em toda linha de auditoria por desenho; o que não pode vazar são os VALORES alterados em changes/detalhe.
    const texto = JSON.stringify({ changes: linha.changes, actionDetail: linha.actionDetail, entityId: linha.entityId, path: linha.path })
    for (const valor of ['Nome Auditado Segredo', '11987654321', cpfDe(5)]) expect(texto).not.toContain(valor)

    // repetir o MESMO pedido: 200, mas nenhuma linha nova
    expect((await request(app).patch('/api/me/profile').set(auth(u.token)).send({ name: 'Nome Auditado Segredo', cpf: cpfDe(5) })).status).toBe(200)
    await settle(300)
    expect(await prisma.auditLog.count({ where: { actorUserId: u.id, actionDetail: 'profile_updated' } })).toBe(1)
  })

  it('rate limit por USUÁRIO: a 21ª escrita em 15 min -> 429 RATE_LIMITED_PROFILE; outro motorista não é afetado', async () => {
    const u = await createUser({ role: 'DRIVER', label: 'prof-rate', suffix })
    const outro = await createUser({ role: 'DRIVER', label: 'prof-rate-outro', suffix })
    for (let i = 0; i < 20; i++) {
      const r = await request(app).patch('/api/me/profile').set(auth(u.token)).send({ name: `Nome ${i}` })
      expect(r.status, `escrita ${i}`).toBe(200)
    }
    const estourou = await request(app).patch('/api/me/profile').set(auth(u.token)).send({ name: 'Nome 21' })
    expect(estourou.status).toBe(429)
    expect(estourou.body.code).toBe('RATE_LIMITED_PROFILE')
    expect((await request(app).patch('/api/me/profile').set(auth(outro.token)).send({ name: 'Livre' })).status).toBe(200)
  })
})
