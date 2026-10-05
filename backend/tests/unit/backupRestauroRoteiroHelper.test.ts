import { describe, expect, it } from 'vitest'
import { removerSetTransactionTimeout } from '../integration/helpers/backupAmbiente'

// O filtro que o teste de ciclo completo do backup aplica ao roteiro do pg_restore (espelha o `sed` do restore-db.sh). Se ele sumir ou errar, o job `backend` da CI
// (cliente 18 x servidor 16) fica vermelho com `unrecognized configuration parameter "transaction_timeout"`.
describe('removerSetTransactionTimeout (roteiro do pg_restore)', () => {
  it('remove só a linha exata, em LF', () => {
    const entrada = 'SET statement_timeout = 0;\nSET transaction_timeout = 0;\nSET lock_timeout = 0;\n'
    expect(removerSetTransactionTimeout(entrada)).toBe('SET statement_timeout = 0;\nSET lock_timeout = 0;\n')
  })

  it('remove também com CRLF (pg_restore no Windows) e preserva o resto', () => {
    const entrada = 'SET statement_timeout = 0;\r\nSET transaction_timeout = 0;\r\nSET lock_timeout = 0;\r\n'
    expect(removerSetTransactionTimeout(entrada)).toBe('SET statement_timeout = 0;\r\nSET lock_timeout = 0;\r\n')
  })

  it('não toca em outra coisa parecida (dado de tabela, comentário, outro valor)', () => {
    const entrada = '-- SET transaction_timeout = 0;\nSET transaction_timeout = 5000;\nCOPY t FROM stdin;\nSET transaction_timeout = 0; x\n'
    expect(removerSetTransactionTimeout(entrada)).toBe(entrada)
  })
})
