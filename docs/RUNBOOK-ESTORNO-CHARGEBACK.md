# Runbook — estorno e chargeback (L1.8, fluxo manual assistido)

Para o **ADMIN** (o dono). Backend: Vega-E, 06/10/2026. Decisões do dono: **DL7** (chargeback perdido: a plataforma absorve; o motorista perde o modo cartão; dívida só por ação manual), **DL8** (estorno de cartão neste lote = pelo **portal da Cielo** + registro no InnoFlow; o InnoFlow **não** chama nenhuma API da Cielo para devolver dinheiro) e **P3** (chargeback perdido bloqueia o cartão, e o ADMIN pode desbloquear caso a caso).

Contrato das rotas: `frontend/src/types/api.ts` (seção L1.8) + as rotas **aditivas** listadas no fim deste documento. Modelo de dados: `docs/MODELO-DADOS-LOTE1.md` §2.7.

---

## 0. Antes de tudo — leia isto (conta Cielo compartilhada com o Parque)

> **TODO estorno de uma venda do InnoFlow gera um alerta FALSO no sistema do Parque das Feiras.**

A conta Cielo (EC) é a mesma do Parque. Qualquer mudança numa venda — estorno feito no **portal da Cielo** ou chargeback — dispara a notificação da Cielo para a URL do **Parque**. O código do Parque reconsulta a venda, vê o pedido `IF-<id>` (começa com `IF-`), **não encontra** esse pedido no banco dele e chama `alertarDinheiroNaoConciliado('pedido-nao-encontrado')`, cujo texto manda **estornar no painel do gateway** (achado **N-2** da auditoria; `docs/AUDITORIA-PRE-PRODUCAO.md`).

**Procedimento para quem lê os alertas do Parque (não altera o Parque):**

1. **Todo alerta do Parque que cite um pedido começado por `IF-` é do InnoFlow.** Ignore-o. **Não estorne, não cancele e não "corrija" a venda por causa dele** — a venda é legítima e já está conciliada no InnoFlow.
2. Quando o ADMIN registrar um estorno/chargeback no InnoFlow, **avise o operador do Parque** (mensagem curta: "vai chegar alerta `IF-…`; é o estorno X do InnoFlow, ignore").
3. Alerta com `MerchantOrderId` que **não** começa com `IF-` continua sendo problema do Parque: tratar lá, como sempre.
4. A correção definitiva (ignorar `IF-` no `/webhook/cielo` do Parque) é um trabalho no repositório do Parque, **fora deste projeto** e que depende de autorização do dono. Até lá, vale este procedimento.

O estorno **para a carteira** (§1.1) **não passa pela Cielo**: não gera alerta no Parque. É a razão de ele ser o caminho recomendado.

---

## 1. Estorno de uma sessão paga

Tela: **Sessões → detalhe da sessão → Estornar**. Pede: valor, motivo (10 a 500 caracteres, **sem nome do motorista**: o texto fica no registro), destino e a **sua senha** (step-up). Só **ADMIN**.

Regras (valem para os dois destinos):

- Só sessão **encerrada e cobrada**. Sessão aberta, sem custo, ou que virou **dívida** (ninguém pagou) → `SESSION_NOT_BILLED`.
- O teto é o que a sessão **de fato cobriu** (carteira + cartão capturado + dívida já quitada), menos o que já foi estornado. **Devoluções pendentes no portal seguram o teto** até serem confirmadas ou canceladas. Passou → `AMOUNT_EXCEEDS_REFUNDABLE` (a resposta traz `details.refundableCents`). Vale mesmo com dois ADMINs estornando a mesma sessão ao mesmo tempo.
- Estorno **nunca** muda a conciliação financeira: o status da venda continua `CAPTURED` e a identidade `faturamento = capturas + débitos + dívida` fecha igual antes e depois (provado em teste). O relatório mostra o estorno só como informação (`cardRefundedCents`, lançamento `REFUND`).

### 1.1 Destino `WALLET` (recomendado)

Crédito **imediato** no saldo do motorista (lançamento "Estorno da recarga de dd/mm"). Serve para sessão paga com carteira **ou** com cartão. Não envolve a Cielo e **não gera alerta no Parque**. Fica `CONFIRMED` na hora.
Não funciona se a conta do motorista foi **excluída** (LGPD) → `DRIVER_ACCOUNT_DELETED`.

### 1.2 Destino `CARD_VIA_PORTAL` (devolver no cartão)

