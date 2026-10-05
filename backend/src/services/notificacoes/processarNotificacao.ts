import { Prisma, type PrismaClient } from '@prisma/client'
import type Redis from 'ioredis'
import { adquirirLock, liberarLock } from '../../lib/redisLock'
import { DeadlineExceededError, withDeadline } from '../../lib/withDeadline'
import type { NotificacaoJobData } from '../../worker/queues'
import type { EmailPronto } from '../../core/auth/emailsDeSenha'
import type { DadosPublicosDaEmpresa } from '../../core/legal/termos'
import {
  emailContaExcluida,
  emailFalhaDeCobranca,
  emailRecargaDeSaldoCreditada,
  emailRecargaIniciadaPeloSuporte,
  emailSaldoBaixo,
  emailSenhaAlteradaDoMotorista,
  emailSessaoConcluida,
  emailSessaoEncerradaPeloServidor,
  type ContextoDoEmail,
  type ResumoDeSessao,
} from '../../core/notificacoes/emails'
import { codigoSeguroDeMotivo, decidirEnvio, jobIdDaNotificacao, NOTIFICATION_TYPES, PREFERENCIAS_PADRAO, type PreferenciasDeNotificacao, type TipoDeNotificacao } from '../../core/notificacoes/politica'
import type { ResultadoEmailTransacional } from '../comunicacao/email'

/**
 * Processa UM job da fila `notificacoes` (L1.6) — o lado que decide, monta e envia. FÁBRICA de dependências injetadas (banco, Redis, SMTP, relógio, origem pública, dados da empresa):
 * a lógica roda em teste com Postgres/Redis reais e SMTP falso, e `worker/jobs/notificacoesJob.ts` liga as peças reais.
 *
 * GARANTIA CENTRAL — "o mesmo fato nunca vira dois e-mails", nem com o job reprocessado (retry do BullMQ, job "stalled" devolvido à fila, reentrega):
 *  1. LOCK no Redis por fato (`notif:lock:...`, TTL): dois processadores do MESMO fato (job stalled + o original ainda vivo) se serializam;
 *  2. RESERVA em `NotificationLog` (`createMany skipDuplicates` = INSERT ... ON CONFLICT DO NOTHING; unique userId+tipo+canal+entidade): a linha É o estado do fato;
 *  3. só processa linha `PENDING` — `SENT`/`SKIPPED` são terminais (o banco recusa voltar atrás) e `FAILED` só volta por reenfileiramento manual;
 *  4. o `UPDATE ... SENT` acontece logo depois do envio, ainda sob o lock.
 * Limite honesto: se o processo morrer ENTRE o SMTP aceitar a mensagem e o `UPDATE SENT` (janela de milissegundos), o retry reenvia — é o preço de não PERDER aviso de cobrança/segurança
 * (at-least-once; o "exatamente uma vez" exigiria uma confirmação transacional do SMTP, que não existe).
 *
 * SEM PII fora do necessário: `NotificationLog.statusReason` guarda só CÓDIGO (o banco recusa espaço e `@`); a mensagem de erro do SMTP nunca vai para o banco nem para o log; o endereço
 * é lido do cadastro na hora do envio (e só `ACCOUNT_DELETED` o traz no payload, porque a conta já foi anonimizada).
 */

export interface LogDoProcessamento {
  info(dados: Record<string, unknown>, mensagem: string): void
  warn(dados: Record<string, unknown>, mensagem: string): void
  error(dados: Record<string, unknown>, mensagem: string): void
}

export interface DepsDoProcessamento {
  prisma: PrismaClient
  redis: Redis
  enviar: (msg: { to: string; subject: string; text: string; html: string }) => Promise<ResultadoEmailTransacional>
  /** Origem pública do PWA (nunca de header de requisição). `null` = e-mail sem links. */
  baseUrl: () => string | null
  empresa: () => DadosPublicosDaEmpresa | Promise<DadosPublicosDaEmpresa>
  log: LogDoProcessamento
  agora?: () => Date
  prazoDoEnvioMs?: number
  ttlDoLockMs?: number
}

export type ResultadoDoProcessamento =
  | { status: 'ENVIADA' }
  | { status: 'JA_TRATADA'; estado: 'SENT' | 'SKIPPED' | 'FAILED' }
  | { status: 'DISPENSADA'; motivo: string }
  | { status: 'INVALIDA' }
  /** Falhou de forma que vale tentar de novo (SMTP fora, lock ocupado...). O job lança com `codigo` e o BullMQ reagenda. */
  | { status: 'REPETIR'; codigo: string }

