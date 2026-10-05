/**
 * Ponto ÚNICO de despacho dos alertas: o `hooks.logMethod` do pino (ver `logger.ts`) chama `despacharAlertaDoLog` em TODA chamada de log, e esta função
 * só age quando o objeto logado tem o campo `alert` (string) — a convenção usada em todo o código. Nenhum call site foi tocado.
 *
 * Por que `hooks.logMethod` e não um stream/serializer: roda no processo principal, SÍNCRONO, ANTES da serialização (vê o objeto cru, não o texto
 * do transport `pino-pretty` que roda em thread à parte) e não altera a linha que vai para o stdout. Por ser antes da redação do logger, o contexto
 * passa pela allowlist própria (`core/alertas/contexto.ts`), não pelo `redact`.
 *
 * LIMITE CONHECIDO (do próprio pino): um nível desabilitado vira `noop` e o hook NÃO roda. Com `LOG_LEVEL=error`, alertas emitidos em `warn` não
 * chegam aqui — o aviso de boot do `instancia.ts` diz isso quando há canal ligado.
 *
 * Carregamento preguiçoso: o módulo `instancia` (Redis, nodemailer) só é carregado quando o boot o pede (`iniciarAlertas`), e sem canal configurado
 * ele nem abre conexão. Eventos que chegam antes do carregamento ficam num buffer curto.
 */
import type { Notificador, EventoBruto } from './notificador'

let notificador: Notificador | null | undefined // undefined = ainda não carregado; null = desligado
let carregando = false
const pendentes: EventoBruto[] = []
const MAX_PENDENTES = 20

/** Chamado uma vez pelo logger depois de criado (fora do caminho de qualquer log). */
export function iniciarAlertas(): void {
  if (notificador !== undefined || carregando) return
  carregando = true
  import('./instancia')
    .then((m) => {
      notificador = m.criarNotificadorDoProcesso()
    })
    .catch(() => {
      notificador = null // nunca derruba: sem notificador, só o log
    })
    .finally(() => {
      carregando = false
      const n = notificador
      for (const e of pendentes.splice(0)) n?.notificar(e)
    })
}

/** Só para testes: injeta (ou remove, com `null`) o notificador. */
export function definirNotificadorParaTeste(n: Notificador | null | undefined): void {
  notificador = n
  pendentes.length = 0
  carregando = false
}

export function despacharAlertaDoLog(args: unknown[], nivelPino: number): void {
  try {
    const a0 = args[0]
    if (typeof a0 !== 'object' || a0 === null) return
    const alerta = (a0 as { alert?: unknown }).alert
    if (typeof alerta !== 'string' || alerta === '') return
    const evento: EventoBruto = { alerta, nivelPino, mensagem: args[1], dados: a0 }
    if (notificador === null) return
    if (notificador === undefined) {
      if (pendentes.length < MAX_PENDENTES) pendentes.push(evento)
      iniciarAlertas()
      return
    }
    notificador.notificar(evento)
  } catch {
    /* um alerta nunca derruba o caminho que logou */
  }
}
