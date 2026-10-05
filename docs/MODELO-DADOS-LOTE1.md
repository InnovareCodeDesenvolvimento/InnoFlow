# Modelo de dados do lote 1 da F6 (Cronos, 05/10/2026)

Libera no backend: **L1.3** (redefinição de senha), **L1.4** (LGPD), **L1.6** (notificações), **L1.8** (estorno/chargeback), **L1.9** (termos).
Fonte: `docs/PLANO-FUNCIONALIDADES.md` (§2, §3.2), decisões DL1–DL8 (PROGRESSO.md) e o contrato literal `frontend/src/types/api.ts` (commit 5ef6386).
Código: `backend/prisma/schema.prisma` + duas migrations:

| Migration | Conteúdo |
|---|---|
| `20261005150000_lote1_audit_action_values` | **só** `ALTER TYPE "AuditAction" ADD VALUE` (4 valores) — isolada por causa da regra transacional do Postgres |
| `20261005150100_lote1_lgpd_notificacoes_estorno_termos` | 9 enums novos, 3 colunas, 5 tabelas, 3 CHECKs em tabelas existentes, triggers, índices parciais |

Convenção do projeto mantida: o que o Prisma não expressa (CHECK, índice parcial, trigger) vive só no `migration.sql`; o `schema.prisma` ganhou os models/colunas e comentários que apontam para lá.
Teste em Postgres real: `backend/tests/integration/lote1ModeloDados.test.ts` (51 testes, banco próprio, `migrate deploy` do zero).

## 1. Decisões de modelagem (e onde ajustei o plano)

1. **Anonimização, nunca DELETE.** `User.deletedAt` + `AccountDeletionRequest`. **Um único timestamp** (`deletedAt`), não `deletedAt` + `anonymizedAt`: um CHECK garante que `deletedAt` preenchido *implica* anonimizado, então um segundo campo só poderia divergir do primeiro.
2. **O banco garante o estado anonimizado** (CHECK `user_deleted_is_anonymized`): `role=DRIVER`, `active=false`, `name='Conta excluída'`, `email='excluido+<id>@anon.invalid'`, `passwordHash/googleSub/cpf/phone = NULL`, `sessionsValidAfter` preenchido. Trigger impede "ressuscitar" (zerar `deletedAt`).
3. **Tombstone único sem mexer nos índices existentes.** `email` é o único campo único "cheio"; o tombstone leva o `id` (único por construção). `googleSub` e `cpf` viram `NULL` (índices únicos não olham NULL). Resultado provado: o mesmo e-mail/Google/CPF pode abrir **conta nova** logo depois da exclusão (critério de aceite do plano).
4. **Notificações: tabela 1:1 de colunas, não linhas por (usuário, tipo, canal).** O contrato é plano (`sessionReceiptEmail`, `lowBalanceEnabled`, `lowBalanceThresholdCents`) e a DL5 pede que o opt-out de segurança/cobrança **não seja persistível** — com colunas isso é estrutural (não existe coluna para desligar). Web push (F7) entra com colunas novas (expand), sem migrar dados.
5. **Estorno e chargeback num razão só (`PaymentReversal`)** com **um enum de estado** (`PaymentReversalStatus`) amarrado ao tipo por CHECK, em vez de `status` + `outcome` (dois campos permitiriam combinações inválidas). Mapeia 1:1 para o contrato.
6. **Bloqueio do modo cartão por chargeback é DERIVADO, sem flag** (`CHARGEBACK_BLOCKED`): bloqueado ⇔ existe chargeback do motorista em `OPEN`/`LOST`/`ACCEPTED`. Uma fonte de verdade só (nada para divergir), índice parcial dedicado. Consequência: não há "desbloqueio manual" depois de `LOST` — ver pendência P3.
7. **`PaymentIntent.amountRefundedCents` mantido por trigger** (Σ `REFUND`/`CARD_VIA_PORTAL`/`CONFIRMED`), recalculado do razão a cada mudança (nunca incrementado). O estorno para a **carteira** não entra nessa soma: ele já aparece no `WalletEntry REFUND` (`referenceType='CHARGING_SESSION'`), que o `paymentsService` soma à parte — contar nos dois seria duplicar. **Conciliação não muda** (provado, §8).
8. **Termos: versão vigente como configuração de ambiente, não tabela** (§6). `ConsentRecord` guarda a prova.
9. **Não criei** `anonymizedAt`, `NotificationChannel` com nome igual ao `NotificationChannelConfig` do Vega-A (o enum se chama `NotificationDeliveryChannel`), nem valores de `WalletEntryType` (`REFUND` e `TOPUP_REFUND` já existem; só adicionei CHECK de sinal).
10. **`AuditAction`: 4 valores** (valor de enum é para sempre): `PASSWORD_RESET`, `ACCOUNT_DELETION` (cobre o pedido do titular **e** o registro do reembolso pelo ADMIN — `actionDetail` distingue), `REFUND`, `CHARGEBACK`. Não adicionei `PASSWORD_CHANGE` (troca do L1.2 hoje cai em `OTHER`/`UPDATE`); se a Auditoria quiser filtrar, é uma migration de uma linha.

