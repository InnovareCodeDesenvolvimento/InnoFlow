# Auditoria de segurança e dinheiro — F5.9 (sessão travada / watchdog)

Data: 2026-10-03 · Auditor: Órion · HEAD auditado: `566db9e` (12 commits: ddb270d, cda06a8, 2a03e0a, 3abb692, 7019915, ba513a5, d4698a0, b2dd68c, 177ce76, f9eed48, 11bc626, 566db9e).
Texto transcrito pelo Atlas do relatório do Órion (ele é somente leitura e não grava arquivos). Os achados ALTO-1 e ALTO-2 foram
conferidos pelo Atlas no código (o `catch` que troca o custo por zero em `finalizarSessao.ts` e a busca por `ocppTransactionId` global em
`stopTransaction.ts`/`meterValues.ts`).

## O que foi lido e o que foi provado
- **Provado por execução:** `vitest` em `avaliarSessaoAberta`, `leituraFinalEAlertasSessao`, `pedirParadaSessaoClassificacao`, `envSessaoWatchdog`
  (4 arquivos, 223 testes) e probes com as funções puras reais (marcados [PROVADO]).
- **Só lido:** o restante (corridas, concorrência, idempotência, SQL). As suítes de integração não foram reexecutadas pelo Órion.
- **Só carregador real prova:** ordem Boot × Stop enfileirado, reuso de `messageId`, `MeterValueSampleInterval`, Reject-e-continua-entregando.

## Veredito
- **Sandbox (simulador, Cielo sandbox, sem dinheiro real): PODE ir** (0 crítico; nenhuma cobrança dupla nem vazamento ao motorista). Corrigir o ALTO-1 antes.
- **Carregador real / produção: NÃO pode ir.** Bloqueiam: ALTO-1, ALTO-2, ALTO-3 (a verificar com o firmware) e M4 (kill-switch).
- Contagem: 0 crítico, 3 altos, 8 médios, 7 baixos.

## ALTO
**ALTO-1 — cálculo de custo que lança exceção fecha a sessão de graça, em silêncio [PROVADO].** `services/carteira/finalizarSessao.ts:101-114` (o
`catch` troca o custo por `ZERO_CUSTOS`, só `logger.error`, sem `alert`); `core/tarifacao/calcularCustoSessao.ts:261-266` (lança se `stoppedAt < startedAt`
ou `chargingEndedAt` fora de [startedAt, stoppedAt]); `core/sessao/leituraFinal.ts:47` (no `LAST_METER_SAMPLE` o timestamp é o `ts` da amostra).
Cenário: o carro termina de carregar (`chargingEndedAt = T2`), a última amostra `T1 < T2`, o carregador some, o watchdog encerra com `timestamp = T1` →
`calcularCustoSessao` lança → `totalCostCents = 0`, STOPPED sem débito; no cartão a pré-autorização é cancelada (VOID). Segundo gatilho: Stop com RTC
resetado (`stoppedAt < startedAt`), inclusive no Stop normal. `provisionalCostCents` e `unbilledCostCents` ficam errados. Perda total de receita, silenciosa.
Correção: `timestamp = max(ts da amostra, chargingEndedAt, startedAt)` em `escolherLeituraFinal`/`resolverLeituraFinal`; clamp de `chargingEndedAt` e
`stoppedAt` em `calcularFechamentoSessao`; se ainda lançar, NÃO fechar com zero: abortar (`ABORTADA`), alerta de erro `session_cost_calculation_failed` e deixar
em STOP_UNCONFIRMED para revisão manual. Regressão: `chargingEndedAt > última amostra` e Stop com timestamp < `startedAt`.