1. **No portal da Cielo**, faça o estorno da venda (localize pelo Tid/NSU: **Relatórios → Pagamentos** do InnoFlow aceita filtrar por `tid`, `authorizationCode` e `proofOfSale`).
2. No InnoFlow, registre: valor, motivo, `portalReference` (a referência do estorno no portal, se houver) e a senha. O registro fica **`PENDING_CONFIRMATION`**. O InnoFlow **não** falou com a Cielo para isso.
3. Um job do worker (a cada 30 min, só leitura) **reconsulta a venda** na Cielo e marca `CONFIRMED` **apenas** quando a consulta mostra a venda como **estornada (Status 11)** e o seu registro cobre **o valor capturado inteiro**. Ao confirmar, `PaymentIntent.amountRefundedCents` sobe (informativo).
4. **Estorno PARCIAL no cartão: o job NÃO confirma.** Não sabemos como a consulta da Cielo mostra um estorno parcial (nunca foi visto em sandbox) e o InnoFlow trata o desconhecido como "não confirmado", nunca como confirmado. O registro fica `PENDING_CONFIRMATION` e, passado `REFUND_PORTAL_PENDING_ALERT_HOURS` (72 h), dispara o alerta `payment_refund_portal_pending_overdue`. Conferir no extrato da Cielo; se o estorno parcial foi feito, **confirme à mão** com a referência do comprovante (§1.4). Se ele **não** foi feito (digitou errado, desistiu), cancele o registro (§1.3) para liberar o teto.
5. **A consulta da Cielo só alcança ~3 meses.** Venda com mais de `REFUND_PORTAL_RECONSULT_WINDOW_DAYS` (85 dias, contados da captura) não é mais reconsultada: o job para e alerta (mesmo alerta, `motivo = JANELA_DE_CONSULTA_EXPIRADA`). Por isso o `Tid`/`AuthorizationCode`/NSU são gravados na hora e o dossiê (§2) guarda a prova. Nesse caso a saída é a **confirmação manual** (§1.4).
6. Se a Cielo mostrar a venda **totalmente** estornada mas o seu registro for parcial → alerta `payment_refund_portal_status_mismatch`; **não** confirma. Corrija o registro (cancele e registre de novo com o valor certo).

Sem credencial Cielo (ou no ambiente de teste com o adaptador falso) o job fica **inerte**: pula a rodada sem ler nem escrever nada. Venda de **outro ambiente** que o do gateway atual (sandbox x produção) não é consultada.

### 1.3 Cancelar o registro

`POST /api/admin/refunds/:id/cancel` (senha). Só uma devolução no cartão ainda `PENDING_CONFIRMATION` (digitou errado, desistiu, estorno nunca feito no portal). Libera o teto. Nunca mexe na Cielo. Estorno já confirmado ou na carteira não se cancela (`REFUND_NOT_CANCELLABLE`).

### 1.4 Confirmar à mão (estorno parcial ou venda antiga)

`POST /api/admin/refunds/:id/confirm` — corpo `{ proofReference, currentPassword }`. Só **ADMIN**, com a **sua senha** (step-up).

**Quando usar:** a devolução no cartão ficou `PENDING_CONFIRMATION` e o job **não** consegue confirmar: (a) **estorno parcial** (a consulta da Cielo não é lida para parcial) ou (b) **venda com mais de ~3 meses** (fora da janela de reconsulta). Você viu o estorno no **portal/extrato da Cielo**: confirme aqui com a referência do comprovante, em vez de cancelar o registro (cancelar perderia a confirmação e libera o teto indevidamente). Se o estorno **não** foi feito, cancele (§1.3).

- `proofReference`: a referência/código do comprovante no portal da Cielo, **5 a 120 caracteres**: só letras, números e `. _ - / # :` (sem espaço, sem e-mail). **Não** cole nome, CPF nem número de cartão: o código recusa CPF com máscara e sequência de 13 a 19 dígitos que seja número de cartão válido. A referência vai para o registro (`portalReference`, substituindo a do cadastro, que continua na auditoria) e para a auditoria.
- Efeitos: o registro vira `CONFIRMED` (guarda **quem** confirmou), a venda ganha o valor em `amountRefundedCents` (informativo) e a **conciliação não muda** (provado em teste: a identidade `faturamento = capturas + débitos + dívida` fecha igual antes e depois; só o campo informativo `cardRefundedCents` sobe). O valor **não** muda e o teto já estava seguro desde o registro.
- Distinguir manual de automática: o DTO de `GET /api/admin/sessions/:id/refunds` traz `confirmedManually` (`true` = confirmada por um ADMIN; `false` = o job confirmou sozinho, está pendente/cancelada ou é carteira).
- Só uma confirmação por registro: dois ADMINs ao mesmo tempo, **um vence**; o outro recebe `409 REFUND_NOT_CONFIRMABLE`. O mesmo 409 vale para devolução já confirmada, cancelada ou na carteira. Se o job confirmar no meio, quem chegar depois não sobrescreve.
- Auditoria `REFUND` / `refund:manually_confirmed` na mesma transação (se a auditoria falhar, nada é confirmado). Rate limit de escrita de estorno (20/min por ADMIN).
- O InnoFlow **não** conversa com a Cielo para isso: a confirmação é um ato humano baseado no que você viu no portal.

