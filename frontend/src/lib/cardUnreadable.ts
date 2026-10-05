import axios from "axios"
import type { ApiErrorBody, MePaymentMethodDTO } from "@/types/api"

/**
 * Cartão ILEGÍVEL (05/10/2026): a chave dos segredos do servidor é derivada do `JWT_SECRET`; se ele mudou, o token de um cartão salvo não abre mais. O backend avisa por
 * `MePaymentMethodDTO.unreadable` (GET) e, se o motorista tentar usar assim mesmo, responde 409 `PAYMENT_METHOD_UNREADABLE` ANTES de autorizar/cobrar qualquer coisa.
 * A saída é do motorista: cadastrar o cartão de novo (e, antes, remover o antigo). Pix e carteira não são afetados. Tom neutro, sem culpa e sem jargão (nada de "chave", "servidor").
 * Funções puras (sem DOM/rede).
 */

export const UNREADABLE_CARD_BADGE = "Cadastre de novo"
export const UNREADABLE_CARD_MESSAGE = "Por segurança, precisamos que você cadastre este cartão novamente."
/** Complemento da tela "Meus cartões", onde existe o menu de remoção e o botão de adicionar. */
export const UNREADABLE_CARD_HOW_TO = "Remova-o e use “Adicionar cartão”."
/** Erro ao iniciar a recarga (o 409 pode chegar mesmo depois de a lista ter dito "legível"). */
export const UNREADABLE_CARD_START_MESSAGE = `${UNREADABLE_CARD_MESSAGE} Enquanto isso, escolha outro cartão ou a carteira.`

/** Ausente = legível (front publicado antes do backend). */
export function isUnreadable(method: Pick<MePaymentMethodDTO, "unreadable">): boolean {
  return method.unreadable === true
}

/** Só os cartões que podem ser escolhidos para pagar. */
export function usableMethods<T extends Pick<MePaymentMethodDTO, "unreadable">>(methods: readonly T[]): T[] {
  return methods.filter((m) => !isUnreadable(m))
}

/** `true` só para o 409 `PAYMENT_METHOD_UNREADABLE`. A decisão é pelo `code`, nunca pelo texto do servidor. */
export function isUnreadableCardError(err: unknown): boolean {
  if (!axios.isAxiosError<ApiErrorBody>(err)) return false
  return err.response?.status === 409 && err.response.data?.code === "PAYMENT_METHOD_UNREADABLE"
}
