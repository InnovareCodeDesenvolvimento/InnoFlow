import { describe, expect, it } from 'vitest'
import { LOG_SERIALIZERS, limparTextoSensivel } from '../../src/lib/logSerializers'

/**
 * F5.8 (Vega-3) — o erro de VALIDAÇÃO do Prisma monta a `message`/`stack` com os VALORES dos argumentos. `limparTextoSensivel` troca só o valor
 * entre aspas de um `campoSensivel: "valor"` (mesma lista de `CAMPOS_SENSIVEIS`), preservando o nome do campo e o resto do diagnóstico.
 */
describe('limparTextoSensivel — `campoSensivel: "valor"` no texto', () => {
  const MENSAGEM_PRISMA = [
    'Invalid `prisma.paymentGatewayConfig.update()` invocation:',
    '',
    '{',
    '  where: {',
    '    id: 1',
    '  },',
    '  data: {',
    '    merchantKeyCiphertext: "v1:k1:SEG-CIPHERTEXT-NO-ARGUMENTO",',
    '    sopClientId: 12345',
    '                 ~~~~~',
    '  }',
    '}',
    '',
    'Argument `sopClientId`: Invalid value provided. Expected String, NullableStringFieldUpdateOperationsInput or Null, provided Int.',
  ].join('\n')

  it('redige o valor da ciphertext, mantém o nome do campo e o diagnóstico', () => {
    const limpo = limparTextoSensivel(MENSAGEM_PRISMA)
    expect(limpo).not.toContain('SEG-CIPHERTEXT-NO-ARGUMENTO')
    expect(limpo).toContain('merchantKeyCiphertext: "[redacted]"')
    expect(limpo).toContain('sopClientId: 12345')
    expect(limpo).toContain('Argument `sopClientId`: Invalid value provided')
  })

  it('não toca em campo comum (mesmo com valor string) e não casa pedaço de nome ("xmerchantKey")', () => {
    const texto = 'data: { name: "Posto Central", siteId: "cm123", xmerchantKey: "visivel", xcpf: "visivel2" }'
    expect(limparTextoSensivel(texto)).toBe(texto)
  })

  it('valor com aspas escapadas e valor depois de outro campo na mesma linha', () => {
    const limpo = limparTextoSensivel('{ cardToken: "a\\"b-SEG1", cpf : "SEG2", ok: "fica" }')
    expect(limpo).not.toContain('SEG1')
    expect(limpo).not.toContain('SEG2')
    expect(limpo).toContain('ok: "fica"')
  })

  it('o serializer do `err` (message E stack) aplica a limpeza ao erro real', () => {
    const err = new Error(MENSAGEM_PRISMA)
    const s = JSON.stringify(LOG_SERIALIZERS.err(err))
    expect(s).not.toContain('SEG-CIPHERTEXT-NO-ARGUMENTO')
    expect(s).toContain('merchantKeyCiphertext')
  })

  it('`set-cookie` e o header do segredo do webhook dentro de um `err` aninhado saem redigidos (nomeDoCampo com colchetes)', () => {
    const err = Object.assign(new Error('h'), { response: { headers: { 'set-cookie': ['SEG-COOKIE'], 'X-InnoElektron-Webhook-Secret': 'SEG-WEBHOOK', accept: 'ok' } } })
    const s = JSON.stringify(LOG_SERIALIZERS.err(err))
    expect(s).not.toContain('SEG-COOKIE')
    expect(s).not.toContain('SEG-WEBHOOK')
    expect(s).toContain('"accept":"ok"')
  })
})
