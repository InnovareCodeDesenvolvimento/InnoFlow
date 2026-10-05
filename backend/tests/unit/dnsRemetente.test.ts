import { describe, expect, it } from 'vitest'
import {
  avaliarDkim,
  avaliarDmarc,
  avaliarSpf,
  dkimSemSeletor,
  dominioDoRemetente,
  dominioOrganizacional,
  dominioPublicoValido,
  ehDominioDeEmailGratuito,
  provedorSmtpConhecido,
  seletorDkimValido,
  statusGeral,
  truncarValor,
} from '../../src/core/comunicacao/dnsRemetente'

describe('domínio e seletor: nunca de input livre', () => {
  it('só domínio público de verdade: recusa IP, localhost, sufixo interno/reservado, rótulo inválido', () => {
    for (const bom of ['empresa.com.br', 'mail.empresa.com.br', 'xn--exemplo-9ua.com']) expect(dominioPublicoValido(bom), bom).toBe(true)
    for (const ruim of ['localhost', '127.0.0.1', '10.0.0.5', '::1', 'db.internal', 'servidor.local', 'a.test', 'x.invalid', 'exemplo.example', '-ruim.com', 'ruim-.com', 'a..com', 'com', '', `${'a'.repeat(64)}.com`, 'empresa.com.br/../x', 'empresa.com br']) {
      expect(dominioPublicoValido(ruim), ruim).toBe(false)
    }
  })

  it('o domínio é a parte depois do ÚLTIMO @, em minúsculas; sem @ ou com domínio inválido = null', () => {
    expect(dominioDoRemetente('Aviso@Empresa.COM.br')).toBe('empresa.com.br')
    expect(dominioDoRemetente('a@b@empresa.com.br')).toBe('empresa.com.br')
    expect(dominioDoRemetente('sem-arroba')).toBeNull()
    expect(dominioDoRemetente('@empresa.com.br')).toBeNull()
    expect(dominioDoRemetente('x@localhost')).toBeNull()
    expect(dominioDoRemetente('x@10.0.0.1')).toBeNull()
    expect(dominioDoRemetente(null)).toBeNull()
  })

  it('seletor: letras, dígitos e hífen, 1 a 63, sem hífen nas pontas e sem ponto', () => {
    for (const bom of ['google', 'selector1', 's1-v2', 'a', 'a'.repeat(63)]) expect(seletorDkimValido(bom), bom).toBe(true)
    for (const ruim of ['', '-a', 'a-', 'a.b', 'a b', 'a_b', 'a'.repeat(64), 'a/b', '../x', 'x;y']) expect(seletorDkimValido(ruim), ruim).toBe(false)
  })

  it('domínio organizacional entende .com.br e e-mail gratuito é reconhecido', () => {
    expect(dominioOrganizacional('mail.empresa.com.br')).toBe('empresa.com.br')
    expect(dominioOrganizacional('empresa.com.br')).toBe('empresa.com.br')
    expect(dominioOrganizacional('a.b.empresa.com')).toBe('empresa.com')
    expect(ehDominioDeEmailGratuito('Gmail.com')).toBe(true)
    expect(ehDominioDeEmailGratuito('empresa.com.br')).toBe(false)
  })

  it('provedor SMTP conhecido pelo host (e desconhecido = null)', () => {
    expect(provedorSmtpConhecido('smtp.gmail.com')?.nome).toContain('Google')
    expect(provedorSmtpConhecido('smtp.office365.com')?.nome).toContain('Microsoft')
    expect(provedorSmtpConhecido('email-smtp.us-east-1.amazonaws.com')?.nome).toContain('Amazon')
    expect(provedorSmtpConhecido('smtp.meuprovedor.com.br')).toBeNull()
    expect(provedorSmtpConhecido(null)).toBeNull()
  })
})

