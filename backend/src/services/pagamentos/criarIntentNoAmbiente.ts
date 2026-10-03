import type { PaymentEnvironment, PaymentIntent, Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { AppError } from '../../api/middleware/errorHandler'
import { ConfiguracaoGatewayIndisponivelError } from '../../core/pagamentos/erros'
import { paraPaymentEnvironment, resolverEstadoEfetivo } from '../../core/pagamentos/configGateway'
import { lerEnvGateway, linhaDeRowDoBanco } from './gatewayConfig'

/**
 * Criação de `PaymentIntent` SERIALIZADA com a troca de ambiente do gateway (F5.8, M4c — achado da Íris).
 *
 * O problema: o `PUT /api/admin/payment-gateway` conta os intents vivos do ambiente atual dentro da sua transação e bloqueia a troca se houver. Mas quem CRIAVA o
 * intent (Pix, pré-autorização de cartão) lia o ambiente do cache (10 s por processo) e gravava SEM tocar a config: um intent criado entre a contagem e o commit da
 * troca nascia com o ambiente ANTIGO, vivo, depois que o efetivo já virou — Pix pago e não creditado (a guarda `ambienteDoIntent` o protegia, mas o dinheiro ficava parado).
 *
 * A correção: um LOCK CONSULTIVO de transação, compartilhado por quem cria intent (`pg_advisory_xact_lock_shared`) e EXCLUSIVO por quem troca a config
 * (`pg_advisory_xact_lock`, primeira coisa na transação do PUT). Resultado: ou o intent commita ANTES de a troca começar (e a contagem o enxerga: 409
 * `GATEWAY_HAS_INFLIGHT_PAYMENTS`), ou espera a troca commitar e nasce no ambiente NOVO. O ambiente gravado vem da leitura FEITA SOB O LOCK, na mesma transação — nunca do cache.
 *
 * Por que lock consultivo e não `SELECT ... FOR SHARE` na linha de config: a linha pode NÃO EXISTIR ainda (ambiente vindo só do env; o 1º PUT a semeia no próprio INSERT) e
 * `FOR SHARE` numa linha ausente não trava nada — a corrida ficaria aberta justamente na 1ª troca. O lock consultivo não depende da linha. Sem deadlock possível: os dois
 * lados pegam este lock PRIMEIRO e depois só tocam linhas que ninguém mais trava (o PUT trava a config; o criador só INSERE o intent). Latência: o criador só espera enquanto
 * um PUT está em andamento (um ato raro do admin, de dezenas de ms).
 */

/** Chave do lock consultivo (texto -> `hashtext`, int4). Literal fixo no SQL: nada parametrizado, nada vindo do cliente. */
export async function travarConfigGatewayParaTroca(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('payment_gateway_config'))`
}

export async function travarConfigGatewayParaCriarIntent(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext('payment_gateway_config'))`
}

/** Ambiente efetivo LIDO NA TRANSAÇÃO (banco manda, env é reserva) — sem cache. Ambiente ilegível => `ConfiguracaoGatewayIndisponivelError`. */
async function ambienteEfetivoNaTransacao(tx: Prisma.TransactionClient): Promise<PaymentEnvironment> {
  const row = await tx.paymentGatewayConfig.findUnique({ where: { id: 1 } })
  const linha = row ? linhaDeRowDoBanco(row) : null
  return paraPaymentEnvironment(resolverEstadoEfetivo(linha, lerEnvGateway()).environment)
}

export type DadosDoIntent = Omit<Prisma.PaymentIntentUncheckedCreateInput, 'environment'>

/**
 * Cria o `PaymentIntent` marcando-o com o ambiente efetivo lido SOB O LOCK. `ambienteEsperado` (opcional): o ambiente que o chamador já usou para decidir algo anterior
 * (ex.: o cartão escolhido só vale no ambiente em que foi tokenizado) — se mudou no meio do caminho, recusa com 503 em vez de rotular o intent com um ambiente que não é o
 * do cartão. Config ilegível => 503 `PAYMENT_GATEWAY_UNAVAILABLE` (fail-closed).
 */
export async function criarPaymentIntentNoAmbienteEfetivo(dados: DadosDoIntent, opcoes: { ambienteEsperado?: PaymentEnvironment } = {}): Promise<PaymentIntent> {
  try {
    return await prisma.$transaction(async (tx) => {
      await travarConfigGatewayParaCriarIntent(tx)
      const environment = await ambienteEfetivoNaTransacao(tx)
      if (opcoes.ambienteEsperado !== undefined && opcoes.ambienteEsperado !== environment) {
        throw new AppError('O pagamento está indisponível no momento. Tente novamente em instantes.', 503, 'PAYMENT_GATEWAY_UNAVAILABLE')
      }
      return tx.paymentIntent.create({ data: { ...dados, environment } })
    })
  } catch (err) {
    if (err instanceof ConfiguracaoGatewayIndisponivelError) throw new AppError('O pagamento está indisponível no momento. Tente novamente em instantes.', 503, 'PAYMENT_GATEWAY_UNAVAILABLE')
    throw err
  }
}
