/**
 * Identificadores da venda que a Cielo devolve e que precisam ser GUARDADOS na hora (F22, C2.5): `Tid`, `AuthorizationCode` e `ProofOfSale`.
 * A consulta de venda só alcança 3 meses e o chargeback chega depois — sem eles gravados, nada a reclamar à adquirente. Pura (sem Prisma/HTTP).
 *
 * Regras: vazio/ausente/tipo estranho -> `null` (nunca string vazia); número vira texto; valor acima de 64 caracteres (tamanho da coluna
 * `VarChar(64)`) é TRUNCADO e sinalizado — o fluxo de dinheiro, que já passou pela Cielo, nunca pode cair por causa de um metadado.
 */
export const LIMITE_IDENTIFICADOR_ADQUIRENTE = 64

export interface IdentificadoresAdquirente {
  tid: string | null
  authorizationCode: string | null
  proofOfSale: string | null
}

export const SEM_IDENTIFICADORES_ADQUIRENTE: IdentificadoresAdquirente = { tid: null, authorizationCode: null, proofOfSale: null }

export function normalizarIdentificadorAdquirente(bruto: unknown, limite: number = LIMITE_IDENTIFICADOR_ADQUIRENTE): { valor: string | null; truncado: boolean } {
  let texto: string
  if (typeof bruto === 'string') texto = bruto.trim()
  else if (typeof bruto === 'number' && Number.isFinite(bruto)) texto = String(bruto)
  else return { valor: null, truncado: false }
  if (texto === '') return { valor: null, truncado: false }
  if (texto.length > limite) return { valor: texto.slice(0, limite), truncado: true }
  return { valor: texto, truncado: false }
}

/** Só as chaves com valor: gravar `null` por cima de um identificador que a autorização já trouxe (a captura nem sempre repete) apagaria o dado. */
export function identificadoresParaGravar(ids: IdentificadoresAdquirente | null | undefined): Partial<{ cieloTid: string; cieloAuthorizationCode: string; cieloProofOfSale: string }> {
  const dados: Partial<{ cieloTid: string; cieloAuthorizationCode: string; cieloProofOfSale: string }> = {}
  if (!ids) return dados
  // Rede de segurança: qualquer adaptador (não só o da Cielo) que devolva mais de 64 caracteres NUNCA pode derrubar o UPDATE que registra uma autorização/captura já feita.
  const tid = normalizarIdentificadorAdquirente(ids.tid).valor
  const authorizationCode = normalizarIdentificadorAdquirente(ids.authorizationCode).valor
  const proofOfSale = normalizarIdentificadorAdquirente(ids.proofOfSale).valor
  if (tid) dados.cieloTid = tid
  if (authorizationCode) dados.cieloAuthorizationCode = authorizationCode
  if (proofOfSale) dados.cieloProofOfSale = proofOfSale
  return dados
}