## 2. Tabelas, estados, índices

### 2.1 `User.deletedAt` (L1.4)
Coluna nula, sem DEFAULT (metadados apenas). Sem índice: nenhuma consulta do lote filtra por ela. Telas que listam motoristas devem decidir se mostram "Conta excluída" (`WHERE "deletedAt" IS NULL` ou não).

### 2.2 `AccountDeletionRequest` (L1.4, DL2/DL3)
Um por conta (`userId` único). Campos: `requestedAt`, `balanceCentsAtRequest` (≥ 0, **imutável**), `refundStatus` (`NOT_REQUIRED | PENDING_REFUND | REFUNDED` — mesmos literais do contrato), `refundPixKeyCiphertext`, `refundedAmountCents`, `refundProofReference`, `refundedAt`, `refundedByUserId`, `refundWalletEntryId` (`WalletEntry TOPUP_REFUND`, 1:1 único).

| Estado | Obrigatório | Proibido |
|---|---|---|
| `NOT_REQUIRED` | saldo = 0 | chave Pix, qualquer campo de reembolso |
| `PENDING_REFUND` | saldo > 0, chave Pix **cifrada** | campos de reembolso |
| `REFUNDED` (terminal) | chave **apagada**, `1 ≤ valor ≤ saldo do pedido`, comprovante não vazio, `refundedAt`, ADMIN, `TOPUP_REFUND` | — |

- **Chave Pix:** o CHECK `account_deletion_pix_key_is_ciphertext` só aceita o formato do `aesGcm.ts` (`v1:<kid 8 hex>:<base64>`); CPF, telefone, e-mail ou chave aleatória em claro **não casam**. É apagada (`NULL`) no `REFUNDED`. Mesma `PAYMENT_SECRETS_KEY` → **`recifrarSegredos` precisa passar a cobrir `AccountDeletionRequest.refundPixKeyCiphertext`** (rotação de chave).
- Linha nunca é apagada; `userId`/`requestedAt`/saldo imutáveis; `NOT_REQUIRED` e `REFUNDED` terminais (trigger).
- Índice: `ix_account_deletion_pending (requestedAt) WHERE refundStatus='PENDING_REFUND'` (fila do ADMIN). Sem índice em `refundedByUserId` (FK Restrict para User, que nunca é apagado).

### 2.3 Alterações em tabelas existentes (L1.4)
- `PaymentMethod`: **sem mudar o tipo** de `cieloCardTokenCiphertext` (continua `NOT NULL`; mudar quebraria os tipos que o Vega usa). "Destruído" = marcador literal `'DESTROYED'` (não é ciphertext válido: decifrar falha alto). CHECK `payment_method_destroyed_token_inactive`: o marcador só existe com `active=false` e `isDefault=false`. `holderName` já é nulável.
- `WalletEntry`: CHECK `wallet_entry_refund_sign` — `REFUND > 0` e `TOPUP_REFUND < 0`. **Não** restringe `ADJUSTMENT_*` nem cria `balanceAfter >= 0` (decisão da Nova mantida). O trigger de append-only da carteira está **intacto** (testado).
- `ChargingSession.startIp VARCHAR(64)`, `startUserAgent VARCHAR(512)` (L1.8): nulos, sem índice. Tamanhos folgados de propósito — se o INSERT da sessão falhar por causa de um campo de **prova**, a recarga não começa; **a aplicação deve truncar o UA em 512** antes de gravar (UA maior estoura, testado). Só sessões iniciadas pelo app; RFID e legado ficam `NULL`.