**ALTO-2 — StopTransaction e MeterValues localizam a sessão só por `ocppTransactionId` global, sem checar o carregador [LIDO; pré-existente].**
`ocpp/handlers/stopTransaction.ts:34-37`, `meterValues.ts:32-34`, `schema.prisma:613` (`ocppTransactionId Int @unique @default(autoincrement())`),
`services/sessao/resolverLeituraFinal.ts:53-60` (`buscarUltimaAmostra` filtra só por `sessionId`). Um carregador autenticado de outro operador (ou credencial
comprometida) pode fechar sessão alheia com `meterStop` arbitrário (recarga grátis ou cobrança/Debt para a vítima) e forjar MeterValues (manter viva/reanimar a
sessão; viram a "última amostra" do watchdog). O id é sequencial. Mitigação existente: `buscarStopTransactionNoLog` já filtra por `chargePointId`.
Correção: buscar por `{ ocppTransactionId, chargePointId: ctx.chargePointId }`; sem match = transação desconhecida + alerta `ocpp_foreign_transaction`;
`buscarUltimaAmostra` filtrar também por `chargePointId`. Teste: carregador B com o `transactionId` do A.

**ALTO-3 — a idempotência pode descartar um StopTransaction real [LIDO; condicional ao firmware].** `ocpp/idempotency.ts:93-105`: o replay procura
`OcppMessage` OUTBOUND com o mesmo `(chargePointId, ocppMessageId)` sem filtrar `action`, janela nem payload. Firmware com `messageId` por contador que zera no
reboot (o incidente do D-A) pode ter o Stop enfileirado confundido com uma resposta antiga: `run()` nunca executa e o carregador acha que foi confirmado.
Vale também para StartTransaction e StatusNotification, sem a rede de segurança do log. Salvaguarda da F5.9: o INBOUND é gravado antes do replay, então o
watchdog acha o Stop no log e fecha com a leitura certa, mas com `closureSource=SERVER` e atraso (R2 ~5 min + G1 10 min se o conector voltar a AVAILABLE; com
o cabo plugado, até a duração máxima de 24 h, cartão retido). Uma exceção anterior ao `try` fica cacheada como CALL_ERROR para sempre.
Correção: filtrar o replay por `action` e janela (ex.: 24 h); reexecutar se o payload INBOUND for diferente; não cachear CALL_ERROR transitório; verificar com firmware real.

## MÉDIO
- **M1 — re-abertura de sessão por corrida com StatusNotification [LIDO].** `ocpp/handlers/statusNotification.ts:75-107`: `findFirst` (abertos) seguido de `update({status})`
  sem condição, fora do lock. Entre os dois o watchdog/Stop commita STOPPED; o update ressuscita a sessão, o watchdog fecha de novo e `finalizarSessao` (só checa
  `status === 'STOPPED'`, `finalizarSessao.ts:158`) recalcula e sobrescreve `totalCostCents` com débito/captura já gravados → a identidade de conciliação quebra.
  Probabilidade baixa. Correção: `updateMany where status in abertos` ou `travarSessao`; `finalizarSessao` recusa quando `stoppedAt != null`.
- **M2 — reconexão após queda longa encerra no 1º ciclo, antes do Stop enfileirado [PROVADO na função pura].** `core/sessao/avaliarSessaoAberta.ts:369-373` (G1 conta desde
  `unconfirmedAt`), `services/sessao/marcarSessaoNaoConfirmada.ts:41` (Boot sobre sessão já STOP_UNCONFIRMED não renova `unconfirmedAt`). Com `unconfirmedAt` há 30 min e
  carregador visto há 6 s a decisão é ENCERRAR_PELO_SERVIDOR. É o D-A de volta para quedas de 25 min a 2 h; o risco "residual" do desenho está subestimado.
  Correção: a janela online conta desde a RECONEXÃO (`max(unconfirmedAt, reconexão) + G1`, ou piso de 2–3 min após o handshake); precisa de `ChargePoint.connectedAt` (Cronos).