const PRAZO_DO_ENVIO_PADRAO_MS = 20_000
const TTL_DO_LOCK_PADRAO_MS = 90_000
const PRAZO_REDIS_MS = 5_000
const TIPOS = new Set<string>(NOTIFICATION_TYPES)
const EMAIL_SIMPLES = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/

export const chaveDoLockDaNotificacao = (tipo: TipoDeNotificacao, userId: string, entityId: string): string => `notif:lock:${userId}:${jobIdDaNotificacao(tipo, entityId)}`

function dadosValidos(d: unknown): d is NotificacaoJobData {
  if (typeof d !== 'object' || d === null) return false
  const x = d as Record<string, unknown>
  return typeof x.tipo === 'string' && TIPOS.has(x.tipo) && typeof x.userId === 'string' && x.userId.length > 0 && typeof x.entityId === 'string' && x.entityId.length > 0 && x.entityId.length <= 128
}

type Montagem = { email: EmailPronto; para: string } | { dispensar: string }

async function resumoDaSessao(db: PrismaClient, userId: string, sessionId: string): Promise<ResumoDeSessao | null> {
  const s = await db.chargingSession.findFirst({
    where: { id: sessionId, userId }, // a sessão tem de ser DESTE usuário (o job nunca confia só no id)
    select: { id: true, startedAt: true, stoppedAt: true, energyDeliveredWh: true, totalCostCents: true, paymentMode: true, site: { select: { name: true } }, chargePoint: { select: { ocppIdentity: true } } },
  })
  if (!s || s.totalCostCents === null || s.stoppedAt === null) return null
  return { sessionId: s.id, local: `${s.site.name} — ${s.chargePoint.ocppIdentity}`, energiaWh: s.energyDeliveredWh, inicio: s.startedAt, fim: s.stoppedAt, totalCents: s.totalCostCents, pagamento: s.paymentMode === 'CARD' ? 'CARD' : 'WALLET' }
}

const inteiroNaoNegativo = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0

async function montarEmail(db: PrismaClient, dados: NotificacaoJobData, ctx: ContextoDoEmail, prefs: PreferenciasDeNotificacao, enderecoDoCadastro: string, agora: Date): Promise<Montagem> {
  const { userId, entityId } = dados
  switch (dados.tipo) {
    case 'SESSION_COMPLETED':
    case 'SESSION_CLOSED_BY_SERVER': {
      const r = await resumoDaSessao(db, userId, entityId)
      if (!r) return { dispensar: 'FACT_NOT_FOUND' }
      return { para: enderecoDoCadastro, email: dados.tipo === 'SESSION_COMPLETED' ? emailSessaoConcluida(ctx, r) : emailSessaoEncerradaPeloServidor(ctx, r) }
    }
    case 'SESSION_PAYMENT_FAILED': {
      const r = await resumoDaSessao(db, userId, entityId)
      const soma = await db.debt.aggregate({ where: { userId, chargingSessionId: entityId }, _sum: { amountCents: true }, _count: true })
      if (!r || soma._count === 0 || !soma._sum.amountCents) return { dispensar: 'FACT_NOT_FOUND' }
      return { para: enderecoDoCadastro, email: emailFalhaDeCobranca(ctx, { sessionId: entityId, local: r.local, valorCents: soma._sum.amountCents }) }
    }
    case 'LOW_BALANCE': {
      const e = await db.walletEntry.findFirst({ where: { id: entityId, wallet: { userId } }, select: { balanceAfterCents: true } })
      if (!e) return { dispensar: 'FACT_NOT_FOUND' }
      return { para: enderecoDoCadastro, email: emailSaldoBaixo(ctx, { saldoCents: e.balanceAfterCents, limiarCents: prefs.lowBalanceThresholdCents }) }
    }
    case 'TOPUP_CREDITED': {
      const e = await db.walletEntry.findFirst({ where: { type: 'TOPUP_PIX', referenceType: 'PAYMENT_INTENT', referenceId: entityId, wallet: { userId } }, select: { amountCents: true, balanceAfterCents: true } })
      if (!e) return { dispensar: 'FACT_NOT_FOUND' }
      return {
        para: enderecoDoCadastro,
        email: emailRecargaDeSaldoCreditada(ctx, {
          creditadoCents: e.amountCents,
          quitouDividaCents: inteiroNaoNegativo(dados.quitouDividaCents) ? dados.quitouDividaCents : 0,
          saldoCents: inteiroNaoNegativo(dados.saldoCents) ? dados.saldoCents : e.balanceAfterCents,
        }),
      }
    }
    case 'REMOTE_START_BY_SUPPORT': {
      const cp = dados.chargePointId ? await db.chargePoint.findUnique({ where: { id: dados.chargePointId }, select: { ocppIdentity: true, site: { select: { name: true, operator: { select: { name: true } } } } } }) : null
      const quando = dados.ocorridoEm ? new Date(dados.ocorridoEm) : agora
      return {
        para: enderecoDoCadastro,
        email: emailRecargaIniciadaPeloSuporte(ctx, { local: cp ? `${cp.site.name} — ${cp.ocppIdentity}` : 'um carregador da rede', operador: cp?.site.operator.name ?? null, quando: Number.isNaN(quando.getTime()) ? agora : quando }),
      }
    }
    case 'PASSWORD_CHANGED': {
      const quando = dados.ocorridoEm ? new Date(dados.ocorridoEm) : agora
      return { para: enderecoDoCadastro, email: emailSenhaAlteradaDoMotorista(ctx, { quando: Number.isNaN(quando.getTime()) ? agora : quando }) }
    }
    case 'ACCOUNT_DELETED': {
      const dest = dados.destinatario
      if (!dest || !EMAIL_SIMPLES.test(dest.email)) return { dispensar: 'NO_RECIPIENT' }
      return { para: dest.email, email: emailContaExcluida({ ...ctx, nome: dest.nome }) }
    }
  }
}

