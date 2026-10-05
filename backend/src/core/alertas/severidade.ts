/**
 * Severidade e orientação dos alertas que chegam ao DONO (N-7: e-mail e WhatsApp). Pura — sem env, sem logger, sem Redis.
 *
 * NÃO é a mesma coisa que `core/sessao/severidadeAlertas.ts`: aquela decide o NÍVEL DE LOG (info/warn/error) dos alertas de sessão travada;
 * esta decide QUEM É ACORDADO (CRITICO = WhatsApp + e-mail agora; IMPORTANTE = e-mail; INFO = só log). As duas respondem perguntas diferentes e um
 * alerta de nível `error` pode ser só IMPORTANTE (ex.: o IP já foi bloqueado), então não foram fundidas.
 *
 * Critério:
 *  - CRITICO: dinheiro de cliente pode estar preso/cobrado errado, ou o pagamento inteiro está fora do ar, e nada se resolve sozinho. Exige ação em horas.
 *  - IMPORTANTE: precisa de um humano olhar no mesmo dia (ataque já contido, dado inconsistente, configuração incoerente), mas nada está queimando.
 *  - INFO: ruído útil só no log (o sistema já tratou sozinho; reconsulta/backoff automático).
 *
 * TODO alerta emitido em `src/` (campo `alert` do log) tem de estar em `SEVERIDADE_DOS_ALERTAS`: o teste `alertasClassificacao.test.ts` varre o código e
 * FALHA se surgir um novo sem classificação. Alerta ausente da tabela vale IMPORTANTE (melhor um e-mail a mais que um silêncio).
 */
import type { TipoAlertaSessao } from '../sessao/avaliarSessaoAberta'

export type SeveridadeNotificacao = 'INFO' | 'IMPORTANTE' | 'CRITICO'

export const ORDEM_SEVERIDADE: Record<SeveridadeNotificacao, number> = { INFO: 0, IMPORTANTE: 1, CRITICO: 2 }

/** `PELO_NIVEL_DO_LOG`: o mesmo alerta sai em níveis diferentes conforme a gravidade (erro => IMPORTANTE, o resto => INFO). */
export type ClassificacaoAlerta = SeveridadeNotificacao | 'PELO_NIVEL_DO_LOG'

export const SEVERIDADE_PADRAO_NAO_CLASSIFICADO: SeveridadeNotificacao = 'IMPORTANTE'

/** Alertas de sessão (o tipo `TipoAlertaSessao` garante, em compilação, que nenhum fica de fora). */
const ALERTAS_DE_SESSAO: Record<TipoAlertaSessao, ClassificacaoAlerta> = {
  session_stop_unconfirmed: 'INFO', // o watchdog acompanha e encerra sozinho
  session_closed_by_server: 'INFO',
  session_max_duration_reached: 'INFO',
  session_no_meter_values: 'INFO',
  ocpp_meter_values_without_transaction: 'INFO',
  session_closed_without_meter_reading: 'IMPORTANTE', // sessão fechada sem leitura: cobrança a conferir
  session_revived_after_unconfirmed: 'IMPORTANTE',
  session_metering_after_close: 'IMPORTANTE',
  card_session_hold_deadline: 'IMPORTANTE',
  session_late_stop_transaction: 'PELO_NIVEL_DO_LOG', // erro = há diferença não cobrada; info = nada a fazer
  session_stop_not_obeyed: 'CRITICO', // o carregador segue entregando energia depois do stop
  session_cost_calculation_failed: 'CRITICO', // sessão presa sem cobrança: revisão manual
  ocpp_foreign_transaction: 'IMPORTANTE', // transactionId de OUTRO carregador (firmware com defeito ou tentativa de fraude)
}

