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
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'req.headers.merchantkey',
  'CardNumber',
  '*.CardNumber',
  'SecurityCode',
  '*.SecurityCode',
  'CardToken',
  '*.CardToken',
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
  'cpf',
  '*.cpf',
]
