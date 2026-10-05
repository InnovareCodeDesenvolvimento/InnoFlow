import type { SessionClosureSource } from '@prisma/client'
import { cruzouLimiarDeSaldoBaixo, type PreferenciasDeNotificacao } from '../../core/notificacoes/politica'
import { dispararEmSegundoPlano, enfileirarEmSegundoPlano, enfileirarNotificacao, type DepsDoEnfileiramento, type PedidoDeNotificacao } from './enfileirarNotificacao'
import { lerPreferencias } from './preferencias'

/**
 * Um gatilho por FATO que gera aviso ao motorista (L1.6). Todos: síncronos, devolvem `void` na hora, NUNCA lançam e só devem ser chamados DEPOIS do commit do fato (rollback
 * avisando por e-mail algo que não existe seria o pior cenário). O envio em si — preferências, idempotência por `NotificationLog`, SMTP, retentativas — é do worker.
 * O `entityId` de cada tipo segue `docs/MODELO-DADOS-LOTE1.md` §2.5 (é ele que faz "o mesmo fato nunca vira dois e-mails").
 */

type Fila = DepsDoEnfileiramento

/**
 * Sessão FECHADA: recibo (`SESSION_COMPLETED`) ou, se quem fechou foi o SERVIDOR (o carregador não confirmou — F5.9), `SESSION_CLOSED_BY_SERVER`. Sessão de custo zero não gera recibo
 * (nada foi cobrado: um "recibo de R$ 0,00" é ruído); o aviso do servidor sai sempre, porque explica por que a sessão acabou.
 * Sessão que JÁ virou dívida (`temDivida`) não manda recibo: "pago com a carteira" seria mentira — quem avisa é a cobrança pendente (`SESSION_PAYMENT_FAILED`). `entityId` = id da sessão.
 */
export function notificarSessaoEncerrada(
  p: { sessionId: string; userId: string; closureSource: SessionClosureSource | null | undefined; totalCostCents: number; temDivida?: boolean },
  deps: Fila = {},
): void {
  const doServidor = p.closureSource === 'SERVER'
  if (!doServidor && (p.totalCostCents <= 0 || p.temDivida === true)) return
  enfileirarEmSegundoPlano({ tipo: doServidor ? 'SESSION_CLOSED_BY_SERVER' : 'SESSION_COMPLETED', userId: p.userId, entityId: p.sessionId }, deps)
}

/** A cobrança da sessão falhou ou ficou parcial e virou `Debt` (carteira sem saldo; captura do cartão negada/parcial). `entityId` = id da sessão. */
export function notificarFalhaDeCobranca(p: { sessionId: string; userId: string }, deps: Fila = {}): void {
  enfileirarEmSegundoPlano({ tipo: 'SESSION_PAYMENT_FAILED', userId: p.userId, entityId: p.sessionId }, deps)
}

/**
 * Saldo baixo: SÓ no cruzamento do limiar (saldo antes >= L e depois < L). A leitura da preferência (limiar e se está ligado) acontece em segundo plano — o chamador não espera o banco.
 * `entityId` = id do `WalletEntry` que cruzou o limiar (cada cruzamento é um fato novo; o mesmo movimento reprocessado não duplica).
 */
export function notificarSaldoBaixoSeCruzou(
  p: { userId: string; walletEntryId: string; saldoAntesCents: number; saldoDepoisCents: number },
  deps: Fila & { lerPrefs?: (userId: string) => Promise<PreferenciasDeNotificacao> } = {},
): void {
  if (p.saldoDepoisCents >= p.saldoAntesCents) return // só movimento que REDUZ o saldo pode cruzar para baixo (evita ler o banco à toa)
  dispararEmSegundoPlano('saldo-baixo', async () => {
    const prefs = await (deps.lerPrefs ?? lerPreferencias)(p.userId)
    if (!prefs.lowBalanceEnabled) return
    if (!cruzouLimiarDeSaldoBaixo(p.saldoAntesCents, p.saldoDepoisCents, prefs.lowBalanceThresholdCents)) return
    await enfileirarNotificacao({ tipo: 'LOW_BALANCE', userId: p.userId, entityId: p.walletEntryId }, deps)
  })
}

/** Pix creditado na carteira. `entityId` = id do `PaymentIntent`. Os números vão no job (o intent não guarda quanto quitou de dívida). */
export function notificarRecargaDeSaldoCreditada(p: { userId: string; paymentIntentId: string; creditadoCents: number; quitouDividaCents: number; saldoCents: number }, deps: Fila = {}): void {
  enfileirarEmSegundoPlano(
    { tipo: 'TOPUP_CREDITED', userId: p.userId, entityId: p.paymentIntentId, creditadoCents: p.creditadoCents, quitouDividaCents: p.quitouDividaCents, saldoCents: p.saldoCents },
    deps,
  )
}

/** O ADMIN iniciou uma recarga na conta do motorista (L1.5). `entityId` = `correlationId` do comando. */
export function notificarRecargaIniciadaPeloSuporte(p: { userId: string; correlationId: string; chargePointId: string; quando?: Date }, deps: Fila = {}): void {
  enfileirarEmSegundoPlano(
    { tipo: 'REMOTE_START_BY_SUPPORT', userId: p.userId, entityId: p.correlationId, chargePointId: p.chargePointId, ocorridoEm: (p.quando ?? new Date()).toISOString() },
    deps,
  )
}

/**
 * Troca de senha pela própria pessoa logada (`POST /api/auth/password`). `entityId` = `<userId>-<instante da troca em ms>`: cada troca é um fato novo, e o mesmo instante
 * reprocessado não duplica (o `sessionsValidAfter` gravado na troca é esse instante).
 */
export function notificarSenhaAlterada(p: { userId: string; trocadaEm: Date }, deps: Fila = {}): void {
  enfileirarEmSegundoPlano({ tipo: 'PASSWORD_CHANGED', userId: p.userId, entityId: `${p.userId}-${p.trocadaEm.getTime()}`, ocorridoEm: p.trocadaEm.toISOString() }, deps)
}

/**
 * Conta excluída (L1.4). O endereço (já anonimizado no banco) só existe no payload do job — `destinatario` — e some ao concluir. `entityId` = id do `AccountDeletionRequest`
 * (`requestId` da resposta). Chamada só quando a exclusão foi de fato feita agora (`resultado.notificar` é `null` na 2ª chamada concorrente: não há 2º aviso).
 */
export function notificarContaExcluida(p: { userId: string; requestId: string; email: string; nome: string }, deps: Fila = {}): void {
  const pedido: PedidoDeNotificacao = { tipo: 'ACCOUNT_DELETED', userId: p.userId, entityId: p.requestId, destinatario: { email: p.email, nome: p.nome } }
  enfileirarEmSegundoPlano(pedido, deps)
}
