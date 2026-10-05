/**
 * L1.6 — conteúdo dos e-mails ao motorista: PT-BR, valores em reais, SEM dado sensível, SEM pixel de rastreio, rodapé com a empresa SÓ do que existe em `LEGAL_*` (nunca CNPJ
 * inventado) e o link "Gerenciar notificações" para `<PUBLIC_APP_URL>/app/perfil`. Funções puras: sem banco, sem SMTP.
 */
import { describe, expect, it } from 'vitest'
import {
  blocoDaEmpresa,
  emailContaExcluida,
  emailFalhaDeCobranca,
  emailRecargaDeSaldoCreditada,
  emailRecargaIniciadaPeloSuporte,
  emailSaldoBaixo,
  emailSenhaAlteradaDoMotorista,
  emailSessaoConcluida,
  emailSessaoEncerradaPeloServidor,
  formatarDuracao,
  formatarKwh,
  formatarReais,
  type ContextoDoEmail,
  type ResumoDeSessao,
} from '../../src/core/notificacoes/emails'

const EMPRESA_COMPLETA = { name: 'InnoFlow Mobilidade Ltda', cnpj: '12.345.678/0001-90', supportEmail: 'suporte@innoflow.com.br', supportPhone: '(11) 4000-1234', dpoEmail: null }
const SEM_EMPRESA = { name: null, cnpj: null, supportEmail: null, supportPhone: null, dpoEmail: null }
const BASE = 'https://app.innoflow.com.br'

const ctx = (extra: Partial<ContextoDoEmail> = {}): ContextoDoEmail => ({ nome: 'Maria Souza', baseUrl: BASE, empresa: EMPRESA_COMPLETA, ...extra })

const sessao: ResumoDeSessao = {
  sessionId: 'cmsess123',
  local: 'Posto Centro — CP-001',
  energiaWh: 12_345,
  inicio: new Date('2026-10-05T12:00:00Z'),
  fim: new Date('2026-10-05T13:05:00Z'),
  totalCents: 4210,
  pagamento: 'WALLET',
}

const todos = (c: ContextoDoEmail) => [
  emailSessaoConcluida(c, sessao),
  emailSessaoEncerradaPeloServidor(c, sessao),
  emailFalhaDeCobranca(c, { sessionId: 'cmsess123', local: sessao.local, valorCents: 1234 }),
  emailSaldoBaixo(c, { saldoCents: 1500, limiarCents: 2000 }),
  emailRecargaDeSaldoCreditada(c, { creditadoCents: 5000, quitouDividaCents: 1234, saldoCents: 3766 }),
  emailRecargaIniciadaPeloSuporte(c, { local: sessao.local, operador: 'Operador Centro', quando: new Date('2026-10-05T15:00:00Z') }),
  emailSenhaAlteradaDoMotorista(c, { quando: new Date('2026-10-05T15:00:00Z') }),
  emailContaExcluida(c),
]

describe('formatação em PT-BR', () => {
  it('reais com vírgula e milhar (sem espaço invisível), kWh e duração', () => {
    expect(formatarReais(4210)).toBe('R$ 42,10')
    expect(formatarReais(123_456)).toBe('R$ 1.234,56')
    expect(formatarReais(0)).toBe('R$ 0,00')
    expect(formatarReais(4210)).not.toContain(String.fromCharCode(160))
    expect(formatarKwh(12_345)).toBe('12,35 kWh')
    expect(formatarDuracao(sessao.inicio, sessao.fim!)).toBe('1 h 05 min')
    expect(formatarDuracao(sessao.inicio, new Date(sessao.inicio.getTime() + 40 * 60_000))).toBe('40 min')
  })
})

