/**
 * O callback do "Conectar com Google" do backup carrega `code` e `state` na QUERY; o `pino-http` loga `req.url` de toda requisição, então a query é mascarada
 * (`mascararUrlComSegredo`). O caminho fica (é diagnóstico); só a query some.
 */
import { describe, expect, it } from 'vitest'
import { mascararUrlComSegredo, serializarReq } from '../../src/lib/logSerializers'

describe('máscara da query do callback do Google (backup)', () => {
  it('apaga code/state/error da query e mantém o caminho', () => {
    const url = '/api/backup/google/callback?state=eyJhZG1pbklkIjoieCJ9.assinatura&code=4%2F0AfJohXn-codigo-secreto&scope=drive.file'
    const m = mascararUrlComSegredo(url)
    expect(m).toBe('/api/backup/google/callback?***')
    expect(m).not.toContain('codigo-secreto')
    expect(m).not.toContain('assinatura')
  })
  it('sem query: devolve como veio; outras rotas não são tocadas; o webhook da Cielo continua mascarado', () => {
    expect(mascararUrlComSegredo('/api/backup/google/callback')).toBe('/api/backup/google/callback')
    expect(mascararUrlComSegredo('/api/admin/backup/runs?page=2')).toBe('/api/admin/backup/runs?page=2')
    expect(mascararUrlComSegredo('/api/webhooks/cielo/TOKEN-SECRETO')).toBe('/api/webhooks/cielo/***')
  })
  it('o serializador do req usa a máscara (é o que o pino-http chama)', () => {
    const r = serializarReq({ url: '/api/backup/google/callback?code=abc&state=def', headers: { host: 'x' } }) as { url: string }
    expect(r.url).toBe('/api/backup/google/callback?***')
  })
})
