/**
 * Processo-filho de TESTE — faz o papel do `worker` (OUTRO processo, com o SEU cache em memória de `gatewayConfig.ts`).
 * Protocolo por linha: lê "ler" do stdin e responde uma linha JSON com o que `getConfigEfetiva()` enxerga AGORA
 * (o mesmo caminho que `getPagamentoPort()`/`getCieloWebhookHeaderSecret()` usam). Sem Redis, sem HTTP: só o Prisma
 * (a `DATABASE_URL` vem do ambiente do pai) e o cache de 10 s de produção. Usado por
 * `paymentGatewayConfigConcorrenciaEProcessos.test.ts`.
 */
import { createInterface } from 'node:readline'
import { getConfigEfetiva } from '../../../src/services/pagamentos/gatewayConfig'
import { prisma } from '../../../src/lib/prisma'

async function main(): Promise<void> {
  const rl = createInterface({ input: process.stdin })
  process.stdout.write('PRONTO\n')
  for await (const linha of rl) {
    if (linha.trim() !== 'ler') continue
    try {
      const { estado } = await getConfigEfetiva()
      process.stdout.write(`${JSON.stringify({ ok: true, source: estado.source, pixEnabled: estado.pixEnabled, cardEnabled: estado.cardEnabled, merchantId: estado.merchantId, environment: estado.environment, t: Date.now() })}\n`)
    } catch (err) {
      process.stdout.write(`${JSON.stringify({ ok: false, erro: err instanceof Error ? err.message : String(err) })}\n`)
    }
  }
  await prisma.$disconnect()
}

void main()