describe('conteúdo de cada e-mail', () => {
  it('recibo: local, energia, duração, total em reais, forma de pagamento e o link do RECIBO da sessão', () => {
    const e = emailSessaoConcluida(ctx(), sessao)
    expect(e.subject).toBe('Recarga concluída — R$ 42,10 — InnoFlow')
    for (const t of [e.text, e.html]) {
      expect(t).toContain('Posto Centro')
      expect(t).toContain('12,35 kWh')
      expect(t).toContain('1 h 05 min')
      expect(t).toContain('R$ 42,10')
      expect(t).toContain('saldo da carteira')
      expect(t).toContain(`${BASE}/app/sessoes/cmsess123`)
    }
    expect(emailSessaoConcluida(ctx(), { ...sessao, pagamento: 'CARD' }).text).toContain('Pago com: cartão')
  })

  it('encerrada pelo servidor: explica o porquê; custo zero diz que nada foi cobrado', () => {
    const e = emailSessaoEncerradaPeloServidor(ctx(), sessao)
    expect(e.text).toContain('O carregador não confirmou o encerramento')
    expect(e.text).toContain('R$ 42,10')
    expect(emailSessaoEncerradaPeloServidor(ctx(), { ...sessao, totalCents: 0 }).text).toContain('Nenhum valor foi cobrado')
  })

  it('cobrança pendente: valor em reais, bloqueio de novas recargas e CTA para adicionar saldo', () => {
    const e = emailFalhaDeCobranca(ctx(), { sessionId: 'x', local: 'Posto Centro — CP-001', valorCents: 1234 })
    expect(e.subject).toBe('Cobrança pendente: R$ 12,34 — InnoFlow')
    expect(e.text).toContain('R$ 12,34 pendentes')
    expect(e.text).toContain('novas recargas ficam bloqueadas')
    expect(e.text).toContain(`${BASE}/app/carteira/adicionar`)
  })

  it('saldo baixo: saldo atual e o limiar escolhido pela pessoa', () => {
    const e = emailSaldoBaixo(ctx(), { saldoCents: 1500, limiarCents: 2000 })
    expect(e.text).toContain('R$ 15,00')
    expect(e.text).toContain('R$ 20,00')
  })

  it('Pix creditado: valor, quitação de dívida (só se houve) e saldo', () => {
    const com = emailRecargaDeSaldoCreditada(ctx(), { creditadoCents: 5000, quitouDividaCents: 1234, saldoCents: 3766 })
    expect(com.text).toContain('R$ 50,00 foram creditados')
    expect(com.text).toContain('R$ 12,34 foram usados para quitar')
    expect(com.text).toContain('Saldo atual: R$ 37,66')
    expect(emailRecargaDeSaldoCreditada(ctx(), { creditadoCents: 5000, quitouDividaCents: 0, saldoCents: 5000 }).text).not.toContain('quitar')
  })

  it('recarga pelo suporte: local, operador e hora de Brasília; diz que se o carregador recusar nada é cobrado', () => {
    const e = emailRecargaIniciadaPeloSuporte(ctx(), { local: 'Posto Centro — CP-001', operador: 'Operador Centro', quando: new Date('2026-10-05T15:00:00Z') })
    expect(e.text).toContain('suporte de Operador Centro')
    expect(e.text).toContain('05/10/2026 às 12:00') // 15:00Z = 12:00 em Brasília
    expect(e.text).toContain('nada é cobrado')
  })

  it('senha alterada: o MESMO texto de segurança da L1.3 (uma fonte só), com link "não fui eu"', () => {
    const e = emailSenhaAlteradaDoMotorista(ctx(), { quando: new Date('2026-10-05T15:00:00Z') })
    expect(e.subject).toBe('Sua senha do InnoFlow foi alterada')
    expect(e.text).toContain('desconectado de todos os aparelhos')
    expect(e.text).toContain(`${BASE}/esqueci-senha`)
  })

  it('conta excluída: confirma a anonimização e fala da devolução do saldo; SEM link de perfil (a conta não existe mais)', () => {
    const e = emailContaExcluida(ctx())
    expect(e.text).toContain('anonimizados')
    expect(e.text).toContain('devolvido por Pix')
    expect(e.text).not.toContain('/app/perfil')
    expect(e.html).not.toContain('/app/perfil')
  })
})

