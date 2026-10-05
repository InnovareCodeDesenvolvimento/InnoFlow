import { describe, expect, it } from "vitest"
import {
  ONBOARDING_OFF_KEY,
  checklistStorageKey,
  clearTourRecord,
  dismissChecklist,
  isChecklistDismissed,
  isOnboardingOff,
  readTourRecord,
  shouldAutoStart,
  tourStorageKey,
  writeTourRecord,
  type TourRecord,
} from "./onboardingStorage"

class MemoryStorage implements Storage {
  private data = new Map<string, string>()
  get length() {
    return this.data.size
  }
  clear() {
    this.data.clear()
  }
  getItem(key: string) {
    return this.data.get(key) ?? null
  }
  key(index: number) {
    return [...this.data.keys()][index] ?? null
  }
  removeItem(key: string) {
    this.data.delete(key)
  }
  setItem(key: string, value: string) {
    this.data.set(key, value)
  }
}

/** Storage que lança em tudo (modo privado, cota cheia, bloqueado pela política do navegador). */
class BrokenStorage extends MemoryStorage {
  getItem(): string | null {
    throw new DOMException("bloqueado", "SecurityError")
  }
  setItem(): void {
    throw new DOMException("cota", "QuotaExceededError")
  }
  removeItem(): void {
    throw new DOMException("bloqueado", "SecurityError")
  }
}

const record = (over: Partial<TourRecord> = {}): TourRecord => ({ version: 1, status: "completed", at: "2026-10-05T12:00:00.000Z", ...over })

describe("persistência do tour por usuário", () => {
  it("sem registro: nenhum, e o tour abre sozinho", () => {
    const read = readTourRecord("u1", "driver", new MemoryStorage())
    expect(read).toEqual({ kind: "none" })
    expect(shouldAutoStart(read, 1)).toBe(true)
  })

  it("grava e lê o registro; quem concluiu a versão atual não é incomodado", () => {
    const s = new MemoryStorage()
    expect(writeTourRecord("u1", "driver", record(), s)).toBe(true)
    const read = readTourRecord("u1", "driver", s)
    expect(read).toEqual({ kind: "record", record: record() })
    expect(shouldAutoStart(read, 1)).toBe(false)
  })

  it("quem PULOU também não é incomodado de novo", () => {
    const s = new MemoryStorage()
    writeTourRecord("u1", "admin", record({ status: "skipped" }), s)
    expect(shouldAutoStart(readTourRecord("u1", "admin", s), 1)).toBe(false)
  })

  it("roteiro novo (versão maior) reexibe o tour a quem viu a anterior; versão igual ou maior no registro não", () => {
    const s = new MemoryStorage()
    writeTourRecord("u1", "admin", record({ version: 1 }), s)
    const read = readTourRecord("u1", "admin", s)
    expect(shouldAutoStart(read, 2)).toBe(true)
    expect(shouldAutoStart(read, 1)).toBe(false)
    expect(shouldAutoStart({ kind: "record", record: record({ version: 3 }) }, 2)).toBe(false)
  })

  it("é por USUÁRIO e por TOUR: o registro de um não vale para outro", () => {
    const s = new MemoryStorage()
    writeTourRecord("u1", "driver", record(), s)
    expect(readTourRecord("u2", "driver", s).kind).toBe("none")
    expect(readTourRecord("u1", "admin", s).kind).toBe("none")
    expect(tourStorageKey("u1", "driver")).not.toBe(tourStorageKey("u2", "driver"))
  })

  it("registro inválido (JSON quebrado ou formato errado) não derruba nem incomoda; o próximo 'concluir' o conserta", () => {
    const s = new MemoryStorage()
    s.setItem(tourStorageKey("u1", "driver"), "{não é json")
    expect(shouldAutoStart(readTourRecord("u1", "driver", s), 1)).toBe(false) // JSON.parse lança: não dá para confiar, então não incomoda
    s.setItem(tourStorageKey("u1", "driver"), JSON.stringify({ version: "x", status: "?" }))
    expect(readTourRecord("u1", "driver", s)).toEqual({ kind: "none" })
    expect(writeTourRecord("u1", "driver", record(), s)).toBe(true)
    expect(readTourRecord("u1", "driver", s).kind).toBe("record")
  })

  it("armazenamento indisponível (lança): não derruba, não grava e NÃO abre o tour sozinho", () => {
    const s = new BrokenStorage()
    const read = readTourRecord("u1", "driver", s)
    expect(read).toEqual({ kind: "unavailable" })
    expect(shouldAutoStart(read, 1)).toBe(false)
    expect(writeTourRecord("u1", "driver", record(), s)).toBe(false)
    expect(() => clearTourRecord("u1", "driver", s)).not.toThrow()
    expect(readTourRecord("u1", "driver", null)).toEqual({ kind: "unavailable" })
    expect(writeTourRecord("u1", "driver", record(), null)).toBe(false)
  })

  it("interruptor do aparelho: com ele ligado o tour nunca abre sozinho", () => {
    const s = new MemoryStorage()
    expect(isOnboardingOff(s)).toBe(false)
    s.setItem(ONBOARDING_OFF_KEY, "1")
    expect(isOnboardingOff(s)).toBe(true)
    expect(shouldAutoStart({ kind: "none" }, 1, isOnboardingOff(s))).toBe(false)
    expect(isOnboardingOff(new BrokenStorage())).toBe(false)
  })

  it("limpar o registro devolve ao 1º acesso", () => {
    const s = new MemoryStorage()
    writeTourRecord("u1", "driver", record(), s)
    clearTourRecord("u1", "driver", s)
    expect(readTourRecord("u1", "driver", s).kind).toBe("none")
  })
})

describe("checklist dispensado", () => {
  it("é por usuário e persiste", () => {
    const s = new MemoryStorage()
    expect(isChecklistDismissed("u1", s)).toBe(false)
    expect(dismissChecklist("u1", s)).toBe(true)
    expect(isChecklistDismissed("u1", s)).toBe(true)
    expect(isChecklistDismissed("u2", s)).toBe(false)
    expect(checklistStorageKey("u1")).not.toBe(checklistStorageKey("u2"))
  })

  it("sem armazenamento não derruba", () => {
    expect(dismissChecklist("u1", new BrokenStorage())).toBe(false)
    expect(isChecklistDismissed("u1", new BrokenStorage())).toBe(false)
  })
})
