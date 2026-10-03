import type { Prisma } from '@prisma/client'

/**
 * Intervalo de amostragem OBSERVADO de uma sessão (M5 do Órion): o maior espaçamento (relógio do CARREGADOR, `MeterSample.ts`) entre as últimas amostras
 * periódicas de energia. É o que `janelaDeConfirmacaoMs` usa para não deixar a janela G1 ser menor que o próprio ritmo de MeterValues do firmware.
 * `null` com menos de 2 amostras (desconhecido => vale G puro). Contexto vazio conta como periódico (é o default do OCPP 1.6).
 */
export async function estimarIntervaloAmostragemMs(tx: Prisma.TransactionClient, sessionId: string, chargePointId: string): Promise<number | null> {
  const amostras = await tx.meterSample.findMany({
    where: { sessionId, chargePointId, measurand: 'Energy.Active.Import.Register', OR: [{ context: null }, { context: 'Sample.Periodic' }] },
    orderBy: { ts: 'desc' },
    take: 4,
    select: { ts: true },
  })
  if (amostras.length < 2) return null
  let maior = 0
  for (let i = 0; i < amostras.length - 1; i++) maior = Math.max(maior, amostras[i]!.ts.getTime() - amostras[i + 1]!.ts.getTime())
  return maior > 0 ? maior : null
}
