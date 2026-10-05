/** N-7 — o hook do logger nunca lança nem atrasa quem logou, mesmo com objeto hostil ou notificador quebrado. */
import { afterEach, describe, expect, it } from 'vitest'
import { definirNotificadorParaTeste, despacharAlertaDoLog } from '../../src/lib/alertas/hookLogger'
import type { Notificador, EventoBruto } from '../../src/lib/alertas/notificador'

afterEach(() => definirNotificadorParaTeste(undefined))

function falso(fn: (e: EventoBruto) => unknown): Notificador {
  return { notificar: fn } as unknown as Notificador
}

describe('despacharAlertaDoLog', () => {
  it('só despacha quando há `alert` string não vazia no PRIMEIRO argumento', () => {
    const vistos: EventoBruto[] = []
    definirNotificadorParaTeste(falso((e) => vistos.push(e)))
    despacharAlertaDoLog([{ alert: 'payment_void_manual_review', paymentIntentId: 'x' }, 'msg'], 50)
    despacharAlertaDoLog([{ alert: 42 }], 50)
    despacharAlertaDoLog([{ alert: '' }], 50)
    despacharAlertaDoLog([{ outro: 'x' }], 50)
    despacharAlertaDoLog(['só texto'], 50)
    despacharAlertaDoLog([null], 50)
    despacharAlertaDoLog([], 50)
    expect(vistos).toHaveLength(1)
    expect(vistos[0]).toMatchObject({ alerta: 'payment_void_manual_review', nivelPino: 50, mensagem: 'msg' })
  })

  it('getter que lança no objeto logado, e notificador que lança: o hook engole (nunca propaga ao call site)', () => {
    const hostil = {}
    Object.defineProperty(hostil, 'alert', { enumerable: true, get() { throw new Error('getter hostil') } })
    definirNotificadorParaTeste(falso(() => { throw new Error('notificador quebrado') }))
    expect(() => despacharAlertaDoLog([hostil], 50)).not.toThrow()
    expect(() => despacharAlertaDoLog([{ alert: 'ocpp_message_flood' }], 40)).not.toThrow()
  })

  it('notificador desligado (null) ignora tudo sem custo', () => {
    definirNotificadorParaTeste(null)
    expect(() => despacharAlertaDoLog([{ alert: 'ocpp_message_flood' }], 40)).not.toThrow()
  })
})
