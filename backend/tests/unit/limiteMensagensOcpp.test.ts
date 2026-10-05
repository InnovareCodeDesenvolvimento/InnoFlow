import { describe, expect, it } from 'vitest'
import {
  ALERTA_OCPP_MESSAGE_FLOOD,
  JanelaDeslizanteMensagens,
  OCPP_MAX_BAD_MESSAGES,
  OCPP_MESSAGE_RATE_MAX_DEFAULT,
  OCPP_MESSAGE_RATE_WINDOW_SECONDS_DEFAULT,
  resumirChamadaSemHandler,
} from '../../src/core/ocpp/limiteMensagens'

/** Relógio controlável para a janela deslizante. */
function relogio(inicio = 1_000_000) {
  let t = inicio
  return { agora: () => t, avancar: (ms: number) => (t += ms) }
}

describe('JanelaDeslizanteMensagens (N-10)', () => {
  it('até `max` mensagens na janela passam; a de número max+1 excede', () => {
    const r = relogio()
    const j = new JanelaDeslizanteMensagens(5, 10_000, r.agora)
    for (let i = 0; i < 5; i++) expect(j.registrar()).toBe(false)
    expect(j.registrar()).toBe(true)
  })

  it('é janela DESLIZANTE: mensagens antigas saem da conta conforme o tempo passa (sem "degrau" de janela fixa)', () => {
    const r = relogio()
    const j = new JanelaDeslizanteMensagens(3, 10_000, r.agora)
    expect(j.registrar()).toBe(false) // t=0
    r.avancar(4_000)
    expect(j.registrar()).toBe(false) // t=4s
    r.avancar(4_000)
    expect(j.registrar()).toBe(false) // t=8s  (3 na janela)
    r.avancar(1_000)
    expect(j.registrar()).toBe(true) // t=9s: a de t=0 ainda está dentro dos 10 s -> 4ª na janela
    r.avancar(1_500)
    // t=10.5s: a de t=0 saiu; o anel agora tem [t=9s(excedente), 4s, 8s] -> a mais antiga que conta é a de 4 s (já a 6,5 s)
    expect(j.registrar()).toBe(true)
  })

  it('volta a aceitar depois de uma pausa maior que a janela (carregador legítimo que só teve uma rajada)', () => {
    const r = relogio()
    const j = new JanelaDeslizanteMensagens(4, 10_000, r.agora)
    for (let i = 0; i < 4; i++) j.registrar()
    expect(j.registrar()).toBe(true)
    r.avancar(10_001)
    for (let i = 0; i < 4; i++) expect(j.registrar()).toBe(false)
  })

  it('o instante exato de saída da janela (agora - mais antigo == janela) conta como FORA', () => {
    const r = relogio()
    const j = new JanelaDeslizanteMensagens(2, 1_000, r.agora)
    j.registrar()
    j.registrar()
    r.avancar(1_000)
    expect(j.registrar()).toBe(false)
  })

  it('rejeita configuração inválida (não vira "sem limite" por engano)', () => {
    expect(() => new JanelaDeslizanteMensagens(0, 1000)).toThrow()
    expect(() => new JanelaDeslizanteMensagens(1.5, 1000)).toThrow()
    expect(() => new JanelaDeslizanteMensagens(10, 0)).toThrow()
    expect(() => new JanelaDeslizanteMensagens(10, Number.NaN)).toThrow()
  })

  it('memória fixa: o anel nunca passa de `max` instantes', () => {
    const r = relogio()
    const j = new JanelaDeslizanteMensagens(100, 10_000, r.agora)
    for (let i = 0; i < 100_000; i++) {
      r.avancar(1)
      j.registrar()
    }
    expect((j as unknown as { instantes: number[] }).instantes.length).toBe(100)
  })
})

describe('defaults escolhidos para o ritmo real de um carregador', () => {
  it('folga larga sobre o regime normal (~2 msg/s) e sobre o replay offline serial (<= ~100/s)', () => {
    const porSegundo = OCPP_MESSAGE_RATE_MAX_DEFAULT / OCPP_MESSAGE_RATE_WINDOW_SECONDS_DEFAULT
    expect(porSegundo).toBeGreaterThanOrEqual(100)
    // pior regime normal plausível: 2 conectores amostrando a cada 1 s
    expect(porSegundo / 2).toBeGreaterThanOrEqual(50)
  })

  it('maxBadMessages é baixo (mensagens ruins SEGUIDAS) e o alert tem nome estável', () => {
    expect(OCPP_MAX_BAD_MESSAGES).toBeGreaterThanOrEqual(3)
    expect(OCPP_MAX_BAD_MESSAGES).toBeLessThanOrEqual(20)
    expect(ALERTA_OCPP_MESSAGE_FLOOD).toBe('ocpp_message_flood')
  })
})

describe('resumirChamadaSemHandler — o que o handler coringa pode logar', () => {
  it('devolve só a ação e o tamanho em bytes dos params — nunca os params', () => {
    const params = { idTag: 'SEGREDO-DO-MOTORISTA', serial: '123456' }
    const r = resumirChamadaSemHandler('DiagnosticsStatusNotification', params)
    expect(r).toEqual({ action: 'DiagnosticsStatusNotification', paramsBytes: Buffer.byteLength(JSON.stringify(params)) })
    expect(JSON.stringify(r)).not.toContain('SEGREDO')
    expect(Object.keys(r).sort()).toEqual(['action', 'paramsBytes'])
  })

  it('params ausentes = 0 bytes; nome de método gigante é truncado (vem do carregador)', () => {
    expect(resumirChamadaSemHandler('Foo', undefined)).toEqual({ action: 'Foo', paramsBytes: 0 })
    const r = resumirChamadaSemHandler('X'.repeat(200_000), {})
    expect(r.action.length).toBeLessThanOrEqual(70)
  })

  it('método não-string não derruba o log', () => {
    expect(resumirChamadaSemHandler(Symbol('x'), 1).action).toBe('Symbol(x)')
  })
})
