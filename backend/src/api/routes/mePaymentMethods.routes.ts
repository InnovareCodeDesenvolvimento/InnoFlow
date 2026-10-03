import { Router } from 'express'
import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { getPagamentoPort } from '../../services/pagamentos/pagamentoPortInstance'
import { assertMeioDePagamentoHabilitado } from '../../services/pagamentos/gatewayConfig'
import { encryptPaymentSecret } from '../../lib/crypto/paymentSecrets'
import { CartaoTokenInvalidoError } from '../../core/pagamentos/erros'
import { toMePaymentMethodDto } from '../../services/pagamentos/paymentMethodDto'
import { AppError } from '../middleware/errorHandler'
import { asyncHandler } from '../middleware/asyncHandler'
import { validateBody } from '../middleware/validate'
import { meCreatePaymentMethodRateLimit, meTokenizationSessionRateLimit } from '../middleware/rateLimit'
import { meCreatePaymentMethodSchema, meUpdatePaymentMethodSchema, type MeCreatePaymentMethodInput, type MeUpdatePaymentMethodInput } from '../schemas/mePaymentMethods.schema'

/**
 * Cadastro de cartão do motorista (F5.3, D1 do dono: cartão salvo/SAQ A-EP).
 * Montado em `/api/me/payment-methods` por `me.routes.ts` — herda
 * `authenticate` + `requireRole('DRIVER')` do router pai, mesma regra dura
 * de lá: NENHUMA rota deste arquivo lê `userId` de body/query/param, sempre
 * `req.user!.userId`; cartão de outro motorista => 404 (nunca 403).
 *
 * Contrato LITERAL de `frontend/src/types/api.ts` — ver handoff da tarefa.
 */

/** Teto de cartões ATIVOS por motorista — mitigação de fraude (Órion): sem isto, um script com uma lista de CardTokens roubados usaria esta rota para "testar" cada um. Fixo (não é parâmetro de negócio tunável como os limites de Pix). */
const MAX_PAYMENT_METHODS_PER_USER = 5

const router = Router()

async function resolverPortOu503() {
  try {
    return await getPagamentoPort()
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, '[api][me] gateway de pagamento indisponível ao cadastrar cartão')
    throw new AppError('O cadastro de cartão está indisponível no momento. Tente novamente em instantes.', 503, 'PAYMENT_GATEWAY_UNAVAILABLE')
  }
}

// ------------------------------------------------------------
// POST /tokenization-session — accessToken para a página isolada da Lyra
// ------------------------------------------------------------

router.post(
  '/tokenization-session',
  meTokenizationSessionRateLimit,
  asyncHandler(async (req, res) => {
    const userId = req.user!.userId
    // F5.5: cartão desligado na tela do gateway => nem sessão de tokenização (cadastro de cartão novo).
    await assertMeioDePagamentoHabilitado('CARD', userId)
    let sessao
    try {
      sessao = await (await getPagamentoPort()).sessaoTokenizacao()
    } catch (err) {
      // Erro de CONFIGURAÇÃO (env ausente) ou de rede/OAuth com a Cielo —
      // os dois viram 503: não é o motorista que errou, é o gateway que não
      // está disponível/configurado (mesmo code que o Pix já usa).
      logger.error({ err: err instanceof Error ? err.message : String(err), userId }, '[api][me] falha ao criar sessão de tokenização')
      throw new AppError('O cadastro de cartão está indisponível no momento. Tente novamente em instantes.', 503, 'PAYMENT_GATEWAY_UNAVAILABLE')
    }

    res.json({
      accessToken: sessao.accessToken,
      merchantId: sessao.merchantId,
      environment: sessao.environment,
      scriptUrl: sessao.scriptUrl,
      expiresAt: sessao.expiresAt.toISOString(),
    })
  }),
)

// ------------------------------------------------------------
// POST / — cadastra o cartão (recebe o CardToken já tokenizado no navegador)
// ------------------------------------------------------------

