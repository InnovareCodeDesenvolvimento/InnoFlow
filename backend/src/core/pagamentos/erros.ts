/**
 * Erros de domínio do fluxo de pagamento que a camada de rota precisa
 * distinguir por TIPO (não por mensagem) para responder com o `code` certo
 * (contrato `MePaymentMethodErrorCode`, ver `frontend/src/types/api.ts`).
 * Puro — sem Prisma, sem HTTP (mesma regra de `core/` do resto do módulo).
 */

/**
 * Produção sem credenciais da Cielo (e sem opt-in para o simulador): o gateway de
 * pagamento está indisponível por CONFIGURAÇÃO. As rotas já convertem qualquer erro
 * do resolvedor em 503 `PAYMENT_GATEWAY_UNAVAILABLE` — nunca fingem que cobraram.
 */
export class GatewayPagamentoNaoConfiguradoError extends Error {
  constructor() {
    super('Gateway de pagamento não configurado: defina CIELO_MERCHANT_ID e CIELO_MERCHANT_KEY (ou PAYMENT_ALLOW_FAKE_ADAPTER=true só para demonstração, sem cobrança real).')
    this.name = 'GatewayPagamentoNaoConfiguradoError'
  }
}

/** `GET /1/card/{token}` (Cielo) devolveu "token desconhecido"/"inválido" — nunca confundir com timeout/erro de rede (`CARD_VERIFICATION_FAILED`). */
export class CartaoTokenInvalidoError extends Error {
  constructor(cardTokenMascarado: string) {
    super(`CardToken inválido/desconhecido na Cielo: ${cardTokenMascarado}`)
    this.name = 'CartaoTokenInvalidoError'
  }
}

/**
 * A configuração do gateway (banco) não pôde ser LIDA/DECIFRADA (Postgres fora, segredo corrompido,
 * `JWT_SECRET` trocado — a chave dos segredos é derivada dele — ou override `PAYMENT_SECRETS_KEY` trocado/inválido, com credencial cifrada no banco). Fail-CLOSED (F5.5): nunca cai para
 * o `FakeAdapter` nem para as credenciais do env "por conveniência" — a conta que o dono configurou na tela é
 * a que vale, e adivinhar outra pode cobrar da conta errada ou de graça. As rotas já convertem qualquer erro do
 * resolvedor em 503 `PAYMENT_GATEWAY_UNAVAILABLE`.
 */
export class ConfiguracaoGatewayIndisponivelError extends Error {
  constructor(motivo: string, options?: { cause?: unknown }) {
    super(`Configuração do gateway de pagamento indisponível: ${motivo}`, options)
    this.name = 'ConfiguracaoGatewayIndisponivelError'
  }
}

/** Ambiente (sandbox/production) incompatível com as URLs explícitas do servidor — recusa construir o adaptador em vez de cobrar/não cobrar na conta errada em silêncio. */
export class ConfiguracaoGatewayIncoerenteError extends Error {
  constructor(motivo: string) {
    super(`Configuração do gateway incoerente: ${motivo}`)
    this.name = 'ConfiguracaoGatewayIncoerenteError'
  }
}

/**
 * `true` quando o erro significa "o gateway está INDISPONÍVEL por configuração/ambiente agora" (produção sem credencial,
 * config ilegível/indecifrável, ambiente x URLs incoerentes) — e NÃO "esta operação falhou". Quem repete trabalho em fila
 * (job de captura) usa isto para ADIAR sem gastar tentativas: a falha não é do intent, é da instalação, e passa quando
 * alguém corrige a config ou o banco volta (F5.7, ALTO-1).
 */
export function ehGatewayIndisponivelPorConfiguracao(err: unknown): boolean {
  return err instanceof GatewayPagamentoNaoConfiguradoError || err instanceof ConfiguracaoGatewayIndisponivelError || err instanceof ConfiguracaoGatewayIncoerenteError
}
