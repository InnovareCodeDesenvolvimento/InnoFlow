/**
 * Decide se a RECONSULTA da venda na Cielo prova que o estorno feito no portal aconteceu (DL8, L1.8). Pura: sem rede, sem banco.
 *
 * O QUE SE SABE da Cielo (API 3.0, doc pública e `normalizarStatusCartaoCielo`): `Status 11 = Refunded` (venda totalmente estornada), `Status 2` = capturada
 * (inclui venda ainda NÃO estornada), `Status 10 = Voided`. O QUE NÃO SE SABE (nunca foi visto em sandbox): como a consulta mostra um estorno PARCIAL
 * (provavelmente `Status 2` com um valor estornado em campo que o adaptador nem lê) e se o `Status 11` aparece num estorno parcial.
 *
 * Por isso a regra é CONSERVADORA — só confirma o que é inequívoco, e trata TODO o resto (inclusive o desconhecido) como "não confirmado":
 *   - `Status 11` E a soma das devoluções registradas (as pendentes + as já confirmadas) é IGUAL ao capturado -> a venda inteira foi estornada e o registro
 *     do ADMIN bate com isso: CONFIRMADO;
 *   - `Status 11` mas o ADMIN registrou MENOS que o capturado -> a Cielo diz "tudo" e nós dizemos "parte": divergência, NÃO confirma (alerta para um humano);
 *   - `Status 2` (ainda capturada) -> NÃO confirmado ainda (ou foi parcial, o que não sabemos ler): segue pendente;
 *   - qualquer outro status, ou ausente -> NÃO confirmado.
 * Nunca lança e nunca devolve "confirmado" por falta de informação.
 */

export type MotivoNaoConfirmado = 'AINDA_CAPTURADA' | 'STATUS_REFUNDED_MAS_REGISTRO_PARCIAL' | 'STATUS_NAO_RECONHECIDO' | 'SEM_STATUS'

export type VeredictoReconsultaEstorno = { confirmado: true } | { confirmado: false; motivo: MotivoNaoConfirmado }

export interface EntradaReconsultaEstorno {
  /** `Payment.Status` BRUTO da consulta (`ResultadoConsultaPagamento.statusBruto`). */
  statusBruto: number | null | undefined
  /** `PaymentIntent.amountCapturedCents`. */
  capturadoCents: number
  /** Σ das devoluções via portal NÃO canceladas da venda (confirmadas + pendentes). */
  devolucoesRegistradasCents: number
}

export function interpretarReconsultaEstorno(entrada: EntradaReconsultaEstorno): VeredictoReconsultaEstorno {
  const { statusBruto, capturadoCents, devolucoesRegistradasCents } = entrada
  if (statusBruto === null || statusBruto === undefined) return { confirmado: false, motivo: 'SEM_STATUS' }
  if (statusBruto === 11) {
    if (capturadoCents > 0 && devolucoesRegistradasCents === capturadoCents) return { confirmado: true }
    return { confirmado: false, motivo: 'STATUS_REFUNDED_MAS_REGISTRO_PARCIAL' }
  }
  if (statusBruto === 2) return { confirmado: false, motivo: 'AINDA_CAPTURADA' }
  return { confirmado: false, motivo: 'STATUS_NAO_RECONHECIDO' }
}

/** A consulta de venda da Cielo só alcança ~3 meses: passada a janela (com folga), reconsultar é inútil e só gera ruído — o job para e alerta. */
export function foraDaJanelaDeConsulta(criadoEm: Date, agora: Date, janelaDias: number): boolean {
  return agora.getTime() - criadoEm.getTime() > janelaDias * 24 * 3600 * 1000
}
