/**
 * Re-cifra os segredos de pagamento com a chave ATUAL — passo da ROTAÇÃO de `PAYMENT_SECRETS_KEY` (F5.7). Script ADMINISTRATIVO, fora do HTTP.
 * Runbook completo em `docs/DEPLOY-EASYPANEL.md` ("Rotação da PAYMENT_SECRETS_KEY").
 *
 * Uso (no terminal do serviço `api` no EasyPanel, com a chave NOVA em PAYMENT_SECRETS_KEY e a ANTIGA em PAYMENT_SECRETS_KEY_PREVIOUS):
 *   npm run payments:recifrar-segredos              # DRY-RUN (padrão): só conta, não grava nada
 *   npm run payments:recifrar-segredos -- --apply   # grava
 *
 * Idempotente (pode rodar de novo). NUNCA imprime segredo nem ciphertext — só contagens. Código de saída: 0 = ok; 1 = há valores ilegíveis ou alterados durante
 * a execução (a rotação NÃO está concluída); 2 = erro (chave ausente, banco fora, argumento desconhecido).
 */
import { prisma } from '../src/lib/prisma'
import { formatarRelatorio, recifrarSegredosDePagamento } from '../src/services/pagamentos/recifrarSegredos'

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  const desconhecidos = args.filter((a) => a !== '--apply')
  if (desconhecidos.length > 0) {
    console.error(`Argumento desconhecido: ${desconhecidos.join(' ')} — o único aceito é --apply (sem ele é DRY-RUN).`)
    return 2
  }
  const relatorio = await recifrarSegredosDePagamento({ apply: args.includes('--apply'), prisma })
  console.log(formatarRelatorio(relatorio))
  return relatorio.totais.ilegiveis > 0 || relatorio.totais.alteradosDuranteExecucao > 0 ? 1 : 0
}

main()
  .then((codigo) => {
    process.exitCode = codigo
  })
  .catch((err: unknown) => {
    // Só a classe/mensagem do erro — nunca um objeto que possa carregar valor de coluna.
    console.error(`Falha: ${err instanceof Error ? `${err.name}: ${err.message}` : 'erro desconhecido'}`)
    process.exitCode = 2
  })
  .finally(async () => {
    await prisma.$disconnect()
    process.exit(process.exitCode ?? 0)
  })
