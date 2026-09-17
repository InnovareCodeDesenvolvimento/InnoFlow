import pino from 'pino'
import { env } from './env'

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
    paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
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
