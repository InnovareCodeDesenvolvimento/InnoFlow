import { describe, expect, it } from 'vitest'
import { clampDiffSize, diffEntity } from '../../src/core/auditoria/diffEntity'

describe('diffEntity', () => {
  it('CREATE (before=null): diff só com `to`, restrito à allowlist', () => {
    const diff = diffEntity(null, { name: 'Site Novo', city: 'SP', secretInternal: 'x' }, ['name', 'city'])
    expect(diff).toEqual({ name: { to: 'Site Novo' }, city: { to: 'SP' } })
  })

  it('DELETE (after=null): diff só com `from`', () => {
    const diff = diffEntity({ name: 'Site Antigo', active: true }, null, ['name', 'active'])
    expect(diff).toEqual({ name: { from: 'Site Antigo' }, active: { from: true } })
  })

  it('UPDATE: só reporta campos que de fato mudaram', () => {
    const diff = diffEntity({ name: 'A', city: 'SP', state: 'SP' }, { name: 'B', city: 'SP', state: 'SP' }, ['name', 'city', 'state'])
    expect(diff).toEqual({ name: { from: 'A', to: 'B' } })
  })

  it('retorna null quando nada na allowlist mudou', () => {
    const diff = diffEntity({ name: 'A' }, { name: 'A' }, ['name'])
    expect(diff).toBeNull()
  })

  it('campo fora da allowlist nunca aparece, mesmo que tenha mudado', () => {
    const diff = diffEntity({ name: 'A', basicAuthSecretHash: 'hash1' }, { name: 'A', basicAuthSecretHash: 'hash2' }, ['name'])
    expect(diff).toBeNull()
  })

  it('campo secreto (password/secret/token/*Hash) vira { changed: true }, nunca o valor — mesmo se alguém colocar na allowlist por engano', () => {
    const diff = diffEntity({ basicAuthSecretHash: 'hash1', apiToken: 'tok1' }, { basicAuthSecretHash: 'hash2', apiToken: 'tok2' }, [
      'basicAuthSecretHash',
      'apiToken',
    ])
    expect(diff).toEqual({ basicAuthSecretHash: { changed: true }, apiToken: { changed: true } })
  })

  it('idTag é mascarado (só os últimos 4 caracteres visíveis), nunca redigido totalmente', () => {
    const diff = diffEntity({ idTag: 'RFID-0000000001' }, { idTag: 'RFID-0000000002' }, ['idTag'])
    expect(diff).toEqual({ idTag: { from: expect.stringMatching(/\*+0001$/), to: expect.stringMatching(/\*+0002$/) } })
  })

  it('não confunde undefined com valor real (campo ausente nos dois lados não entra no diff)', () => {
    const diff = diffEntity({ name: 'A' }, { name: 'A' }, ['name', 'unrelatedField'])
    expect(diff).toBeNull()
  })

  it('clampDiffSize: diff pequeno passa intacto', () => {
    const diff = { name: { from: 'A', to: 'B' } }
    expect(clampDiffSize(diff, 8192)).toEqual(diff)
  })

  it('clampDiffSize: diff maior que o teto vira { truncated: true }', () => {
    const bigValue = 'x'.repeat(9000)
    const diff = { description: { from: '', to: bigValue } }
    expect(clampDiffSize(diff, 8192)).toEqual({ truncated: true })
  })

  it('clampDiffSize: null passa direto', () => {
    expect(clampDiffSize(null, 8192)).toBeNull()
  })
})