describe('SPF', () => {
  const D = 'empresa.com.br'
  it('ausente: AUSENTE, e NÃO inventa o valor (manda pedir ao provedor)', () => {
    const r = avaliarSpf(D, ['google-site-verification=abc'], null)
    expect(r.status).toBe('AUSENTE')
    expect(r.valorEncontrado).toBeNull()
    expect(r.recomendacao).toMatch(/provedor/i)
    expect(r.recomendacao).not.toMatch(/v=spf1/)
  })

  it('termina em -all: OK; ~all: OK com nota; ?all e +all e sem regra final: ATENCAO', () => {
    expect(avaliarSpf(D, ['v=spf1 include:_spf.exemplo.com -all'], null).status).toBe('OK')
    const til = avaliarSpf(D, ['v=spf1 include:_spf.exemplo.com ~all'], null)
    expect(til.status).toBe('OK')
    expect(til.recomendacao).toContain('~all')
    expect(avaliarSpf(D, ['v=spf1 include:x.com ?all'], null).status).toBe('ATENCAO')
    const mais = avaliarSpf(D, ['v=spf1 +all'], null)
    expect(mais.status).toBe('ATENCAO')
    expect(mais.recomendacao).toMatch(/QUALQUER/)
    expect(avaliarSpf(D, ['v=spf1 include:x.com'], null).status).toBe('ATENCAO')
  })

  it('redirect= conta como regra final (OK); dois registros SPF = ATENCAO (o SPF inteiro é ignorado)', () => {
    expect(avaliarSpf(D, ['v=spf1 redirect=_spf.exemplo.com'], null).status).toBe('OK')
    const dois = avaliarSpf(D, ['v=spf1 -all', 'v=spf1 include:x.com ~all'], null)
    expect(dois.status).toBe('ATENCAO')
    expect(dois.recomendacao).toMatch(/mais de um/)
  })

  it('provedor conhecido sem o include dele: ATENCAO; com o include: OK; v=SPF1 em maiúsculas é reconhecido', () => {
    const google = provedorSmtpConhecido('smtp.gmail.com')
    expect(avaliarSpf(D, ['v=spf1 include:outro.com -all'], google).status).toBe('ATENCAO')
    expect(avaliarSpf(D, ['V=SPF1 include:_spf.google.com -all'], google).status).toBe('OK')
    expect(avaliarSpf(D, ['v=spf1 include:outro.com -all'], null).status).toBe('OK') // provedor desconhecido: não dá para exigir
  })

  it('o valor encontrado é truncado', () => {
    const longo = `v=spf1 ${'ip4:203.0.113.1 '.repeat(60)}-all`
    const r = avaliarSpf(D, [longo], null)
    expect(r.valorEncontrado!.length).toBeLessThanOrEqual(301)
    expect(r.valorEncontrado!.endsWith('…')).toBe(true)
  })
})

describe('DMARC', () => {
  const nome = '_dmarc.empresa.com.br'
  it('ausente: AUSENTE com exemplo SEGURO (p=none) e a caixa de relatório', () => {
    const r = avaliarDmarc(nome, [], null, 'suporte@empresa.com.br')
    expect(r.status).toBe('AUSENTE')
    expect(r.recomendacao).toContain('v=DMARC1; p=none; rua=mailto:suporte@empresa.com.br')
    expect(r.recomendacao).toContain(nome)
  })

  it('p=reject e p=quarantine: OK; p=none: ATENCAO (só monitora); sem p=: ATENCAO; dois registros: ATENCAO', () => {
    expect(avaliarDmarc(nome, ['v=DMARC1; p=reject; rua=mailto:a@b.com'], null, 'x').status).toBe('OK')
    expect(avaliarDmarc(nome, ['v=DMARC1; p=quarantine'], null, 'x').status).toBe('OK')
    const none = avaliarDmarc(nome, ['v=DMARC1; p=none'], null, 'x')
    expect(none.status).toBe('ATENCAO')
    expect(none.recomendacao).toMatch(/monitora/)
    expect(avaliarDmarc(nome, ['v=DMARC1; rua=mailto:a@b.com'], null, 'x').status).toBe('ATENCAO')
    expect(avaliarDmarc(nome, ['v=DMARC1; p=none', 'v=DMARC1; p=reject'], null, 'x').status).toBe('ATENCAO')
  })

  it('herdado do domínio principal: diz de onde veio', () => {
    const r = avaliarDmarc('_dmarc.empresa.com.br', ['v=DMARC1; p=reject'], 'empresa.com.br', 'x')
    expect(r.status).toBe('OK')
    expect(r.recomendacao).toContain('herdado do domínio principal empresa.com.br')
  })
})

describe('DKIM', () => {
  it('sem seletor: ATENCAO, não consultado, explica o que é o seletor', () => {
    const r = dkimSemSeletor('empresa.com.br')
    expect(r.status).toBe('ATENCAO')
    expect(r.nomeConsultado).toBeNull()
    expect(r.recomendacao).toMatch(/seletor/)
  })

  it('ausente: AUSENTE; com chave pública: OK; chave vazia (revogada) e registro sem p=: ATENCAO', () => {
    const nome = 'google._domainkey.empresa.com.br'
    expect(avaliarDkim(nome, 'google', []).status).toBe('AUSENTE')
    expect(avaliarDkim(nome, 'google', ['v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC']).status).toBe('OK')
    expect(avaliarDkim(nome, 'google', ['v=DKIM1; p=']).status).toBe('ATENCAO')
    expect(avaliarDkim(nome, 'google', ['alguma coisa qualquer']).status).toBe('ATENCAO')
  })
})

describe('resumo e limpeza', () => {
  const r = (status: 'OK' | 'ATENCAO' | 'AUSENTE' | 'ERRO') => ({ status, nomeConsultado: null, valorEncontrado: null, recomendacao: '' })
  it('ERRO > AUSENTE > ATENCAO > OK', () => {
    expect(statusGeral([r('OK'), r('OK')])).toBe('OK')
    expect(statusGeral([r('OK'), r('ATENCAO')])).toBe('ATENCAO')
    expect(statusGeral([r('ATENCAO'), r('AUSENTE')])).toBe('AUSENTE')
    expect(statusGeral([r('AUSENTE'), r('ERRO')])).toBe('ERRO')
  })

  it('truncarValor remove caracteres de controle e corta com reticências', () => {
    expect(truncarValor('a\r\nb\u0000c')).toBe('a b c')
    expect(truncarValor('x'.repeat(500))).toHaveLength(301)
  })
})