describe('regras que valem para TODOS os e-mails', () => {
  it('rodapé com a empresa (LEGAL_*) e link "Gerenciar notificações" -> /app/perfil (menos a conta excluída)', () => {
    for (const e of todos(ctx())) {
      expect(e.text).toContain('InnoFlow Mobilidade Ltda')
      expect(e.text).toContain('CNPJ 12.345.678/0001-90')
      expect(e.text).toContain('suporte@innoflow.com.br')
    }
    const comLink = todos(ctx()).filter((e) => e.text.includes('Gerenciar notificações'))
    expect(comLink).toHaveLength(7)
    for (const e of comLink) {
      expect(e.text).toContain(`Gerenciar notificações: ${BASE}/app/perfil`)
      expect(e.html).toContain(`href="${BASE}/app/perfil"`)
    }
  })

  it('SEM dados da empresa: o bloco some — NENHUM CNPJ/nome inventado nem "CNPJ" solto', () => {
    for (const e of todos(ctx({ empresa: SEM_EMPRESA }))) {
      expect(e.text).not.toMatch(/CNPJ/i)
      expect(e.html).not.toMatch(/CNPJ/i)
      expect(e.text).not.toMatch(/Ltda/)
    }
    expect(blocoDaEmpresa(SEM_EMPRESA)).toBe('')
    // só o que existe: nome sem CNPJ não inventa o CNPJ
    expect(blocoDaEmpresa({ ...SEM_EMPRESA, name: 'Só o Nome' })).toBe('Só o Nome')
    expect(blocoDaEmpresa({ ...SEM_EMPRESA, supportEmail: 'a@b.com', supportPhone: '1199' })).toBe('Suporte: a@b.com · 1199')
  })

  it('SEM origem pública confiável: nenhum link nem botão (nunca um link inventado)', () => {
    for (const e of todos(ctx({ baseUrl: null }))) {
      expect(e.text).not.toMatch(/https?:\/\//)
      expect(e.html).not.toMatch(/href=/)
    }
  })

  it('sem pixel de rastreio nem recurso remoto: nada de <img>, <script>, <link>, CSS externo, url(...) ou iframe', () => {
    for (const e of todos(ctx())) {
      expect(e.html).not.toMatch(/<img|<script|<link|<iframe|@import|url\(|<style/i)
      expect(e.html).toContain('lang="pt-BR"')
    }
  })

  it('SEM dado sensível: nem número de cartão, nem idTag/token, nem CPF, nem o e-mail da pessoa; só o primeiro nome na saudação', () => {
    for (const e of todos(ctx())) {
      expect(e.text).not.toMatch(/\b\d{13,19}\b/) // PAN
      expect(e.text).not.toMatch(/\d{3}\.?\d{3}\.?\d{3}-?\d{2}/) // CPF
      expect(e.text).not.toMatch(/idTag|token|Bearer/i)
      expect(e.text).not.toContain('Souza') // sobrenome
      expect(e.text).not.toMatch(/[\w.+-]+@example\.com/)
    }
    expect(emailSessaoConcluida(ctx(), sessao).text).toContain('Olá, Maria.')
  })

  it('o ASSUNTO nunca leva texto de usuário (nome do motorista, nome do posto): só texto fixo e valores em reais', () => {
    const c = ctx({ nome: 'Fulano <script>' })
    const s = { ...sessao, local: 'Posto <b>Malicioso</b> — CP-9' }
    for (const e of [emailSessaoConcluida(c, s), emailSessaoEncerradaPeloServidor(c, s), emailFalhaDeCobranca(c, { sessionId: 'x', local: s.local, valorCents: 100 }), emailRecargaIniciadaPeloSuporte(c, { local: s.local, operador: s.local, quando: new Date() })]) {
      expect(e.subject).not.toMatch(/Malicioso|Fulano|<|>/)
    }
  })

  it('texto vindo de cadastro é ESCAPADO no HTML (nome do posto, operador, nome da pessoa)', () => {
    const e = emailSessaoConcluida(ctx({ nome: 'Ana <img src=x onerror=alert(1)>' }), { ...sessao, local: 'Posto <script>alert(1)</script> — CP-1' })
    expect(e.html).not.toContain('<script>alert(1)</script>')
    expect(e.html).not.toContain('<img src=x')
    expect(e.html).toContain('&lt;script&gt;')
  })

  it('sempre html + texto, e o texto não tem tag HTML', () => {
    for (const e of todos(ctx())) {
      expect(e.html.length).toBeGreaterThan(200)
      expect(e.text).not.toMatch(/<\/?(p|div|table|td|a|h1)\b/i)
    }
  })

  it('o motivo no rodapé diferencia o que é desligável do que é sempre enviado', () => {
    expect(emailFalhaDeCobranca(ctx(), { sessionId: 'x', local: 'L', valorCents: 1 }).text).toContain('sempre enviado')
    expect(emailSaldoBaixo(ctx(), { saldoCents: 1, limiarCents: 2 }).text).toContain('desativar os opcionais')
  })
})