### 2.4 `NotificationPreference` (L1.6, DL5)
PK = `userId`. `sessionReceiptEmail` (default `true`), `lowBalanceEnabled` (default `true`), `lowBalanceThresholdCents` (default `2000`, CHECK `500..50000`). **Linha criada sob demanda** (upsert no `PATCH`); sem linha = os mesmos defaults (o `GET` devolve defaults). Não há coluna para segurança/cobrança (`PASSWORD_CHANGED`, `SESSION_PAYMENT_FAILED`, `ACCOUNT_DELETED`): sempre enviados.

### 2.5 `NotificationLog` (L1.6) — outbox + idempotência
Campos: `userId`, `type` (`NotificationType`: os 8 literais do contrato), `channel` (`EMAIL`), `entityId` (≤128), `status` (`PENDING|SENT|FAILED|SKIPPED`), `attempts`, `statusReason`, `providerMessageId`, `createdAt`, `lastAttemptAt`, `sentAt`.

- **Idempotência:** `UNIQUE (userId, type, channel, entityId)`. Receita do worker: `INSERT … ON CONFLICT (userId,type,channel,entityId) DO NOTHING` (0 linhas = o fato já foi reservado) → enviar → `UPDATE status='SENT', sentAt`. Provado com 20 reservas simultâneas: exatamente 1 vence. `jobId` BullMQ = `${type}:${entityId}`.
- **`entityId` por tipo (sugestão):** `SESSION_COMPLETED`/`SESSION_PAYMENT_FAILED`/`SESSION_CLOSED_BY_SERVER` = id da sessão; `LOW_BALANCE` = id do `WalletEntry` que cruzou o limiar; `TOPUP_CREDITED` = id do `PaymentIntent`; `REMOTE_START_BY_SUPPORT` = `correlationId` do comando; `PASSWORD_CHANGED` = id único do evento (ex.: id da linha de auditoria — cada troca é um fato novo); `ACCOUNT_DELETED` = id do `AccountDeletionRequest`.
- **Sem PII por desenho:** nem corpo, nem endereço, nem a mensagem de erro do SMTP (costuma repetir o destinatário). `statusReason` só aceita **código** (`^[A-Za-z0-9_.-]+$`: espaço e `@` são recusados pelo banco). O e-mail do `ACCOUNT_DELETED` (a conta já foi anonimizada) vive só no payload do job BullMQ — **o Vega deve remover o payload ao concluir** (`removeOnComplete`/`removeOnFail` com prazo curto).
- **Estados:** `SENT` e `SKIPPED` terminais (trigger: não voltam a `PENDING` = não existe 2º e-mail do mesmo fato); `FAILED` pode voltar a `PENDING` (reenfileiramento manual); `SENT` ⇔ `sentAt`; `FAILED`/`SKIPPED` exigem `statusReason`; a chave do fato é imutável.
- **Índices:** o único acima; `createdAt` (retenção de 12 meses por lote); parcial `ix_notification_log_pending (createdAt) WHERE status='PENDING'` (varredor de job perdido: Redis caiu entre o INSERT e o enqueue).
- **Retenção:** 12 meses por `createdAt`; **não** é append-only (log operacional). O expurgo ainda não está no job do N-11 (`retencao.ts`): depende de env nova e de o dono ligar a retenção — ver "PARA O PRÓXIMO".

