/**
 * Montagem do notificador do PROCESSO (api, ocpp-gateway ou worker): a configuração (canais, destinatários, severidade mínima, dedupe) vem do RESOLVEDOR central
 * (`services/comunicacao/configComunicacao.ts`: painel > env, cache curto) e o dedupe é o Redis compartilhado (com queda para memória). Carregado sob demanda por
 * `hookLogger.iniciarAlertas()` — nunca no import do logger (este módulo importa o logger, o banco e o Redis).
 *
 * Nada é aberto até o PRIMEIRO alerta: a configuração só é lida (banco) e a conexão Redis só é criada quando um alerta de fato chega. Sem canal configurado em lugar
 * nenhum, o alerta é descartado no snapshot (nada de envio, nada de erro) — o comportamento de quem não configurou é idêntico ao de antes.
 */
import Redis from 'ioredis'
import { logger } from '../logger'
import { createLogGate } from '../rateLimitedLog'
import { env } from '../env'
import { getConfigComunicacao, resolverAgora } from '../../services/comunicacao/configComunicacao'
import { criarCanalEmail, criarCanalWhatsapp, type CanalDeAlerta } from './canais'
import { booleano, type ConfigAlertas } from './config'
import { Notificador, type LogDoNotificador, type ProvedorDeConfig } from './notificador'
import { DedupeStoreComFallback, RedisDedupeStore, type RedisMinimo } from './storeRedis'

/** Valores de LOG_LEVEL que desligam o nível `warn` (e com ele o hook para alertas emitidos em warn/info; ver `hookLogger.ts`). */
const NIVEIS_ACIMA_DE_WARN = new Set(['error', 'fatal', 'silent'])

const logDoNotificador: LogDoNotificador = (nivel, dados, mensagem) => {
  // `dados` NUNCA tem o campo `alert` (o hook ignoraria de qualquer forma): é o que impede o laço notificador -> log -> notificador.
  if (nivel === 'error') logger.error(dados, mensagem)
  else logger.warn(dados, mensagem)
}

export function descreverCanais(c: ConfigAlertas): string {
  const partes: string[] = []
  if (c.email) partes.push(`email[${c.email.origem}](${c.email.para.length} destinatario(s), min ${c.email.minSeveridade})`)
  if (c.whatsapp) partes.push(`whatsapp/${c.whatsapp.provedor}[${c.whatsapp.origem}](${c.whatsapp.para.length} numero(s), min ${c.whatsapp.minSeveridade})`)
  return partes.length > 0 ? partes.join(' + ') : 'nenhum'
}

export function montarCanais(c: ConfigAlertas): CanalDeAlerta[] {
  const canais: CanalDeAlerta[] = []
  if (c.email) canais.push(criarCanalEmail(c.email))
  if (c.whatsapp) canais.push(criarCanalWhatsapp(c.whatsapp))
  return canais
}

/** Cliente Redis PRÓPRIO do notificador, criado na primeira necessidade: sem fila offline (Redis fora => erro imediato => cai na memória). */
function criarRedisPreguicoso(): RedisMinimo {
  let conexao: Redis | null = null
  const abrir = (): Redis => {
    const c = new Redis(env.REDIS_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: 3_000, retryStrategy: (n) => Math.min(n * 1_000, 15_000) })
    const gate = createLogGate(60_000)
    c.on('error', (err: Error & { code?: string }) => {
      gate((suprimidos) => logger.warn({ notifier: 'redis', code: err.code, suprimidos }, '[alertas] Redis do notificador indisponivel — dedupe em memoria ate voltar'))
    })
    return c
  }
  return {
    async eval(script, numKeys, ...args) {
      const c = (conexao ??= abrir())
      if (c.status !== 'ready') {
        // 1º uso: dá até 1 s para a conexão subir (sem fila offline o comando falharia na hora). Passou disso: o erro cai na memória.
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 1_000)
          t.unref?.()
          c.once('ready', () => {
            clearTimeout(t)
            resolve()
          })
        })
      }
      return c.eval(script, numKeys, ...args)
    },
  }
}

/** Provedor de configuração do processo: resolvedor central (painel > env). Loga UMA linha quando o conjunto de canais muda (boot e mudanças salvas no painel). */
function criarProvedor(): ProvedorDeConfig {
  let ultimaDescricao: string | null = null
  let avisouLogLevel = false
  const apenasEnv = booleano(process.env, 'COMMUNICATION_DISABLE_DB_CONFIG', false)
  return async () => {
    const r = apenasEnv ? resolverAgora(null) : await getConfigComunicacao()
    const descricao = descreverCanais(r.config)
    if (descricao !== ultimaDescricao) {
      ultimaDescricao = descricao
      for (const aviso of r.avisos) logger.warn({ notifier: 'config' }, `[alertas] ${aviso}`)
      logger.info({ notifier: 'config', servico: r.config.servico, origem: r.source }, `[alertas] avisos ao dono: ${descricao} (dedupe ${r.config.dedupeMinutos} min, teto ${r.config.maxPorHora}/h)`)
      if (descricao !== 'nenhum' && !avisouLogLevel && NIVEIS_ACIMA_DE_WARN.has(env.LOG_LEVEL.toLowerCase())) {
        avisouLogLevel = true
        logger.error({ notifier: 'config' }, `[alertas] LOG_LEVEL=${env.LOG_LEVEL}: alertas emitidos em nivel warn/info NAO chegam ao dono (o pino descarta o nivel desligado antes do hook). Use LOG_LEVEL=info ou warn.`)
      }
    }
    return { config: r.config, canais: montarCanais(r.config) }
  }
}

export function criarNotificadorDoProcesso(): Notificador {
  return new Notificador({
    provedor: criarProvedor(),
    store: new DedupeStoreComFallback(new RedisDedupeStore(criarRedisPreguicoso()), undefined, Date.now, (motivo) =>
      logger.warn({ notifier: 'redis', motivo }, '[alertas] dedupe em memoria (Redis indisponivel) — pode chegar aviso repetido'),
    ),
    log: logDoNotificador,
  })
}
