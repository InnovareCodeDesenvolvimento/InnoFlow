import { Router } from 'express'
import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { avaliarElegibilidadeCartao, registrarTentativaDeCadastroDeCartao } from '../../services/pagamentos/elegibilidadeCartao'
import { getPagamentoPort, isUsandoFakeAdapter } from '../../services/pagamentos/pagamentoPortInstance'
import { assertMeioDePagamentoHabilitado, getAmbienteEfetivoParaBancoOu503 } from '../../services/pagamentos/gatewayConfig'
import { encryptPaymentSecret } from '../../lib/crypto/paymentSecrets'
import { CartaoTokenInvalidoError } from '../../core/pagamentos/erros'
import { toMePaymentMethodDto } from '../../services/pagamentos/paymentMethodDto'
import { travarCartoesDoUsuario } from '../../services/pagamentos/travaCartoesDoUsuario'
import { AppError } from '../middleware/errorHandler'
import { asyncHandler } from '../middleware/asyncHandler'
import { validateBody } from '../middleware/validate'
import { meCreatePaymentMethodRateLimit, meTokenizationSessionRateLimit } from '../middleware/rateLimit'
import { ehCardTokenDeMock, meCreatePaymentMethodSchema, meUpdatePaymentMethodSchema, type MeCreatePaymentMethodInput, type MeUpdatePaymentMethodInput } from '../schemas/mePaymentMethods.schema'

/**
 * Cadastro de cartão do motorista (F5.3, D1 do dono: cartão salvo/SAQ A-EP).
 * Montado em `/api/me/payment-methods` por `me.routes.ts` — herda
 * `authenticate` + `requireRole('DRIVER')` do router pai, mesma regra dura
 * de lá: NENHUMA rota deste arquivo lê `userId` de body/query/param, sempre
 * `req.user!.userId`; cartão de outro motorista => 404 (nunca 403).
 *
 * Contrato LITERAL de `frontend/src/types/api.ts` — ver handoff da tarefa.
 *
 * F5.7 (M4, marca de ambiente): TODA rota daqui enxerga só os cartões do ambiente EFETIVO do gateway (`PaymentMethod.environment` =
 * `SANDBOX`/`PRODUCTION`); cartão do outro ambiente é "como se não existisse" (404). O padrão (`isDefault`) é resolvido por
 * `(userId, environment)` na aplicação — o banco NÃO garante "um padrão por usuário" (e nunca poderia: há um por ambiente).
 */

