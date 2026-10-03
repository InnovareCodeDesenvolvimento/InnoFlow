import { describe, expect, it } from "vitest"
import {
  ACTIVE_SESSION_STATUSES,
  formatClockTime,
  formatSessionAmount,
  getDriverClosureNotice,
  isActiveSessionStatus,
} from "./sessionClosure"
import { DRIVER_CLOSURE_COPY, STOP_UNCONFIRMED_LABEL } from "./sessionClosureCopy"
import { CHARGING_SESSION_STATUS_LABELS, sessionStatusBadgeVariant } from "./utils"
import type { ChargingSessionStatus, MeSessionDetail, SessionClosureInfo } from "@/types/api"

// Sempre construído no fuso LOCAL e depois serializado — o teste não depende do TZ da máquina que o roda.
const localIso = (h: number, m: number) => new Date(2026, 9, 3, h, m, 0, 0).toISOString()

const emptyClosure: SessionClosureInfo = {
  source: null,
  meterStopSource: null,
  unconfirmedSince: null,
  unconfirmedReason: null,
  confirmDeadline: null,
  billedUntil: null,
}

type NoticeInput = Pick<MeSessionDetail, "status" | "paymentMode" | "closure" | "payment">

const walletUnconfirmed: NoticeInput = {
  status: "STOP_UNCONFIRMED",
  paymentMode: "WALLET",
  closure: { ...emptyClosure, unconfirmedReason: "STOP_NOT_CONFIRMED", confirmDeadline: localIso(18, 30) },
}

describe("formatClockTime", () => {
  it("HH:MM com zero à esquerda, no fuso local", () => {
    expect(formatClockTime(localIso(9, 5))).toBe("09:05")
    expect(formatClockTime(localIso(18, 30))).toBe("18:30")
  })

  it("meia-noite é 00:00 (ciclo de 24h, nunca 24:00 nem AM/PM)", () => {
    expect(formatClockTime(localIso(0, 0))).toBe("00:00")
  })

  it("ausente ou inválido => null (quem chama decide a frase sem horário)", () => {
    expect(formatClockTime(null)).toBeNull()
    expect(formatClockTime(undefined)).toBeNull()
    expect(formatClockTime("")).toBeNull()
    expect(formatClockTime("não é data")).toBeNull()
  })
})

describe("getDriverClosureNotice", () => {
  it("STOP_UNCONFIRMED na carteira: diz que nada foi cobrado e até que horas (closure.confirmDeadline)", () => {
    const notice = getDriverClosureNotice(walletUnconfirmed)
    expect(notice?.kind).toBe("pending")
    expect(notice?.lines).toEqual(["Encerramento em confirmação com o carregador. Nada foi cobrado ainda. Valor final até 18:30."])
  })

  it("STOP_UNCONFIRMED no cartão: acrescenta a pré-autorização que continua reservada, com o valor do payload", () => {
    const notice = getDriverClosureNotice({
      ...walletUnconfirmed,
      paymentMode: "CARD",
      payment: { mode: "CARD", card: { brand: "Visa", last4: "1234", authorizedCents: 6000, capturedCents: null, status: "AUTHORIZED" } },
    })
    expect(notice?.lines).toHaveLength(2)
    expect(notice?.lines[1]).toMatch(/^A pré-autorização de R\$\s60,00 continua reservada\.$/)
  })

  it("STOP_UNCONFIRMED no cartão SEM o valor autorizado no payload: não inventa valor, só a primeira frase", () => {
    const notice = getDriverClosureNotice({ ...walletUnconfirmed, paymentMode: "CARD", payment: { mode: "CARD", card: null } })
    expect(notice?.lines).toHaveLength(1)
  })

  it("STOP_UNCONFIRMED em carteira nunca fala de pré-autorização, mesmo que o payload traga um cartão", () => {
    const notice = getDriverClosureNotice({
      ...walletUnconfirmed,
      payment: { mode: "CARD", card: { brand: "Visa", last4: "1234", authorizedCents: 6000, capturedCents: null, status: "AUTHORIZED" } },
    })
    expect(notice?.lines).toHaveLength(1)
  })

  it("sem confirmDeadline (contrato diz que vem, mas é defensivo): a frase não termina em 'até null'", () => {
    const notice = getDriverClosureNotice({ ...walletUnconfirmed, closure: emptyClosure })
    expect(notice?.lines[0]).toBe("Encerramento em confirmação com o carregador. Nada foi cobrado ainda.")
  })

  it("STOPPED fechada pelo SERVIDOR: cobramos só o que foi medido até closure.billedUntil", () => {
    const notice = getDriverClosureNotice({
      status: "STOPPED",
      paymentMode: "WALLET",
      closure: { ...emptyClosure, source: "SERVER", meterStopSource: "LAST_METER_SAMPLE", billedUntil: localIso(14, 7) },
    })
    expect(notice?.kind).toBe("server")
    expect(notice?.lines).toEqual(["O carregador parou de responder. Cobramos só o que foi medido até 14:07."])
  })

  it("STOPPED fechada pelo CARREGADOR (o caminho normal): nenhum aviso", () => {
    expect(
      getDriverClosureNotice({ status: "STOPPED", paymentMode: "WALLET", closure: { ...emptyClosure, source: "CHARGER", meterStopSource: "STOP_TRANSACTION" } }),
    ).toBeNull()
  })

  it("sessão anterior à F5.9 (closure todo null) e sessão aberta: nenhum aviso", () => {
    expect(getDriverClosureNotice({ status: "STOPPED", paymentMode: "WALLET", closure: emptyClosure })).toBeNull()
    expect(getDriverClosureNotice({ status: "CHARGING", paymentMode: "WALLET", closure: emptyClosure })).toBeNull()
  })

  it("o stop tardio NUNCA chega ao motorista: nem o tipo de entrada tem o campo, e nenhum texto o menciona", () => {
    const all = [DRIVER_CLOSURE_COPY.unconfirmed("18:30"), DRIVER_CLOSURE_COPY.serverClosed("14:07"), DRIVER_CLOSURE_COPY.cardHoldKept("R$ 60,00")].join(" ")
    expect(all).not.toMatch(/tardio|StopTransaction|late/i)
  })
})