router.post(
  '/',
  meCreatePaymentMethodRateLimit,
  validateBody(meCreatePaymentMethodSchema),
  asyncHandler(async (req, res) => {
    const userId = req.user!.userId
    const { cardToken, brand, makeDefault } = req.body as MeCreatePaymentMethodInput

    // F5.5: cartão desligado na tela do gateway => não cadastra cartão novo (checagem ANTES de qualquer chamada à Cielo).
    await assertMeioDePagamentoHabilitado('CARD', userId)

    // Checagem RÁPIDA antes de gastar uma chamada de rede na Cielo — a
    // checagem de VERDADE (que fecha a maior parte da janela de corrida)
    // roda de novo dentro da transação, logo antes do INSERT.
    const activeCountAntes = await prisma.paymentMethod.count({ where: { userId, active: true } })
    if (activeCountAntes >= MAX_PAYMENT_METHODS_PER_USER) {
      throw new AppError('Você já tem o número máximo de cartões cadastrados.', 409, 'TOO_MANY_PAYMENT_METHODS')
    }

    // Resolver o adaptador FORA do try: gateway bloqueado/ilegível é 503 (indisponível), não "falha ao verificar o cartão" (502).
    const pagamentoPort = await resolverPortOu503()
    let dadosCartao
    try {
      dadosCartao = await pagamentoPort.consultarCartaoTokenizado(cardToken)
    } catch (err) {
      if (err instanceof CartaoTokenInvalidoError) {
        throw new AppError('Cartão inválido ou não reconhecido.', 400, 'INVALID_CARD_TOKEN')
      }
      // Timeout/5xx/erro de rede — NUNCA logar `cardToken` (ver logRedactPaths.ts).
      logger.error({ err: err instanceof Error ? err.message : String(err), userId }, '[api][me] falha ao verificar cartão na Cielo')
      throw new AppError('Não foi possível verificar o cartão no momento. Tente novamente.', 502, 'CARD_VERIFICATION_FAILED')
    }

    // Cifra ANTES de qualquer log/erro subsequente poder tocar a variável —
    // `cardToken` em claro nunca é passado adiante depois deste ponto.
    const cieloCardTokenCiphertext = encryptPaymentSecret(cardToken)
    // Brand da Cielo é a fonte de VERDADE quando disponível (não confirmado
    // se `GET /1/card/{token}` devolve — ver `cieloAdapter.ts`); cai pro
    // valor que o cliente mandou (resultado da própria tokenização) senão.
    const resolvedBrand = dadosCartao.brand ?? brand

    const created = await prisma.$transaction(async (tx) => {
      const activeCountAgora = await tx.paymentMethod.count({ where: { userId, active: true } })
      if (activeCountAgora >= MAX_PAYMENT_METHODS_PER_USER) {
        throw new AppError('Você já tem o número máximo de cartões cadastrados.', 409, 'TOO_MANY_PAYMENT_METHODS')
      }
      const shouldBeDefault = makeDefault === true || activeCountAgora === 0
      if (shouldBeDefault) {
        await tx.paymentMethod.updateMany({ where: { userId, active: true, isDefault: true }, data: { isDefault: false } })
      }
      return tx.paymentMethod.create({
        data: {
          userId,
          type: 'CREDIT_CARD',
          cieloCardTokenCiphertext,
          brand: resolvedBrand,
          last4: dadosCartao.last4,
          holderName: dadosCartao.holderName,
          expiryMonth: dadosCartao.expiryMonth,
          expiryYear: dadosCartao.expiryYear,
          isDefault: shouldBeDefault,
        },
      })
    })

    logger.info({ userId, paymentMethodId: created.id, brand: created.brand, last4: created.last4 }, '[api][me] cartão cadastrado')
    res.status(201).json(toMePaymentMethodDto(created))
  }),
)

// ------------------------------------------------------------
// GET / — lista os cartões ATIVOS do motorista (sem paginação: teto de
// MAX_PAYMENT_METHODS_PER_USER torna a lista sempre pequena por desenho)
// ------------------------------------------------------------

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const userId = req.user!.userId
    const items = await prisma.paymentMethod.findMany({
      where: { userId, active: true },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    })
    res.json({ items: items.map(toMePaymentMethodDto) })
  }),
)

// ------------------------------------------------------------
// PATCH /:id — marca como padrão (só aceita isDefault: true)
// ------------------------------------------------------------

router.patch(
  '/:id',
  validateBody(meUpdatePaymentMethodSchema),
  asyncHandler(async (req, res) => {
    const userId = req.user!.userId
    const { id } = req.params
    void (req.body as MeUpdatePaymentMethodInput) // validado — só existe isDefault: true

    const updated = await prisma.$transaction(async (tx) => {
      const method = await tx.paymentMethod.findFirst({ where: { id, userId, active: true } })
      if (!method) return null
      if (!method.isDefault) {
        await tx.paymentMethod.updateMany({ where: { userId, active: true, isDefault: true }, data: { isDefault: false } })
      }
      return tx.paymentMethod.update({ where: { id: method.id }, data: { isDefault: true } })
    })

    if (!updated) throw new AppError('Cartão não encontrado.', 404, 'PAYMENT_METHOD_NOT_FOUND')
    res.json(toMePaymentMethodDto(updated))
  }),
)

// ------------------------------------------------------------
// DELETE /:id — soft delete (active=false). Só o dono mexe no próprio
// cartão: outro usuário => 404 (nunca 403, mesma convenção anti-enumeração
// do resto da API).
// ------------------------------------------------------------

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const userId = req.user!.userId
    const { id } = req.params

    const found = await prisma.$transaction(async (tx) => {
      const method = await tx.paymentMethod.findFirst({ where: { id, userId, active: true } })
      if (!method) return null
      await tx.paymentMethod.update({ where: { id: method.id }, data: { active: false, isDefault: false } })
      // Cartão removido era o padrão e sobraram outros ativos: promove o mais
      // recente a padrão (decisão de UX — não deixar o motorista sem cartão
      // padrão algum quando ele ainda tem opção; não faz parte do contrato
      // literal, sinalizado no handoff).
      if (method.isDefault) {
        const proximo = await tx.paymentMethod.findFirst({ where: { userId, active: true }, orderBy: { createdAt: 'desc' } })
        if (proximo) await tx.paymentMethod.update({ where: { id: proximo.id }, data: { isDefault: true } })
      }
      return method
    })

    if (!found) throw new AppError('Cartão não encontrado.', 404, 'PAYMENT_METHOD_NOT_FOUND')
    logger.info({ userId, paymentMethodId: found.id }, '[api][me] cartão removido (soft delete)')
    res.status(204).send()
  }),
)

export default router
