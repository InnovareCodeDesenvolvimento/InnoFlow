import { describe, expect, it } from "vitest"
import { extractSseData, splitSseEvents } from "./sse"

describe("splitSseEvents", () => {
  it("separa blocos completos do resto incompleto", () => {
    const buffer = 'data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"c":3}'
    const { events, rest } = splitSseEvents(buffer)
    expect(events).toEqual(['data: {"a":1}', 'data: {"b":2}'])
    expect(rest).toBe('data: {"c":3}')
  })

  it("normaliza CRLF (alguns proxies reescrevem quebra de linha)", () => {
    const buffer = 'data: {"a":1}\r\n\r\ndata: {"b":2}\r\n\r\n'
    const { events, rest } = splitSseEvents(buffer)
    expect(events).toEqual(['data: {"a":1}', 'data: {"b":2}'])
    expect(rest).toBe("")
  })

  it("ignora blocos vazios (heartbeat de linha em branco dupla)", () => {
    const { events } = splitSseEvents("\n\n\n\ndata: {}\n\n")
    expect(events).toEqual(["data: {}"])
  })
})

describe("extractSseData", () => {
  it("extrai o payload de uma linha data: simples", () => {
    expect(extractSseData('data: {"type":"dashboard.dirty"}')).toBe('{"type":"dashboard.dirty"}')
  })

  it("concatena múltiplas linhas data: (payload multi-linha)", () => {
    expect(extractSseData("data: linha1\ndata: linha2")).toBe("linha1\nlinha2")
  })

  it("devolve null para comentário/heartbeat puro (:ping)", () => {
    expect(extractSseData(":ping")).toBeNull()
  })

  it("ignora linhas de comentário misturadas com data:", () => {
    expect(extractSseData(':ping\ndata: {"ok":true}')).toBe('{"ok":true}')
  })
})
