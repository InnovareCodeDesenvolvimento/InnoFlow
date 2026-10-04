/**
 * Paths sensíveis do `redact` do pino (ver `logger.ts`), extraídos para um
 * módulo PRÓPRIO — sem importar `env`/`pino` — só para isto poder ser
 * reutilizado pelo teste (`tests/unit/loggerRedact.test.ts`) sem duplicar a
 * lista à mão. A duplicação por comentário ("se mudar aqui, mude lá
 * também") é o tipo de contrato que quebra em silêncio: alguém edita
 * `logger.ts` sem lembrar do teste, e o teste continua verde testando uma
 * lista que não é mais a real. Módulo separado (em vez de importar
 * `logger.ts` inteiro no teste) porque `logger.ts` cria a instância real do
 * pino com transport `pino-pretty` como efeito colateral do import — pesado
 * e desnecessário só para testar a lista de campos.
 */
import { WEBHOOK_SECRET_HEADER_NAME_LOWER } from '../core/pagamentos/webhookHeader'

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'req.headers.merchantkey',
  // F5.5 — achado ao rodar o webhook contra Postgres real: o `pino-http` loga `req.headers` de TODA requisição e o
  // header do segredo do webhook da Cielo (valor EM CLARO do segredo compartilhado) saía no log a cada notificação.
  // Nome do header = `WEBHOOK_SECRET_HEADER_NAME_LOWER` (minúsculo, como o Node entrega; só letras desde a C1.4, então não precisa de colchetes).
  `req.headers.${WEBHOOK_SECRET_HEADER_NAME_LOWER}`,
  'CardNumber',
  '*.CardNumber',
  'SecurityCode',
  '*.SecurityCode',
  'CardToken',
  '*.CardToken',
  // F5.3 (cadastro de cartão) — `cardToken` é o nome do campo no CORPO da
  // requisição (`MeCreatePaymentMethodRequest.cardToken`, lowercase, contrato
  // de `frontend/src/types/api.ts`) e em variáveis internas ANTES de cifrar
  // — nome DIFERENTE do `CardToken` (PascalCase) do wire format da Cielo.
  // `fast-redact` é case-sensitive (achado já registrado da F5.1), por isso
  // entra separado, não é o mesmo path do de cima.
  'cardToken',
  '*.cardToken',
  'cieloCardTokenCiphertext',
  '*.cieloCardTokenCiphertext',
  'PaymentToken',
  '*.PaymentToken',
  'MerchantKey',
  '*.MerchantKey',
  'ClientSecret',
  '*.ClientSecret',
  'access_token',
  '*.access_token',
  // F5.3 — `accessToken` da sessão de tokenização (`MeCardTokenizationSessionResponse`,
  // camelCase — path PRÓPRIO, não o mesmo de `access_token` snake_case acima)
  // e o `client_secret`/Basic auth do OAuth do SOP (`cieloSopOAuth.ts`).
  'accessToken',
  '*.accessToken',
  'clientSecret',
  '*.clientSecret',
  'cpf',
  '*.cpf',
  // F5.5 (config do gateway, camelCase — nomes do corpo do `PUT /api/admin/payment-gateway` e das colunas de
  // `PaymentGatewayConfig`). `fast-redact` é case-sensitive e só casa 1 nível (`*.`): por isso cada nome entra
  // solto E com `*.`, e NÃO bastam `MerchantKey`/`ClientSecret` (PascalCase, outro nome).
  'merchantKey',
  '*.merchantKey',
  'sopClientSecret',
  '*.sopClientSecret',
  'webhookHeaderSecret',
  '*.webhookHeaderSecret',
  'merchantKeyCiphertext',
  '*.merchantKeyCiphertext',
  'sopClientSecretCiphertext',
  '*.sopClientSecretCiphertext',
  'webhookHeaderSecretCiphertext',
  '*.webhookHeaderSecretCiphertext',
  // F5.7 (M2, step-up) — a senha ATUAL do ADMIN no corpo do PUT do gateway (`UpdatePaymentGatewayConfigRequest.currentPassword`). A rota a descarta
  // do corpo e nunca a loga, mas a rede de segurança vale para qualquer log de corpo/erro que um dia a carregue (solta E `*.`, como as demais).
  'currentPassword',
  '*.currentPassword',
  // F5.7 (B6, portão do Órion) — dado pessoal/sensível do payload da Cielo e do Pix: `Identity` (CPF do pagador no
  // `Customer`), `Holder` (nome impresso no cartão, `CreditCard.Holder`), `holderName` (idem, camelCase do nosso lado),
  // `QrCodeString`/`pixQrCode` (o "copia e cola" do Pix: quem o tem paga para a NOSSA conta, mas ele identifica o pagamento
  // e o motorista). Soltos e `*.` como os demais — e, para o que vem DENTRO de um `err`, o serializer de `logSerializers.ts`
  // varre em profundidade usando esta mesma lista (o `fast-redact` só casa 1 nível e é case-sensitive).
  'Identity',
  '*.Identity',
  'Holder',
  '*.Holder',
  'holderName',
  '*.holderName',
  'QrCodeString',
  '*.QrCodeString',
  'pixQrCode',
  '*.pixQrCode',
]
