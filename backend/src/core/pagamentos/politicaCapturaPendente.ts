/**
 * Política PURA da "rede de segurança da captura" (F5.7, ALTO-1 do portão do Órion): um intent de cartão que ficou em
 * `CAPTURE_PENDING` (Stop aconteceu, energia entregue) sem que a captura tenha concluído. Sem Prisma/Redis/relógio aqui —
 * quem chama passa as idades e os contadores, e testa fácil.
 */

/** Idade (minutos) a partir da qual um `CAPTURE_PENDING` esquecido deixa de ser "um soluço" e vira alerta de erro. */
export const CAPTURA_PENDENTE_ALERTA_ALTO_MINUTOS = 60
/** Idade a partir da qual a pré-autorização está perto de expirar no cartão (e o dinheiro, de se perder): intervenção humana. */
export const CAPTURA_PENDENTE_ALERTA_CRITICO_MINUTOS = 24 * 60

export type SeveridadeCapturaPendente = 'normal' | 'alta' | 'critica'

/** Escalona o alerta pela idade: <1 h normal (aviso), >=1 h alta (erro), >=24 h crítica (erro, acionar o plantão). */
export function severidadeCapturaPendente(idadeMinutos: number): SeveridadeCapturaPendente {
  if (idadeMinutos >= CAPTURA_PENDENTE_ALERTA_CRITICO_MINUTOS) return 'critica'
  if (idadeMinutos >= CAPTURA_PENDENTE_ALERTA_ALTO_MINUTOS) return 'alta'
  return 'normal'
}

export type DecisaoReenfileirarCaptura = 'REENFILEIRAR' | 'TETO_ATINGIDO'

/**
 * Teto de reenfileiramentos por intent. Sem ele um intent que NUNCA captura (ex.: cartão cancelado do lado do emissor e a
 * Cielo respondendo "pendente" para sempre) seria reenfileirado a cada janela eternamente. Ao atingir o teto o varredor
 * PARA de tentar e só continua alertando (um humano decide) — não esconde o problema, só para de martelar a Cielo.
 */
export function decidirReenfileirarCaptura(tentativasDoVarredor: number, maxTentativas: number): DecisaoReenfileirarCaptura {
  return tentativasDoVarredor >= maxTentativas ? 'TETO_ATINGIDO' : 'REENFILEIRAR'
}
