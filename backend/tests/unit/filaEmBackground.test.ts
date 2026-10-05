import { describe, expect, it } from 'vitest'
import { FilaEmBackground } from '../../src/lib/filaEmBackground'

const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

describe('FilaEmBackground', () => {
  it('agendar é síncrono e NÃO executa a tarefa no mesmo tick (o chamador responde antes)', async () => {
    const fila = new FilaEmBackground()
    let rodou = false
    expect(fila.agendar(async () => { rodou = true })).toBe(true)
    expect(rodou).toBe(false)
    await fila.aguardarOciosa()
    expect(rodou).toBe(true)
  })

  it('limita a concorrência', async () => {
    const fila = new FilaEmBackground({ concorrencia: 2 })
    let ativas = 0
    let pico = 0
    for (let i = 0; i < 8; i++) {
      fila.agendar(async () => {
        ativas++
        pico = Math.max(pico, ativas)
        await dormir(10)
        ativas--
      })
    }
    await fila.aguardarOciosa()
    expect(pico).toBe(2)
  })

  it('fila cheia descarta o excesso e avisa (false), sem acumular', async () => {
    const fila = new FilaEmBackground({ concorrencia: 1, tamanhoMaximo: 3 })
    const resultados = Array.from({ length: 6 }, () => fila.agendar(async () => dormir(5)))
    expect(resultados.filter(Boolean)).toHaveLength(3)
    expect(resultados.filter((r) => !r)).toHaveLength(3)
    await fila.aguardarOciosa()
  })

  it('uma tarefa que lança não derruba as outras nem o processo (vai para aoFalhar)', async () => {
    const falhas: unknown[] = []
    const fila = new FilaEmBackground({ aoFalhar: (e) => falhas.push(e) })
    let depois = false
    fila.agendar(async () => { throw new Error('boom') })
    fila.agendar(async () => { depois = true })
    await fila.aguardarOciosa()
    expect(depois).toBe(true)
    expect(falhas).toHaveLength(1)
  })

  it('aoFalhar que também lança não quebra a fila', async () => {
    const fila = new FilaEmBackground({ aoFalhar: () => { throw new Error('tratador ruim') } })
    let rodou = false
    fila.agendar(async () => { throw new Error('x') })
    fila.agendar(async () => { rodou = true })
    await fila.aguardarOciosa()
    expect(rodou).toBe(true)
  })
})
