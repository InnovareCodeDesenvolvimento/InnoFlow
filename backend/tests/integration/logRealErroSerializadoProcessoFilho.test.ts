import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * Íris (02/10/2026) — a SAÍDA do logger real do servidor (processo filho, `NODE_ENV=production`, `LOG_LEVEL=info`, transport `pino-pretty`) para `err`
 * que carregam segredos, depois da F5.7 B5/B6/B3. `tests/unit/logSerializers.test.ts` prova a mesma coisa com um `pino` montado à mão; aqui é a instância
 * REAL de `src/lib/logger.ts`. Cada segredo é um valor ÚNICO (`SEG-...`) procurado no stdout/stderr INTEIRO; o CONTROLE POSITIVO prova que o log saiu.
 */

let saida = ''

beforeAll(() => {
  const r = spawnSync(process.execPath, [join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'tests/integration/helpers/logFilhoErros.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'production', LOG_LEVEL: 'info' },
    encoding: 'utf8',
    timeout: 90_000,
  })
  saida = `${r.stdout ?? ''}${r.stderr ?? ''}`
}, 120_000)

describe('logger real: o `err` com segredo em profundidade não vaza', () => {
  it('CONTROLE: o processo filho logou (campo não sensível visível e a linha final presente)', () => {
    expect(saida).toContain('CONTROLE-VISIVEL-NO-LOG')
    expect(saida).toContain('FIM-DOS-LOGS-DO-FILHO')
  })

  it('Authorization/MerchantKey em `err.config.headers` e CardNumber/Holder em `err.response.data` saem como [redacted]', () => {
    for (const v of ['SEG-AUTH-HEADER', 'SEG-MERCHANTKEY-HEADER', 'SEG-PAN-4111', 'SEG HOLDER']) expect(saida).not.toContain(v)
    expect(saida).toContain('Request failed with status code 500') // a mensagem útil continua
  })

  it('segredo em `Error.cause` (como Error, como objeto e mais fundo) e em AggregateError não vaza', () => {
    for (const v of ['SEG-MK-CAUSA-ERRO', 'SEG-AUTH-CAUSA', 'SEG-MK-CAUSA-OBJETO', 'SEG-PAN-FUNDO', 'SEG-MK-AGREGADO']) expect(saida).not.toContain(v)
  })

  it('o corpo do `CieloHttpError` (não enumerável) não vaza', () => {
    expect(saida).not.toContain('SEG-PAN-CIELOHTTPERROR')
    expect(saida).toContain('Cielo respondeu HTTP 400')
  })

  // ACHADO (baixo): a varredura em profundidade monta o conjunto de nomes sensíveis a partir de `REDACT_PATHS`, e `nomeDoCampo` (logSerializers.ts)
  // só tira os colchetes quando o path COMEÇA com `["`. Os dois paths escritos com colchetes (`res.headers["set-cookie"]` e
  // `req.headers["x-innoelektron-webhook-secret"]`) viram os nomes `headers["set-cookie` e `headers["x-innoelektron-webhook-secret` e NUNCA casam:
  // dentro de um `err` (ex.: `err.response.headers`) o cookie e o segredo do webhook saem EM CLARO. (O `redact` do pino ainda os cobre em `req`/`res` de topo.)
  // CORREÇÃO: no `nomeDoCampo`, extrair o nome com `/\["?([^"\]]+)"?\]$/` (ou escrever o path da lista sem colchetes). `it.fails`: ao corrigir, vira `it`.
  it.fails('(BUG) `set-cookie` e o header do segredo do webhook dentro de um `err` também saem redigidos', () => {
    for (const v of ['SEG-SET-COOKIE', 'SEG-WEBHOOK-HEADER']) expect(saida).not.toContain(v)
  })

  // ACHADO (baixo): o erro de VALIDAÇÃO do Prisma monta a mensagem com os VALORES dos argumentos (`merchantKeyCiphertext: "..."`) — o texto, não um
  // campo: o `limparTextoSensivel` só conhece o padrão `Failing row contains (`. Sai a ciphertext COMPLETA (não truncada) em `message` e `stack`.
  // Só acontece por erro de programação (tipo errado em algum campo do mesmo `data`), nunca por entrada de usuário — por isso baixo. CORREÇÃO: no
  // `limparTextoSensivel`, trocar o valor das chaves `*Ciphertext`/`*Token` no texto, ou não logar `message` de `PrismaClientValidationError`.
  it.fails('(BUG baixo) o erro de validação do Prisma não ecoa no log o valor de um campo `*Ciphertext` do `data`', () => {
    expect(saida).not.toContain('SEG-CIPHERTEXT-NO-ARGUMENTO')
  })
})
