import { describe, expect, it } from 'vitest'
import { escaparHtml, layoutEmail } from '../../src/core/comunicacao/layoutEmail'
import { emailDeAvisoGoogle, emailDeRedefinicao, emailDeSenhaAlterada, formatarQuando } from '../../src/core/auth/emailsDeSenha'

/** L1.3 — moldura de e-mail da marca (reaproveitável pelo L1.6) e os 3 e-mails de senha. */

describe('layoutEmail', () => {
  it('escapa HTML em TODO texto de entrada (nada vira marcação)', () => {
    const ataque = '<script>alert(1)</script> & "aspas" \'simples\''
    const { html } = layoutEmail({ titulo: ataque, preheader: ataque, paragrafos: [ataque], aviso: ataque, rodape: ataque, cta: { rotulo: ataque, url: 'https://x.com/a?b=1&c="2"' } })
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('&amp;')
    expect(html).toContain('&quot;')
    // a URL do botão também sai escapada no atributo
    expect(html).not.toMatch(/href="[^"]*"[^>]*"2"/)
  })

  it('CTA só aceita http/https (javascript:/data: viram erro, não link)', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'não é url', '']) {
      expect(() => layoutEmail({ titulo: 't', paragrafos: [], cta: { rotulo: 'x', url } })).toThrow()
    }
    expect(() => layoutEmail({ titulo: 't', paragrafos: [], cta: { rotulo: 'x', url: 'https://ok.com' } })).not.toThrow()
  })

  it('sempre devolve HTML E texto puro, com a marca InnoFlow e o link por extenso', () => {
    const { html, text } = layoutEmail({ titulo: 'Olá', paragrafos: ['p1', 'p2'], cta: { rotulo: 'Clique', url: 'https://app.x.com/y#t=abc' }, aviso: 'cuidado' })
    expect(html).toContain('Inno')
    expect(html).toContain('lang="pt-BR"')
    expect(html).toContain('href="https://app.x.com/y#t=abc"')
    expect(text).toContain('InnoFlow')
    expect(text).toContain('Clique:')
    expect(text).toContain('https://app.x.com/y#t=abc')
    expect(text).toContain('cuidado')
    expect(text).not.toMatch(/<[a-z]+/i)
  })

  it('sem nada externo: sem imagem remota, script, iframe ou CSS remoto (nem pixel de rastreio)', () => {
    const { html } = layoutEmail({ titulo: 'T', paragrafos: ['p'], cta: { rotulo: 'ir', url: 'https://x.com' } })
    expect(html).not.toMatch(/<img|<script|<iframe|<link|@import|url\(/i)
  })

  it('quebra de linha no parágrafo vira <br> (e continua escapado)', () => {
    expect(layoutEmail({ titulo: 'T', paragrafos: ['a\nb<'] }).html).toContain('a<br>b&lt;')
  })

  it('escaparHtml cobre os 5 caracteres', () => {
    expect(escaparHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;')
  })
})

describe('e-mails de senha (PT-BR, conteúdo seguro)', () => {
  const link = 'https://app.innoflow.com.br/redefinir-senha#t=TOKEN_FAKE_43_CHARS_xxxxxxxxxxxxxxxxxxxxxxx'

  it('redefinição: link só no corpo, validade, "se não foi você, ignore", assunto fixo', () => {
    const e = emailDeRedefinicao({ nome: 'Maria da Silva', link, validadeMinutos: 30 })
    expect(e.subject).toBe('Redefinição de senha — InnoFlow')
    expect(e.text).toContain(link)
    expect(e.html).toContain(link)
    expect(e.text).toContain('Olá, Maria.')
    expect(e.text).toContain('30 minutos')
    expect(e.text).toMatch(/ignorar este e-mail/)
    expect(e.text).toContain('Nunca compartilhe')
    expect(e.subject).not.toContain('TOKEN')
  })

  it('o nome nunca vira HTML nem cabeçalho (só corpo, escapado)', () => {
    const e = emailDeRedefinicao({ nome: '<b>Hack</b>\r\nBcc: x@y.com', link, validadeMinutos: 30 })
    expect(e.html).not.toContain('<b>Hack')
    expect(e.subject).not.toMatch(/Hack|Bcc/)
    // só o PRIMEIRO "nome" entra na saudação (sem a quebra de linha da injeção de cabeçalho)
    expect(e.text).not.toContain('Bcc: x@y.com')
  })

  it('sem nome utilizável: saudação neutra', () => {
    expect(emailDeRedefinicao({ nome: '   ', link, validadeMinutos: 30 }).text).toContain('Olá.')
  })

  it('aviso Google: sem link de redefinição e sem token', () => {
    const e = emailDeAvisoGoogle({ nome: 'Ana' })
    expect(e.subject).toBe('Sua conta InnoFlow entra com o Google')
    expect(e.text).not.toContain('redefinir-senha')
    expect(e.html).not.toContain('redefinir-senha')
    expect(e.text).toMatch(/Entrar com o Google/)
  })

  it('senha alterada: data em PT-BR, sem IP, com link "não fui eu" só se há origem pública', () => {
    const quando = formatarQuando(new Date('2026-10-05T15:30:00Z'))
    expect(quando).toBe('05/10/2026 às 12:30')
    const com = emailDeSenhaAlterada({ nome: 'Ana', quando, linkEsqueciSenha: 'https://app.x.com/esqueci-senha' })
    expect(com.text).toContain('05/10/2026 às 12:30')
    expect(com.text).toContain('https://app.x.com/esqueci-senha')
    expect(com.text).toMatch(/desconectado de todos os aparelhos/)
    const sem = emailDeSenhaAlterada({ nome: 'Ana', quando, linkEsqueciSenha: null })
    expect(sem.text).not.toContain('esqueci-senha')
  })
})
