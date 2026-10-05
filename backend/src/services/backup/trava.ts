import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { INTERVALO_DO_BATIMENTO_MS, TRAVA_EXPIRA_EM_MS } from '../../core/backup/politica'

/**
 * Trava do backup por UPDATE condicional na linha singleton (`BackupConfig.runningSince`): quem consegue mudar a linha de "livre ou expirada" para "agora" é o dono da execução.
 * Seguro com 2 réplicas do worker (e com o tick e o pedido manual ao mesmo tempo): o Postgres serializa o UPDATE, só um ganha. Trava mais velha que `TRAVA_EXPIRA_EM_MS` é
 * considerada abandonada (o processo morreu no meio) — e o processo VIVO a RENOVA a cada `INTERVALO_DO_BATIMENTO_MS` (compare-and-set sobre o valor que ele mesmo gravou), então
 * uma execução longa não perde a trava para outra.
 */

export interface TravaTomada {
  /** Chame no `finally`: só libera se a trava ainda for a MINHA (se alguém tomou a expirada, não apaga a dela). */
  liberar(): Promise<void>
  /** `true` se o batimento descobriu que a trava foi tomada por outro (checar antes de passos que mudam o mundo, como o upload). */
  perdida(): boolean
}

export async function tomarTrava(agora: Date, opcoes: { intervaloDoBatimentoMs?: number; relogio?: () => Date } = {}): Promise<TravaTomada | null> {
  const expirou = new Date(agora.getTime() - TRAVA_EXPIRA_EM_MS)
  const r = await prisma.backupConfig.updateMany({
    where: { id: 1, OR: [{ runningSince: null }, { runningSince: { lt: expirou } }] },
    data: { runningSince: agora, lastAttemptAt: agora },
  })
  if (r.count !== 1) return null

  let atual = agora
  let perdeu = false
  let emVoo: Promise<void> | null = null
  const relogio = opcoes.relogio ?? (() => new Date())
  const timer = setInterval(() => {
    const novo = relogio()
    emVoo = prisma.backupConfig
      .updateMany({ where: { id: 1, runningSince: atual }, data: { runningSince: novo } })
      .then((res) => {
        if (res.count === 1) atual = novo
        else perdeu = true
      })
      .then(() => undefined, (err) => logger.warn({ err }, '[backup] não consegui renovar a trava (tento de novo no próximo batimento)'))
  }, opcoes.intervaloDoBatimentoMs ?? INTERVALO_DO_BATIMENTO_MS)
  timer.unref()

  return {
    perdida: () => perdeu,
    async liberar() {
      clearInterval(timer)
      await emVoo // um batimento em voo moveria a trava depois do meu UPDATE e ela ficaria presa até expirar
      await prisma.backupConfig
        .updateMany({ where: { id: 1, runningSince: atual }, data: { runningSince: null } })
        .catch((err) => logger.error({ err }, '[backup] não consegui liberar a trava (ela expira sozinha em 2 h)'))
    },
  }
}
