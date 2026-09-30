import { redis } from '../../lib/redis'

/**
 * Cache efêmero de dois detalhes de LEITURA da recarga Pix, no MESMO
 * espírito de `ocpp/commandResultCache.ts` (Redis, TTL curto, sem migration
 * nova — não é a fonte de verdade, só conveniência de exibição):
 *
 * 1. `qrCodeImageBase64` — a Cielo devolve a imagem só na CRIAÇÃO do Pix
 *    (`criarPix`); `PaymentIntent` (schema do Cronos) não tem coluna para
 *    guardar a imagem (só `pixQrCode`, o "copia e cola" em texto). Persistir
 *    um base64 de imagem no Postgres exigiria mexer no schema, fora do
 *    escopo desta tarefa — o cache resolve sem tocar `prisma/schema.prisma`.
 * 2. `debtSettledCents` — quanto do crédito quitou dívida automaticamente
 *    (`MeTopupDTO.debtSettledCents`). É um FATO histórico calculado uma vez
 *    (`creditarTopupPix`), mas não existe coluna dedicada em `PaymentIntent`
 *    para gravá-lo — o registro PERMANENTE e auditável continua sendo os
 *    `WalletEntry` (tipo `DEBT_SETTLEMENT`) já gravados na carteira; isto é
 *    só um atalho de leitura para a tela de sucesso do motorista.
 *
 * TTL generoso (24h): o `topupId` só é consultado durante a MESMA sessão do
 * motorista (não é parâmetro de URL — `CarteiraAdicionar.tsx` guarda em
 * `useState`), mas cobre folga para o motorista voltar à tela depois de
 * minutos/horas sem perder o resultado. Se o cache expirar antes de alguém
 * consultar, o pior caso é a tela não mostrar a imagem/valor de quitação de
 * um pagamento ANTIGO — nunca afeta o saldo real (que vem do `WalletEntry`).
 */

const QR_IMAGE_PREFIX = 'topup:qrimg:'
const DEBT_SETTLED_PREFIX = 'topup:debtsettled:'
const TTL_SECONDS = 24 * 60 * 60

export async function cacheTopupQrImage(topupId: string, base64: string): Promise<void> {
  await redis.set(`${QR_IMAGE_PREFIX}${topupId}`, base64, 'EX', TTL_SECONDS)
}

export async function getTopupQrImage(topupId: string): Promise<string | null> {
  return redis.get(`${QR_IMAGE_PREFIX}${topupId}`)
}

export async function cacheTopupDebtSettledCents(topupId: string, cents: number): Promise<void> {
  await redis.set(`${DEBT_SETTLED_PREFIX}${topupId}`, String(cents), 'EX', TTL_SECONDS)
}

/** `0` quando não há nada em cache — mesmo default de "não havia dívida em aberto" (degrada de forma segura: nunca inventa um valor maior que o real). */
export async function getTopupDebtSettledCents(topupId: string): Promise<number> {
  const raw = await redis.get(`${DEBT_SETTLED_PREFIX}${topupId}`)
  if (raw === null) return 0
  const value = Number(raw)
  return Number.isFinite(value) ? value : 0
}
