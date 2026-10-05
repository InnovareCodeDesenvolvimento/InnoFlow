/**
 * Regras PURAS da exclusão de conta do motorista (L1.4, LGPD) — sem Prisma, sem Express, sem relógio. O serviço (`services/lgpd/excluirConta.ts`) lê o estado do banco
 * sob lock e pergunta aqui "pode excluir? e o que acontece com o saldo?".
 *
 * Decisões do dono (DL2/DL3, 05/10/2026):
 *  - DL3: dívida ABERTA bloqueia a exclusão até quitar (`OPEN_DEBT`);
 *  - DL2: saldo positivo NÃO bloqueia — a conta é excluída e o saldo vira devolução MANUAL por Pix (precisa da chave: `REFUND_PIX_KEY_REQUIRED`); sem saldo, nada a devolver.
 * Mais as duas condições operacionais do plano: sessão de recarga em andamento (`ACTIVE_SESSION`, inclui `STOP_UNCONFIRMED`) e pagamento em andamento (`PAYMENT_IN_PROGRESS`:
 * cartão autorizado/captura pendente, Pix pendente) — anonimizar no meio disso deixaria dinheiro sem dono para reconciliar.
 */

/** Literais do tombstone — o CHECK `user_deleted_is_anonymized` do banco exige EXATAMENTE estes valores (docs/MODELO-DADOS-LOTE1.md §3.1). */
export const NOME_CONTA_EXCLUIDA = 'Conta excluída'
export const DOMINIO_EMAIL_ANONIMO = 'anon.invalid'
export const MARCADOR_TOKEN_CARTAO_DESTRUIDO = 'DESTROYED'

/** `excluido+<id>@anon.invalid` — único por construção (o id é único) e inválido para envio (TLD reservado pela RFC 6761). */
export function emailAnonimo(userId: string): string {
  return `excluido+${userId}@${DOMINIO_EMAIL_ANONIMO}`
}

export type RecusaExclusao = 'ACTIVE_SESSION' | 'PAYMENT_IN_PROGRESS' | 'OPEN_DEBT' | 'REFUND_PIX_KEY_REQUIRED' | 'REFUND_PIX_KEY_INVALID'

export interface SituacaoParaExclusao {
  /** Sessões `STARTED/CHARGING/FINISHING/FAULTED` + `STOP_UNCONFIRMED`. */
  sessoesEmAndamento: number
  /** Intents `AUTHORIZED/CAPTURE_PENDING/PENDING` (e `CREATED` recente). */
  pagamentosEmAndamento: number
  dividasAbertas: number
  /** Saldo da carteira em centavos (negativo/ausente já normalizado por quem chama: aqui só `> 0` conta). */
  saldoCents: number
  /** O que o corpo trouxe como chave Pix: nada, algo que não é uma chave Pix reconhecível, ou uma chave válida. Só é lida quando há saldo. */
  chavePix: 'AUSENTE' | 'INVALIDA' | 'VALIDA'
}

export type DecisaoDeExclusao = { permitida: false; recusa: RecusaExclusao } | { permitida: true; refundStatus: 'NOT_REQUIRED' | 'PENDING_REFUND'; saldoCents: number }

/**
 * Ordem das recusas = ordem de "o que o titular resolve primeiro": terminar/cancelar a recarga, esperar o pagamento, quitar a dívida, e só então informar a chave Pix
 * (que só é pedida quando as outras três já passaram — não faz sentido pedir a chave de quem ainda não pode excluir).
 */
export function decidirExclusao(s: SituacaoParaExclusao): DecisaoDeExclusao {
  if (s.sessoesEmAndamento > 0) return { permitida: false, recusa: 'ACTIVE_SESSION' }
  if (s.pagamentosEmAndamento > 0) return { permitida: false, recusa: 'PAYMENT_IN_PROGRESS' }
  if (s.dividasAbertas > 0) return { permitida: false, recusa: 'OPEN_DEBT' }
  const saldoCents = s.saldoCents > 0 ? s.saldoCents : 0
  if (saldoCents === 0) return { permitida: true, refundStatus: 'NOT_REQUIRED', saldoCents: 0 }
  if (s.chavePix === 'AUSENTE') return { permitida: false, recusa: 'REFUND_PIX_KEY_REQUIRED' }
  if (s.chavePix === 'INVALIDA') return { permitida: false, recusa: 'REFUND_PIX_KEY_INVALID' }
  return { permitida: true, refundStatus: 'PENDING_REFUND', saldoCents }
}

export const MENSAGEM_DA_RECUSA: Readonly<Record<RecusaExclusao, { status: number; mensagem: string }>> = {
  ACTIVE_SESSION: { status: 409, mensagem: 'Há uma recarga em andamento. Encerre a recarga e aguarde a conclusão antes de excluir a conta.' },
  PAYMENT_IN_PROGRESS: { status: 409, mensagem: 'Há um pagamento em andamento (cartão ou Pix). Aguarde a conclusão antes de excluir a conta.' },
  OPEN_DEBT: { status: 409, mensagem: 'Há uma dívida em aberto. Quite o valor pendente antes de excluir a conta.' },
  REFUND_PIX_KEY_REQUIRED: { status: 400, mensagem: 'Sua carteira tem saldo. Informe uma chave Pix para receber a devolução.' },
  // O contrato não tem código próprio: sai como 400 `VALIDATION_ERROR` (a rota troca o código), com esta mensagem.
  REFUND_PIX_KEY_INVALID: { status: 400, mensagem: 'A chave Pix informada não é válida. Use CPF, CNPJ, celular, e-mail ou chave aleatória.' },
}

/** Status que a API devolve ao titular (contrato `MeAccountDeletionResponse`). */
export function statusDaResposta(refundStatus: 'NOT_REQUIRED' | 'PENDING_REFUND' | 'REFUNDED'): 'DELETED' | 'DELETED_PENDING_REFUND' {
  return refundStatus === 'NOT_REQUIRED' ? 'DELETED' : 'DELETED_PENDING_REFUND'
}

/** `CREATED` é transitório (o intent nasce e vai à Cielo em segundos): só bloqueia se for recente — um `CREATED` esquecido de dias não pode travar a exclusão para sempre. */
export const JANELA_INTENT_CREATED_MS = 15 * 60 * 1000

/**
 * Devolução manual do saldo (ADMIN). Prazo máximo RECOMENDADO pelo Cronos (P4): 30 dias — acima disso o pedido pendente (que guarda a chave Pix cifrada de uma conta já anonimizada)
 * vira alerta ao dono.
 */
export const PRAZO_MAXIMO_DEVOLUCAO_DIAS = 30

export function idadeEmDias(desde: Date, agora: Date): number {
  return Math.max(0, Math.floor((agora.getTime() - desde.getTime()) / 86_400_000))
}

export function devolucaoAtrasada(desde: Date, agora: Date): boolean {
  return idadeEmDias(desde, agora) > PRAZO_MAXIMO_DEVOLUCAO_DIAS
}