---

## 2. Chargeback (contestação do titular do cartão)

O InnoFlow **nunca descobre um chargeback sozinho**: a Cielo avisa o **dono** (e-mail/portal) e não existe webhook do InnoFlow nesta conta. Quando o aviso chegar, **cadastre no mesmo dia** — há prazo para responder.

### 2.1 Registrar

1. Ache a venda: **Relatórios → Pagamentos**, filtro por `tid`, `authorizationCode` ou `proofOfSale` (dados do aviso da Cielo), ou por valor/data. Anote o `id` da venda.
2. **Pagamentos → venda → Registrar chargeback**: valor contestado (≤ capturado), data do aviso (`notifiedAt`), **referência do caso** na Cielo, código do motivo e prazo de resposta (opcionais). Um chargeback por venda (`CHARGEBACK_ALREADY_REGISTERED`).
3. Efeitos **imediatos**, na mesma operação: (a) o **modo cartão do motorista é bloqueado** (`CHARGEBACK_BLOCKED`; Pix e carteira seguem); (b) o **dossiê** é gravado na hora; (c) a venda ganha `chargebackAt` (informativo; o status continua `CAPTURED`).

### 2.2 Dossiê (`GET /api/admin/chargebacks/:id/dossier`, JSON)

Snapshot **imutável**, montado no momento do registro, para você anexar à resposta na Cielo: identificadores da adquirente (PaymentId, Tid, código de autorização, NSU), valores e datas da venda, cartão (**só bandeira e final**), dados da sessão (horários, kWh, custo, **tarifa congelada**), **curva de medição amostrada** (até 240 pontos por série, primeiro e último sempre presentes), **trilha OCPP resumida** (só eventos de protocolo da própria sessão/conector), idade da conta, identidade verificada (login Google) e os aceites de termos. Ele **sobrevive** ao expurgo da medição/log (retenção N-11): a prova mora na própria linha.

**O que NÃO entra (LGPD):** nome, e-mail, CPF, telefone, `idTag`, titular do cartão. O IP do início da sessão entra **mascarado** (`a.b.c.0/24`) e o User-Agent **truncado em 120 caracteres**. *(Se o seu advogado/a Cielo exigir o IP completo, é decisão de política — pendência P2 do `MODELO-DADOS-LOTE1`.)* Ver o dossiê é auditado.

### 2.3 Desfecho (`PATCH /api/admin/chargebacks/:id`, senha)

| Desfecho | Efeito |
|---|---|
| `WON` (ganhamos a disputa) | O modo cartão do motorista **volta sozinho**. Não gera dívida. |
| `LOST` (perdemos) | A **plataforma absorve** o prejuízo. O motorista **continua sem o modo cartão**. |
| `ACCEPTED` (aceitamos o chargeback sem contestar) | Igual a `LOST`. |

**Dívida do motorista** (só em `LOST`/`ACCEPTED`, **ação manual sua**): `debtPolicy: "CREATE_DEBT"` cria uma dívida em aberto do valor do chargeback; omitido ou `"ABSORB"` não cria nada. A dívida bloqueia a próxima recarga (`DRIVER_HAS_OPEN_DEBT`) e é quitada automaticamente por um crédito de Pix. Ela **não** é ligada à sessão de propósito: assim não altera a conciliação do período. Desfecho dado uma vez não se refaz (`CHARGEBACK_ALREADY_RESOLVED`).

### 2.4 Desbloquear o cartão depois de um chargeback perdido (P3)

`POST /api/admin/chargebacks/:id/unblock-card` (motivo de 10 a 500 caracteres + senha). Só em `LOST`/`ACCEPTED` (`CHARGEBACK_NOT_LOST` nos demais; `CARD_ALREADY_UNBLOCKED` se já foi). Devolve o modo cartão **sem apagar nada**: o registro, o desfecho, o dossiê e a dívida ficam como estão (o banco recusa qualquer outra alteração). O desbloqueio é por chargeback: se o motorista tiver **dois** chargebacks perdidos, desbloquear um mantém o bloqueio pelo outro. Fica na auditoria (sem o texto do motivo).

---

## 3. Auditoria e segurança

