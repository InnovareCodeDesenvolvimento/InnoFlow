/**
 * Qual adaptador de pagamento o processo deve usar — decisão PURA (sem env, sem
 * logger, sem rede), para ser testável em todas as combinações.
 *
 * Por que existe (Atlas, 02/10/2026): o resolvedor caía para `FakeAdapter` sempre
 * que faltava credencial da Cielo — INCLUSIVE em produção. O Fake aceita QUALQUER
 * texto como cartão válido e aprova toda pré-autorização, então um backend
 * implantado sem credenciais deixava qualquer motorista cadastrado registrar um
 * "cartão" qualquer e recarregar de graça (a captura "acontece" no Fake e o
 * sistema contabiliza como cobrado). Regra agora:
 *
 *  - credencial presente        -> CIELO (qualquer ambiente; sandbox ou produção).
 *  - sem credencial, dev/teste  -> FAKE_DEV (como sempre foi: demo, CI e testes).
 *  - sem credencial, PRODUÇÃO   -> BLOQUEADO. Pix e cartão respondem 503 em vez de
 *    fingir; só vira Fake com opt-in explícito (`PAYMENT_ALLOW_FAKE_ADAPTER=true`),
 *    para quem quer demonstrar o fluxo antes de ter conta Cielo, sabendo o risco.
 *
 * Sem credencial = falta `CIELO_MERCHANT_ID` OU `CIELO_MERCHANT_KEY`. Credencial
 * presente mas inválida NÃO cai para Fake: o erro do adaptador Cielo propaga
 * (fail-closed), em vez de esconder uma configuração errada atrás de um simulador.
 */

export type DecisaoAdaptadorPagamento = 'CIELO' | 'FAKE_DEV' | 'FAKE_PERMITIDO_EM_PRODUCAO' | 'BLOQUEADO'

export interface EntradaDecisaoAdaptador {
  nodeEnv: 'development' | 'test' | 'production'
  /** `CIELO_MERCHANT_ID` e `CIELO_MERCHANT_KEY` ambas presentes. */
  temCredenciaisCielo: boolean
  /** `PAYMENT_ALLOW_FAKE_ADAPTER` — opt-in explícito, default `false`. */
  permitirFakeEmProducao: boolean
}

export function decidirAdaptadorPagamento(entrada: EntradaDecisaoAdaptador): DecisaoAdaptadorPagamento {
  if (entrada.temCredenciaisCielo) return 'CIELO'
  if (entrada.nodeEnv !== 'production') return 'FAKE_DEV'
  return entrada.permitirFakeEmProducao ? 'FAKE_PERMITIDO_EM_PRODUCAO' : 'BLOQUEADO'
}