### 2.6 `ConsentRecord` (L1.9)
`(userId, kind TERMS|PRIVACY, version ≤32, acceptedAt, source REGISTER|GOOGLE_SIGNUP|REACCEPT, ip ≤64)`. `UNIQUE (userId, kind, version)` = reaceite da mesma versão é idempotente (`ON CONFLICT DO NOTHING`) e responde "já aceitou a versão X?"; o prefixo `(userId, kind)` serve "última versão aceita". Só `ip` (o plano previu IP; UA não). **Append-only** por trigger com **uma exceção estreita**: o `ip` pode ser **zerado** (anonimização); nada mais muda, nada é apagado. `version` não vazia (CHECK). Usuários sem registro = `upToDate=false` (não se fabrica consentimento retroativo).

### 2.7 `PaymentReversal` (L1.8, DL7/DL8)
| Campo | REFUND | CHARGEBACK |
|---|---|---|
| `kind` / `status` | `REFUND`: `PENDING_CONFIRMATION → CONFIRMED \| CANCELLED` | `CHARGEBACK`: `OPEN → WON \| LOST \| ACCEPTED` |
| `destination` | `WALLET` (nasce `CONFIRMED`) ou `CARD_VIA_PORTAL` (nasce pendente) | `NULL` |
| `chargingSessionId` | obrigatório | derivado do intent |
| `paymentIntentId` | obrigatório se `CARD_VIA_PORTAL` | obrigatório |
| `userId` | **copiado pelo banco** (sessão/intent) | idem |
| `reason` | obrigatório (≤500) | proibido |
| `walletEntryId` | obrigatório **⇔** `WALLET` (1:1 único) | proibido |
| `portalReference` | só `CARD_VIA_PORTAL` | proibido |
| `caseReference`, `notifiedAt`, `dossierSnapshot` (objeto JSON ≤ 4 MiB) | proibidos | obrigatórios |
| `debtId` | proibido | só em `LOST`/`ACCEPTED` (ADMIN escolheu `CREATE_DEBT`) |
| `resolvedAt` / `resolvedByUserId` | `resolvedAt` ⇔ saiu de `PENDING_CONFIRMATION`; ADMIN `NULL` quando o job confirma | `resolvedAt` ⇔ saiu de `OPEN`; ADMIN **obrigatório** no desfecho |

Invariantes impostas **no banco** (não no código):
- **Teto do estorno sob concorrência:** `Σ estornos (≠ CANCELLED) da sessão ≤ ChargingSession.totalCostCents`, e `Σ CARD_VIA_PORTAL da venda ≤ amountCapturedCents`, num trigger `BEFORE INSERT` que toma `FOR NO KEY UPDATE` na **sessão** (serializa estornos da mesma sessão sem bloquear os `INSERT` de `MeterSample` do OCPP). Provado: 10 estornos simultâneos de 300 numa sessão de 1000 → exatamente 3 entram. Mensagens com os códigos do contrato (`AMOUNT_EXCEEDS_REFUNDABLE`, `SESSION_NOT_BILLED`) para o Vega mapear 409. O teto do banco é o **limite superior** (total da sessão / capturado); "o que de fato foi cobrado" (sessão que virou dívida, por exemplo) continua regra mais fina do Vega (`SESSION_NOT_BILLED`). **Ordem de lock para o Vega: sessão primeiro, depois a venda** (evita deadlock com `finalizarSessao`).
- **Um chargeback por venda** (índice único parcial `ux_payment_reversal_chargeback_per_intent`, vale em corrida → `CHARGEBACK_ALREADY_REGISTERED`).
- Só venda de cartão (`CIELO_CARD`) tem estorno/chargeback; chargeback ≤ capturado; sessão e venda precisam ser da mesma sessão e do mesmo pagador.
- Imutáveis: tipo, vínculos, valor, motivo, dossiê, autoria; estados terminais não mudam (`CHARGEBACK_ALREADY_RESOLVED`); linha **nunca é apagada**.
- **Trigger `AFTER`** mantém `PaymentIntent.amountRefundedCents` e grava `PaymentIntent.chargebackAt = notifiedAt` no registro do chargeback (não limpa no `WON`: histórico). O status do intent **não muda** (continua `CAPTURED`).
- **Dossiê:** `dossierSnapshot` é a prova **na própria linha**: sobrevive ao expurgo de partições do N-11 e a qualquer remoção de sessão. `dossierId` do contrato = `id` do `PaymentReversal`. Amostre a curva de medição (limite 4 MiB; estourar é erro claro). **Sem nome/e-mail/CPF.**
- **Índices:** `chargingSessionId`, `paymentIntentId` (FK + soma do teto); parciais `ix_payment_reversal_card_block (userId) WHERE chargeback OPEN/LOST/ACCEPTED` (consulta do bloqueio de cartão — a mesma do `POST /api/me/sessions/start` e do cadastro de cartão) e `ix_payment_reversal_pending_confirmation (createdAt) WHERE PENDING_CONFIRMATION` (job que reconsulta a Cielo). Planos conferidos com `EXPLAIN`. Sem índice em `userId` geral/`createdByUserId`/`resolvedByUserId`: eventos manuais do ADMIN (dezenas por ano), FK Restrict para `User`, que nunca é apagado.

