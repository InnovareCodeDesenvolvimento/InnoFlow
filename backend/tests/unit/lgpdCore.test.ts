import { describe, expect, it } from 'vitest'
import { normalizarChavePix, validarCnpj } from '../../src/core/lgpd/chavePix'
import { decidirExclusao, devolucaoAtrasada, emailAnonimo, idadeEmDias, MENSAGEM_DA_RECUSA, PRAZO_MAXIMO_DEVOLUCAO_DIAS, statusDaResposta, type SituacaoParaExclusao } from '../../src/core/lgpd/exclusaoDeConta'
import { formatarValidade, mascararIdTag, nomeDoArquivoDeExportacao } from '../../src/core/lgpd/exportacao'
import { escolherMetodoDeReautenticacao, identidadeGoogleConfere } from '../../src/core/lgpd/reautenticacao'

/** L1.4 — regras PURAS: chave Pix, decisão de exclusão (DL2/DL3), exportação e reautenticação. */

describe('chave Pix de devolução (normalizarChavePix)', () => {
  it('aceita as 5 formas do BCB e devolve a forma canônica', () => {
    expect(normalizarChavePix('529.982.247-25')).toBe('52998224725') // CPF
    expect(normalizarChavePix('11.222.333/0001-81')).toBe('11222333000181') // CNPJ
    expect(normalizarChavePix('(11) 91234-5678')).toBe('+5511912345678') // celular sem país
    expect(normalizarChavePix('+55 11 91234-5678')).toBe('+5511912345678') // celular com país
    expect(normalizarChavePix('  Maria.Silva@Example.COM ')).toBe('maria.silva@example.com') // e-mail
    expect(normalizarChavePix('123E4567-E89B-12D3-A456-426614174000')).toBe('123e4567-e89b-12d3-a456-426614174000') // EVP
  })

  it('recusa o que não é chave Pix (e nunca devolve o texto cru)', () => {
    const ruins = ['', '   ', 'abc', '123', '11111111111', '12345678901', '11222333000182', '(11) 1234-5678', 'a@b', 'x'.repeat(78), '123e4567-e89b-12d3-a456', 'DROP TABLE;--', '+55 (11) 81234-5678 ramal 9']
    for (const ruim of ruins) {
      expect(normalizarChavePix(ruim), JSON.stringify(ruim)).toBeNull()
    }
  })

  it('validarCnpj confere os dois dígitos verificadores', () => {
    expect(validarCnpj('11222333000181')).toBe(true)
    expect(validarCnpj('11222333000180')).toBe(false)
    expect(validarCnpj('00000000000000')).toBe(false)
  })
})

describe('decidirExclusao (DL2: saldo -> Pix manual; DL3: dívida bloqueia)', () => {
  const livre: SituacaoParaExclusao = { sessoesEmAndamento: 0, pagamentosEmAndamento: 0, dividasAbertas: 0, saldoCents: 0, chavePix: 'AUSENTE' }

  it('sem saldo: NOT_REQUIRED, e a chave Pix (mesmo informada) é irrelevante', () => {
    expect(decidirExclusao(livre)).toEqual({ permitida: true, refundStatus: 'NOT_REQUIRED', saldoCents: 0 })
    expect(decidirExclusao({ ...livre, chavePix: 'INVALIDA' })).toEqual({ permitida: true, refundStatus: 'NOT_REQUIRED', saldoCents: 0 })
  })

  it('saldo negativo/zero nunca vira devolução', () => {
    expect(decidirExclusao({ ...livre, saldoCents: -50 })).toEqual({ permitida: true, refundStatus: 'NOT_REQUIRED', saldoCents: 0 })
  })

  it('saldo positivo exige chave Pix: ausente e inválida têm recusas distintas; válida vira PENDING_REFUND com o saldo', () => {
    expect(decidirExclusao({ ...livre, saldoCents: 1500 })).toEqual({ permitida: false, recusa: 'REFUND_PIX_KEY_REQUIRED' })
    expect(decidirExclusao({ ...livre, saldoCents: 1500, chavePix: 'INVALIDA' })).toEqual({ permitida: false, recusa: 'REFUND_PIX_KEY_INVALID' })
    expect(decidirExclusao({ ...livre, saldoCents: 1500, chavePix: 'VALIDA' })).toEqual({ permitida: true, refundStatus: 'PENDING_REFUND', saldoCents: 1500 })
  })

  it('ordem das recusas: sessão > pagamento > dívida > chave Pix', () => {
    const tudo: SituacaoParaExclusao = { sessoesEmAndamento: 1, pagamentosEmAndamento: 1, dividasAbertas: 1, saldoCents: 900, chavePix: 'AUSENTE' }
    expect(decidirExclusao(tudo)).toEqual({ permitida: false, recusa: 'ACTIVE_SESSION' })
    expect(decidirExclusao({ ...tudo, sessoesEmAndamento: 0 })).toEqual({ permitida: false, recusa: 'PAYMENT_IN_PROGRESS' })
    expect(decidirExclusao({ ...tudo, sessoesEmAndamento: 0, pagamentosEmAndamento: 0 })).toEqual({ permitida: false, recusa: 'OPEN_DEBT' })
    expect(decidirExclusao({ ...tudo, sessoesEmAndamento: 0, pagamentosEmAndamento: 0, dividasAbertas: 0 })).toEqual({ permitida: false, recusa: 'REFUND_PIX_KEY_REQUIRED' })
  })

  it('os 409 do contrato são 409 e a chave ausente é 400', () => {
    expect(MENSAGEM_DA_RECUSA.ACTIVE_SESSION.status).toBe(409)
    expect(MENSAGEM_DA_RECUSA.PAYMENT_IN_PROGRESS.status).toBe(409)
    expect(MENSAGEM_DA_RECUSA.OPEN_DEBT.status).toBe(409)
    expect(MENSAGEM_DA_RECUSA.REFUND_PIX_KEY_REQUIRED.status).toBe(400)
  })

  it('statusDaResposta: só NOT_REQUIRED é DELETED (REFUNDED também foi um pedido com saldo)', () => {
    expect(statusDaResposta('NOT_REQUIRED')).toBe('DELETED')
    expect(statusDaResposta('PENDING_REFUND')).toBe('DELETED_PENDING_REFUND')
    expect(statusDaResposta('REFUNDED')).toBe('DELETED_PENDING_REFUND')
  })

  it('e-mail anônimo é o do tombstone exigido pelo CHECK do banco', () => {
    expect(emailAnonimo('abc123')).toBe('excluido+abc123@anon.invalid')
  })
})

