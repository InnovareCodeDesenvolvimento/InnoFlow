import { describe, expect, it } from "vitest"
import { AxiosError, AxiosHeaders } from "axios"
import { UNREADABLE_CARD_BADGE, UNREADABLE_CARD_MESSAGE, UNREADABLE_CARD_START_MESSAGE, isUnreadable, isUnreadableCardError, usableMethods } from "./cardUnreadable"

const axiosError = (status: number, data: unknown) =>
  new AxiosError("falhou", String(status), undefined, undefined, { status, statusText: "", headers: {}, config: { headers: new AxiosHeaders() }, data })

describe("cartão ilegível", () => {
  it("só `unreadable: true` é ilegível; ausente (servidor antigo) ou false = legível", () => {
    expect(isUnreadable({ unreadable: true })).toBe(true)
    expect(isUnreadable({ unreadable: false })).toBe(false)
    expect(isUnreadable({})).toBe(false)
  })

  it("usableMethods tira os ilegíveis e preserva a ordem", () => {
    const list = [{ id: "a", unreadable: true }, { id: "b" }, { id: "c", unreadable: false }]
    expect(usableMethods(list).map((m) => m.id)).toEqual(["b", "c"])
    expect(usableMethods([{ id: "x", unreadable: true }])).toEqual([])
  })

  it("409 PAYMENT_METHOD_UNREADABLE é reconhecido por code; outros 409/códigos não", () => {
    expect(isUnreadableCardError(axiosError(409, { error: "x", code: "PAYMENT_METHOD_UNREADABLE" }))).toBe(true)
    expect(isUnreadableCardError(axiosError(409, { error: "x", code: "PAYMENT_METHOD_DISABLED" }))).toBe(false)
    expect(isUnreadableCardError(axiosError(404, { error: "x", code: "PAYMENT_METHOD_UNREADABLE" }))).toBe(false)
    expect(isUnreadableCardError(new Error("rede"))).toBe(false)
  })

  it("textos: neutros, sem jargão de servidor, e o do erro repete o aviso do cartão", () => {
    expect(UNREADABLE_CARD_BADGE).toBe("Cadastre de novo")
    expect(UNREADABLE_CARD_MESSAGE).toBe("Por segurança, precisamos que você cadastre este cartão novamente.")
    expect(UNREADABLE_CARD_START_MESSAGE).toContain(UNREADABLE_CARD_MESSAGE)
    expect(`${UNREADABLE_CARD_BADGE} ${UNREADABLE_CARD_MESSAGE} ${UNREADABLE_CARD_START_MESSAGE}`).not.toMatch(/JWT|chave|servidor|erro|falha|culpa/i)
  })
})
