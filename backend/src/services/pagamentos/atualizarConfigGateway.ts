import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { encryptPaymentSecret, isPaymentSecretsKeyConfigured } from '../../lib/crypto/paymentSecrets'
import { diffEntity, type EntityDiff } from '../../core/auditoria/diffEntity'
import { avaliarMudancaDeConfig, calcularReadiness, paraPaymentEnvironment, resolverEstadoEfetivo, type AmbienteGateway, type EstadoEfetivo, type LinhaConfigGateway } from '../../core/pagamentos/configGateway'
import { AppError } from '../../api/middleware/errorHandler'
import type { UpdatePaymentGatewayConfigBody } from '../../api/schemas/paymentGateway.schema'
import { writeAuditLog } from '../auditoria/writeAuditLog'
import { invalidarCacheConfigGateway, lerEnvGateway } from './gatewayConfig'
import { travarConfigGatewayParaTroca } from './criarIntentNoAmbiente'

/**
 * Grava a configuração do gateway (F5.5) — `PUT /api/admin/payment-gateway`.
 *
 * AUDITORIA FAIL-CLOSED (Órion, recomendação 4): o upsert da config e a linha de `AuditLog`
 * (`PAYMENT_CONFIG_CHANGE`, ator = o ADMIN) saem na MESMA `$transaction` — se a auditoria falhar, NADA é gravado
 * (mesmo padrão do ajuste manual de saldo, `walletLedger.ts`). A rota marca `skip: true` no `auditCtx` para o
 * middleware genérico não duplicar a linha.
 *
 * CONCORRÊNCIA: lock consultivo exclusivo (F5.8, M4c) serializa a troca com a CRIAÇÃO de `PaymentIntent`; depois, `INSERT ... ON CONFLICT DO NOTHING` garante a linha singleton e `SELECT ... FOR UPDATE` a
 * trava até o commit — dois admins gravando juntos se serializam (o segundo calcula o "antes" sobre o resultado
 * do primeiro, nada de último-escreve-silenciosamente-por-cima). A linha semeada na PRIMEIRA gravação parte do
 * que já valia pelo ambiente (ambiente e "habilitado = há credenciais"), para salvar um campo qualquer não
 * desligar sem querer o que funcionava só pelo env; se a validação falhar, o INSERT semeado volta junto
 * (rollback) — uma tentativa recusada não deixa linha para trás.
 *
 * SEGREDOS: cifrados com `encryptPaymentSecret` antes de tocar o banco; NUNCA em log nem na auditoria (nem
 * cifrados) — `changes` leva só `{changed: true}`; campos não secretos entram com antes/depois.
 */

export interface AtorConfigGateway {
  userId: string
  role: 'ADMIN' | 'OPERATOR' | 'DRIVER'
  email: string
  name: string
  operatorId: string | null
}

export interface RequisicaoConfigGateway {
  method: string
  path: string
  ipAddress: string | null
  userAgent: string | null
  requestId: string | null
}

/** `PaymentIntent` "vivo": ainda vai falar com a Cielo (autorizar/reconsultar/capturar/creditar). Trocar o ambiente do gateway enquanto houver um é bloqueado (M4c). */
export const STATUS_DE_INTENT_VIVO = ['CREATED', 'AUTHORIZED', 'PENDING', 'CAPTURE_PENDING'] as const

/** Campos não secretos que entram na auditoria com antes/depois. */
const CAMPOS_AUDITAVEIS = ['environment', 'merchantId', 'sopClientId', 'cardEnabled', 'pixEnabled'] as const
const SEGREDOS = ['merchantKey', 'sopClientSecret', 'webhookHeaderSecret'] as const

type RowBanco = {
  environment: string
  merchantId: string | null
  merchantKeyCiphertext: string | null
  sopClientId: string | null
  sopClientSecretCiphertext: string | null
  webhookHeaderSecretCiphertext: string | null
  cardEnabled: boolean
  pixEnabled: boolean
  updatedAt: Date
}

