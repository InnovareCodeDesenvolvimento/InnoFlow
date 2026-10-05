import { describe, expect, it } from "vitest"
import { AxiosError, type AxiosResponse } from "axios"
import {
  ACCEPTED_WITH_SESSION_DETAIL,
  CHARGE_POINT_OFFLINE_NOTICE,
  COMMAND_PHASE_COPY,
  REMOTE_START_FALLBACK_MESSAGE,
  REMOTE_START_REASON_MAX,
  REMOTE_START_REASON_MIN,
  commandPhaseCopy,
  isChargePointOffline,
  isConnectorStartable,
  isTerminalPhase,
  remoteStartError,
  remoteStartSummary,
  validateReason,
} from "./remoteStart"
import { CONNECTOR_STATUSES } from "@/types/api"

function httpError(status: number, code?: string, details?: Array<{ path?: string; message?: string }>, headers?: Record<string, string>) {
  const err = new AxiosError("falhou")
  err.response = { status, data: { error: "texto do backend que NÃO pode aparecer", code, details }, headers } as unknown as AxiosResponse
  return err
}

describe("carregador offline — só `online === false` explícito bloqueia", () => {
  it("false bloqueia; true e undefined (campo ausente) deixam seguir e o servidor decide", () => {
    expect(isChargePointOffline(false)).toBe(true)
    expect(isChargePointOffline(true)).toBe(false)
    expect(isChargePointOffline(undefined)).toBe(false)
  })
  it("o aviso é o texto combinado", () => {
    expect(CHARGE_POINT_OFFLINE_NOTICE).toBe("Este carregador está offline. Não é possível iniciar uma recarga agora.")
  })
})

describe("validateReason — espelha 10–200, trim, sem caracteres de controle", () => {
  it("vazio e só espaços: pede o motivo", () => {
    expect(validateReason("").error).toMatch(/Informe o motivo/)
    expect(validateReason("          ").error).toMatch(/Informe o motivo/)
  })
  it("conta DEPOIS do trim: 9 letras com espaços em volta ainda é curto, e diz quantas faltam", () => {
    const v = validateReason("   123456789   ")
    expect(v.reason).toBe("123456789")
    expect(v.error).toMatch(/faltam 1/)
  })
  it("10 e 200 passam; 201 não (e diz quantos sobram)", () => {
    expect(validateReason("x".repeat(REMOTE_START_REASON_MIN)).error).toBeNull()
    expect(validateReason("x".repeat(REMOTE_START_REASON_MAX)).error).toBeNull()
    expect(validateReason("x".repeat(REMOTE_START_REASON_MAX + 1)).error).toMatch(/sobram 1/)
  })
  it("quebra de linha e tab NO MEIO são recusados (iriam para a auditoria); a do fim é aparada pelo trim, como no servidor", () => {
    expect(validateReason("primeira linha\nsegunda linha").error).toMatch(/uma linha só/)
    expect(validateReason("com\ttab no meio do texto").error).toMatch(/uma linha só/)
    expect(validateReason("motivo completo e válido\n").error).toBeNull()
  })
})

describe("isConnectorStartable — só AVAILABLE (o servidor responde CONNECTOR_BUSY para o resto, inclusive PREPARING)", () => {
  it("é AVAILABLE e mais nada", () => {
    expect(CONNECTOR_STATUSES.filter(isConnectorStartable)).toEqual(["AVAILABLE"])
  })
})

