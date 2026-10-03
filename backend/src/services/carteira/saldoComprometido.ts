import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { env } from '../../lib/env'
import { calcularTetoReserva } from '../../core/carteira/calcularTetoReserva'
import { listarEstadosSessaoAberta } from '../../core/sessao/estadosSessao'
import type { TariffSnapshot } from '../../core/tarifacao/calcularCustoSessao'

/**
 * Saldo COMPROMETIDO do motorista (F5.9: decisão D7 + M3 do Órion). A carteira é pré-paga SEM hold (a identidade de conciliação proíbe reservar por
 * débito antecipado), então o "saldo disponível" para INICIAR outra recarga tem de descontar, por conta, o que as sessões que ainda vão debitar já consomem:
 *
 *  1. sessões `STOP_UNCONFIRMED` de modo WALLET: ainda NÃO debitaram, mas vão — pelo `provisionalCostCents` (custo com a melhor leitura conhecida; é
 *     recalculado quando entram amostras novas, ver `custoProvisorio.ts`);
 *  2. sessões WALLET ABERTAS (STARTED/CHARGING/FINISHING/FAULTED): estão consumindo agora; sem hold, o que cobre o consumo futuro é o TETO DE RESERVA
 *     (`calcularTetoReserva`, o mesmo número que a guarda usa como limite) — sem isto, "só soma STOP_UNCONFIRMED" deixava duas inicializações simultâneas
 *     passarem no MESMO saldo (M3).
 *
 * Sessão CARD não compromete a carteira (a pré-autorização dela cobre). Uma pré-autorização NOVA de cartão é independente de tudo isto.
 * Lê com o cliente recebido: dentro de `$transaction` (StartTransaction, sob o lock da Wallet) passa-se o `tx`, para a reconferência ver o que já commitou.
 */
export interface Comprometimento {
  /** Quantas sessões STOP_UNCONFIRMED o motorista tem (qualquer modo de pagamento) — a chave D7 decide se isso bloqueia o início. */
  total: number
  /** Primeira sessão em confirmação (para o 409 apontar). */
  sessionId: string | null
  /** Soma do `provisionalCostCents` das STOP_UNCONFIRMED WALLET. */
  provisionalCents: number
  /** Soma do teto de reserva das sessões WALLET abertas. */
  reservadoAbertasCents: number
  /** `provisionalCents + reservadoAbertasCents` — o que sai do saldo disponível. Nunca negativo. */
  comprometidoCents: number
}

export type SessoesNaoConfirmadasDoMotorista = Comprometimento

type Cliente = Prisma.TransactionClient | typeof prisma

export async function carregarSessoesNaoConfirmadas(userId: string, opcoes: { excetoSessionId?: string; cliente?: Cliente } = {}): Promise<Comprometimento> {
  const db = opcoes.cliente ?? prisma
  const excecao = opcoes.excetoSessionId ? { id: { not: opcoes.excetoSessionId } } : {}

  const [naoConfirmadas, abertasWallet] = await Promise.all([
    db.chargingSession.findMany({
      where: { userId, status: 'STOP_UNCONFIRMED', ...excecao },
      select: { id: true, paymentMode: true, provisionalCostCents: true },
      orderBy: { createdAt: 'asc' },
    }),
    db.chargingSession.findMany({
      where: { userId, paymentMode: 'WALLET', status: { in: listarEstadosSessaoAberta() }, ...excecao },
      select: { tariffSnapshot: true, connector: { select: { maxPowerKw: true } } },
    }),
  ])

  const provisionalCents = naoConfirmadas.filter((s) => s.paymentMode === 'WALLET').reduce((acc, s) => acc + Math.max(0, s.provisionalCostCents ?? 0), 0)
  const reservadoAbertasCents = abertasWallet.reduce((acc, s) => {
    const t = s.tariffSnapshot as unknown as TariffSnapshot
    return (
      acc +
      calcularTetoReserva(
        { pricePerKwh: t.pricePerKwh, pricePerMinute: t.pricePerMinute, sessionFeeCents: t.sessionFeeCents },
        { maxPowerKw: s.connector.maxPowerKw?.toString() ?? null },
        { pisoCents: env.RESERVA_PISO_CENTS, tetoCents: env.RESERVA_TETO_CENTS },
      )
    )
  }, 0)

  return { total: naoConfirmadas.length, sessionId: naoConfirmadas[0]?.id ?? null, provisionalCents, reservadoAbertasCents, comprometidoCents: provisionalCents + reservadoAbertasCents }
}

/**
 * M3 (Órion): reconferência do início de uma sessão WALLET SOB O LOCK DA CARTEIRA, dentro da transação que cria a sessão. O `checkAuthorization` (e o
 * pré-check da API) leem saldo e comprometido SEM lock: duas inicializações simultâneas (RFID em dois carregadores, RemoteStart + RFID) passavam no MESMO
 * saldo — o lock `me:start` da API é liberado no 202, antes de a sessão existir. Aqui: `SELECT ... FOR UPDATE` na Wallet serializa os inícios do motorista;
 * o 2º espera o commit do 1º e então ENXERGA a sessão dele (o teto de reserva dela entra no comprometido) e recusa se o disponível ficou abaixo do mínimo.
 * Só vale para WALLET (cartão tem a própria pré-autorização). Devolve o motivo da recusa, ou `null` se pode iniciar.
 */
export async function reconferirInicioWalletSobLock(tx: Prisma.TransactionClient, userId: string): Promise<null | 'INSUFFICIENT_BALANCE' | 'SESSION_PENDING_CONFIRMATION'> {
  const carteira = await tx.wallet.findUnique({ where: { userId }, select: { id: true } })
  if (!carteira) return 'INSUFFICIENT_BALANCE'
  await tx.$queryRaw`SELECT id FROM "Wallet" WHERE id = ${carteira.id} FOR UPDATE`

  const ultima = await tx.walletEntry.findFirst({ where: { walletId: carteira.id }, orderBy: { createdAt: 'desc' }, select: { balanceAfterCents: true } })
  const saldo = ultima?.balanceAfterCents ?? 0
  const comp = await carregarSessoesNaoConfirmadas(userId, { cliente: tx })
  if (comp.total > 0 && !env.SESSION_ALLOW_START_WHILE_UNCONFIRMED) return 'SESSION_PENDING_CONFIRMATION'
  return saldo - comp.comprometidoCents >= env.WALLET_MIN_START_BALANCE_CENTS ? null : 'INSUFFICIENT_BALANCE'
}