- **Desbloqueio manual do cartão (P3, aceita pelo dono em 06/10/2026 — migration `20261006130000_chargeback_card_unblock`, Vega-E):** o bloqueio segue DERIVADO, agora `OPEN` **ou** (`LOST`/`ACCEPTED` com `cardUnblockedAt` nulo). Três colunas nulas em `PaymentReversal` (`cardUnblockedAt/ByUserId/Reason`), CHECK `payment_reversal_card_unblock` (nascem juntas, só em chargeback LOST/ACCEPTED) e o trigger `payment_reversal_guard` passou a permitir gravar o desbloqueio **uma vez** (depois imutável) sem liberar mais nenhuma mudança no estado terminal; dossiê, desfecho e dívida seguem intactos. A consulta do bloqueio (§4) é `kind=CHARGEBACK AND (status=OPEN OR (status IN (LOST,ACCEPTED) AND cardUnblockedAt IS NULL))` — subconjunto do predicado do índice parcial existente. Procedimento: `docs/RUNBOOK-ESTORNO-CHARGEBACK.md`.

## 3. LGPD — sequência de anonimização, o que fica e riscos

### 3.1 Sequência recomendada (uma transação, sob `FOR UPDATE` no usuário)
1. Pré-condições (código): sem sessão ativa/`STOP_UNCONFIRMED`, sem intent `AUTHORIZED/CAPTURE_PENDING/PENDING`, sem `Debt OPEN`.
2. `INSERT AccountDeletionRequest` (`NOT_REQUIRED` se saldo 0; senão `PENDING_REFUND` com a chave cifrada).
3. **Um `UPDATE "User"`** com exatamente: `name='Conta excluída'`, `email='excluido+'||id||'@anon.invalid'`, `phone/cpf/googleSub/passwordHash=NULL`, `active=false`, `sessionsValidAfter=now()`, `deletedAt=now()` (qualquer desvio é recusado pelo CHECK).
4. `PaymentMethod`: `active=false`, `isDefault=false`, `holderName=NULL`, `cieloCardTokenCiphertext='DESTROYED'`. `AuthToken` → `BLOCKED`.
5. `ConsentRecord.ip = NULL` e **(recomendado) `ChargingSession.startIp/startUserAgent = NULL`** nas sessões do usuário (ver P2).
6. Auditoria `ACCOUNT_DELETION` **com o snapshot de ator já anonimizado** (e-mail/nome de tombstone) — a linha do próprio evento não deve nascer com PII. `NotificationPreference` pode ficar (não tem PII) ou ser apagada.
7. Depois do commit: e-mail `ACCOUNT_DELETED` (endereço só no payload do job).

### 3.2 O que fica, e por quê
`ChargingSession`, `PaymentIntent`, `Debt`, `WalletEntry`, `Wallet` — ligados ao id pseudônimo (obrigação legal/fiscal, art. 16). `ConsentRecord` (prova do aceite, sem IP). `PaymentReversal`/dossiês (defesa de chargeback — art. 7º VI). `NotificationLog` (sem PII).