/**
 * Teto de cartões ATIVOS por motorista — mitigação de fraude (Órion): sem isto, um script com uma lista de CardTokens roubados usaria esta rota para "testar" cada um. Fixo (não é parâmetro de negócio tunável como os limites de Pix).
 * F5.7 (M4): conta só os cartões do AMBIENTE EFETIVO — os do outro ambiente "não existem" para o motorista (e não ocupam vaga).
 */
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
    await assertMeioDePagamentoHabilitado('CARD', userId, { ip: req.ip })
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

    // S-5: o AccessToken do SOP vai ao navegador (validade ~540 s) — nunca em cache de proxy/navegador.
    // S-9 (minimização de dados): o `merchantId` NÃO vai ao navegador — o script do SOP só precisa do AccessToken (que já carrega o lojista) e o front não o usa.
    // A validade (`expiresAt`) vem da `ExpiresIn` da Braspag menos 30 s; a emissão do AccessToken (`POST /accesstoken`) não tem parâmetro documentado para encurtá-la, então não é configurável.
    res.setHeader('Cache-Control', 'no-store')
    res.json({
      accessToken: sessao.accessToken,
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
    const { cardToken, brand, makeDefault, last4: last4Enviado, expiryMonth: expiryMonthEnviado, expiryYear: expiryYearEnviado } = req.body as MeCreatePaymentMethodInput

    // F5.5: cartão desligado na tela do gateway => não cadastra cartão novo (checagem ANTES de qualquer chamada à Cielo).
    await assertMeioDePagamentoHabilitado('CARD', userId, { ip: req.ip })
    // I-7: conta o cadastro TENTADO (mesmo que falhe depois) — 10 por dia por padrão; o bloqueio vale na PRÓXIMA tentativa.
    await registrarTentativaDeCadastroDeCartao({ userId, ip: req.ip })

    // O cartão nasce com o ambiente EFETIVO (explícito: a coluna tem DEFAULT SANDBOX e esquecer isto em produção rotularia token real como teste).
    const environment = await getAmbienteEfetivoParaBancoOu503()

    // Checagem RÁPIDA antes de gastar uma chamada de rede na Cielo — a checagem de VERDADE roda de novo dentro da transação, SOB o lock
    // consultivo do motorista (N-9: `travarCartoesDoUsuario`), logo antes do INSERT. Esta aqui só economiza a chamada à Cielo.
    const activeCountAntes = await prisma.paymentMethod.count({ where: { userId, active: true, environment } })
    if (activeCountAntes >= MAX_PAYMENT_METHODS_PER_USER) {
      throw new AppError('Você já tem o número máximo de cartões cadastrados.', 409, 'TOO_MANY_PAYMENT_METHODS')
    }

    // Resolver o adaptador FORA do try: gateway bloqueado/ilegível é 503 (indisponível), não "falha ao verificar o cartão" (502).
    // C1.3: com a Cielo real a consulta é só enriquecimento e NUNCA lança (o `GET /1/card` não está confirmado) — `INVALID_CARD_TOKEN`/502 abaixo
    // só valem para adaptadores que conseguem afirmar que o token é inválido (o FakeAdapter dos testes); a validade real do token se prova na 1ª pré-autorização.
    const pagamentoPort = await resolverPortOu503()
    // S-1: o token do SOP SIMULADO só vale com o FakeAdapter. Com a Cielo real ele iria à Cielo como "CardToken" (e poderia carregar o que o motorista digitou).
    if (ehCardTokenDeMock(cardToken) && !isUsandoFakeAdapter()) {
      throw new AppError('Cartão inválido ou não reconhecido.', 400, 'INVALID_CARD_TOKEN')
    }
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

    // Se o ambiente efetivo MUDOU durante a verificação na Cielo (o admin trocou o gateway), o token foi verificado num host e seria rotulado com o outro: recusa.
    if ((await getAmbienteEfetivoParaBancoOu503()) !== environment) {
      throw new AppError('O cadastro de cartão está indisponível no momento. Tente novamente em instantes.', 503, 'PAYMENT_GATEWAY_UNAVAILABLE')
    }

    // Cifra ANTES de qualquer log/erro subsequente poder tocar a variável —
    // `cardToken` em claro nunca é passado adiante depois deste ponto.
    const cieloCardTokenCiphertext = encryptPaymentSecret(cardToken)
    // C1.3: a Cielo é a fonte de VERDADE quando a consulta (opcional, melhor esforço) devolve dados; senão valem os que a página isolada enviou
    // (o script do SOP não devolve bandeira nem final — a página os conhece do que o motorista digitou).
    const resolvedBrand = dadosCartao.brand ?? brand
    const last4 = dadosCartao.last4 ?? last4Enviado ?? null
    const expiryMonth = dadosCartao.expiryMonth ?? expiryMonthEnviado ?? null
    const expiryYear = dadosCartao.expiryYear ?? expiryYearEnviado ?? null

    const created = await prisma.$transaction(async (tx) => {
      // N-9: serializa os cadastros do MESMO motorista — sem isto, N requisições paralelas liam a mesma contagem e todas inseriam (teto furado).
      await travarCartoesDoUsuario(tx, userId)
      const activeCountAgora = await tx.paymentMethod.count({ where: { userId, active: true, environment } })
      if (activeCountAgora >= MAX_PAYMENT_METHODS_PER_USER) {
        throw new AppError('Você já tem o número máximo de cartões cadastrados.', 409, 'TOO_MANY_PAYMENT_METHODS')
      }
      const shouldBeDefault = makeDefault === true || activeCountAgora === 0
      if (shouldBeDefault) {
        await tx.paymentMethod.updateMany({ where: { userId, active: true, environment, isDefault: true }, data: { isDefault: false } })
      }
      return tx.paymentMethod.create({
        data: {
          userId,
          environment,
          type: 'CREDIT_CARD',
          cieloCardTokenCiphertext,
          brand: resolvedBrand,
          last4,
          holderName: dadosCartao.holderName,
          expiryMonth,
          expiryYear,
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
    const environment = await getAmbienteEfetivoParaBancoOu503()
    const items = await prisma.paymentMethod.findMany({
      where: { userId, active: true, environment },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    })
    // I-7: a lista continua mostrando os cartões já cadastrados de quem não é elegível (inutilizáveis); `cardEligibility` diz se PODE pagar/cadastrar agora e por que não.
    const cardEligibility = await avaliarElegibilidadeCartao(userId, req.ip)
    res.json({ items: items.map(toMePaymentMethodDto), cardEligibility })
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
    const environment = await getAmbienteEfetivoParaBancoOu503()

    const updated = await prisma.$transaction(async (tx) => {
      await travarCartoesDoUsuario(tx, userId) // N-9: mesmo lock do cadastro — "um padrão por motorista/ambiente" também é regra de aplicação
      const method = await tx.paymentMethod.findFirst({ where: { id, userId, active: true, environment } })
      if (!method) return null
      if (!method.isDefault) {
        await tx.paymentMethod.updateMany({ where: { userId, active: true, environment, isDefault: true }, data: { isDefault: false } })
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
    const environment = await getAmbienteEfetivoParaBancoOu503()

    const found = await prisma.$transaction(async (tx) => {
      await travarCartoesDoUsuario(tx, userId) // N-9: mesmo lock do cadastro (a promoção do próximo padrão não corre com um cadastro/PATCH)
      const method = await tx.paymentMethod.findFirst({ where: { id, userId, active: true, environment } })
      if (!method) return null
      await tx.paymentMethod.update({ where: { id: method.id }, data: { active: false, isDefault: false } })
      // Cartão removido era o padrão e sobraram outros ativos: promove o mais
      // recente a padrão (decisão de UX — não deixar o motorista sem cartão
      // padrão algum quando ele ainda tem opção; não faz parte do contrato
      // literal, sinalizado no handoff).
      if (method.isDefault) {
        const proximo = await tx.paymentMethod.findFirst({ where: { userId, active: true, environment }, orderBy: { createdAt: 'desc' } })
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