describe("remoteStartError — por code/status, nunca pelo texto do backend", () => {
  it("cada código do contrato tem mensagem própria, e nenhuma é o texto do backend", () => {
    const codes = ["CHARGE_POINT_NOT_FOUND", "CONNECTOR_NOT_FOUND", "USER_NOT_FOUND", "DRIVER_HAS_OPEN_DEBT", "INSUFFICIENT_BALANCE", "CONNECTOR_BUSY", "CHARGE_POINT_OFFLINE", "FORBIDDEN"]
    const messages = codes.map((c) => remoteStartError(httpError(c === "FORBIDDEN" ? 403 : 409, c)).message)
    expect(new Set(messages).size).toBe(codes.length) // todas diferentes
    for (const m of messages) {
      expect(m).not.toMatch(/NÃO pode aparecer/)
      expect(m).not.toBe(REMOTE_START_FALLBACK_MESSAGE)
    }
    expect(remoteStartError(httpError(409, "DRIVER_HAS_OPEN_DEBT")).message).toMatch(/dívida em aberto/)
    expect(remoteStartError(httpError(403, "FORBIDDEN")).message).toMatch(/administradores/)
  })
  it("400 com details[].path = reason: o erro é DO CAMPO (a tela volta ao formulário); outro 400 não", () => {
    expect(remoteStartError(httpError(400, "VALIDATION_ERROR", [{ path: "reason", message: "x" }])).field).toBe("reason")
    expect(remoteStartError(httpError(400, "VALIDATION_ERROR", [{ path: "connectorId", message: "x" }])).field).toBeUndefined()
  })
  it("sem resposta (rede) e 5xx: resultado INCERTO — manda conferir em Sessões antes de repetir", () => {
    const network = remoteStartError(new AxiosError("Network Error"))
    expect(network.message).toMatch(/Sem conexão/)
    expect(network.message).toMatch(/Sessões/)
    expect(remoteStartError(httpError(500, "INTERNAL_ERROR")).message).toMatch(/Sessões/)
    expect(remoteStartError(httpError(503)).message).toMatch(/instável/)
  })
  it("429 com Retry-After legível (CORS expõe o header) diz o tempo exato; sem o header, 'alguns minutos'", () => {
    expect(remoteStartError(httpError(429, "RATE_LIMITED", undefined, { "retry-after": "300" })).message).toBe("Muitas tentativas para esta conta. Tente de novo em 5 minutos.")
    expect(remoteStartError(httpError(429, "RATE_LIMITED", undefined, { "retry-after": "20" })).message).toMatch(/menos de 1 minuto/)
    expect(remoteStartError(httpError(429, "RATE_LIMITED")).message).toMatch(/alguns minutos/)
  })
  it("429 e código desconhecido caem em mensagens próprias", () => {
    expect(remoteStartError(httpError(429, "RATE_LIMITED")).message).toMatch(/Muitas tentativas/)
    expect(remoteStartError(httpError(409, "ALGO_NOVO")).message).toBe(REMOTE_START_FALLBACK_MESSAGE)
    expect(remoteStartError(new Error("x")).message).toBe(REMOTE_START_FALLBACK_MESSAGE)
  })
})

describe("textos de acompanhamento", () => {
  it("REJECTED é aviso, não erro: 'O carregador recusou…', tom warning", () => {
    expect(COMMAND_PHASE_COPY.REJECTED.title).toBe("O carregador recusou o início da recarga.")
    expect(COMMAND_PHASE_COPY.REJECTED.tone).toBe("warning")
  })
  it("TIMEOUT diz 'Sem resposta do carregador' e avisa que pode ter começado; 404 é 'Resultado indisponível'", () => {
    expect(COMMAND_PHASE_COPY.TIMEOUT.title).toBe("Sem resposta do carregador.")
    expect(COMMAND_PHASE_COPY.TIMEOUT.detail).toMatch(/pode ter começado/)
    expect(COMMAND_PHASE_COPY.UNAVAILABLE.title).toBe("Resultado indisponível.")
  })
  it("fases terminais: tudo menos IDLE e POLLING", () => {
    expect(isTerminalPhase("IDLE")).toBe(false)
    expect(isTerminalPhase("POLLING")).toBe(false)
    for (const p of ["ACCEPTED", "REJECTED", "TIMEOUT", "UNAVAILABLE", "NO_ANSWER", "ERROR"] as const) expect(isTerminalPhase(p)).toBe(true)
  })
  it("STARTING (aceito, sessão ainda não criada) NÃO é desfecho e tem texto próprio", () => {
    expect(isTerminalPhase("STARTING")).toBe(false)
    expect(COMMAND_PHASE_COPY.STARTING.title).toBe("Aguardando a sessão iniciar…")
    expect(COMMAND_PHASE_COPY.STARTING.tone).toBe("info")
  })
  it("ACCEPTED: o detalhe muda quando a sessão já existe", () => {
    expect(commandPhaseCopy("ACCEPTED", "sess_1").detail).toBe(ACCEPTED_WITH_SESSION_DETAIL)
    expect(commandPhaseCopy("ACCEPTED", null)).toBe(COMMAND_PHASE_COPY.ACCEPTED)
    expect(commandPhaseCopy("TIMEOUT", "sess_1")).toBe(COMMAND_PHASE_COPY.TIMEOUT)
  })
  it("a frase de confirmação nomeia a carteira", () => {
    expect(remoteStartSummary("Carla Motorista")).toBe("Vai debitar a carteira de Carla Motorista")
  })
})