### 3.3 Riscos LGPD conhecidos (nada disso foi alterado por mim)
| # | Onde está o dado pessoal que sobrevive | Gravidade | Proposta |
|---|---|---|---|
| R1 | **`AuditLog.actorEmail/actorName/ipAddress/userAgent`** de linhas antigas do motorista (login, perfil, exportação). Trigger bloqueia `UPDATE` sempre; `DELETE` só após 24 meses. | **Alta** | **Decisão do dono/Órion (P1)** — não toquei no trigger. |
| R2 | `WebhookEvent.payload` (JSON da Cielo) — **não verifiquei** se contém nome/documento do comprador. | Média | Órion/Vega conferem um payload real; expurgo por idade (180 d, DL6) já cobre. |
| R3 | Texto livre: `WalletEntry.description`, `Debt.reason`, `PaymentReversal.reason`, `AuditLog.actionDetail/changes`. Um ADMIN pode digitar nome. | Média | Orientar o ADMIN a não colocar nome; revisão na tela. |
| R4 | `ChargingSession.startIp/startUserAgent` e IP dentro do `dossierSnapshot`. | Média | P2. |
| R5 | Cartão: `brand/last4/expiryMonth/expiryYear` permanecem. | Baixa | Aceitável (não identifica sozinho); zerar é decisão de política. |
| R6 | `AccountDeletionRequest` pendente "para sempre" mantém a chave Pix cifrada. | Média | Prazo máximo para o ADMIN devolver (P4). |

### 3.4 `AuditLog` — o que o trigger permite hoje
> **RESOLVIDA (05/10/2026).** **P1 aceita** (opção A abaixo: documentar na política de privacidade e deixar sair no expurgo por idade; o trigger append-only **não** foi alterado) e a **purga automática foi implementada** (Vega-L): etapa `retencaoAuditLog` do job de retenção (N-11), prazo **24 meses** (`RETENTION_AUDIT_LOG_DAYS`, padrão e piso 730), `DELETE` em lotes de 1000 por `occurredAt` (os mais antigos primeiro), sob as mesmas guardas (`RETENTION_ENABLED`, `RETENTION_DRY_RUN`) e o lock consultivo da manutenção; o corte usa a mesma expressão do trigger (`LEAST(agora − N dias, now() − interval '24 months')`), então nunca esbarra nele (24 meses é 730 **ou 731** dias, conforme um 29/02 na janela). Cada rodada que apaga algo grava 1 linha `SYSTEM`/`OTHER` (`retention:audit_log_purged`) com contagem e intervalo, na mesma transação, sem PII. O risco R1 fica, portanto, **limitado a 24 meses** (com a retenção ligada em produção — ela nasce desligada). Detalhes e operação: `docs/DEPLOY-EASYPANEL.md` §7.3.1. O texto original desta seção segue abaixo, como registro da decisão.

`UPDATE` bloqueado **sempre**; `DELETE` só de linha com `occurredAt` > 24 meses. Logo, anonimizar o snapshot exigiria **enfraquecer** o append-only. Opções para decidir (P1):
- **A) Só documentar** na política de privacidade (base: obrigação de segurança/prova, art. 7º II e VI) e deixar sair no expurgo por idade. Zero mudança de banco.
- **B) Parar de gravar PII real do motorista no snapshot** daqui para frente (ex.: gravar `actorEmail` mascarado) — a tela de Auditoria deixa de mostrar o e-mail completo de motorista.
- **C) Exceção estreita no trigger** (função `SECURITY DEFINER` que só aceita trocar `actorEmail/actorName/ipAddress/userAgent` por **valores de tombstone**, para um `actorUserId` com `deletedAt`). Honestidade: o app roda com o mesmo papel do banco, então um código malicioso poderia usar a mesma exceção para **apagar a identidade de um ator** (anti-forense), ainda que sem poder forjar conteúdo. Só com parecer do Órion.

## 4. Quem lê/escreve o quê (por item)

