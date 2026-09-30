/**
 * Projeta `PaymentIntent.status` (enum do Prisma, com vários valores que não
 * fazem sentido para o fluxo Pix — CAPTURED/VOIDED/DENIED são vocabulário de
 * CARTÃO) no vocabulário pequeno que o PWA do motorista conhece
 * (`MeTopupStatus` em `frontend/src/types/api.ts`: PENDING/PAID/EXPIRED/
 * FAILED — sem `CREATED`).
 *
 * Núcleo puro (sem `@prisma/client` de propósito — `core/` não pode
 * importar o client, ver `eslint.config.mjs`): recebe o valor como string.
 * `CREATED` (intent só existe entre o INSERT e a chamada `criarPix` retornar
 * — nunca deveria "vazar" para uma resposta HTTP, mas se vazar por uma falha
 * no meio do caminho, cai em `FAILED` — fail-safe, nunca fica preso
 * indicando "pendente" para sempre) e qualquer valor desconhecido também.
 */
export type MeTopupStatus = 'PENDING' | 'PAID' | 'EXPIRED' | 'FAILED'

export function mapearStatusTopup(status: string): MeTopupStatus {
  switch (status) {
    case 'PENDING':
      return 'PENDING'
    case 'PAID':
      return 'PAID'
    case 'EXPIRED':
      return 'EXPIRED'
    default:
      return 'FAILED'
  }
}