describe('prazo da devolução manual (30 dias — P4 do Cronos)', () => {
  const t0 = new Date('2026-10-01T12:00:00Z')
  const depois = (dias: number, extraMs = 0) => new Date(t0.getTime() + dias * 86_400_000 + extraMs)

  it('idade em dias cheios; passou de 30 = atrasada (30 exatos ainda não)', () => {
    expect(PRAZO_MAXIMO_DEVOLUCAO_DIAS).toBe(30)
    expect(idadeEmDias(t0, depois(0, 3_600_000))).toBe(0)
    expect(idadeEmDias(t0, depois(30))).toBe(30)
    expect(devolucaoAtrasada(t0, depois(30))).toBe(false)
    expect(devolucaoAtrasada(t0, depois(31))).toBe(true)
  })

  it('relógio atrás do pedido não dá idade negativa', () => {
    expect(idadeEmDias(t0, depois(-2))).toBe(0)
  })
})

describe('exportação (máscaras e nome do arquivo)', () => {
  it('idTag mascarado: 2 primeiros + 2 últimos; curtos viram só asteriscos', () => {
    expect(mascararIdTag('T123456789012345678')).toBe('T1***************78')
    expect(mascararIdTag('ABCD')).toBe('****')
    expect(mascararIdTag('AB')).toBe('**')
    expect(mascararIdTag('ABCDE')).toBe('AB*DE')
  })

  it('validade MM/AAAA; faltando mês ou ano = vazio', () => {
    expect(formatarValidade(3, 2029)).toBe('03/2029')
    expect(formatarValidade(12, 2030)).toBe('12/2030')
    expect(formatarValidade(null, 2030)).toBe('')
    expect(formatarValidade(3, null)).toBe('')
  })

  it('nome do arquivo: innoflow-meus-dados-AAAAMMDD.json (UTC)', () => {
    expect(nomeDoArquivoDeExportacao(new Date('2026-10-06T23:59:59Z'))).toBe('innoflow-meus-dados-20261006.json')
    expect(nomeDoArquivoDeExportacao(new Date('2026-01-02T00:00:00Z'))).toBe('innoflow-meus-dados-20260102.json')
  })
})

describe('reautenticação da exclusão', () => {
  it('conta COM senha exige a senha, mesmo que o corpo traga o Google', () => {
    expect(escolherMetodoDeReautenticacao({ temSenha: true, temGoogle: true }, { senhaInformada: true, googleInformado: true })).toEqual({ metodo: 'SENHA' })
    expect(escolherMetodoDeReautenticacao({ temSenha: true, temGoogle: true }, { senhaInformada: false, googleInformado: true })).toEqual({ metodo: 'NENHUM', erro: 'CURRENT_PASSWORD_REQUIRED' })
  })

  it('conta só-Google exige o ID token; sem nenhum método não há como provar identidade', () => {
    expect(escolherMetodoDeReautenticacao({ temSenha: false, temGoogle: true }, { senhaInformada: true, googleInformado: true })).toEqual({ metodo: 'GOOGLE' })
    expect(escolherMetodoDeReautenticacao({ temSenha: false, temGoogle: true }, { senhaInformada: true, googleInformado: false })).toEqual({ metodo: 'NENHUM', erro: 'GOOGLE_CREDENTIAL_REQUIRED' })
    expect(escolherMetodoDeReautenticacao({ temSenha: false, temGoogle: false }, { senhaInformada: true, googleInformado: true })).toEqual({ metodo: 'NENHUM', erro: 'SEM_METODO_DE_PROVA' })
  })

  it('o Google só vale se o sub é o da conta e o e-mail está verificado', () => {
    expect(identidadeGoogleConfere({ sub: 's1', emailVerified: true }, 's1')).toBe(true)
    expect(identidadeGoogleConfere({ sub: 's2', emailVerified: true }, 's1')).toBe(false)
    expect(identidadeGoogleConfere({ sub: 's1', emailVerified: false }, 's1')).toBe(false)
  })
})
