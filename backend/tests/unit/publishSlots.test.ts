import { describe, expect, it } from 'vitest'
import { createPublishSlots } from '../../src/core/realtime/publishSlots'

function relogio(inicio = 1_000_000) {
  let t = inicio
  return { now: () => t, avancar: (ms: number) => (t += ms) }
}

describe('createPublishSlots (teto de publishes em voo — B1)', () => {
  it('reserva até o teto e recusa o excedente; liberar devolve a vaga', () => {
    const slots = createPublishSlots({ max: 2, maxAgeMs: 60_000 })
    const a = slots.tryAcquire()
    const b = slots.tryAcquire()
    expect(a.id).not.toBeNull()
    expect(b.id).not.toBeNull()
    expect(slots.tryAcquire().id).toBeNull()
    expect(slots.release(a.id!)).toBe(true)
    expect(slots.size).toBe(1)
    expect(slots.tryAcquire().id).not.toBeNull()
  })

  it('liberar é idempotente: a segunda devolução da MESMA vaga não abre vaga que não existe', () => {
    const slots = createPublishSlots({ max: 1, maxAgeMs: 60_000 })
    const a = slots.tryAcquire()
    expect(slots.release(a.id!)).toBe(true)
    expect(slots.release(a.id!)).toBe(false)
    const b = slots.tryAcquire()
    expect(b.id).not.toBeNull()
    expect(slots.tryAcquire().id).toBeNull() // o `release` repetido NÃO deixou o teto passar de 1
  })

  it('vagas ÓRFÃS (nunca liquidadas) são recuperadas por idade só quando o teto enche — e a promessa que liquida depois não devolve em dobro', () => {
    const r = relogio()
    const slots = createPublishSlots({ max: 3, maxAgeMs: 60_000, now: r.now })
    const orfas = [slots.tryAcquire(), slots.tryAcquire(), slots.tryAcquire()]
    expect(slots.tryAcquire().id).toBeNull() // cheio, ninguém tem idade para ser recuperado ainda

    r.avancar(59_999)
    expect(slots.tryAcquire()).toMatchObject({ id: null, reclaimed: 0 })

    r.avancar(2) // passou de 60 s: as três são órfãs
    const nova = slots.tryAcquire()
    expect(nova.id).not.toBeNull()
    expect(nova.reclaimed).toBe(3)
    expect(slots.size).toBe(1)

    // uma das órfãs "ressuscita" e liquida: não pode devolver a vaga de ninguém
    expect(slots.release(orfas[0].id!)).toBe(false)
    expect(slots.size).toBe(1)
  })

  it('só recupera as VELHAS: vagas recentes continuam ocupadas', () => {
    const r = relogio()
    const slots = createPublishSlots({ max: 2, maxAgeMs: 60_000, now: r.now })
    slots.tryAcquire() // velha
    r.avancar(50_000)
    const recente = slots.tryAcquire()
    r.avancar(20_000) // a 1ª tem 70 s; a 2ª, 20 s
    const nova = slots.tryAcquire()
    expect(nova.reclaimed).toBe(1)
    expect(nova.id).not.toBeNull()
    expect(slots.size).toBe(2) // a recente + a nova
    expect(slots.release(recente.id!)).toBe(true)
  })
})