- **M3 — saldo comprometido (D7) contornável [LIDO].** `ocpp/authorizationCheck.ts:60-72`, `services/carteira/saldoComprometido.ts:27-36`, `services/sessao/guardaDeSaldo.ts:89-90`,
  `api/routes/me.routes.ts:97-110`, `ocpp/handlers/startTransaction.ts:57-95`. (1) Check-then-act sem lock de carteira: duas inicializações simultâneas (RFID em dois carregadores,
  RemoteStart + RFID) passam no mesmo saldo; o lock `me:start` é liberado após o 202, antes de a sessão existir. (2) O "comprometido" só soma STOP_UNCONFIRMED; sessões WALLET abertas não
  comprometem nada. (3) `provisionalCostCents` congela na marcação. Perda limitada: débito = `min(saldo, custo)`, resto vira Debt que bloqueia o próximo início (inadimplência, não duplicidade).
  Correção: `SELECT … FOR UPDATE` na Wallet no StartTransaction e reconferir na transação; comprometer o teto de reserva das sessões WALLET abertas; recalcular o provisório com amostras.
- **M4 — sem kill-switch do watchdog e rollout sem ordem [LIDO].** `lib/env.ts:257-287`, `entrypoints/worker.ts:33-34`, migration `20261003120000`. Sem `SESSION_WATCHDOG_ENABLED`; no deploy
  rolante um worker novo gera STOP_UNCONFIRMED enquanto API/gateway antigos não conhecem o enum (erro antes do `try` vira CALL_ERROR cacheado, ver ALTO-3). Correção: `SESSION_WATCHDOG_ENABLED`
  (default false no 1º deploy); ordem migration → API e gateway → worker por último; documentar rollback.
- **M5 — sessão viva fechada: Boot/transiente com amostragem > G1, e energia grátis com Rejected + silêncio [LIDO].** `bootNotification.ts:32`, `avaliarSessaoAberta.ts:372`, `leituraFinal.ts:49-58`.
  A) firmware que manda Boot a cada reconexão sem interromper a transação, com `MeterValueSampleInterval` > G1 (10 min) ou 0 → fechada pela última amostra enquanto o carro segue carregando.
  B) RemoteStop recusado + sem MeterValues → NO_READING; com `NO_CHARGE`, custo 0 com energia saindo. É a política D2/D4 funcionando como desenhada, mas o risco precisa ficar explícito.
  Correção: ao marcar STOP_UNCONFIRMED com o carregador online, disparar `TriggerMessage(MeterValues)` (hoje só o R4, só em sessão aberta); validar G1 contra o intervalo de amostragem;
  alerta de ERRO obrigatório e roteado para `session_closed_without_meter_reading` e `session_metering_after_close`.
- **M6 — `stopAttempts` inflável por toques do motorista [LIDO].** `services/sessao/pedirParadaSessao.ts:78-82`, `avaliarSessaoAberta.ts:363-364`. 3 toques espaçados de 10 s levam a `stopAttempts=3`:
  o R3 passa a só marcar, e a reanimação fica bloqueada para sempre; com Redis fora o cooldown some. Correção: só GUARD/WATCHDOG contam para o teto; limitar toques humanos.
- **M7 — U1 com relógio do servidor: MeterValues em buffer reanimam por engano; vai-e-vem do R2 sem teto [LIDO + P2 PROVADO].** `meterValues.ts:108-114`, `avaliarSessaoAberta.ts:308-313,362-367`.
  Depois de queda, MeterValues antigos reanimam a sessão (alerta de erro falso); com o conector AVAILABLE há > 5 min o R2 marca de novo no ciclo seguinte, ~a cada 60 s, sem teto, com alertas e SSE
  sem limite. Sem efeito no dinheiro. Correção: reanimar só se a energia da nova amostra passar da energia na marcação (`energyAtUnconfirmedWh`); `alertarSessaoLimitado` e teto de reanimações.
- **M8 — negação de serviço do watchdog com falha de infraestrutura [LIDO].** `services/sessao/vigiarSessoes.ts:40,278-283` (R6 aplica a guarda a toda sessão aberta sem atividade ≥ 60 s,
  prazo 15 s por sessão, em sequência), `finalizarSessao.ts:241` (VOID da Cielo com `await` sem prazo dentro do loop e do handler de Stop). Com Redis fora, 100 sessões = ciclo de 25 min; job com
  concurrency 1 atrasa R1–U2. Correção: circuit breaker de Redis no ciclo (pular R6); `withDeadline` e fire-and-forget no VOID pós-commit (o varredor caso A já cobre o retry).

