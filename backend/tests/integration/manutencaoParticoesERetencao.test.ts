import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { criarBancoProprio } from './helpers/bancoProprio'

/**
 * N-11 — partições futuras e retenção, contra Postgres REAL (BANCO PRÓPRIO por arquivo: o teste derruba e recria partições de
 * `MeterSample`/`OcppMessage`, o que não pode acontecer no banco compartilhado das outras suítes em paralelo).
 *
 * O tempo é o REAL (`new Date()`); as partições do cenário são reconstruídas relativas a "agora" (`recriarParticoes`) — o teste não
 * depende do ano em que roda, nem do `TimeZone` do servidor (nesta máquina é America/Cayenne; na CI, UTC).
 */

let banco: Awaited<ReturnType<typeof criarBancoProprio>>
let db: PrismaClient
let part: typeof import('../../src/services/manutencao/particoes')
let ret: typeof import('../../src/services/manutencao/retencao')
let manut: typeof import('../../src/services/manutencao/manutencaoParticoes')
let fx: typeof import('./helpers/fixtures')
let sf: typeof import('./helpers/sessaoTravadaFixture')
let logger: typeof import('../../src/lib/logger').logger

const TABELAS = ['MeterSample', 'OcppMessage'] as const
const DIA = 86_400_000

const mesesDe = (data: Date, n: number) => {
  const d = new Date(data.getTime())
  d.setUTCMonth(d.getUTCMonth() + n)
  return d
}
/** Dia 15, 12:00 UTC, `n` meses de agora (negativo = passado) — meio do mês: longe das bordas, sem flake de virada de mês. */
const meioDoMes = (n: number) => {
  const d = mesesDe(new Date(), n)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 15, 12, 0, 0))
}
const diasAtras = (n: number) => new Date(Date.now() - n * DIA)

interface Particao {
  nome: string
  padrao: boolean
  inicio: Date | null
  fim: Date | null
}

async function particoesDe(tabela: string): Promise<Particao[]> {
  const linhas = await db.$queryRaw<{ nome: string; borda: string }[]>`
    SELECT c.relname::text AS nome, pg_get_expr(c.relpartbound, c.oid) AS borda
      FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent = to_regclass(quote_ident(${tabela})) ORDER BY 1`
  return linhas.map((l) => {
    const m = /FROM \('([^']+)'\) TO \('([^']+)'\)/.exec(l.borda)
    return { nome: l.nome, padrao: l.borda === 'DEFAULT', inicio: m ? new Date(m[1].replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00')) : null, fim: m ? new Date(m[2].replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00')) : null }
  })
}

async function nomesExplicitos(tabela: string): Promise<string[]> {
  return (await particoesDe(tabela)).filter((p) => !p.padrao).map((p) => p.nome)
}