describe("'sessão ativa' do motorista", () => {
  it("FAULTED entra (o motorista pode encerrar); STOP_UNCONFIRMED e STOPPED não", () => {
    expect(isActiveSessionStatus("FAULTED")).toBe(true)
    expect(isActiveSessionStatus("STOP_UNCONFIRMED")).toBe(false)
    expect(isActiveSessionStatus("STOPPED")).toBe(false)
  })

  it("STARTED, CHARGING e FINISHING continuam ativas; ausente não é ativa", () => {
    for (const s of ["STARTED", "CHARGING", "FINISHING"] as const) expect(isActiveSessionStatus(s)).toBe(true)
    expect(isActiveSessionStatus(undefined)).toBe(false)
    expect(isActiveSessionStatus(null)).toBe(false)
  })

  it("a lista é exatamente estas 4 (mexer nela muda o polling e a tela de sessão)", () => {
    expect([...ACTIVE_SESSION_STATUSES].sort()).toEqual(["CHARGING", "FAULTED", "FINISHING", "STARTED"])
  })
})

describe("STOP_UNCONFIRMED nos rótulos e badges", () => {
  it("todo status tem rótulo, e o novo é o texto combinado", () => {
    const all: ChargingSessionStatus[] = ["STARTED", "CHARGING", "FINISHING", "STOPPED", "FAULTED", "STOP_UNCONFIRMED"]
    for (const s of all) expect(CHARGING_SESSION_STATUS_LABELS[s]).toBeTruthy()
    expect(CHARGING_SESSION_STATUS_LABELS.STOP_UNCONFIRMED).toBe("Encerramento em confirmação")
    expect(STOP_UNCONFIRMED_LABEL).toBe(CHARGING_SESSION_STATUS_LABELS.STOP_UNCONFIRMED)
  })

  it("é aviso (warning), não sucesso nem erro: nada foi cobrado, mas também não deu errado", () => {
    expect(sessionStatusBadgeVariant("STOP_UNCONFIRMED")).toBe("warning")
  })
})

describe("formatSessionAmount", () => {
  it("em confirmação não mostra R$ 0,00 (seria uma afirmação falsa), mostra 'Em confirmação'", () => {
    expect(formatSessionAmount("STOP_UNCONFIRMED", null)).toBe("Em confirmação")
  })

  it("nos outros estados formata normalmente", () => {
    expect(formatSessionAmount("STOPPED", 3265)).toMatch(/^R\$\s32,65$/)
  })
})
