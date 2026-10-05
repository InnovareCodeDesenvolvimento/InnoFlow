/**
 * Texto das notificações (e-mail e WhatsApp). Puro. Só usa campos já sanitizados (`contexto.ts`); o nome do alerta é reduzido a [a-z0-9_]
 * (vira assunto de e-mail: sem quebra de linha/injeção de cabeçalho).
 */
import { ORIENTACAO_DOS_ALERTAS, ORIENTACAO_PADRAO, type SeveridadeNotificacao } from './severidade'
import type { ValorDeContexto } from './contexto'

export interface EventoDeAlerta {
  alerta: string
  severidade: SeveridadeNotificacao
  /** api | ocpp | worker (ou `processo`). */
  servico: string
  ambiente: string
  /** ISO 8601. */
  em: string
  mensagem: string
  contexto: Record<string, ValorDeContexto>
  /** Quantas ocorrências foram SUPRIMIDAS pelo dedupe desde o último aviso deste alerta (0 = nenhuma). */
  ocorrenciasSuprimidas: number
  /** Aviso sintético "tempestade de alertas" (não é um alerta do sistema). */
  tempestade?: { limitePorHora: number }
}

export function nomeSeguroDoAlerta(alerta: string): string {
  const limpo = alerta.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 80)
  return limpo === '' ? 'alerta_desconhecido' : limpo
}

export function assuntoDoAlerta(e: EventoDeAlerta): string {
  const nome = e.tempestade ? 'tempestade_de_alertas' : nomeSeguroDoAlerta(e.alerta)
  return `[InnoFlow][${e.severidade}] ${nome} (${e.ambiente})`
}

function linhasDoContexto(contexto: Record<string, ValorDeContexto>): string[] {
  return Object.entries(contexto).map(([k, v]) => `  ${k}: ${String(v)}`)
}

function textoDeOcorrencias(e: EventoDeAlerta): string | null {
  if (e.ocorrenciasSuprimidas <= 0) return null
  return `Ocorreu mais ${e.ocorrenciasSuprimidas} vez(es) desde o ultimo aviso (avisos repetidos foram agrupados).`
}

export function corpoDoEmail(e: EventoDeAlerta): string {
  if (e.tempestade) {
    return [
      `Tempestade de alertas no InnoFlow (${e.ambiente}).`,
      '',
      `Mais de ${e.tempestade.limitePorHora} avisos na ultima hora: para nao encher sua caixa, ESTE e o ultimo aviso desta hora (nivel ${e.severidade}). Os alertas continuam nos logs do EasyPanel (campo alert).`,
      'Abra os logs agora: algo esta falhando em volume (gateway fora do ar, ataque ou erro em laco).',
      '',
      `Servico que detectou: ${e.servico}`,
      `Hora: ${e.em}`,
    ].join('\n')
  }
  const ocorrencias = textoDeOcorrencias(e)
  const linhas = [
    `Alerta: ${nomeSeguroDoAlerta(e.alerta)}`,
    `Severidade: ${e.severidade}`,
    `Ambiente: ${e.ambiente}`,
    `Servico: ${e.servico}`,
    `Hora: ${e.em}`,
    '',
    `O que aconteceu: ${e.mensagem || '(sem mensagem)'}`,
    `O que fazer: ${ORIENTACAO_DOS_ALERTAS[e.alerta] ?? ORIENTACAO_PADRAO}`,
  ]
  if (ocorrencias) linhas.push('', ocorrencias)
  const ctx = linhasDoContexto(e.contexto)
  if (ctx.length > 0) linhas.push('', 'Contexto (so ids, codigos e contagens; nada sensivel):', ...ctx)
  linhas.push('', 'Tabela de alertas: docs/GO-LIVE-PAGAMENTOS.md secao 6.')
  return linhas.join('\n')
}

/** Texto curto para WhatsApp (uma mensagem, sem formatação que varie entre provedores além do negrito `*...*` que todos aceitam). */
export function textoDoWhatsapp(e: EventoDeAlerta): string {
  if (e.tempestade) {
    return `*[InnoFlow][${e.severidade}] Tempestade de alertas* (${e.ambiente})\nMais de ${e.tempestade.limitePorHora} avisos na ultima hora; silenciando o resto desta hora. Abra os logs do EasyPanel.`
  }
  const partes = [
    `*[InnoFlow][${e.severidade}] ${nomeSeguroDoAlerta(e.alerta)}* (${e.ambiente}/${e.servico})`,
    e.mensagem || '',
    `Fazer: ${ORIENTACAO_DOS_ALERTAS[e.alerta] ?? ORIENTACAO_PADRAO}`,
  ]
  const chavesDeId = ['paymentIntentId', 'paymentId', 'sessionId', 'chargePointId', 'returnCode', 'motivo']
  const ids = chavesDeId.filter((k) => e.contexto[k] !== undefined).map((k) => `${k}=${String(e.contexto[k])}`)
  if (ids.length > 0) partes.push(ids.join(' '))
  if (e.ocorrenciasSuprimidas > 0) partes.push(`(mais ${e.ocorrenciasSuprimidas} ocorrencia(s) desde o ultimo aviso)`)
  partes.push(e.em)
  return partes.filter((p) => p !== '').join('\n').slice(0, 1500)
}