## BAIXO
1. Alertas sem limite: `session_revived_after_unconfirmed`, `session_stop_unconfirmed`, `session_closed_by_server` não passam por `alertarSessaoLimitado` (`vigiarSessoes.ts:285-287`, `marcarSessaoNaoConfirmada.ts:71-78`).
2. Relógios misturados na guarda: `guardaDeSaldo.ts:98` usa `stoppedAt: new Date()` (servidor) contra `startedAt` (carregador).
3. MeterValues sem `transactionId` (`meterValues.ts:77`) grava `sessionId` nulo: não vira prova, pode cair em NO_READING. Logar e alertar.
4. CHECKs unidirecionais: faltam coerência de `unconfirmedAt` fora do estado e `closureSource`/`meterStopSource` em STOPPED (antigas ficam NULL de propósito). O índice `ix_charging_session_watchdog` não serve à paginação por `id` (tabela viva pequena).
5. `ux_charging_session_active_per_connector` não cobre FAULTED nem STOP_UNCONFIRMED; a reanimação trata o P2002 e o D7 depende disso.
6. Comentário contraditório em `finalizarSessao.ts:242` (o varredor caso A cobre sessão STOPPED).
7. PII em logs, pré-existente: `idTag` e `userId` em `[sessao] remote-start disparado` e `StartTransaction recusado`. Os alertas novos estão limpos.

## VALIDADO (lido, salvo onde indicado)
- **Corrida watchdog × StopTransaction × stop do motorista:** todas as mudanças de estado passam por `travarSessao` (`FOR UPDATE`) com compare-and-swap da foto; a prova do log bruto é resolvida SOB o lock; quem perde recebe `JA_ENCERRADA` e o Stop vira
  `registrarStopTardio`; débito idempotente sob o lock da Wallet com índices únicos de `CHARGE_DEBIT` e Debt aberta; CARD só cria CAPTURE_PENDING com o intent AUTHORIZED; o retry `liquidarSessao` não debita CARD.
- **Stop tardio:** só escreve `lateStop*` e `unbilledCostCents`; nunca `totalCostCents`, `meterStopWh`, carteira ou cartão; idempotente; só para `closureSource=SERVER`.
- **Conciliação:** `revenue` soma só STOPPED; STOP_UNCONFIRMED não entra; `NO_CHARGE` contribui 0 dos dois lados; captura parcial + Debt `CARD_CAPTURE_SHORTFALL` fecha. Só quebra com M1.
- **D2:** `NO_CHARGE` zera taxa fixa e mínimo e nunca estima energia; env inválida derruba o boot; `MIN_FEE` é o comportamento antigo.
- **Vazamento/autorização:** campos explícitos nas respostas do motorista; `lateStop` só ADMIN (OPERATOR recebe null), `driver.email` só ADMIN; `POST /api/admin/sessions/:id/stop` usa `operatorScopeWhere`; SSE `session.updated` só com ids técnicos para operador dono, motorista e admin.
- **SQL cru:** `sessionStatusSql.ts` com constantes e cast de enum, sem injeção; sem lock consultivo na F5.9; exclusão entre réplicas do watchdog por locks de linha.
- **Alertas:** sem dado pessoal; cooldown do TriggerMessage fecha em falha; teto de comandos em voo = 20.
- **Migrations:** aditivas; enum em arquivo separado; backfill não causa encerramento em massa; rollback documentado.

## Pendências
- Só o carregador real responde: ordem Boot × Stop enfileirado; `messageId` reaproveitado; Boot a cada reconnect; `MeterValueSampleInterval` real; RemoteStop recusado seguido de energia; TriggerMessage; RTC após queda. Afetam ALTO-3, M2 e M5.
- Decisões do dono não confirmadas: D2 (`NO_CHARGE`), D7, D3. O Órion pede confirmação EXPLÍCITA da perda aceita nos casos M2 e M5, hoje silenciosa.
- Não avaliado: hooks/UI do frontend; prazo real do hold do cartão na Cielo; carga do watchdog em volume.
