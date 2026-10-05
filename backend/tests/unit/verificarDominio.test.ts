import { describe, expect, it } from 'vitest'
import { verificarDominioRemetente, type ResolvedorTxt } from '../../src/services/comunicacao/verificarDominio'

/** Resolvedor FALSO (sem rede): um mapa nome -> registros TXT; nome fora do mapa = ENODATA; valor `Error` = falha do DNS. Guarda os nomes consultados. */
function dnsFalso(mapa: Record<string, string[] | Error>): { resolver: ResolvedorTxt; consultados: string[] } {
  const consultados: string[] = []
  const resolver: ResolvedorTxt = async (nome) => {
    consultados.push(nome)
    const v = mapa[nome]
    if (v === undefined) throw Object.assign(new Error(`queryTxt ENODATA ${nome}`), { code: 'ENODATA' })
    if (v instanceof Error) throw v
    return v.map((t) => [t]) // um pedaço por registro
  }
  return { resolver, consultados }
}

const base = { suporteEmail: null, seletor: null, agora: () => new Date('2026-10-06T12:00:00Z') }

describe('verificarDominioRemetente (resolvedor injetado, sem rede)', () => {
  it('sem remetente configurado: nada é consultado e a resposta explica o que fazer', async () => {
    const { resolver, consultados } = dnsFalso({})
    const r = await verificarDominioRemetente({ ...base, remetente: null, smtpHost: null, resolverTxt: resolver })
    expect(r).toMatchObject({ senderConfigured: false, domain: null, overallStatus: null, spf: null, dkim: null, dmarc: null, instructions: null })
    expect(r.warnings[0]).toMatch(/remetente/)
    expect(consultados).toEqual([])
  })

  it('remetente com domínio NÃO público (IP, localhost, .internal): não consulta DNS nenhum', async () => {
    for (const remetente of ['a@127.0.0.1', 'a@localhost', 'a@servidor.internal', 'a@10.0.0.9']) {
      const { resolver, consultados } = dnsFalso({})
      const r = await verificarDominioRemetente({ ...base, remetente, smtpHost: null, resolverTxt: resolver })
      expect(r.senderConfigured, remetente).toBe(false)
      expect(consultados, remetente).toEqual([])
    }
  })

  it('tudo certo: SPF -all com o provedor, DMARC reject, DKIM com chave => OK geral; consulta só nomes do domínio do remetente', async () => {
    const { resolver, consultados } = dnsFalso({
      'empresa.com.br': ['v=spf1 include:_spf.google.com -all', 'google-site-verification=xyz'],
      '_dmarc.empresa.com.br': ['v=DMARC1; p=reject; rua=mailto:dmarc@empresa.com.br'],
      'google._domainkey.empresa.com.br': ['v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A'],
    })
    const r = await verificarDominioRemetente({ ...base, remetente: 'Aviso@Empresa.com.br', smtpHost: 'smtp.gmail.com', seletor: 'google', resolverTxt: resolver })
    expect(r.domain).toBe('empresa.com.br')
    expect(r.smtpProvider).toContain('Google')
    expect(r.overallStatus).toBe('OK')
    expect(r.spf?.status).toBe('OK')
    expect(r.dmarc?.status).toBe('OK')
    expect(r.dkim).toMatchObject({ status: 'OK', nomeConsultado: 'google._domainkey.empresa.com.br' })
    expect(r.checkedAt).toBe('2026-10-06T12:00:00.000Z')
    expect([...consultados].sort()).toEqual(['_dmarc.empresa.com.br', 'empresa.com.br', 'google._domainkey.empresa.com.br'])
  })

  it('nada cadastrado: SPF e DMARC AUSENTE, DKIM pede o seletor; geral AUSENTE; instruções: SPF/DKIM sem valor inventado, DMARC com exemplo seguro', async () => {
    const { resolver } = dnsFalso({})
    const r = await verificarDominioRemetente({ ...base, remetente: 'aviso@empresa.com.br', smtpHost: 'smtp.meuprovedor.com.br', resolverTxt: resolver })
    expect(r.spf?.status).toBe('AUSENTE')
    expect(r.dmarc?.status).toBe('AUSENTE')
    expect(r.dkim).toMatchObject({ status: 'ATENCAO', nomeConsultado: null })
    expect(r.overallStatus).toBe('AUSENTE')
    expect(r.smtpProvider).toBeNull()
    expect(r.instructions?.spf.valorSugerido).toBeNull()
    expect(r.instructions?.dkim.valorSugerido).toBeNull()
    expect(r.instructions?.dkim.nome).toBe('<seletor>._domainkey.empresa.com.br')
    expect(r.instructions?.dmarc).toMatchObject({ nome: '_dmarc.empresa.com.br', tipo: 'TXT', valorSugerido: 'v=DMARC1; p=none; rua=mailto:dmarc@empresa.com.br' })
    expect(r.warnings.join(' ')).toMatch(/provedor/)
  })

  it('DMARC rua: usa o e-mail de suporte só se for do MESMO domínio; senão uma caixa dmarc@ do domínio', async () => {
    const { resolver } = dnsFalso({})
    const mesmo = await verificarDominioRemetente({ ...base, remetente: 'aviso@empresa.com.br', smtpHost: null, suporteEmail: 'suporte@empresa.com.br', resolverTxt: resolver })
    expect(mesmo.instructions?.dmarc.valorSugerido).toBe('v=DMARC1; p=none; rua=mailto:suporte@empresa.com.br')
    const outro = await verificarDominioRemetente({ ...base, remetente: 'aviso@empresa.com.br', smtpHost: null, suporteEmail: 'suporte@gmail.com', resolverTxt: resolver })
    expect(outro.instructions?.dmarc.valorSugerido).toBe('v=DMARC1; p=none; rua=mailto:dmarc@empresa.com.br')
  })

  it('falha do DNS vira ERRO só naquele registro (os outros seguem) e a chamada NÃO lança; sem texto cru do erro', async () => {
    const { resolver } = dnsFalso({
      'empresa.com.br': Object.assign(new Error('queryTxt ESERVFAIL 10.1.2.3:53 segredo-interno'), { code: 'ESERVFAIL' }),
      '_dmarc.empresa.com.br': ['v=DMARC1; p=quarantine'],
    })
    const r = await verificarDominioRemetente({ ...base, remetente: 'a@empresa.com.br', smtpHost: null, resolverTxt: resolver })
    expect(r.spf?.status).toBe('ERRO')
    expect(r.dmarc?.status).toBe('OK')
    expect(r.overallStatus).toBe('ERRO')
    const json = JSON.stringify(r)
    expect(json).not.toContain('10.1.2.3')
    expect(json).not.toContain('segredo-interno')
    expect(json).not.toContain('ESERVFAIL')
  })

  it('timeout do resolvedor (nunca responde) vira ERRO no prazo, sem pendurar', async () => {
    const pendurado: ResolvedorTxt = () => new Promise(() => undefined)
    const t = Date.now()
    const r = await verificarDominioRemetente({ ...base, remetente: 'a@empresa.com.br', smtpHost: null, resolverTxt: pendurado })
    expect(Date.now() - t).toBeLessThan(8000)
    expect(r.spf?.status).toBe('ERRO')
    expect(r.spf?.recomendacao).toMatch(/não respondeu a tempo/)
  }, 15_000)

  it('subdomínio: DMARC herdado do domínio principal quando o próprio nome não tem', async () => {
    const { resolver, consultados } = dnsFalso({ '_dmarc.empresa.com.br': ['v=DMARC1; p=reject'], 'mail.empresa.com.br': ['v=spf1 -all'] })
    const r = await verificarDominioRemetente({ ...base, remetente: 'a@mail.empresa.com.br', smtpHost: null, resolverTxt: resolver })
    expect(r.dmarc).toMatchObject({ status: 'OK', nomeConsultado: '_dmarc.empresa.com.br' })
    expect(r.dmarc?.recomendacao).toContain('herdado do domínio principal empresa.com.br')
    expect(consultados).toContain('_dmarc.mail.empresa.com.br')
  })

  it('e-mail gratuito: avisa que SPF/DKIM/DMARC são do provedor (e ainda assim diagnostica)', async () => {
    const { resolver } = dnsFalso({ 'gmail.com': ['v=spf1 redirect=_spf.google.com'] })
    const r = await verificarDominioRemetente({ ...base, remetente: 'dono@gmail.com', smtpHost: 'smtp.gmail.com', resolverTxt: resolver })
    expect(r.warnings.join(' ')).toMatch(/gratuito/)
    expect(r.spf?.status).toBe('OK')
  })

  it('o valor encontrado é só o TXT público, truncado', async () => {
    const { resolver } = dnsFalso({ 'empresa.com.br': [`v=spf1 ${'ip4:203.0.113.1 '.repeat(80)}-all`] })
    const r = await verificarDominioRemetente({ ...base, remetente: 'a@empresa.com.br', smtpHost: null, resolverTxt: resolver })
    expect(r.spf?.valorEncontrado?.length).toBeLessThanOrEqual(301)
  })

  it('TXT em pedaços de 255 é juntado antes de avaliar (SPF/DKIM longos)', async () => {
    const resolver: ResolvedorTxt = async (nome) => (nome === 'empresa.com.br' ? [['v=spf1 include:_spf.exemplo.', 'com -all']] : (() => { throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }) })())
    const r = await verificarDominioRemetente({ ...base, remetente: 'a@empresa.com.br', smtpHost: null, resolverTxt: resolver })
    expect(r.spf).toMatchObject({ status: 'OK', valorEncontrado: 'v=spf1 include:_spf.exemplo.com -all' })
  })
})