export const SEVERIDADE_DOS_ALERTAS: Readonly<Record<string, ClassificacaoAlerta>> = {
  ...ALERTAS_DE_SESSAO,

  // --- pagamento: dinheiro de cliente / pagamento fora do ar -------------------------------------------------------------------------
  payment_void_manual_review: 'CRITICO', // pré-autorização que não consigo cancelar: dinheiro do cliente preso no cartão
  payment_void_skipped_already_captured: 'CRITICO', // a Cielo diz que já foi capturada: possível cobrança dupla
  payment_capture_retry_exhausted: 'CRITICO', // captura que o varredor desistiu de repetir: sessão consumida e não cobrada
  payment_authorization_stuck: 'CRITICO', // autorização presa num estado que a Cielo não define
  payment_pix_credit_divergence: 'CRITICO', // pagamento Pix com valor/pedido divergente: NÃO creditado
  payment_gateway_credential_rejected: 'CRITICO', // credencial recusada: TODO pagamento falha
  payment_gateway_ip_not_allowed: 'CRITICO', // IP do servidor fora da lista da Cielo: TODO pagamento falha
  payment_gateway_account_restriction: 'CRITICO', // restrição cadastral da conta Cielo
  payment_gateway_environment_url_mismatch: 'CRITICO', // adaptador NÃO construído (fail-closed): pagamento fora do ar
  payment_gateway_config_decrypt_failed: 'CRITICO', // chave de cifragem trocada/ausente: pagamento fora do ar
  payment_gateway_secrets_undecryptable: 'CRITICO',
  payment_gateway_config_load_failed: 'CRITICO',
  payment_gateway_not_configured: 'CRITICO', // produção sem credencial
  payment_fake_adapter_in_production: 'CRITICO', // aprova QUALQUER cartão e não cobra nada
  payment_void_refused: 'IMPORTANTE', // a Cielo recusou o cancelamento; o `manual_review` correspondente é o CRITICO
  payment_void_unconfirmed: 'IMPORTANTE',
  payment_void_in_progress: 'INFO',
  payment_authorization_request_refused: 'IMPORTANTE',
  payment_authorization_not_definitive: 'INFO', // o varredor reconsulta
  payment_authorized_amount_mismatch: 'IMPORTANTE',
  payment_authorized_status_unlisted_returncode: 'IMPORTANTE',
  payment_captured_status_unlisted_returncode: 'IMPORTANTE',
  payment_cielo_status_unrecognized: 'IMPORTANTE',
  payment_reconciliation_multiple_payments: 'IMPORTANTE',
  payment_pix_returncode_unexpected: 'INFO',
  payment_cielo_identifier_truncated: 'INFO',
  payment_pix_creation_invalid_response: 'IMPORTANTE',
  payment_intent_environment_mismatch: 'IMPORTANTE',
  payment_capture_pending_stale: 'PELO_NIVEL_DO_LOG', // warn nos primeiros minutos, error depois de muito tempo pendente
  payment_capture_sweep_scan_truncated: 'IMPORTANTE',
  payment_config_changed: 'IMPORTANTE', // alguém alterou a config do gateway (se não foi você, é sinal de invasão)
  payment_secrets_key_previous_invalid: 'IMPORTANTE',
  payment_webhook_secret_weak: 'INFO',
  payment_webhook_secret_decrypt_failed: 'IMPORTANTE',
  payment_card_testing_suspected: 'IMPORTANTE', // carding: o bloqueio automático já agiu
  payment_gateway_stepup_failed: 'IMPORTANTE', // senha de admin errada na confirmação da config do gateway
  payment_gateway_stepup_locked: 'IMPORTANTE',
  payment_gateway_stepup_unavailable: 'IMPORTANTE',
  payment_gateway_stepup_late_reservation_released: 'INFO',

  // --- segurança / OCPP / contas -----------------------------------------------------------------------------------------------------
  ocpp_auth_ip_flood: 'IMPORTANTE', // IP já bloqueado pelo próprio limite
  ocpp_auth_lockout: 'IMPORTANTE',
  ocpp_message_flood: 'IMPORTANTE',
  ocpp_start_transaction_no_active_tariff: 'IMPORTANTE', // motorista não consegue carregar
  ocpp_trust_proxy_hops_zero_in_production: 'IMPORTANTE',
  google_link_repeated_failures: 'IMPORTANTE',
  login_account_locked: 'INFO',

  // --- operação ----------------------------------------------------------------------------------------------------------------------
  session_watchdog_redis_unstable: 'IMPORTANTE',
  session_watchdog_scan_truncated: 'IMPORTANTE',
  communication_config_changed: 'IMPORTANTE', // alguém alterou para onde os avisos vão (se não foi você: sinal de invasão)

  // --- partições e retenção (N-11, Cronos) — services/manutencao/ ---------------------------------------------------------------------
  partition_horizon_low: 'IMPORTANTE', // < 2 meses de partições à frente: a criação automática não está funcionando
  partition_default_has_rows: 'IMPORTANTE', // linhas na partição DEFAULT: mês sem partição (ou relógio de carregador fora do intervalo)
  partition_maintenance_failed: 'IMPORTANTE',
  partition_maintenance_boot_failed: 'IMPORTANTE',
  partition_maintenance_lock_timeout: 'INFO', // outra transação segurava a tabela; a próxima rodada repete (o horizonte_low pega se persistir)
  retention_failed: 'IMPORTANTE',
  retention_lock_timeout: 'INFO',
  retention_partition_blocked: 'INFO', // partição velha NÃO apagada porque uma sessão/dívida/pagamento ainda depende dela (esperado, resolve-se sozinho)
  retention_webhook_unprocessed_kept: 'INFO',
}

/** Alerta de TESTE do `npm run alerts:test` (nunca emitido pelo sistema). */
export const ALERTA_DE_TESTE = 'alerts_test'

