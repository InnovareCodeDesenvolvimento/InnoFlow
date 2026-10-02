import { timingSafeEqual } from 'node:crypto'

/**
 * Tamanho mínimo de um segredo/token do webhook da Cielo (F5.7, B2 do portão do Órion). O segredo do header é a ÚNICA autenticação
 * do webhook (a Cielo não assina) e fica exposto a força bruta online; 8 caracteres era fraco demais. 32 caracteres aleatórios
 * (o gerador da tela faz 40) tornam isso inviável. É EXIGIDO no `PUT /api/admin/payment-gateway`; nas ENVs
 * (`CIELO_WEBHOOK_HEADER_SECRET`/`CIELO_WEBHOOK_PATH_TOKEN`) o schema segue aceitando >= 8 — derrubar o boot de uma instalação que
 * já roda seria pior que o aviso — e o uso loga um `warn` quando abaixo disto.
 */
export const SEGREDO_WEBHOOK_TAMANHO_MINIMO = 32

/**
 * Compara o header estático do webhook da Cielo em TEMPO CONSTANTE — decisão
 * #3 da Nova (`decisoes-f5-pagamento-cielo.md`): a Cielo não assina o
 * webhook, só ecoa até 3 headers estáticos configurados no painel dela. Esse
 * header é o SEGREDO de verdade (o `pathToken` na URL é só roteamento,
 * comparado por igualdade simples — não precisa ser tempo constante).
 *
 * `timingSafeEqual` do Node EXIGE buffers do MESMO tamanho (lança
 * `RangeError` se não forem) — por isso não dá pra chamar direto com strings
 * de tamanho arbitrário vindas de fora. Comparamos o TAMANHO primeiro (não é
 * uma fuga de tempo relevante: o tamanho de um segredo não é informação
 * sensível do jeito que o CONTEÚDO é) e só then comparamos os bytes.
 */
export function verificarSegredoWebhookConstante(recebido: string | undefined | null, esperado: string): boolean {
  if (!recebido) return false
  const a = Buffer.from(recebido, 'utf8')
  const b = Buffer.from(esperado, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