| Item | Escreve | Lê |
|---|---|---|
| **L1.3** senha | `AuditLog action=PASSWORD_RESET`; `User.passwordHash/sessionsValidAfter` (já existem); `NotificationLog` (`PASSWORD_CHANGED`, via L1.6) | nada novo (o token vive no Redis, não no banco) |
| **L1.4** LGPD | `User.deletedAt` (+ UPDATE do §3.1), `AccountDeletionRequest`, `PaymentMethod` (marcador), `WalletEntry TOPUP_REFUND` (ADMIN), `AuditLog ACCOUNT_DELETION`, `ConsentRecord.ip=NULL`, `ChargingSession.startIp/UA=NULL` | `ConsentRecord`, `NotificationLog`, `WalletEntry`, `ChargingSession`, `AccountDeletionRequest` (export + fila admin) |
| **L1.6** notificações | `NotificationLog` (reserva/estado), `NotificationPreference` (PATCH) | `NotificationPreference` (recibo/saldo baixo/limiar), `NotificationLog` (varredor, export) |
| **L1.8** estorno/chargeback | `PaymentReversal`, `WalletEntry REFUND` (carteira), `Debt` (só `CREATE_DEBT`), `AuditLog REFUND/CHARGEBACK`, `ChargingSession.startIp/UA` (no `sessions/start`); o trigger grava `PaymentIntent.amountRefundedCents/chargebackAt` | `PaymentReversal` (bloqueio de cartão, dossiê, lista), `PaymentIntent.cielo*` (já existem), filtros `tid/authorizationCode/proofOfSale` já têm colunas |
| **L1.9** termos | `ConsentRecord` (register/google/`POST /api/me/consents`) | `ConsentRecord` (`upToDate`, export); versão vigente = env (§6) |

### Mapa contrato → colunas (para a Vega-B/Lyra)
- `MeNotificationPreferences` ↔ `NotificationPreference` (3 colunas, mesmos nomes). `AdminAccountDeletionRow` ↔ `AccountDeletionRequest` (`refundPixKey` = decifrar `refundPixKeyCiphertext`; `null` após `REFUNDED`).
- `RefundStatus` = `status` (`PENDING_CONFIRMATION|CONFIRMED`). `ChargebackOutcome` = `status` se `WON|LOST|ACCEPTED`, senão `null` (`OPEN`). `CreateChargebackResponse.dossierId` = `id`. `CardEligibilityReason.CHARGEBACK_BLOCKED` = a consulta do §2.7.
- `MeConsentStatus` ← `ConsentRecord` (último `TERMS`/`PRIVACY` por `acceptedAt`; `upToDate` = existe linha da versão **vigente** dos dois).
- **Frontend/backend precisam dos 4 valores novos de `AuditAction`:** `frontend/src/types/api.ts` + `AUDIT_ACTION_LABELS: Record<AuditAction,string>` (utils.ts) e o `z.enum` de `backend/src/api/schemas/auditLog.schema.ts` (que já está sem `PAYMENT_CREDIT`/`PAYMENT_CONFIG_CHANGE` — falha pré-existente).

## 5. Índices — justificativa e o que NÃO indexei
Criados só onde há consulta real (tabela acima). **Não** criei: índice em `User.deletedAt`; em FKs de ator (`createdBy/resolvedBy/refundedBy`); em `userId` geral de `PaymentReversal`; em `NotificationLog.userId` isolado (o prefixo do `UNIQUE` já serve). Reavaliar só com tabela grande + Seq Scan medido.

## 6. Versão dos termos e dados da empresa: configuração, não tabela
Envs sugeridas (o `env.ts` é do Vega; tudo opcional exceto as versões): `LEGAL_TERMS_VERSION`, `LEGAL_PRIVACY_VERSION`, `LEGAL_COMPANY_NAME`, `LEGAL_COMPANY_CNPJ`, `LEGAL_SUPPORT_EMAIL`, `LEGAL_SUPPORT_PHONE`, `LEGAL_DPO_EMAIL` (vazias = `null` no contrato). Motivo: não há tela de admin planejada para editar, o dono já edita env no EasyPanel, e a versão só muda junto com o **texto** (que é deploy do frontend). Contra: trocar a env sem publicar o texto desalinha — a versão deve subir no mesmo deploy. Reversível: criar uma tabela singleton depois é expand puro.

