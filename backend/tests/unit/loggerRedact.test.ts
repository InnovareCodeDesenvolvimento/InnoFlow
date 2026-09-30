import { describe, expect, it } from 'vitest'
import pino from 'pino'
import { Writable } from 'node:stream'
import { REDACT_PATHS } from '../../src/lib/logRedactPaths'

/**
 * Confere o `redact` de VERDADE usado por `src/lib/logger.ts` — importa a
 * MESMA lista de `logRedactPaths.ts` (não uma cópia à mão), então editar a
 * lista sem atualizar este teste não passa mais em silêncio. Não importa
 * `logger.ts` inteiro porque ele cria a instância real do pino com
 * transport `pino-pretty` como efeito colateral do import — pesado e
 * desnecessário só para testar a config de `redact`.
 *
 * Regra da tarefa (prioridade alta, achado do Órion): nenhum dos valores
 * sensíveis pode aparecer na SAÍDA do logger, nem em campo solto na raiz nem
 * aninhado um nível (o formato mais comum de log real — ex.
 * `logger.info({ cielo: { CardNumber } })`).
 */

function capturarSaidaDoLogger(objetoLogado: Record<string, unknown>): string {
  const chunks: string[] = []
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString())
      cb()
    },
  })
  const logger = pino({ redact: { paths: REDACT_PATHS, censor: '[redacted]' } }, stream)
  logger.info(objetoLogado, 'pagamento cielo (teste)')
  return chunks.join('')
}

const VALORES_SENSIVEIS = {
  CardNumber: '4111111111111111',
  SecurityCode: '737',
  CardToken: 'card-token-real-9f8e7d',
  cieloCardTokenCiphertext: 'cielo-card-token-real-abc123',
  PaymentToken: 'payment-token-real-xyz789',
  MerchantKey: 'merchant-key-real-secret',
  ClientSecret: 'client-secret-real-google',
  access_token: 'ya29.real-access-token',
  cpf: '12345678900',
}

describe('redact do logger — campos sensíveis do fluxo de pagamento (Cielo)', () => {
  it('campos soltos na raiz do objeto logado nunca aparecem na saída', () => {
    const saida = capturarSaidaDoLogger({ ...VALORES_SENSIVEIS })
    for (const valor of Object.values(VALORES_SENSIVEIS)) {
      expect(saida).not.toContain(valor)
    }
    expect(saida).toContain('[redacted]')
  })

  it('campos aninhados um nível (formato real de log, ex. logger.info({ cielo: {...} })) nunca aparecem na saída', () => {
    const saida = capturarSaidaDoLogger({ cielo: { ...VALORES_SENSIVEIS } })
    for (const valor of Object.values(VALORES_SENSIVEIS)) {
      expect(saida).not.toContain(valor)
    }
  })

  it('req.headers.merchantkey (case do Express — headers HTTP chegam em minúsculas) nunca aparece na saída', () => {
    const saida = capturarSaidaDoLogger({ req: { headers: { merchantkey: 'header-secret-value' } } })
    expect(saida).not.toContain('header-secret-value')
  })

  it('campos NÃO sensíveis do log de pagamento continuam visíveis (PaymentId/Status/ReturnCode/valores) — redact não apaga o log inteiro', () => {
    const saida = capturarSaidaDoLogger({
      cielo: { PaymentId: 'p-123', Status: 1, ReturnCode: '00', amountAuthorizedCents: 5000, ...VALORES_SENSIVEIS },
    })
    expect(saida).toContain('p-123')
    expect(saida).toContain('5000')
    expect(saida).toContain('"ReturnCode":"00"')
  })
})
