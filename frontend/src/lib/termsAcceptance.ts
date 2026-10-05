import axios from "axios"
import { getApiErrorCode, getApiErrorStatus } from "@/services/api"
import type { ApiErrorBody } from "@/types/api"

/**
 * Aceite dos Termos de Uso e da Política de Privacidade (L1.9) - lógica PURA. O servidor exige `acceptedTermsVersion` (= a versão VIGENTE de `GET /api/public/legal`) ao CRIAR conta
 * (cadastro por e-mail e Google). Trata por `status`/`code`/`details[].path`, nunca pelo texto do backend.
 */

export const TERMS_REQUIRED_MESSAGE = "Aceite os Termos de Uso e a Política de Privacidade para criar a conta."
export const TERMS_OUTDATED_MESSAGE = "Os Termos de Uso foram atualizados. Leia a versão atual e aceite de novo."
export const TERMS_LOAD_ERROR_MESSAGE = "Não foi possível carregar a versão atual dos Termos. Tente de novo."

/** 400 `VALIDATION_ERROR` apontando para `acceptedTermsVersion`: o servidor está criando conta e não recebeu o aceite (Google, ou cadastro sem o campo). */
export function isTermsRequiredError(err: unknown): boolean {
  if (getApiErrorStatus(err) !== 400 || getApiErrorCode(err) !== "VALIDATION_ERROR") return false
  if (!axios.isAxiosError<ApiErrorBody>(err)) return false
  return (err.response?.data?.details ?? []).some((d) => typeof d.path === "string" && d.path.split(".")[0] === "acceptedTermsVersion")
}

/** 409 `TERMS_VERSION_OUTDATED`: a versão que a tela mandou não é mais a vigente - recarregar `GET /api/public/legal` e pedir o aceite de novo. */
export function isTermsOutdatedError(err: unknown): boolean {
  return getApiErrorCode(err) === "TERMS_VERSION_OUTDATED"
}