export function criarProcessadorDeNotificacoes(deps: DepsDoProcessamento) {
  const agora = deps.agora ?? ((): Date => new Date())
  const { prisma: db, log } = deps

  /** `INSERT ... ON CONFLICT DO NOTHING` + leitura da linha (a nova ou a que já existia). */
  async function reservar(d: NotificacaoJobData): Promise<{ id: string; status: string } | null> {
    try {
      await db.notificationLog.createMany({ data: [{ userId: d.userId, type: d.tipo, channel: 'EMAIL', entityId: d.entityId }], skipDuplicates: true })
    } catch (err) {
      // Usuário inexistente (FK): payload de um fato que não existe — não adianta tentar de novo.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') return null
      throw err
    }
    return db.notificationLog.findUnique({ where: { userId_type_channel_entityId: { userId: d.userId, type: d.tipo, channel: 'EMAIL', entityId: d.entityId } }, select: { id: true, status: true } })
  }

  async function dispensar(id: string, motivo: string): Promise<void> {
    await db.notificationLog.update({ where: { id }, data: { status: 'SKIPPED', statusReason: codigoSeguroDeMotivo(motivo, 'SKIPPED'), lastAttemptAt: agora() } })
  }

  async function marcarEnviada(id: string, messageId: string | undefined): Promise<void> {
    const quando = agora()
    // O e-mail JÁ saiu: se o banco soluçar aqui, tenta de novo algumas vezes antes de desistir (desistir deixa a linha PENDING e um reprocessamento reenviaria).
    for (let tentativa = 1; ; tentativa++) {
      try {
        await db.notificationLog.update({ where: { id }, data: { status: 'SENT', sentAt: quando, lastAttemptAt: quando, statusReason: null, providerMessageId: messageId ?? null } })
        return
      } catch (err) {
        if (tentativa >= 3) {
          log.error({ err, event: 'notification_mark_sent_failed', notificationId: id }, '[notificacoes] o e-mail saiu, mas não consegui gravar SENT (um reprocessamento pode reenviar)')
          return
        }
        await new Promise((r) => setTimeout(r, 150 * tentativa))
      }
    }
  }

  async function sobLock(d: NotificacaoJobData): Promise<ResultadoDoProcessamento> {
    const linha = await reservar(d)
    if (!linha) {
      log.warn({ event: 'notification_user_missing', tipo: d.tipo, userId: d.userId }, '[notificacoes] usuário do aviso não existe — descartado')
      return { status: 'INVALIDA' }
    }
    if (linha.status !== 'PENDING') return { status: 'JA_TRATADA', estado: linha.status as 'SENT' | 'SKIPPED' | 'FAILED' }

    const usuario = await db.user.findUnique({ where: { id: d.userId }, select: { name: true, email: true, active: true, deletedAt: true } })
    if (!usuario) {
      await dispensar(linha.id, 'ACCOUNT_NOT_FOUND')
      return { status: 'DISPENSADA', motivo: 'ACCOUNT_NOT_FOUND' }
    }
    // ACCOUNT_DELETED sai para uma conta que JÁ não existe mais (anonimizada); todos os outros só para conta viva.
    if (d.tipo !== 'ACCOUNT_DELETED' && (!usuario.active || usuario.deletedAt !== null)) {
      await dispensar(linha.id, 'ACCOUNT_INACTIVE')
      return { status: 'DISPENSADA', motivo: 'ACCOUNT_INACTIVE' }
    }
    if (d.tipo !== 'ACCOUNT_DELETED' && !EMAIL_SIMPLES.test(usuario.email)) {
      await dispensar(linha.id, 'NO_RECIPIENT')
      return { status: 'DISPENSADA', motivo: 'NO_RECIPIENT' }
    }

    const prefsLinha = await db.notificationPreference.findUnique({ where: { userId: d.userId }, select: { sessionReceiptEmail: true, lowBalanceEnabled: true, lowBalanceThresholdCents: true } })
    const prefs = prefsLinha ?? { ...PREFERENCIAS_PADRAO }
    const decisao = decidirEnvio(d.tipo, prefs)
    if (!decisao.enviar) {
      await dispensar(linha.id, decisao.motivo)
      return { status: 'DISPENSADA', motivo: decisao.motivo }
    }

    const ctx: ContextoDoEmail = { nome: usuario.name, baseUrl: deps.baseUrl(), empresa: await deps.empresa() }
    const montagem = await montarEmail(db, d, ctx, prefs, usuario.email, agora())
    if ('dispensar' in montagem) {
      await dispensar(linha.id, montagem.dispensar)
      return { status: 'DISPENSADA', motivo: montagem.dispensar }
    }

    await db.notificationLog.update({ where: { id: linha.id }, data: { attempts: { increment: 1 }, lastAttemptAt: agora() } })

    let resultado: ResultadoEmailTransacional
    const prazo = deps.prazoDoEnvioMs ?? PRAZO_DO_ENVIO_PADRAO_MS
    try {
      resultado = await withDeadline(deps.enviar({ to: montagem.para, subject: montagem.email.subject, text: montagem.email.text, html: montagem.email.html }), prazo, 'enviar e-mail da notificação')
    } catch (err) {
      const codigo = err instanceof DeadlineExceededError ? 'SEND_TIMEOUT' : 'SEND_ERROR'
      await db.notificationLog.update({ where: { id: linha.id }, data: { statusReason: codigo } }).catch(() => undefined)
      return { status: 'REPETIR', codigo }
    }
    if (!resultado.ok) {
      const codigo = codigoSeguroDeMotivo(resultado.code)
      await db.notificationLog.update({ where: { id: linha.id }, data: { statusReason: codigo } }).catch(() => undefined)
      return { status: 'REPETIR', codigo }
    }
    await marcarEnviada(linha.id, resultado.messageId)
    return { status: 'ENVIADA' }
  }

  return {
    /** Nunca lança por dado ruim (devolve `INVALIDA`); lança só por infraestrutura (Redis/banco fora) — o BullMQ retenta. */
    async processar(dados: unknown): Promise<ResultadoDoProcessamento> {
      if (!dadosValidos(dados)) {
        log.error({ event: 'notification_job_invalid' }, '[notificacoes] job com payload inválido — descartado')
        return { status: 'INVALIDA' }
      }
      const chave = chaveDoLockDaNotificacao(dados.tipo, dados.userId, dados.entityId)
      const token = await withDeadline(adquirirLock(deps.redis, chave, deps.ttlDoLockMs ?? TTL_DO_LOCK_PADRAO_MS), PRAZO_REDIS_MS, 'adquirir o lock da notificação')
      if (token === null) return { status: 'REPETIR', codigo: 'LOCKED' }
      try {
        return await sobLock(dados)
      } finally {
        await withDeadline(liberarLock(deps.redis, chave, token), PRAZO_REDIS_MS, 'liberar o lock da notificação').catch(() => undefined) // o TTL cobre a falha
      }
    },

    /**
     * As tentativas ACABARAM (o job vai para `failed` de vez): marca `FAILED` com o código do motivo (nunca a mensagem). Só mexe em linha `PENDING` (um `SENT` nunca vira `FAILED`).
     * Devolve `true` se marcou (o worker então emite o alerta).
     */
    async marcarEsgotada(dados: unknown, motivoBruto: string): Promise<boolean> {
      if (!dadosValidos(dados)) return false
      const codigo = codigoSeguroDeMotivo(motivoBruto, 'SEND_FAILED')
      try {
        await db.notificationLog.createMany({ data: [{ userId: dados.userId, type: dados.tipo, channel: 'EMAIL', entityId: dados.entityId }], skipDuplicates: true })
        const r = await db.notificationLog.updateMany({
          where: { userId: dados.userId, type: dados.tipo, channel: 'EMAIL', entityId: dados.entityId, status: 'PENDING' },
          data: { status: 'FAILED', statusReason: codigo, lastAttemptAt: agora() },
        })
        return r.count > 0
      } catch (err) {
        log.error({ err, event: 'notification_mark_failed_error', tipo: dados.tipo }, '[notificacoes] não consegui marcar a notificação como FAILED')
        return false
      }
    },
  }
}

export type ProcessadorDeNotificacoes = ReturnType<typeof criarProcessadorDeNotificacoes>
