import { describe, expect, it } from 'vitest'
import { LINHA_REJEITADA_OMITIDA, limparTextoSensivel, serializarErro } from '../../src/lib/logSerializers'

/**
 * F5.9 (9b2) — a limpeza do `DETAIL` de violação de constraint NÃO depende do idioma do Postgres. As mensagens abaixo são REAIS, capturadas do
 * Prisma 5 contra um PG 18 com `lc_messages` em inglês e em português (Portuguese_Brazil.1252): o texto do detalhe muda ("Failing row contains"
 * / "Registro que falhou contém"), o rótulo do Prisma em volta (`DETAIL:` no erro bruto, `detail: Some("...")` no erro do client) não.
 */
const LINHA = 'cmusge9zz000tpbs8vsu0swuw, 1, cmusge9kj0000pbs87nbquctu, STOPPED, 500, v1:SEGREDO-CIPHERTEXT-TRUNCADO-64-CARACTERES==, null, -1, CHARGER'

const BRUTO_EN = `Raw query failed. Code: \`23514\`. Message: \`ERROR: new row for relation "ChargingSession" violates check constraint "charging_session_f59_amounts_non_negative"\nDETAIL: Failing row contains (${LINHA}).\``
const BRUTO_PT = `Raw query failed. Code: \`23514\`. Message: \`ERRO: a nova linha da relação "ChargingSession" viola a restrição de verificação "charging_session_f59_amounts_non_negative"\nDETAIL: Registro que falhou contém (${LINHA}).\``
const CLIENT_PT = `Error occurred during query execution:\nConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "23514", message: "a nova linha da relação \\"ChargingSession\\" viola a restrição de verificação \\"charging_session_f59_amounts_non_negative\\"", severity: "ERRO", detail: Some("Registro que falhou contém (${LINHA})."), column: None, hint: None }) })`
const CLIENT_EN = CLIENT_PT.replace('Registro que falhou contém', 'Failing row contains').replace('a nova linha da relação', 'new row for relation')
const UNICA_PT = 'ERRO: duplicar valor da chave viola a restrição de unicidade "User_email_key"\nDETAIL: Chave (email)=(maria.silva@example.com) já existe.'

describe('limparTextoSensivel — DETAIL de violação de constraint em QUALQUER idioma', () => {
  it.each([
    ['erro bruto (P2010), inglês', BRUTO_EN],
    ['erro bruto (P2010), português', BRUTO_PT],
    ['erro do client (update/create), português', CLIENT_PT],
    ['erro do client (update/create), inglês', CLIENT_EN],
  ])('%s: a linha rejeitada (com o ciphertext) não sobra, o marcador entra e o resto continua diagnosticável', (_nome, mensagem) => {
    const limpo = limparTextoSensivel(mensagem)
    expect(limpo).not.toContain('SEGREDO-CIPHERTEXT')
    expect(limpo).not.toContain('cmusge9zz000tpbs8vsu0swuw')
    expect(limpo).not.toMatch(/Failing row|Registro que falhou/)
    expect(limpo).toContain(LINHA_REJEITADA_OMITIDA)
    expect(limpo).toContain('charging_session_f59_amounts_non_negative') // qual constraint continua no log
  })

  it('chave duplicada (UNIQUE) em português também some: o DETAIL carregava o e-mail do usuário', () => {
    const limpo = limparTextoSensivel(UNICA_PT)
    expect(limpo).not.toContain('maria.silva@example.com')
    expect(limpo).toContain('User_email_key')
  })

  it('é idempotente (passar duas vezes não muda nada) e não toca em texto sem DETAIL', () => {
    const uma = limparTextoSensivel(BRUTO_PT)
    expect(limparTextoSensivel(uma)).toBe(uma)
    expect(limparTextoSensivel('conexão recusada em 127.0.0.1:5432')).toBe('conexão recusada em 127.0.0.1:5432')
  })
})

describe('serializarErro — o `err` inteiro (message, stack e meta) sai limpo com o Postgres em português', () => {
  it('erro de Prisma com meta.message e message em português: nada da linha em lugar nenhum do objeto serializado', () => {
    const err = Object.assign(new Error(BRUTO_PT), { name: 'PrismaClientKnownRequestError', code: 'P2010', meta: { code: '23514', message: `ERRO: a nova linha ...\nDETAIL: Registro que falhou contém (${LINHA}).` } })
    const json = JSON.stringify(serializarErro(err))
    expect(json).not.toContain('SEGREDO-CIPHERTEXT')
    expect(json).not.toContain('Registro que falhou')
    expect(json).toContain(LINHA_REJEITADA_OMITIDA)
  })
})