export function estaClassificado(alerta: string): boolean {
  return Object.prototype.hasOwnProperty.call(SEVERIDADE_DOS_ALERTAS, alerta)
}

/** Nível numérico do pino a partir do qual `PELO_NIVEL_DO_LOG` vira IMPORTANTE (50 = error). */
const NIVEL_PINO_ERROR = 50

export function severidadeDoEvento(alerta: string, nivelPino: number): SeveridadeNotificacao {
  if (alerta === ALERTA_DE_TESTE) return 'INFO'
  const c = estaClassificado(alerta) ? SEVERIDADE_DOS_ALERTAS[alerta] : SEVERIDADE_PADRAO_NAO_CLASSIFICADO
  if (c === 'PELO_NIVEL_DO_LOG') return nivelPino >= NIVEL_PINO_ERROR ? 'IMPORTANTE' : 'INFO'
  return c
}

export function severidadeAtinge(severidade: SeveridadeNotificacao, minima: SeveridadeNotificacao): boolean {
  return ORDEM_SEVERIDADE[severidade] >= ORDEM_SEVERIDADE[minima]
}

/** O que o dono deve fazer, em uma linha (só para os CRITICOS e alguns IMPORTANTES). Detalhe em `docs/GO-LIVE-PAGAMENTOS.md` §6. */
export const ORIENTACAO_DOS_ALERTAS: Readonly<Record<string, string>> = {
  payment_void_manual_review: 'Conferir a venda no Site Cielo e cancelar/estornar a pre-autorizacao a mao.',
  payment_void_skipped_already_captured: 'A Cielo diz que a venda ja foi capturada: conferir no Site Cielo se ha cobranca duplicada e estornar o excedente.',
  payment_capture_retry_exhausted: 'A captura nao fechou depois de muitas tentativas: conferir a venda no Site Cielo e capturar/cancelar a mao.',
  payment_authorization_stuck: 'Autorizacao presa: conferir a venda no Site Cielo; se estiver autorizada e sem sessao, cancelar.',
  session_cost_calculation_failed: 'Sessao encerrada sem calcular o custo: revisar a sessao (tarifa/leituras) e cobrar ou isentar a mao.',
  session_stop_not_obeyed: 'O carregador nao obedeceu o stop e segue entregando energia: desligar o carregador/disjuntor e investigar.',
  payment_pix_credit_divergence: 'Pix pago com valor/pedido divergente e NAO creditado: conferir na Cielo e creditar a mao se for legitimo.',
  payment_gateway_credential_rejected: 'A Cielo recusou a credencial: conferir MerchantId/MerchantKey na tela do gateway. Todo pagamento falha ate corrigir.',
  payment_gateway_ip_not_allowed: 'A Cielo bloqueou o IP do servidor: pedir a liberacao do IP de saida da VPS no suporte da Cielo.',
  payment_gateway_account_restriction: 'Restricao cadastral na conta Cielo: falar com o suporte da Cielo.',
  payment_gateway_environment_url_mismatch: 'URLs da Cielo incoerentes com o ambiente: conferir a tela do gateway. Pagamento fora do ar ate corrigir.',
  payment_gateway_config_decrypt_failed: 'Nao foi possivel decifrar as credenciais: PAYMENT_SECRETS_KEY trocada/ausente. Pagamento fora do ar ate corrigir.',
  payment_gateway_secrets_undecryptable: 'Segredos do gateway ilegiveis: conferir PAYMENT_SECRETS_KEY (e a chave anterior).',
  payment_gateway_config_load_failed: 'Falha ao ler a config do gateway no banco: conferir o banco. Pagamento fora do ar ate voltar.',
  payment_gateway_not_configured: 'Producao sem credencial Cielo: configurar na tela do gateway. Pix e cartao indisponiveis.',
  payment_fake_adapter_in_production: 'Adaptador FAKE ativo em producao (aprova qualquer cartao, nao cobra nada): remover PAYMENT_ALLOW_FAKE_ADAPTER.',
  payment_config_changed: 'Alguem alterou a config do gateway. Se NAO foi voce, trocar a senha do admin e a chave de cifragem.',
  payment_card_testing_suspected: 'Padrao de teste de cartoes (carding): o bloqueio automatico ja agiu; conferir os IPs/usuarios e considerar bloquear no firewall.',
  ocpp_auth_ip_flood: 'IP bloqueado por excesso de falhas de autenticacao OCPP: se for um carregador seu, confira a senha dele; senao, ignore ou bloqueie no firewall.',
  ocpp_foreign_transaction: 'Carregador usou o transactionId de outro: firmware com defeito ou tentativa de fraude; conferir o carregador.',
}

export const ORIENTACAO_PADRAO = 'Ver docs/GO-LIVE-PAGAMENTOS.md secao 6 (Alertas de Log) e os logs do EasyPanel (procure o campo alert).'