async function ondeEstaLinha(tabela: string, id: string): Promise<string | null> {
  const r = await db.$queryRawUnsafe<{ p: string }[]>(`SELECT tableoid::regclass::text AS p FROM "${tabela}" WHERE id = $1`, id)
  return r.length ? r[0].p.replace(/"/g, '') : null
}

async function contar(tabela: string): Promise<number> {
  const r = await db.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::float8 AS n FROM "${tabela}"`)
  return Number(r[0].n)
}

/** Apaga TODAS as partições explícitas e linhas das duas tabelas e recria [agora - desde, agora + aFrente] meses com a própria função SQL. */
async function recriarParticoes(desdeMeses: number, aFrenteMeses: number): Promise<void> {
  for (const t of TABELAS) {
    for (const nome of await nomesExplicitos(t)) await db.$executeRawUnsafe(`DROP TABLE "${nome}"`)
    await db.$executeRawUnsafe(`DELETE FROM "${t}"`)
    await db.$queryRaw`SELECT * FROM ensure_partitions_ahead(${t}, ${desdeMeses + aFrenteMeses}::int, ${mesesDe(new Date(), -desdeMeses)}::timestamptz)`
  }
}

let seq = 0
async function inserirAmostra(chargePointId: string, ts: Date, sessionId?: string): Promise<string> {
  const id = `ms-${Date.now()}-${++seq}`
  await db.meterSample.create({ data: { id, chargePointId, operatorId: 'sera-sobrescrito-pelo-trigger', ts, measurand: 'Energy.Active.Import.Register', value: 1, sessionId: sessionId ?? null } })
  return id
}
async function inserirMensagem(chargePointId: string, occurredAt: Date, action = 'Heartbeat'): Promise<string> {
  const id = `om-${Date.now()}-${++seq}`
  await db.ocppMessage.create({
    data: { id, chargePointId, operatorId: 'sera-sobrescrito-pelo-trigger', direction: 'INBOUND', messageType: 'CALL', ocppMessageId: `m-${id}`, action, payload: {}, occurredAt },
  })
  return id
}

const alertasEmitidos = (spy: ReturnType<typeof vi.spyOn>, alerta: string) =>
  spy.mock.calls.filter((c) => (c[0] as { alert?: string } | undefined)?.alert === alerta)

let tenant: Awaited<ReturnType<(typeof import('./helpers/fixtures'))['createTenant']>>

beforeAll(async () => {
  banco = await criarBancoProprio('n11')
  ;({ prisma: db } = await import('../../src/lib/prisma'))
  part = await import('../../src/services/manutencao/particoes')
  ret = await import('../../src/services/manutencao/retencao')
  manut = await import('../../src/services/manutencao/manutencaoParticoes')
  fx = await import('./helpers/fixtures')
  sf = await import('./helpers/sessaoTravadaFixture')
  ;({ logger } = await import('../../src/lib/logger'))
  tenant = await fx.createTenant({ suffix: fx.uniqueSuffix(), label: 'n11' })
}, 120_000)

afterAll(async () => {
  await db.$disconnect()
  const { redis } = await import('../../src/lib/redis')
  redis.disconnect()
  await banco.descartar()
})

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('N-11 — partições futuras (função SQL + job)', () => {
  it('a migration deixou >= 12 meses à frente em AMBAS as tabelas, com a DEFAULT intacta e vazia', async () => {
    for (const t of TABELAS) {
      const ps = await particoesDe(t)
      expect(ps.some((p) => p.padrao)).toBe(true)
      const ultimoFim = ps.filter((p) => !p.padrao).map((p) => p.fim!.getTime()).sort((a, b) => a - b).pop()!
      expect(ultimoFim).toBeGreaterThanOrEqual(mesesDe(new Date(), 12).getTime())
      expect(await contar(`${t}_default`)).toBe(0)
    }
  })

  it('é IDEMPOTENTE: rodar de novo não cria nada nem falha; rodar com horizonte maior cria só o que falta', async () => {
    await recriarParticoes(2, 7)
    const antes = await nomesExplicitos('MeterSample')
    const r1 = await part.garantirParticoesFuturas(db, { mesesAFrente: 6 })
    expect(r1.every((r) => r.criadas.length === 0 && !r.erro)).toBe(true)
    expect(await nomesExplicitos('MeterSample')).toEqual(antes)

    const r2 = await part.garantirParticoesFuturas(db, { mesesAFrente: 12 })
    for (const r of r2) {
      expect(r.erro).toBeUndefined()
      expect(r.criadas.length).toBeGreaterThanOrEqual(4)
      expect(r.horizonteAte!.getTime()).toBeGreaterThanOrEqual(mesesDe(new Date(), 12).getTime())
    }
    const depois = await nomesExplicitos('MeterSample')
    expect(depois.length).toBe(antes.length + r2[0].criadas.length)

    const r3 = await part.garantirParticoesFuturas(db, { mesesAFrente: 12 })
    expect(r3.every((r) => r.criadas.length === 0)).toBe(true)
    expect(await nomesExplicitos('MeterSample')).toEqual(depois)
  })

  it('as partições são CONTÍGUAS (sem buraco nem sobreposição) e têm os mesmos índices, triggers e FKs da irmã mais antiga', async () => {
    await recriarParticoes(1, 3)
    await part.garantirParticoesFuturas(db, { mesesAFrente: 14 })
    for (const t of TABELAS) {
      const ps = (await particoesDe(t)).filter((p) => !p.padrao)
      for (let i = 1; i < ps.length; i++) expect(ps[i].inicio!.getTime()).toBe(ps[i - 1].fim!.getTime())
      const comparar = async (nome: string) => ({
        indices: Number((await db.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::float8 AS n FROM pg_index WHERE indrelid = '"${nome}"'::regclass`))[0].n),
        triggers: Number((await db.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::float8 AS n FROM pg_trigger WHERE tgrelid = '"${nome}"'::regclass AND NOT tgisinternal`))[0].n),
        fks: Number((await db.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::float8 AS n FROM pg_constraint WHERE conrelid = '"${nome}"'::regclass AND contype = 'f'`))[0].n),
      })
      const velha = await comparar(ps[0].nome)
      const nova = await comparar(ps[ps.length - 1].nome)
      expect(nova).toEqual(velha)
      expect(nova.triggers).toBeGreaterThanOrEqual(1)
      expect(nova.fks).toBeGreaterThanOrEqual(2)
    }
  })

  it('INSERT num mês futuro (além do que a migration inicial criou) cai na partição do mês, não na DEFAULT, e o trigger de operatorId continua valendo', async () => {
    await recriarParticoes(1, 3)
    await part.garantirParticoesFuturas(db, { mesesAFrente: 18 })
    const ts = meioDoMes(17)
    const idM = await inserirAmostra(tenant.chargePointId, ts)
    const idO = await inserirMensagem(tenant.chargePointId, ts)
    expect(await ondeEstaLinha('MeterSample', idM)).toMatch(/^MeterSample_20\d\d_\d\d$/)
    expect(await ondeEstaLinha('OcppMessage', idO)).toMatch(/^OcppMessage_20\d\d_\d\d$/)
    const [{ operatorId }] = await db.$queryRaw<{ operatorId: string }[]>`SELECT "operatorId" FROM "MeterSample" WHERE id = ${idM}`
    expect(operatorId).toBe(tenant.operatorId)
  })

  it('a hipótese da auditoria estava errada pela metade: SEM partição o INSERT não falha — cai na DEFAULT e dispara o alerta; criar o mês depois MOVE as linhas', async () => {
    await recriarParticoes(1, 3)
    const ts = meioDoMes(10)
    const id = await inserirAmostra(tenant.chargePointId, ts)
    const idO = await inserirMensagem(tenant.chargePointId, ts)
    expect(await ondeEstaLinha('MeterSample', id)).toBe('MeterSample_default')

    // Prova do perigo que o job resolve: CREATE ... PARTITION OF "ingênuo" falharia com linhas do mês na DEFAULT.
    await expect(db.$executeRawUnsafe(`CREATE TABLE "x_ingenua" PARTITION OF "MeterSample" FOR VALUES FROM ('${meioDoMes(10).toISOString().slice(0, 7)}-01 00:00:00+00') TO ('${meioDoMes(11).toISOString().slice(0, 7)}-01 00:00:00+00')`)).rejects.toThrow(/default partition/i)

    const warn = vi.spyOn(logger, 'warn')
    const rel = await part.garantirParticoesFuturas(db, { mesesAFrente: 0 }) // não cria nada: só mede
    expect(alertasEmitidos(warn, 'partition_default_has_rows').length).toBe(2) // uma por tabela
    expect(rel.every((r) => r.linhasNaDefault === 1)).toBe(true)

    // Agora o job de verdade, com horizonte que cobre o mês: as linhas MIGRAM para a partição nova.
    const rel2 = await part.garantirParticoesFuturas(db, { mesesAFrente: 12 })
    expect(rel2.every((r) => !r.erro && r.linhasNaDefault === 0)).toBe(true)
    expect(rel2.map((r) => r.criadas.reduce((n, c) => n + c.linhasMovidasDaDefault, 0))).toEqual([1, 1])
    expect(await ondeEstaLinha('MeterSample', id)).toMatch(/^MeterSample_20\d\d_\d\d$/)
    expect(await ondeEstaLinha('OcppMessage', idO)).toMatch(/^OcppMessage_20\d\d_\d\d$/)
    expect(await contar('MeterSample')).toBe(1) // nenhuma linha perdida nem duplicada
    expect(await contar('OcppMessage_default')).toBe(0)
  })

  it('simula o relógio andando (`agora` = daqui a 30 meses): cria o que a migration não cobria, mantém contiguidade e o horizonte pedido', async () => {
    await recriarParticoes(1, 12)
    const futuro = mesesDe(new Date(), 30)
    const rels = await part.garantirParticoesFuturas(db, { mesesAFrente: 3, agora: futuro })
    for (const r of rels) {
      expect(r.erro).toBeUndefined()
      expect(r.horizonteAte!.getTime()).toBeGreaterThanOrEqual(mesesDe(futuro, 3).getTime())
      expect(r.criadas.length).toBeGreaterThanOrEqual(18)
    }
    const ps = (await particoesDe('OcppMessage')).filter((p) => !p.padrao)
    for (let i = 1; i < ps.length; i++) expect(ps[i].inicio!.getTime()).toBe(ps[i - 1].fim!.getTime())
  })

  it('alerta partition_horizon_low quando o horizonte fica < 2 meses; não alerta com horizonte saudável', async () => {
    await recriarParticoes(1, 0) // termina no fim do mês corrente: < 2 meses à frente
    const warn = vi.spyOn(logger, 'warn')
    await part.garantirParticoesFuturas(db, { mesesAFrente: 0 })
    expect(alertasEmitidos(warn, 'partition_horizon_low').length).toBe(2)

    warn.mockClear()
    await part.garantirParticoesFuturas(db, { mesesAFrente: 6 })
    expect(alertasEmitidos(warn, 'partition_horizon_low').length).toBe(0)
    expect(alertasEmitidos(warn, 'partition_default_has_rows').length).toBe(0)
  })

  it('lock consultivo: com a manutenção rodando em outra conexão, esta rodada PULA (nada criado, sem erro); duas rodadas simultâneas não colidem', async () => {
    await recriarParticoes(1, 3)
    const { PrismaClient } = await import('@prisma/client')
    const outro = new PrismaClient({ datasources: { db: { url: banco.url } } })
    try {
      let liberar!: () => void
      const segurando = new Promise<void>((r) => (liberar = r))
      let travado!: () => void
      const ficouTravado = new Promise<void>((r) => (travado = r))
      const tx = outro.$transaction(
        async (t) => {
          await t.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('innoelektron:manutencao-particoes'))`
          travado()
          await segurando
        },
        { timeout: 60_000 },
      )
      await ficouTravado
      const antes = await nomesExplicitos('MeterSample')
      const rels = await part.garantirParticoesFuturas(db, { mesesAFrente: 12 })
      expect(rels.every((r) => r.pulou && !r.erro && r.criadas.length === 0)).toBe(true)
      expect(await nomesExplicitos('MeterSample')).toEqual(antes)
      liberar()
      await tx

      const [a, b] = await Promise.all([part.garantirParticoesFuturas(db, { mesesAFrente: 12 }), part.garantirParticoesFuturas(db, { mesesAFrente: 12 })])
      const todos = [...a, ...b]
      expect(todos.every((r) => !r.erro)).toBe(true)
      expect(todos.filter((r) => r.tabela === 'MeterSample').reduce((n, r) => n + r.criadas.length, 0)).toBeGreaterThanOrEqual(9)
      const nomes = await nomesExplicitos('MeterSample')
      expect(new Set(nomes).size).toBe(nomes.length)
    } finally {
      await outro.$disconnect()
    }
  })

  it('falha de criação (lock de tabela seguro por outra transação) NÃO derruba: erro registrado, alerta de horizonte emitido mesmo assim', async () => {
    await recriarParticoes(1, 0)
    const { PrismaClient } = await import('@prisma/client')
    const outro = new PrismaClient({ datasources: { db: { url: banco.url } } })
    try {
      let liberar!: () => void
      const segurando = new Promise<void>((r) => (liberar = r))
      let travado!: () => void
      const ficouTravado = new Promise<void>((r) => (travado = r))
      // Uma transação "longa" segurando lock exclusivo no pai: o ATTACH precisa de SHARE UPDATE EXCLUSIVE e fica esperando.
      const tx = outro.$transaction(
        async (t) => {
          await t.$executeRawUnsafe(`LOCK TABLE "MeterSample" IN ACCESS EXCLUSIVE MODE`)
          travado()
          await segurando
        },
        { timeout: 60_000 },
      )
      await ficouTravado
      const erro = vi.spyOn(logger, 'error')
      const warn = vi.spyOn(logger, 'warn')
      const rels = await part.garantirParticoesFuturas(db, { mesesAFrente: 12, lockTimeoutMs: 500 })
      const m = rels.find((r) => r.tabela === 'MeterSample')!
      expect(m.erro).toBeTruthy()
      expect(alertasEmitidos(erro, 'partition_maintenance_lock_timeout').length).toBe(1)
      expect(m.criadas.length).toBe(0)
      // OcppMessage (outra tabela) não foi impedida por isso:
      expect(rels.find((r) => r.tabela === 'OcppMessage')!.criadas.length).toBeGreaterThan(0)
      liberar()
      await tx
      // O alerta de horizonte (< 2 meses) saiu mesmo com a criação falhando: leitura do catálogo não precisa do lock do pai.
      expect(alertasEmitidos(warn, 'partition_horizon_low').length).toBeGreaterThanOrEqual(1)
      // Próxima rodada recupera sozinha.
      const rels2 = await part.garantirParticoesFuturas(db, { mesesAFrente: 12 })
      expect(rels2.every((r) => !r.erro)).toBe(true)
    } finally {
      await outro.$disconnect()
    }
  }, 60_000)

  it('o fuso do banco não importa: com o banco em UTC e depois em America/Sao_Paulo a continuação continua contígua', async () => {
    for (const tz of ['UTC', 'America/Sao_Paulo']) {
      await recriarParticoes(1, 2)
      await db.$executeRawUnsafe(`ALTER DATABASE "${banco.nome}" SET timezone TO '${tz}'`)
      await db.$disconnect()
      await db.$connect()
      await part.garantirParticoesFuturas(db, { mesesAFrente: 10 })
      for (const t of TABELAS) {
        const ps = (await particoesDe(t)).filter((p) => !p.padrao)
        for (let i = 1; i < ps.length; i++) expect(ps[i].inicio!.getTime()).toBe(ps[i - 1].fim!.getTime())
        const nomes = ps.map((p) => p.nome)
        expect(new Set(nomes).size).toBe(nomes.length)
      }
    }
    await db.$executeRawUnsafe(`ALTER DATABASE "${banco.nome}" RESET timezone`)
    await db.$disconnect()
    await db.$connect()
  })
})

const CFG = { habilitada: true, dryRun: false, ocppMessageDias: 90, meterSampleDias: 395, webhookEventDias: 90 }

/** Meses (relativos) em que a retenção deve apagar / preservar. `meioDoMes(-n)` cai em partição que termina bem antes do corte de 395 d (n >= 15). */
describe('N-11 — retenção (DETACH + DROP de partição inteira)', () => {
  const corte = (dias: number) => new Date(Date.now() - dias * DIA)

  async function montar() {
    await recriarParticoes(28, 6)
    const velhoM = await inserirAmostra(tenant.chargePointId, meioDoMes(-20))
    const recenteM = await inserirAmostra(tenant.chargePointId, diasAtras(300))
    const correnteM = await inserirAmostra(tenant.chargePointId, new Date())
    const velhoO = await inserirMensagem(tenant.chargePointId, diasAtras(200))
    const recenteO = await inserirMensagem(tenant.chargePointId, diasAtras(60))
    const correnteO = await inserirMensagem(tenant.chargePointId, new Date())
    return { velhoM, recenteM, correnteM, velhoO, recenteO, correnteO }
  }

  it('RETENTION_ENABLED=false (padrão): NÃO toca em nada — nem partição, nem linha, nem lê o banco', async () => {
    const ids = await montar()
    const antes = { m: await nomesExplicitos('MeterSample'), o: await nomesExplicitos('OcppMessage'), cm: await contar('MeterSample'), co: await contar('OcppMessage') }
    const query = vi.spyOn(db, '$queryRaw')
    const exec = vi.spyOn(db, '$executeRaw')
    const rel = await ret.aplicarRetencao(db, { ...CFG, habilitada: false })
    expect(rel.acoes).toEqual([])
    expect(query).not.toHaveBeenCalled()
    expect(exec).not.toHaveBeenCalled()
    expect({ m: await nomesExplicitos('MeterSample'), o: await nomesExplicitos('OcppMessage'), cm: await contar('MeterSample'), co: await contar('OcppMessage') }).toEqual(antes)
    expect(await ondeEstaLinha('MeterSample', ids.velhoM)).not.toBeNull()
    // O orquestrador completo com o default do env (desligada) também não purga:
    const todo = await manut.executarManutencaoParticoes(db, { mesesAFrente: 6, retencao: { ...CFG, habilitada: false } })
    expect(todo.retencao.acoes).toEqual([])
    expect(await ondeEstaLinha('OcppMessage', ids.velhoO)).not.toBeNull()
  })

  it('DRY-RUN: só loga o que removeria; nenhuma partição/linha muda', async () => {
    await montar()
    const antes = { m: await nomesExplicitos('MeterSample'), o: await nomesExplicitos('OcppMessage'), cm: await contar('MeterSample'), co: await contar('OcppMessage') }
    const info = vi.spyOn(logger, 'info')
    const rel = await ret.aplicarRetencao(db, { ...CFG, dryRun: true })
    expect(rel.acoes.some((a) => a.acao === 'dry_run_partition')).toBe(true)
    expect(rel.acoes.some((a) => a.acao === 'partition_dropped')).toBe(false)
    expect(info.mock.calls.some((c) => (c[0] as { event?: string })?.event === 'retention_dry_run')).toBe(true)
    expect(info.mock.calls.some((c) => (c[0] as { event?: string })?.event === 'retention_partition_dropped')).toBe(false)
    expect({ m: await nomesExplicitos('MeterSample'), o: await nomesExplicitos('OcppMessage'), cm: await contar('MeterSample'), co: await contar('OcppMessage') }).toEqual(antes)
  })

  it('ligada: remove SÓ as partições inteiras além do prazo (90 d OcppMessage / 395 d MeterSample) e preserva a do corte, as recentes, a corrente, as futuras e a DEFAULT', async () => {
    const ids = await montar()
    const ancient = `old-default-${Date.now()}`
    // Linha antiquíssima na DEFAULT (anterior à 1ª partição): a retenção NUNCA toca na DEFAULT.
    await db.$executeRawUnsafe(`INSERT INTO "MeterSample"(id,"chargePointId","operatorId",ts,measurand,value) VALUES ('${ancient}','${tenant.chargePointId}','${tenant.operatorId}','2001-01-01T00:00:00Z','x',1)`)
    expect(await ondeEstaLinha('MeterSample', ancient)).toBe('MeterSample_default')

    const antes = { M: await particoesDe('MeterSample'), O: await particoesDe('OcppMessage') }
    const info = vi.spyOn(logger, 'info')
    const rel = await ret.aplicarRetencao(db, CFG)
    expect(rel.erros).toEqual([])

    const esperado = (ps: Particao[], dias: number) => ps.filter((p) => !p.padrao && p.fim!.getTime() <= corte(dias).getTime()).map((p) => p.nome)
    const apagadasM = esperado(antes.M, 395)
    const apagadasO = esperado(antes.O, 90)
    expect(apagadasM.length).toBeGreaterThan(5)
    expect(apagadasO.length).toBeGreaterThan(15)
    const depoisM = (await particoesDe('MeterSample')).map((p) => p.nome)
    const depoisO = (await particoesDe('OcppMessage')).map((p) => p.nome)
    expect(depoisM).toEqual(antes.M.map((p) => p.nome).filter((n) => !apagadasM.includes(n)))
    expect(depoisO).toEqual(antes.O.map((p) => p.nome).filter((n) => !apagadasO.includes(n)))
    expect(depoisM).toContain('MeterSample_default')
    expect(depoisO).toContain('OcppMessage_default')

    // Semântica: a partição que CONTÉM o instante do corte (e tudo depois) sobrevive.
    const contem = (ps: Particao[], instante: Date) => ps.find((p) => !p.padrao && p.inicio!.getTime() <= instante.getTime() && instante.getTime() < p.fim!.getTime())!.nome
    expect(depoisM).toContain(contem(antes.M, new Date(corte(395).getTime() + DIA)))
    expect(depoisO).toContain(contem(antes.O, new Date(corte(90).getTime() + DIA)))

    // Linhas: as antigas sumiram junto com a partição; as recentes e a corrente continuam; a da DEFAULT também.
    expect(await ondeEstaLinha('MeterSample', ids.velhoM)).toBeNull()
    expect(await ondeEstaLinha('OcppMessage', ids.velhoO)).toBeNull()
    expect(await ondeEstaLinha('MeterSample', ids.recenteM)).not.toBeNull()
    expect(await ondeEstaLinha('MeterSample', ids.correnteM)).not.toBeNull()
    expect(await ondeEstaLinha('OcppMessage', ids.recenteO)).not.toBeNull()
    expect(await ondeEstaLinha('OcppMessage', ids.correnteO)).not.toBeNull()
    expect(await ondeEstaLinha('MeterSample', ancient)).toBe('MeterSample_default')

    // Log estruturado de cada ação.
    const dropped = info.mock.calls.filter((c) => (c[0] as { event?: string })?.event === 'retention_partition_dropped').map((c) => (c[0] as { particao: string }).particao)
    expect([...dropped].sort()).toEqual([...apagadasM, ...apagadasO].sort())

    // A manutenção seguinte ainda cria o que falta (nada de retenção "comer" o horizonte).
    const m = await part.garantirParticoesFuturas(db, { mesesAFrente: 6 })
    expect(m.every((r) => !r.erro)).toBe(true)
  })

  it('prazos abaixo do piso de 30 dias são elevados a 30 (um "1" ou "0" digitado errado não limpa o mês anterior)', async () => {
    await montar()
    // "Agora" fixo no dia 15 do mês: a partição do mês ANTERIOR terminou há ~14,5 dias — dentro de 30 d (deve sobrar), fora de 1 d (cairia sem o piso).
    const agora = meioDoMes(0)
    const anterior = (ps: Particao[]) => ps.find((p) => !p.padrao && p.fim!.getTime() <= agora.getTime() && agora.getTime() - p.fim!.getTime() < 30 * DIA)!
    const antesM = await particoesDe('MeterSample')
    const antesO = await particoesDe('OcppMessage')
    const nomeAnteriorM = anterior(antesM).nome
    const nomeAnteriorO = anterior(antesO).nome
    const rel = await ret.aplicarRetencao(db, { ...CFG, ocppMessageDias: 1, meterSampleDias: 0, webhookEventDias: -5 }, agora)
    expect(rel.erros).toEqual([])
    expect((await particoesDe('MeterSample')).map((p) => p.nome)).toContain(nomeAnteriorM)
    expect((await particoesDe('OcppMessage')).map((p) => p.nome)).toContain(nomeAnteriorO)
    // ...e o piso de 30 d ainda deixa cair o que passou de 30 d (não ficou "tudo protegido"):
    expect(rel.acoes.some((a) => a.acao === 'partition_dropped')).toBe(true)
    const m = (await particoesDe('MeterSample')).filter((p) => !p.padrao)
    expect(m.every((p) => p.fim!.getTime() > agora.getTime() - 30 * DIA)).toBe(true)
  })

  it('NÃO apaga partição referenciada por sessão aberta, dívida em aberto ou pagamento em andamento — e alerta; apaga a que ninguém usa (inclusive a de chargeback: o dossiê é snapshot)', async () => {
    await recriarParticoes(28, 6)
    const c = await sf.criarCenario(fx.uniqueSuffix(), 'n11ret')
    const minutosAte = (alvo: Date) => (Date.now() - alvo.getTime()) / 60_000

    async function sessaoEm(meses: number, status: 'STOPPED' | 'CHARGING') {
      const inicio = meioDoMes(meses)
      const s = await sf.criarSessao(c, { mode: 'WALLET', status, iniciouHaMin: minutosAte(inicio) })
      if (status === 'STOPPED') await db.chargingSession.update({ where: { id: s.session.id }, data: { stoppedAt: new Date(inicio.getTime() + 3_600_000) } })
      const amostra = await inserirAmostra(c.tenant.chargePointId, new Date(inicio.getTime() + 600_000), s.session.id)
      const msg = await inserirMensagem(c.tenant.chargePointId, new Date(inicio.getTime() + 600_000), 'StopTransaction')
      return { ...s, amostra, msg }
    }

    const limpa = await sessaoEm(-24, 'STOPPED')
    const comDivida = await sessaoEm(-22, 'STOPPED')
    await db.debt.create({ data: { userId: comDivida.driver.id, chargingSessionId: comDivida.session.id, amountCents: 500, status: 'OPEN', reason: 'teste' } })
    const comIntent = await sessaoEm(-20, 'STOPPED')
    await db.paymentIntent.create({ data: { purpose: 'SESSION_CARD_CAPTURE', provider: 'CIELO_CARD', userId: comIntent.driver.id, chargingSessionId: comIntent.session.id, status: 'CAPTURE_PENDING', amountRequestedCents: 500 } })
    const comEstorno = await sessaoEm(-18, 'STOPPED')
    await db.paymentIntent.create({ data: { purpose: 'SESSION_CARD_CAPTURE', provider: 'CIELO_CARD', userId: comEstorno.driver.id, chargingSessionId: comEstorno.session.id, status: 'CAPTURE_PENDING', amountRequestedCents: 500 } })
    await db.paymentIntent.updateMany({ where: { chargingSessionId: comEstorno.session.id }, data: { status: 'CAPTURED', returnCode: '6', amountCapturedCents: 500, chargebackAt: new Date() } })
    const aberta = await sessaoEm(-16, 'CHARGING')
    // Controle: sessão FECHADA e quitada (intent CAPTURED sem estorno, dívida SETTLED) não protege nada.
    const quitada = await sessaoEm(-26, 'STOPPED')
    await db.paymentIntent.create({ data: { purpose: 'SESSION_CARD_CAPTURE', provider: 'CIELO_CARD', userId: quitada.driver.id, chargingSessionId: quitada.session.id, status: 'CAPTURED', returnCode: '6', amountRequestedCents: 500, amountCapturedCents: 500 } })
    await db.debt.create({ data: { userId: quitada.driver.id, chargingSessionId: quitada.session.id, amountCents: 100, status: 'SETTLED', reason: 'teste' } })

    const warn = vi.spyOn(logger, 'warn')
    const rel = await ret.aplicarRetencao(db, CFG)
    expect(rel.erros).toEqual([])

    // Quem ninguém usa foi apagado (nas duas tabelas):
    // (chargeback NÃO protege — decisão DL6: o dossiê é snapshot, não depende destas tabelas depois de salvo)
    for (const s of [limpa, quitada, comEstorno]) {
      expect(await ondeEstaLinha('MeterSample', s.amostra)).toBeNull()
      expect(await ondeEstaLinha('OcppMessage', s.msg)).toBeNull()
    }
    // Quem ainda é referenciado ficou, inclusive a sessão aberta (reconciliação lê MeterSample/StopTransaction no log):
    for (const s of [comDivida, comIntent, aberta]) {
      expect(await ondeEstaLinha('MeterSample', s.amostra), `amostra da sessão ${s.session.id}`).not.toBeNull()
      expect(await ondeEstaLinha('OcppMessage', s.msg), `mensagem da sessão ${s.session.id}`).not.toBeNull()
    }
    const bloqueios = alertasEmitidos(warn, 'retention_partition_blocked')
    expect(bloqueios.length).toBeGreaterThanOrEqual(6) // 3 sessões x 2 tabelas (a aberta bloqueia ainda MAIS meses: todo o seu intervalo)
    const idsBloqueados = new Set(bloqueios.flatMap((b) => ((b[0] as { sessoes: { id: string }[] }).sessoes ?? []).map((s) => s.id)))
    for (const s of [comDivida, comIntent, aberta]) expect(idsBloqueados.has(s.session.id)).toBe(true)
    expect(idsBloqueados.has(limpa.session.id)).toBe(false)
    expect(idsBloqueados.has(quitada.session.id)).toBe(false)
    expect(idsBloqueados.has(comEstorno.session.id)).toBe(false)

    // Resolver a pendência libera na rodada seguinte (a dívida quitada deixa de proteger):
    await db.debt.update({ where: { id: (await db.debt.findFirstOrThrow({ where: { chargingSessionId: comDivida.session.id } })).id }, data: { status: 'SETTLED', settledAt: new Date() } })
    await ret.aplicarRetencao(db, CFG)
    expect(await ondeEstaLinha('MeterSample', comDivida.amostra)).toBeNull()
    expect(await ondeEstaLinha('OcppMessage', comDivida.msg)).toBeNull()
    expect(await ondeEstaLinha('MeterSample', comIntent.amostra)).not.toBeNull() // ainda CAPTURE_PENDING
  }, 120_000)

  // MUDANÇA DELIBERADA (decisão do dono, 05/10/2026): o AuditLog passou a ser purgado aos 24 meses (era 'nunca tocado'). WalletEntry e as tabelas financeiras SEGUEM intocadas, por mais antigas que sejam.
  it('AuditLog > 24 meses é purgado (e a purga deixa 1 linha SYSTEM); WalletEntry e as tabelas financeiras NUNCA são tocadas, por mais antigas que sejam e mesmo com a retenção ligada', async () => {
    await montar()
    const c = await sf.criarCenario(fx.uniqueSuffix(), 'n11audit')
    const s = await sf.criarSessao(c, { mode: 'WALLET', status: 'STOPPED', saldoCents: 1000, iniciouHaMin: 40 * 30 * 24 * 60 })
    const trinta = mesesDe(new Date(), -40)
    await db.auditLog.create({ data: { occurredAt: trinta, actorUserId: 'n11-audit', actorRole: 'ADMIN', actorEmail: 'a@example.com', actorName: 'A', action: 'OTHER', outcome: 'SUCCESS', httpStatus: 200, method: 'GET', path: '/x' } })
    await db.$executeRawUnsafe(`UPDATE "ChargingSession" SET "stoppedAt" = "startedAt" + interval '1 hour' WHERE id = '${s.session.id}'`)
    await db.$executeRawUnsafe(`ALTER TABLE "WalletEntry" DISABLE TRIGGER wallet_entry_no_update`) // só p/ envelhecer a linha de teste; reabilitado logo abaixo
    await db.$executeRawUnsafe(`UPDATE "WalletEntry" SET "createdAt" = '${trinta.toISOString()}' WHERE "walletId" = '${s.wallet.id}'`)
    await db.$executeRawUnsafe(`ALTER TABLE "WalletEntry" ENABLE TRIGGER wallet_entry_no_update`)

    const contagens = async () => ({
      audit: await contar('AuditLog'),
      wallet: await contar('WalletEntry'),
      sessions: await contar('ChargingSession'),
      intents: await contar('PaymentIntent'),
      debts: await contar('Debt'),
      auditVelha: Number((await db.$queryRaw<{ n: number }[]>`SELECT count(*)::float8 AS n FROM "AuditLog" WHERE "occurredAt" < now() - interval '24 months'`)[0].n),
      walletVelha: Number((await db.$queryRaw<{ n: number }[]>`SELECT count(*)::float8 AS n FROM "WalletEntry" WHERE "createdAt" < now() - interval '24 months'`)[0].n),
    })
    const antes = await contagens()
    expect(antes.auditVelha).toBeGreaterThanOrEqual(1)
    expect(antes.walletVelha).toBeGreaterThanOrEqual(1)

    await manut.executarManutencaoParticoes(db, { mesesAFrente: 6, retencao: { ...CFG, ocppMessageDias: 30, meterSampleDias: 30, webhookEventDias: 30 } })

    const depois = await contagens()
    // financeiro e extrato: byte a byte iguais, inclusive a linha de carteira de 40 meses
    expect({ wallet: depois.wallet, sessions: depois.sessions, intents: depois.intents, debts: depois.debts, walletVelha: depois.walletVelha }).toEqual({ wallet: antes.wallet, sessions: antes.sessions, intents: antes.intents, debts: antes.debts, walletVelha: antes.walletVelha })
    // auditoria: a linha de 40 meses saiu, nada velho sobrou, e entrou exatamente 1 linha da purga (SYSTEM, recente)
    expect(depois.auditVelha).toBe(0)
    expect(await db.auditLog.count({ where: { actorUserId: 'n11-audit' } })).toBe(0)
    expect(await db.auditLog.count({ where: { actorRole: 'SYSTEM', actionDetail: 'retention:audit_log_purged' } })).toBeGreaterThanOrEqual(1)
    expect(depois.audit).toBe(antes.audit - antes.auditVelha + 1)
    // Os triggers append-only continuam instalados e ativos (UPDATE em linha de AuditLog segue recusado):
    const triggers = await db.$queryRaw<{ tgname: string }[]>`SELECT tgname::text FROM pg_trigger WHERE tgname IN ('audit_log_no_update','audit_log_restrict_delete','audit_log_no_truncate','wallet_entry_no_update','wallet_entry_no_delete','wallet_entry_no_truncate') AND tgenabled = 'O'`
    expect(triggers.length).toBe(6)
    await expect(db.$executeRawUnsafe(`UPDATE "AuditLog" SET "path" = '/y' WHERE "actionDetail" = 'retention:audit_log_purged'`)).rejects.toThrow(/append-only/)
  }, 120_000)

  it('WebhookEvent: apaga em lote só os JÁ PROCESSADOS além do prazo; mantém os recentes, os não processados (e alerta) e os ligados a pagamento em andamento', async () => {
    const c = await sf.criarCenario(fx.uniqueSuffix(), 'n11wh')
    const s = await sf.criarSessao(c, { mode: 'WALLET', status: 'STOPPED' })
    const intentVivo = await db.paymentIntent.create({ data: { purpose: 'SESSION_CARD_CAPTURE', provider: 'CIELO_CARD', userId: s.driver.id, chargingSessionId: s.session.id, status: 'CAPTURE_PENDING', amountRequestedCents: 100 } })
    const base = { provider: 'CIELO', changeType: 1, payload: {} }
    const velhoProc = await db.webhookEvent.create({ data: { ...base, externalId: 'w1', receivedAt: diasAtras(200), processedAt: diasAtras(199) } })
    const recente = await db.webhookEvent.create({ data: { ...base, externalId: 'w2', receivedAt: diasAtras(10), processedAt: diasAtras(10) } })
    const velhoNaoProc = await db.webhookEvent.create({ data: { ...base, externalId: 'w3', receivedAt: diasAtras(200) } })
    const velhoIntentVivo = await db.webhookEvent.create({ data: { ...base, externalId: 'w4', receivedAt: diasAtras(200), processedAt: diasAtras(199), paymentIntentId: intentVivo.id } })
    const lote = await db.webhookEvent.createMany({ data: Array.from({ length: 2300 }, (_, i) => ({ ...base, externalId: `lote-${i}`, receivedAt: diasAtras(300), processedAt: diasAtras(299) })) })
    expect(lote.count).toBe(2300)

    const ids = [velhoProc.id, recente.id, velhoNaoProc.id, velhoIntentVivo.id]
    const existem = async () => (await db.webhookEvent.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((x) => x.id)

    // dry-run: nada muda
    await ret.aplicarRetencao(db, { ...CFG, dryRun: true })
    expect((await existem()).length).toBe(4)
    expect(await db.webhookEvent.count({ where: { externalId: { startsWith: 'lote-' } } })).toBe(2300)

    const warn = vi.spyOn(logger, 'warn')
    const rel = await ret.aplicarRetencao(db, CFG)
    expect(rel.acoes.find((a) => a.acao === 'webhook_deleted')!.linhas).toBeGreaterThanOrEqual(2301) // 2300 do lote (3 lotes de 1000) + o velho processado
    expect((await existem()).sort()).toEqual([recente.id, velhoNaoProc.id, velhoIntentVivo.id].sort())
    expect(await db.webhookEvent.count({ where: { externalId: { startsWith: 'lote-' } } })).toBe(0)
    expect(alertasEmitidos(warn, 'retention_webhook_unprocessed_kept').length).toBe(1)
  }, 120_000)
})

describe('N-11 — orquestração', () => {
  it('uma rodada completa (retenção desligada) garante o horizonte configurado e não purga nada', async () => {
    await recriarParticoes(20, 1)
    const velha = await inserirAmostra(tenant.chargePointId, meioDoMes(-19))
    const rel = await manut.executarManutencaoParticoes(db, { mesesAFrente: 6, retencao: { ...CFG, habilitada: false } })
    expect(rel.particoes.every((p) => p.horizonteAte!.getTime() >= mesesDe(new Date(), 6).getTime())).toBe(true)
    expect(rel.retencao.acoes).toEqual([])
    expect(await ondeEstaLinha('MeterSample', velha)).not.toBeNull()
  })
})
