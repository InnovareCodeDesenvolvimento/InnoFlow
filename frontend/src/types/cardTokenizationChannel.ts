import type { CardBrand, MeCardTokenizationSessionResponse } from "./api"

/**
 * Contrato de `postMessage` entre o app principal (`/app/carteira/cartoes`,
 * que abre a aba) e o documento ISOLADO `pagamento-cartao.html` (F5.3, SAQ
 * A-EP — ver `.claude/agent-memory/nova/decisoes-f5-pagamento-cielo.md` §2).
 *
 * Importado dos DOIS lados de propósito — é exatamente o tipo de contrato
 * que já divergiu neste projeto quando dois agentes desenharam o mesmo
 * formato em paralelo sem se ver (7 rotas de retaguarda, ver
 * `.claude/agent-memory/lyra/feedback_contrato_compartilhado_trabalho_paralelo.md`).
 * Só tipos + uma const string, zero import de React/axios/etc — importar
 * isto do app principal não quebra a isolação do documento isolado. A
 * isolação é o caminho INVERSO: `src/pagamento-cartao/**` não pode importar
 * nada do app principal (componentes, hooks, services, mocks, store) — ver a
 * regra `no-restricted-imports` em `eslint.config.js`.
 *
 * DECISÃO — postMessage, não querystring de sessão: a sessão de tokenização
 * carrega um `accessToken`. Colocá-lo na URL vazaria para o histórico do
 * navegador, logs de proxy/CDN e o cabeçalho `Referer` de qualquer recurso
 * externo que a página viesse a carregar (o próprio script da Cielo,
 * inclusive). `postMessage` nunca sai do processo do navegador. Custo aceito:
 * precisa de um handshake `ready` → `init`, porque a aba pode terminar de
 * montar DEPOIS do pai já ter chamado `window.open` — ver
 * `frontend/src/hooks/useAddCardFlow.ts` (lado pai) e
 * `frontend/src/pagamento-cartao/CardTokenizationApp.tsx` (lado filho).
 * Mitigado SEM race: o pai registra o listener de `message` ANTES de chamar
 * `window.open` — a aba filha não tem como carregar/rodar JS antes disso.
 *
 * Toda mensagem inclui `source` (para o outro lado distinguir de qualquer
 * outra coisa que por acaso poste na mesma origem) e os dois lados sempre
 * passam `targetOrigin` explícito (nunca `"*"`) — pai e filho vivem sempre no
 * mesmo domínio, então `window.location.origin` é sempre o valor certo.
 */
export const CARD_TOKENIZATION_CHANNEL_SOURCE = "innoflow-pagamento-cartao"

export type CardTokenizationInitMessage = {
  source: typeof CARD_TOKENIZATION_CHANNEL_SOURCE
  type: "init"
  payload: MeCardTokenizationSessionResponse
}

/**
 * `token`: `cardToken`+`brand` e o PAN TRUNCADO (`last4`) com a validade -
 * número inteiro/CVV/nome do titular NUNCA saem do documento isolado, nem para o app principal via postMessage,
 * nem para o nosso backend (ver `MeCreatePaymentMethodRequest`). Isso é o
 * que mantém o limite SAQ A-EP correto: o app principal (e nosso servidor)
 * jamais veem dado de cartão em texto puro, só o token que a Cielo emitiu.
 */
export interface CardTokenizationTokenPayload {
  cardToken: string
  brand: CardBrand
  /** Últimos 4 dígitos - PAN TRUNCADO (permitido guardar/transmitir pelo PCI DSS). O servidor não depende mais de `GET /1/card/{token}` para saber o final. */
  last4: string
  /** 1..12 */
  expiryMonth: number
  /** 4 dígitos */
  expiryYear: number
}

export type CardTokenizationChildMessage =
  | { source: typeof CARD_TOKENIZATION_CHANNEL_SOURCE; type: "ready" }
  | { source: typeof CARD_TOKENIZATION_CHANNEL_SOURCE; type: "token"; payload: CardTokenizationTokenPayload }
  | { source: typeof CARD_TOKENIZATION_CHANNEL_SOURCE; type: "cancelled" }
