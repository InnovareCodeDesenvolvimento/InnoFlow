/**
 * Validação pura do valor de recarga Pix — MESMOS limites do frontend
 * (`frontend/src/lib/topupAmount.ts`: `TOPUP_MIN_AMOUNT_CENTS`/
 * `TOPUP_MAX_AMOUNT_CENTS`, R$ 10,00 a R$ 500,00). O frontend valida por UX;
 * isto aqui é a AUTORIDADE — o cliente pode mandar qualquer coisa.
 */
export const TOPUP_MIN_AMOUNT_CENTS = 1_000
export const TOPUP_MAX_AMOUNT_CENTS = 50_000

export function valorTopupDentroDoLimite(amountCents: number, minCents: number = TOPUP_MIN_AMOUNT_CENTS, maxCents: number = TOPUP_MAX_AMOUNT_CENTS): boolean {
  return Number.isInteger(amountCents) && amountCents >= minCents && amountCents <= maxCents
}
