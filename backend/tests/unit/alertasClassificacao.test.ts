/**
 * N-7: TODO alerta emitido no código (campo `alert` do log) tem de ter severidade explícita em `core/alertas/severidade.ts`. Este teste varre `src/` e
 * FALHA quando alguém cria um alerta novo sem classificá-lo — sem isto, o alerta novo cairia no padrão (IMPORTANTE) sem ninguém decidir nada.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ALERTA_DE_TESTE,
  ORIENTACAO_DOS_ALERTAS,
  SEVERIDADE_DOS_ALERTAS,
  estaClassificado,
  severidadeDoEvento,
} from '../../src/core/alertas/severidade'

const RAIZ_SRC = join(__dirname, '..', '..', 'src')
/** `logger.child({ alert: ... })`: o campo estaria no binding, fora do objeto que o hook enxerga. */
const CHILD_COM_ALERT = /\.child\(\s*\{[^}]*\balert\b/

function arquivosTs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? arquivosTs(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []))
}

/** Prefixos de domínio que os alertas usam (convenção do projeto). Uma string com um destes prefixos entre aspas é tratada como nome de alerta. */
const NOME_DE_ALERTA = /(?<!\b(?:event|actionDetail):\s{0,3})['"`]((?:payment|session|ocpp|google|login|card|communication|partition|retention|backup|chargeback|secrets)_[a-z0-9_]+)['"`]/g

/** Strings com o prefixo de alerta que NÃO são alertas (ex.: nome de coluna/enum/rota). Só entra aqui com justificativa. */
const NAO_SAO_ALERTAS = new Set<string>([
  'session_revoked', // motivo de fechamento do SSE (SseCloseReason)
  'google_login_blocked', // actionDetail de auditoria
  'google_linked', // actionDetail de auditoria
  'payment_intent_purpose_consistency', // nome de CHECK constraint do Postgres (comentário)
  'payment_intent_return_code_required', // nome de CHECK constraint do Postgres (comentário)
  'payment_gateway_config', // chave do advisory lock
  'payment_method_user', // chave do advisory lock
  'partition_dropped', // valores de `acao` do relatório da retenção (services/manutencao/retencao.ts), não são alertas
  'partition_blocked',
  'partition_skipped',
  'secrets_key_missing', // `motivo` do retorno de services/backup/googleOAuth.ts (chave-mestra indisponível ao conectar o Google), não é alerta de log
])

function alertasNoCodigo(): Map<string, string[]> {
  const achados = new Map<string, string[]>()
  for (const arquivo of arquivosTs(RAIZ_SRC)) {
    const rel = relative(RAIZ_SRC, arquivo).split(sep).join('/')
    // A própria tabela (e o texto de orientação dela) lista nomes: não conta como "emissão".
    if (rel === 'core/alertas/severidade.ts') continue
    for (const m of readFileSync(arquivo, 'utf8').matchAll(NOME_DE_ALERTA)) {
      const lista = achados.get(m[1]) ?? []
      lista.push(rel)
      achados.set(m[1], lista)
    }
  }
  return achados
}

describe('classificação de severidade dos alertas (N-7)', () => {
  const achados = alertasNoCodigo()

  it('a varredura enxerga os alertas (não está cega)', () => {
    // Âncoras: se o regex quebrar, a varredura "passaria" sem ver nada.
    for (const nome of ['payment_void_manual_review', 'ocpp_message_flood', 'google_link_repeated_failures', 'session_cost_calculation_failed', 'payment_gateway_stepup_failed']) {
      expect(achados.has(nome), `a varredura não achou ${nome}`).toBe(true)
    }
    for (const nome of ['backup_failed', 'backup_verify_failed', 'backup_stale']) expect(achados.has(nome), `a varredura não achou ${nome}`).toBe(true)
    for (const nome of ['chargeback_response_deadline_near', 'chargeback_response_deadline_overdue']) expect(achados.has(nome), `a varredura não achou ${nome}`).toBe(true)
    expect(achados.size).toBeGreaterThan(40)
  })

  it('todo alerta emitido em src/ tem severidade EXPLÍCITA (alerta novo sem classificação falha aqui)', () => {
    const semClassificacao = [...achados.entries()]
      .filter(([nome]) => !NAO_SAO_ALERTAS.has(nome) && !estaClassificado(nome))
      .map(([nome, arquivos]) => `${nome} (em ${[...new Set(arquivos)].join(', ')})`)
    expect(semClassificacao, `Alertas sem classificação em core/alertas/severidade.ts — decida CRITICO/IMPORTANTE/INFO:\n${semClassificacao.join('\n')}`).toEqual([])
  })

  it('a tabela não guarda alerta que não existe mais no código (evita classificação fantasma)', () => {
    const orfaos = Object.keys(SEVERIDADE_DOS_ALERTAS).filter((nome) => !achados.has(nome))
    expect(orfaos).toEqual([])
  })

  it('os 9 alertas da N-7 + ocpp_message_flood + google_link_repeated_failures estão classificados', () => {
    const esperados: Record<string, string> = {
      payment_void_manual_review: 'CRITICO',
      payment_capture_retry_exhausted: 'CRITICO',
      payment_authorization_stuck: 'CRITICO',
      session_cost_calculation_failed: 'CRITICO',
      payment_pix_credit_divergence: 'CRITICO',
      payment_gateway_credential_rejected: 'CRITICO',
      ocpp_auth_ip_flood: 'IMPORTANTE',
      payment_card_testing_suspected: 'IMPORTANTE',
      ocpp_foreign_transaction: 'IMPORTANTE',
      ocpp_message_flood: 'IMPORTANTE',
      google_link_repeated_failures: 'IMPORTANTE',
    }
    for (const [nome, sev] of Object.entries(esperados)) {
      expect(estaClassificado(nome), nome).toBe(true)
      expect(severidadeDoEvento(nome, 40), nome).toBe(sev)
    }
  })

  it('alerta sem classificação vale IMPORTANTE (melhor um e-mail a mais que um silêncio); o alerta de teste é INFO', () => {
    expect(severidadeDoEvento('alerta_que_ninguem_classificou', 40)).toBe('IMPORTANTE')
    expect(severidadeDoEvento(ALERTA_DE_TESTE, 40)).toBe('INFO')
  })

  it('PELO_NIVEL_DO_LOG: erro => IMPORTANTE, o resto => INFO', () => {
    expect(severidadeDoEvento('session_late_stop_transaction', 50)).toBe('IMPORTANTE')
    expect(severidadeDoEvento('session_late_stop_transaction', 30)).toBe('INFO')
    expect(severidadeDoEvento('payment_capture_pending_stale', 40)).toBe('INFO')
    expect(severidadeDoEvento('payment_capture_pending_stale', 50)).toBe('IMPORTANTE')
  })

  it('o logger é UM só (hook cobre todo call site): nenhum outro módulo cria instância do pino nem usa .child({ alert })', () => {
    const criam: string[] = []
    const filhoComAlert: string[] = []
    for (const arquivo of arquivosTs(RAIZ_SRC)) {
      const rel = relative(RAIZ_SRC, arquivo).split(sep).join('/')
      const texto = readFileSync(arquivo, 'utf8')
      if (/import\s+pino\s+from\s+['"]pino['"]/.test(texto) || /require\(['"]pino['"]\)/.test(texto)) criam.push(rel)
      if (CHILD_COM_ALERT.test(texto)) filhoComAlert.push(rel)
    }
    expect(criam).toEqual(['lib/logger.ts'])
    expect(filhoComAlert).toEqual([])
  })

  it('todo alerta CRITICO tem orientação do que fazer', () => {
    const criticos = Object.entries(SEVERIDADE_DOS_ALERTAS).filter(([, s]) => s === 'CRITICO').map(([n]) => n)
    expect(criticos.length).toBeGreaterThan(8)
    expect(criticos.filter((n) => !ORIENTACAO_DOS_ALERTAS[n])).toEqual([])
  })
})