function linhaDoBanco(row: RowBanco): LinhaConfigGateway {
  return {
    environment: row.environment as AmbienteGateway,
    merchantId: row.merchantId,
    merchantKeyCiphertext: row.merchantKeyCiphertext,
    sopClientId: row.sopClientId,
    sopClientSecretCiphertext: row.sopClientSecretCiphertext,
    webhookHeaderSecretCiphertext: row.webhookHeaderSecretCiphertext,
    cardEnabled: row.cardEnabled,
    pixEnabled: row.pixEnabled,
    updatedAt: row.updatedAt,
  }
}

function snapshotAuditavel(estado: EstadoEfetivo): Record<string, unknown> {
  return { environment: estado.environment, merchantId: estado.merchantId, sopClientId: estado.sopClientId, cardEnabled: estado.cardEnabled, pixEnabled: estado.pixEnabled }
}

export async function atualizarConfigGateway(params: { body: UpdatePaymentGatewayConfigBody; actor: AtorConfigGateway; request: RequisicaoConfigGateway }): Promise<{ camposAlterados: string[] }> {
  const { body, actor, request } = params
  const segredosEnviados = SEGREDOS.filter((k) => body[k] !== undefined)

  // Sem a chave de cifragem do servidor não há como guardar segredo — recusa ANTES de abrir transação.
  if (segredosEnviados.length > 0 && !isPaymentSecretsKeyConfigured()) {
    throw new AppError('O servidor não tem a chave de cifragem (PAYMENT_SECRETS_KEY) configurada: não é possível guardar segredos de pagamento.', 503, 'PAYMENT_SECRETS_KEY_MISSING')
  }

  const envGateway = lerEnvGateway()
  const semeadoAmbiente: AmbienteGateway = envGateway.sandbox ? 'sandbox' : 'production'
  const semeadoHabilitado = Boolean(envGateway.merchantId && envGateway.temMerchantKey)

  const camposAlterados = await prisma.$transaction(async (tx) => {
    // F5.8 (M4c): PRIMEIRA coisa da transação — lock consultivo EXCLUSIVO, o par do lock COMPARTILHADO de quem cria PaymentIntent (`criarIntentNoAmbiente.ts`). Cria-intent e
    // troca-de-ambiente se serializam: o intent ou entra na contagem de vivos abaixo, ou espera a troca e nasce no ambiente novo. Vem ANTES do INSERT/FOR UPDATE (mesma ordem em todo mundo).
    await travarConfigGatewayParaTroca(tx)
    const inseridas = await tx.$executeRaw`
      INSERT INTO "PaymentGatewayConfig" ("id", "environment", "cardEnabled", "pixEnabled", "createdAt", "updatedAt")
      VALUES (1, ${semeadoAmbiente}, ${semeadoHabilitado}, ${semeadoHabilitado}, NOW(), NOW())
      ON CONFLICT ("id") DO NOTHING`
    const criada = inseridas === 1

    await tx.$queryRaw`SELECT "id" FROM "PaymentGatewayConfig" WHERE "id" = 1 FOR UPDATE`
    const rowAntes = await tx.paymentGatewayConfig.findUniqueOrThrow({ where: { id: 1 } })

    const estadoAntes = resolverEstadoEfetivo(linhaDoBanco(rowAntes), envGateway)

    const data: Prisma.PaymentGatewayConfigUpdateInput = {}
    if (body.environment !== undefined) data.environment = body.environment
    if (body.merchantId !== undefined) data.merchantId = body.merchantId
    if (body.merchantKey !== undefined) data.merchantKeyCiphertext = encryptPaymentSecret(body.merchantKey)
    if (body.sopClientId !== undefined) data.sopClientId = body.sopClientId
    if (body.sopClientSecret !== undefined) data.sopClientSecretCiphertext = encryptPaymentSecret(body.sopClientSecret)
    if (body.webhookHeaderSecret !== undefined) data.webhookHeaderSecretCiphertext = encryptPaymentSecret(body.webhookHeaderSecret)
    if (body.cardEnabled !== undefined) data.cardEnabled = body.cardEnabled
    if (body.pixEnabled !== undefined) data.pixEnabled = body.pixEnabled

    const rowDepois = await tx.paymentGatewayConfig.update({ where: { id: 1 }, data })
    const estadoDepois = resolverEstadoEfetivo(linhaDoBanco(rowDepois), envGateway)

    // `antes` de uma linha recém-semeada é, para a regra, "nada salvo ainda" (source 'env').
    const antesParaRegra: EstadoEfetivo = criada ? { ...estadoAntes, source: 'env', updatedAt: null } : estadoAntes
    const erro = avaliarMudancaDeConfig({
      antes: antesParaRegra,
      depois: estadoDepois,
      readinessAntes: calcularReadiness(antesParaRegra, envGateway),
      readinessDepois: calcularReadiness(estadoDepois, envGateway),
      confirmProduction: body.confirmProduction === true,
    })
    if (erro?.kind === 'PRODUCTION_CONFIRMATION_REQUIRED') {
      throw new AppError('Mudar para produção exige confirmação explícita.', 400, 'PRODUCTION_CONFIRMATION_REQUIRED')
    }
    if (erro?.kind === 'GATEWAY_NOT_READY') {
      throw new AppError('O gateway não está pronto para este estado: faltam pré-requisitos.', 409, 'GATEWAY_NOT_READY', erro.missing)
    }

    // F5.7 (M4c): trocar o AMBIENTE (qualquer direção) com PaymentIntent VIVO do ambiente atual deixaria esses pagamentos sendo reconsultados/capturados/cancelados no
    // host errado. Bloqueia até liquidarem. Dentro da mesma transação (a linha está travada FOR UPDATE: dois admins não furam a regra um do outro).
    if (body.environment !== undefined && body.environment !== antesParaRegra.environment) {
      const vivos = await tx.paymentIntent.count({ where: { environment: paraPaymentEnvironment(antesParaRegra.environment), status: { in: [...STATUS_DE_INTENT_VIVO] } } })
      if (vivos > 0) {
        throw new AppError('Há pagamentos em andamento no ambiente atual. Aguarde liquidarem para trocar o ambiente.', 409, 'GATEWAY_HAS_INFLIGHT_PAYMENTS', { count: vivos })
      }
    }

    const changes: EntityDiff = { ...(diffEntity(snapshotAuditavel(antesParaRegra), snapshotAuditavel(estadoDepois), CAMPOS_AUDITAVEIS) ?? {}) }
    if (criada) changes.source = { from: 'env', to: 'database' }
    for (const segredo of segredosEnviados) changes[segredo] = { changed: true } // marcador — NUNCA o valor, nem cifrado

    // FAIL-CLOSED: se isto lançar, o `$transaction` inteiro reverte (config volta ao que era).
    await writeAuditLog(
      {
        actorUserId: actor.userId,
        actorRole: actor.role,
        actorEmail: actor.email,
        actorName: actor.name,
        actorOperatorId: actor.operatorId,
        action: 'PAYMENT_CONFIG_CHANGE',
        outcome: 'SUCCESS',
        httpStatus: 200,
        entityType: 'PaymentGatewayConfig',
        entityId: '1',
        method: request.method,
        path: request.path,
        ipAddress: request.ipAddress,
        userAgent: request.userAgent,
        requestId: request.requestId,
        changes: Object.keys(changes).length > 0 ? changes : null,
      },
      tx,
    )

    return Object.keys(changes)
  })

  // ALERTA (M2): toda gravação bem-sucedida da conta que recebe o dinheiro da plataforma é um evento que o dono quer ver. Só NOMES de campos
  // (os ENVIADOS, mesmo que o valor não tenha mudado, + os que mudaram) — nunca valores (regra de log do projeto + dos segredos desta tela).
  const changedFields = [...new Set([...Object.keys(body).filter((k) => k !== 'confirmProduction'), ...camposAlterados])]
  logger.warn({ alert: 'payment_config_changed', actorUserId: actor.userId, changedFields }, '[pagamentos] configuração do gateway atualizada pelo admin')
  invalidarCacheConfigGateway() // o processo que gravou enxerga a mudança na hora; o worker, no máximo no TTL
  return { camposAlterados }
}