- Toda escrita grava linha de auditoria `REFUND` ou `CHARGEBACK` **na mesma transação** do dinheiro (se a auditoria falhar, nada acontece). Sem o texto livre do motivo, sem a senha, sem nome/e-mail do motorista (só o id).
- Escritas pedem a **sua senha** (mesmo mecanismo do gateway: 5 erradas trancam por um tempo; senha errada grava `DENIED`). **Exceção do contrato:** *registrar* o chargeback não pede senha (é reversível pelo desfecho `WON`, que pede).
- Rate limit de escrita: 20/min por ADMIN.
- Não coloque o nome do motorista no motivo: o texto fica gravado no registro (e na exportação LGPD do titular, se aplicável).
- **Quanto tempo a trilha de auditoria fica:** as linhas `REFUND`/`CHARGEBACK` do log de auditoria são **purgadas automaticamente depois de 24 meses** (decisão do dono, 05/10/2026; a rotina de retenção só apaga com `RETENTION_ENABLED=true` — `docs/DEPLOY-EASYPANEL.md` §7.3.1). O que prova o chargeback **não** mora só nessa trilha: o **dossiê é um snapshot salvo na própria linha do chargeback** (`GET /api/admin/chargebacks/:id/dossier`) e **sobrevive** à purga da auditoria, do log OCPP e das leituras do medidor, assim como o registro do estorno, o extrato e a dívida (nada disso é purgado). Disputa que ainda possa estar em andamento perto dos 24 meses: baixe o dossiê e guarde-o junto da resposta à Cielo. **Antes de ligar a retenção em produção**, faça backup e restauração testada (a purga é irreversível).

## 4. Alertas (chegam ao dono por e-mail/WhatsApp, N-7)

| Alerta | Severidade | O que fazer |
|---|---|---|
| `payment_refund_portal_pending_overdue` | IMPORTANTE | Devolução no portal ainda não confirmada: conferir o extrato da Cielo; se foi feita, **confirmar à mão** (§1.4); se não, cancelar (§1.3). |
| `payment_refund_portal_status_mismatch` | IMPORTANTE | A Cielo mostra estorno total e o registro é parcial: ajustar o registro (§1.2 item 6). |
| `chargeback_response_deadline_near` | **CRÍTICO** | Chargeback em aberto com o prazo de resposta em até **3 dias** (`chargebackId`, `diasRestantes`): baixar o dossiê (§2.2), responder no portal da Cielo e registrar o desfecho (§2.3). |
| `chargeback_response_deadline_overdue` | **CRÍTICO** | O prazo de resposta **já venceu** e o chargeback segue em aberto (`chargebackId`, `diasDeAtraso`): confirmar na Cielo se ainda aceita contestação; senão registre o desfecho (perdido/aceito). **Avisa todo dia até o desfecho.** |

**Vigia do prazo dos chargebacks:** um job do worker roda **1 vez por dia** e avisa, **por chargeback**, os que estão `OPEN` com `responseDeadline` nos próximos 3 dias (ou já vencido). Só chargeback com **prazo cadastrado** é vigiado: ao registrar, preencha sempre o prazo que a Cielo informou. O desfecho (`WON`/`LOST`/`ACCEPTED`) é o que para o aviso. Teto de 50 avisos por rodada (os de prazo mais antigo primeiro). Sem nome do motorista no aviso: só ids e dias.

## 5. Rotas (resumo para quem integra)

| Rota | Quem | Observação |
|---|---|---|
| `POST /api/admin/sessions/:id/refunds` | ADMIN + senha | Contrato. `201 { refundId, status }` |
| `GET /api/admin/sessions/:id/refunds` | ADMIN | **Aditiva.** `{ billedCents, refundedCents, refundableCents, items[] }` |
| `POST /api/admin/refunds/:id/cancel` | ADMIN + senha | **Aditiva.** `{ refundId, status: "CANCELLED" }` |
| `POST /api/admin/refunds/:id/confirm` | ADMIN + senha | **Aditiva** (§1.4). Corpo `{ proofReference, currentPassword }` → `{ refundId, status: "CONFIRMED", confirmedManually: true, proofReference }`. 409 `REFUND_NOT_CONFIRMABLE` |
| `POST /api/admin/payments/:intentId/chargebacks` | ADMIN | Contrato. `201 { chargebackId, dossierId }` |
| `PATCH /api/admin/chargebacks/:id` | ADMIN + senha | Contrato. `200 ChargebackDTO` |
| `GET /api/admin/chargebacks` · `/:id` | ADMIN | **Aditivas.** Lista paginada (`outcome`, `paymentIntentId`) e detalhe |
| `GET /api/admin/chargebacks/:id/dossier` | ADMIN | Contrato. Auditado |
| `POST /api/admin/chargebacks/:id/unblock-card` | ADMIN + senha | **Aditiva** (P3). `200 ChargebackDTO` |
| `GET /api/admin/reports/payments?tid=&authorizationCode=&proofOfSale=` | ADMIN/OPERATOR (no escopo) | Filtros por igualdade exata |

Variáveis de ambiente novas (todas opcionais): `REFUND_PORTAL_SCAN_INTERVAL_MS` (30 min), `REFUND_PORTAL_RECONSULT_WINDOW_DAYS` (85), `REFUND_PORTAL_PENDING_ALERT_HOURS` (72).