## 7. Migração segura, rollback, expand/contract
- **Expand puro:** nada removido/renomeado; o código atual segue igual. Colunas novas em tabelas existentes: nulas, sem DEFAULT (**só catálogo** — provado: `relfilenode` e tamanho de `User`/`ChargingSession` idênticos antes/depois com o seed-demo). CHECKs em tabelas existentes: `NOT VALID` + `VALIDATE` (3 casos). Tabelas novas: normais (nascem vazias).
- **Rollback documentado** no fim do `migration.sql` (ordem inversa; os 4 valores de `AuditAction` não têm rollback — Postgres não tem `DROP VALUE`; ficar ocioso é inofensivo). **Executei o rollback inteiro sobre o seed-demo** (11.304 sessões, 8.999 intents, 7.461 lançamentos) e **reapliquei** a migration: tudo voltou, mesma ordem de grandeza de tempo (3 s), constraints validadas.
- Se for preciso reverter depois de o código gravar: conferir `SELECT count(*) FROM "User" WHERE "deletedAt" IS NOT NULL` (o rollback apagaria a prova da anonimização) e pausar o código do lote 1 antes.

## 8. O que foi provado (e como)
Em Postgres 18 real, porta alta descartável:
1. `migrate deploy` **do zero** (24 migrations) e **sobre o seed + seed-demo** (rollback executado e reaplicado): ok; `migrate diff --from-url` contra o banco migrado só acusa o `ux_ocpp_message_dedupe` de sempre.
2. 51 testes de constraint/trigger (`lote1ModeloDados.test.ts`): tombstone libera e-mail/Google/CPF; CHECK recusa cada PII restante (9 variantes); sem ressurreição; `DELETE` de `User` impossível; máquina de estados da exclusão; chave Pix em claro recusada; idempotência do `NotificationLog` com 20 reservas simultâneas; `statusReason` sem `@`/espaço; aceite append-only com exceção do `ip`; teto de estorno sob 10 requisições concorrentes; chargeback único em corrida; bloqueio de cartão derivado (`WON` libera, `LOST/ACCEPTED` mantêm); dossiê imutável e limitado; append-only de `WalletEntry` e `AuditLog` **intactos**; planos de índice parciais.
3. **Mutação:** 29 mutações (cada uma remove UMA garantia — CHECK, trigger, índice, e uma versão do trigger do teto **sem lock** com `pg_sleep`), harness `LOTE1_MUTACAO` do teste. **29/29 mortas** (cada uma derruba ≥ 1 teste, inclusive a do lock: só o teste de concorrência cai).
4. **Conciliação** (`getPaymentsReconciliation`) antes/depois de anonimizar um motorista, confirmar um estorno no cartão e abrir um chargeback sobre o seed: **o único campo que mudou foi `cardRefundedCents`** (informativo, 0 → 200); `revenue`, `accounted` e `difference` idênticos.

**Não provado:** comportamento com tabelas realmente grandes (as do seed têm ~10⁴ linhas); deadlocks com `finalizarSessao`/StopTransaction reais (a ordem de lock sessão→venda está documentada, não exercitada contra o código do Vega); conteúdo de PII em `WebhookEvent.payload` (R2); que o código futuro grave o UPDATE de §3.1 exatamente como o CHECK exige (o banco recusa se não).

## 9. Harness de mutação
`LOTE1_MUTACAO='<sql>@@<sql>' npx vitest run tests/integration/lote1ModeloDados.test.ts` executa o SQL logo após o `migrate deploy` do banco próprio e deve **falhar**. Exemplo: `ALTER TABLE "User" DROP CONSTRAINT user_deleted_is_anonymized` derruba 11 testes.

## 10. Pendências de decisão (resumo — detalhe no handoff)
P1 `AuditLog` PII (§3.4) · P2 IP/UA da sessão e do dossiê: zerar na exclusão? por quanto tempo no dossiê? · P3 chargeback `LOST` bloqueia o cartão **para sempre**? (hoje não há desbloqueio manual) · P4 prazo máximo do reembolso pendente e reembolso **parcial** (o contrato aceita `amountCents ≤ saldo`; o resto ficaria na carteira da conta excluída).
