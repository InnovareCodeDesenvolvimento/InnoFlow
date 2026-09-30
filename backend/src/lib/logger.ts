import pino from 'pino'
import { env } from './env'
import { REDACT_PATHS } from './logRedactPaths'

/**
 * Logger compartilhado pelos 3 entrypoints. `pino-pretty` roda em TODO
 * ambiente (não só dev) — decisão de 17/09/2026: o painel de logs do
 * EasyPanel só mostra o stdout cru, então JSON "puro" em produção
 * significava o dono lendo `{"level":30,"time":1789...,"pid":1,...}` linha
 * a linha sem conseguir acompanhar o que estava acontecendo de verdade.
 * Sem coletor estruturado (Datadog/ELK/etc.) neste MVP, não há motivo pra
 * pagar esse custo de legibilidade só para economizar o overhead do
 * `pino-pretty` — se um coletor estruturado entrar depois, isto volta a
 * JSON puro (ou vira condicional por env de novo).
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  // `pino-http` (app.ts) usa esta MESMA instância como logger base — o
  // `redact` daqui vale para os objetos req/res que ele serializa
  // automaticamente em toda requisição, não só para chamadas manuais de
  // `logger.info(...)`. Sem isto, o header `Authorization: Bearer <jwt>`
  // (e qualquer cookie) ia parar em texto puro nos logs de produção em
  // TODA rota autenticada — achado real do Órion, 17/09/2026: combinado
  // com token de 12h sem revogação, isso equivale a sequestro de sessão
  // pra quem tiver acesso aos logs do EasyPanel. Bloqueante antes da F5
  // (pagamento real), corrigido antes de prosseguir.
  redact: {
    // F5.1 (30/09/2026, recomendação do Órion — prioridade alta): segredos e
    // dado sensível do fluxo de pagamento (Cielo). `fast-redact` (motor do
    // pino) NÃO tem wildcard de profundidade arbitrária (`**`) — só um nível
    // por `*` (`*.CardNumber` casa `payload.CardNumber`, NÃO
    // `a.b.CardNumber` nem um `CardNumber` solto na raiz). Por isso cada
    // campo aparece 2x: a forma "solta" (raiz do objeto logado) e a forma
    // `*.campo` (um nível de aninhamento, o formato mais comum de log real
    // — ex. `logger.info({ cielo: { CardNumber } })`). Comportamento
    // verificado com um script Node ad-hoc nesta tarefa, não só suposto —
    // ver teste `loggerRedact.test.ts`, que importa a MESMA lista de
    // `logRedactPaths.ts` (não uma cópia) — sem isso, editar a lista aqui
    // sem lembrar do teste deixava o teste verde testando uma lista velha.
    //
    // A defesa de VERDADE contra vazar corpo de request/response da Cielo
    // é o cliente HTTP nunca logar o corpo inteiro (só PaymentId/Status/
    // ReturnCode/valores — ver `services/pagamentos/cieloHttpClient.ts`).
    // Isto aqui é rede de segurança para o dia em que alguém logar um objeto
    // por engano.
    paths: REDACT_PATHS,
    censor: '[redacted]',
  },
  transport: {
    target: 'pino-pretty',
    options: {
      // Sem cor em produção: não sabemos se o visualizador de log do
      // EasyPanel renderiza ANSI — sem essa certeza, texto colorido vira
      // caractere de escape cru no meio da linha (pior que JSON simples).
      colorize: env.NODE_ENV === 'development',
      translateTime: 'yyyy-mm-dd HH:MM:ss',
      // pid/hostname mudam a cada deploy/restart e não ajudam ninguém lendo
      // — só poluem a linha. chargePointId, correlationId etc. (os campos
      // que importam pra seguir o fluxo de uma sessão/comando) continuam
      // aparecendo, só o ruído fixo some.
      ignore: 'pid,hostname',
      // Uma linha por evento: o gateway OCPP gera muitos eventos rápidos
      // (ping, boot, comandos) — pretty-print multi-linha faria rolar a
      // tela inteira pra cada um. Uma linha = dá pra acompanhar o fluxo
      // rolando a página normalmente.
      singleLine: true,
    },
  },
})
