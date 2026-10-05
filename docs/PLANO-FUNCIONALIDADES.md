# Plano das próximas funcionalidades — InnoFlow (Nova, 05/10/2026)

> Só planejamento. Nenhum código foi escrito. Cada lacuna abaixo foi **conferida no código** (rota, tela, schema
> ou job) neste mesmo dia; onde algo depende de doc externa ou de hardware, está marcado **[não confirmado]**.
> Fonte de verdade de contrato continua sendo `frontend/src/types/api.ts`: os contratos daqui são **esboço** que a
> Vega formaliza lá **antes** de qualquer Lyra começar (regra que nasceu do incidente de contratos divergentes).

---

## 0. Contexto e hipóteses declaradas

- **Maturidade:** MVP indo a público. Um operador real (o dono), dezenas de carregadores no máximo no 1º ano,
  motoristas na casa de centenas a poucos milhares. Multi-tenant já existe no schema e na API; o 2º operador é
  hipótese de médio prazo, não de lançamento.
- **Implicação:** nada aqui pede fila nova de infraestrutura, serviço novo nem banco novo. Tudo cabe nos três
  processos existentes (`api`, `ocpp-gateway`, `worker`), no Postgres e no Redis/BullMQ que já rodam.
- **Recursos agora (05/10):** Vega no notificador de alertas N-7 (traz o módulo SMTP com `nodemailer` —
  já aparece no `backend/package.json` do working tree); Cronos no N-11 (partições/retenção); Lyra-1 na tela do
  gateway (mexe em `components/ui/{Card,Dialog,Switch,buttonVariants}` e cria `Alert`/`InlineCode`); Lyra-2 na
  apresentação em PDF. Livres: Íris, Órion, Vulcano, Alexandria, e uma segunda instância da Vega ("Vega-B") se o
  Atlas quiser.
- **Restrições de negócio que valem para todo o plano:** conta Cielo **compartilhada com o Parque das Feiras**,
  sem webhook no InnoFlow (Pix por polling; chargeback só aparece no portal da Cielo); **o Parque não pode ser
  alterado**; motorista é **conta de rede** (sem `operatorId`); nota fiscal **adiada pelo dono**.

---

## 1. O que EXISTE de fato (inventário conferido)

| Área | Existe | Evidência |
|---|---|---|
| Autenticação | login, cadastro (sempre DRIVER), Google (só DRIVER), vínculo Google, **troca de senha só na API** | `auth.routes.ts`: `/register` `/login` `/google` `/google/link` `/password` |
| PWA motorista | início, mapa+lista, sessão ao vivo, histórico paginado, recibo, carteira+extrato, Pix, cartões salvos, instalação (Android + coach iOS) | `pages/App/*`, `components/pwa/InstallPromptCard.tsx` |
| Admin operação | dashboard, sessões (+ encerramento F5.9), pontos de recarga com **reset/unlock/change-availability/trigger-message**, conectores, sites, tarifas **e vínculo de tarifa (TariffAssignment) com UI** | `pages/Admin/*`, `components/chargePoints/ChargePointCommandsMenu.tsx`, `components/tariffAssignments/*` |
| Admin financeiro | financeiro/conciliação, faturamento, movimento diário, pagamentos, carteiras (ajuste ADMIN), **CSV** em relatórios e auditoria | `reports.routes.ts` (`?format=csv`), `components/relatorios/ExportCsvButton.tsx` |
| Admin plataforma | tokens RFID, auditoria, gateway Cielo | `pages/Admin/{AuthTokens,Auditoria,GatewayPagamento}` |
| Tempo real | SSE por audiência | `events.routes.ts`, `me.routes.ts /events` |
| Jobs | Pix expirar/poll, varredor de pré-autorização, watchdog de sessão | `worker/jobs/*` |

> Memória desatualizada encontrada: "Gap: TariffAssignment sem CRUD" e "sem hook de query" — a UI e o hook
> **existem hoje** (`TariffAssignmentManager` usado em `Admin/ChargePoints` e `Admin/Connectors`,
> `hooks/useTariffAssignments.ts`). O Atlas deve atualizar/remover essas duas memórias.

---

## 2. LOTE 1 (F6) — os 8 itens pedidos pelo dono + 1 que eu recomendo juntar

Ordem de leitura = ordem de execução sugerida (ver §3 para ondas e colisões).

### L1.1 — Erro de rede no login diz "E-mail ou senha inválidos" ✅ confirmado

- **Prova:** `pages/Auth/Login.tsx:41` usa `authErrorMessage(err, "E-mail ou senha inválidos.")`; em
  `services/api.ts:62` `getApiErrorMessage` devolve o `fallback` quando **não há resposta** (rede caiu, timeout,
  CORS) e também em 5xx sem corpo. Ou seja: servidor fora do ar = "sua senha está errada".
- **Valor:** motorista na tomada com 4G ruim não fica tentando senha (e não aciona o throttle por conta à toa).
- **Esforço:** Lyra/Atlas **P** (só `lib/authErrors.ts` + teste) · Íris **P** · resto —.
- **Regra (sem API nova):** `status === undefined` → "Sem conexão com o servidor. Confira sua internet e tente
  de novo."; `status >= 500` → "O serviço está instável agora. Tente novamente em instantes."; só `401
  INVALID_CREDENTIALS` mostra "E-mail ou senha inválidos."; 429 continua como está. Vale para login, cadastro e
  Google (todos passam por `authErrorMessage`).
- **Aceite:** teste unitário com axios sem `response` → texto de conexão; 503 → texto de instabilidade; 401
  `INVALID_CREDENTIALS` → texto de credencial; E2E com `page.route('**/api/auth/login', r => r.abort())` mostra o
  texto de conexão.
- **Colisão:** nenhuma (não toca `components/ui`). **Pode sair hoje.**

### L1.2 — Perfil do motorista + troca de senha com tela ✅ confirmado

- **Prova:** não há `GET/PATCH /api/me/profile` nem rota equivalente; o usuário só existe no `authStore` vindo do
  login. `POST /api/auth/password` existe com contrato completo (`types/api.ts:37`) e **nenhuma tela o chama**
  (grep `auth/password` em `.tsx` = 0). O admin também não tem "alterar minha senha".
- **Valor:** motorista corrige nome/telefone/CPF, define senha numa conta só-Google, troca senha; staff troca a
  própria senha sem pedir ao dono rodar script.
- **Esforço:** Vega **P** · Lyra **M** (tela PWA + diálogo no admin) · Íris **P** · Órion **P** (só conferir
  escopo).
- **Contrato (esboço):**
  - `GET /api/me/profile` (DRIVER) → `200 { id, name, email, phone|null, cpfMasked|null, hasPassword,
    googleLinked, identityVerified, createdAt }`. `cpfMasked` = `***.456.789-**`; o CPF inteiro só sai na
    exportação LGPD (L1.4).
  - `PATCH /api/me/profile` `{ name?, phone?|null, cpf?|null }` → `200` (mesmo DTO). Erros: `400
    VALIDATION_ERROR`, `409 CPF_IN_USE`. **E-mail não é editável no lote 1** (trocar e-mail exige verificação no
    endereço novo e conversa com o vínculo Google — fica para F7, item "verificação de e-mail").
  - Troca de senha: **reusa** `POST /api/auth/password` (já devolve token novo; o cliente substitui).
  - Rota nova em arquivo próprio (`meProfile.routes.ts`) montado em `/api/me/profile`, com
    `authenticate + requireRole('DRIVER')`; **nenhum `userId` lido de body/query/param** (regra das `/api/me/*`).
- **Design system:** página `/app/perfil` com `PageHeader` + `Card` claros (miolo claro), botão de salvar em
  petróleo; acesso pelo cabeçalho do PWA (avatar ao lado do "Sair") — **não** como 6º item da barra inferior,
  que já tem 5. No admin, "Alterar senha" no menu do usuário do cabeçalho, em `Dialog`.
- **Aceite:** PATCH com nome válido reflete no cabeçalho sem relogar; CPF inválido → 400 por campo; CPF de outro
  → 409; troca de senha invalida o token antigo (request com o token velho → 401) e a tela segue logada com o
  novo; conta só-Google vê "Definir senha" sem campo "senha atual".

### L1.3 — "Esqueci minha senha" / redefinição por e-mail ✅ confirmado (não existe nada)

- **Prova:** grep `forgot|reset-password|esqueci|redefin` em `backend/src` e `frontend/src` = nenhuma rota/tela;
  nenhum mailer em uso no código commitado.
- **Valor:** sem isso, motorista com senha esquecida perde a conta **e o saldo da carteira** — chamado de suporte
  garantido no dia 1.
- **Depende de:** **mailer da Vega (N-7)** — duro. E de **SPF/DKIM/DMARC** do domínio remetente (Vulcano +
  dono, DNS): sem isso o e-mail cai em spam e a funcionalidade "existe" mas não funciona.
- **Esforço:** Cronos **P** (só valor de enum de auditoria, ver abaixo) · Vega **M** · Lyra **M** · Íris **M** ·
  Órion **M**.
- **Desenho (sem tabela nova):** token de 32 bytes aleatórios; no Redis só o **hash**:
  `pwdreset:{sha256(token)} → { userId, emitidoEm, impressaoDaSenha }`, TTL 30 min, e
  `pwdreset:user:{userId}` apontando para o último (pedir de novo invalida o anterior). Consumo com `GETDEL`
  (uso único atômico). `impressaoDaSenha` = hash curto do `passwordHash` atual: se a senha mudou por outro
  caminho depois do pedido, o link morre.
- **O link leva o token no fragmento** — `https://<app>/redefinir-senha#t=<token>`. Fragmento não vai para o
  access log do nginx nem para o `Referer` (mesma regra que tirou o JWT da querystring do SSE).
- **Contrato (esboço):**
  - `POST /api/auth/password/forgot` `{ email }` → **sempre `202 { ok: true }`** — exista ou não a conta, ativa
    ou não (não vira oráculo de e-mails). Rate limit por IP (5/15 min, `RATE_LIMITED_AUTH`) e, silencioso, por
    e-mail (3/h: continua respondendo 202, só não envia). O envio vai para fila (BullMQ), nunca inline.
  - `POST /api/auth/password/reset` `{ token, newPassword }` → `204`. Erros: `400 VALIDATION_ERROR`
    (10–72 bytes, igual ao `/password`), `400 RESET_TOKEN_INVALID` (**um código só** para expirado/usado/
    inexistente), `429 RATE_LIMITED_AUTH`. Efeitos numa transação: `passwordHash`, `sessionsValidAfter = now()`
    (derruba todas as sessões, inclusive SSE), linha de auditoria (ator = o próprio usuário). Depois do commit:
    e-mail "sua senha foi alterada" (vale também para a troca do L1.2).
  - Depois do 204 a tela manda para `/login` com o e-mail preenchido — **sem auto-login** por link de e-mail.
- **Regras de borda:** conta vinculada ao Google recebe e-mail "sua conta entra com o Google" **sem token**
  (mantém a identidade verificada do I-7 ancorada no Google); conta inativa recebe nada; staff conforme **DL1**.
- **Schema:** a auditoria precisa de `AuditAction.PASSWORD_RESET` (hoje o enum tem `OTHER`, que funciona, mas
  esconde o evento). Valor de enum novo = migration isolada (armadilha do `ADD VALUE` já conhecida) → entra no
  **lote de migration único do Cronos** (§3).
- **Design system:** duas telas em `AuthShell` (moldura escura, mesmo padrão de Login/Cadastro, mascote
  permitido pela D3), link "Esqueci minha senha" no Login.
- **Aceite:** e-mail inexistente e existente produzem resposta byte a byte igual e tempo parecido (sem `await` do
  envio); token usado 2× → 2ª vez `RESET_TOKEN_INVALID`; token de 31 min → inválido; dois pedidos → só o último
  vale; após reset, token JWT anterior → 401; o token nunca aparece em log (teste de redact) nem na querystring;
  e-mail entregue no `smtp-server` de teste (a dependência já está em `devDependencies`).

### L1.4 — LGPD: exclusão/anonimização de conta e exportação de dados ✅ confirmado

- **Prova:** nenhuma rota `DELETE /api/me` ou export em `me.routes.ts`; `User` não tem `deletedAt`; o Órion
  listou "sem rota de apagar conta (LGPD)" no N-11.
- **Por que é anonimização e não DELETE:** `ChargingSession`, `PaymentMethod`, `PaymentIntent`, `Wallet` e
  `Debt` apontam para `User` com `onDelete: Restrict`, e `WalletEntry`/`AuditLog` são append-only por trigger.
  E o registro financeiro tem de sobreviver (obrigação legal/fiscal — base do art. 16 da LGPD). Então: a
  **pessoa** some, o **fato contábil** fica ligado a um id pseudônimo.
- **Valor:** direito do titular (art. 18: acesso, portabilidade, eliminação). Sem isso a abertura ao público
  tem passivo jurídico direto.
- **Depende de:** L1.2 (a seção mora na tela de perfil), **item L1.9** (a política de privacidade diz o que é
  retido e por quanto tempo), migration do Cronos, decisões **DL2/DL3**. Mailer: só para o e-mail de confirmação
  (dependência fraca — dá para sair sem).
- **Esforço:** Cronos **P/M** · Vega **M** · Lyra **M** · Íris **M** · Órion **M**.
- **Contrato (esboço):**
  - `GET /api/me/data-export` → `200 application/json` com `Content-Disposition: attachment;
    filename="innoflow-meus-dados-AAAAMMDD.json"`. Conteúdo: perfil (CPF inteiro, é dele), consentimentos,
    sessões com custo e decomposição, extrato da carteira, recargas Pix, cartões (bandeira/final/validade/
    titular — **nunca** token/ciphertext), tokens RFID (idTag mascarado), notificações enviadas. Síncrono (um
    motorista tem no máximo centenas de sessões). Rate limit 3/dia por usuário. Gera linha de auditoria
    `EXPORT` (regra já fixada: extração é auditada). **Gatilho para virar job assíncrono com link por e-mail:**
    resposta > 5 MB ou p95 > 3 s.
  - `POST /api/me/account/deletion` `{ confirmation: "EXCLUIR", currentPassword? , googleCredential?,
    refundPixKey? }` → `200 { status: "DELETED" | "DELETED_PENDING_REFUND" }`. Reautenticação obrigatória
    (senha, ou ID token do Google para conta só-Google). Erros: `409 ACTIVE_SESSION` (inclui
    `STOP_UNCONFIRMED`), `409 PAYMENT_IN_PROGRESS` (intent `AUTHORIZED`/`CAPTURE_PENDING`/Pix `PENDING`),
    `409 OPEN_DEBT` (conforme DL3), `409 WALLET_BALANCE_POSITIVE` (conforme DL2), `403
    INVALID_CURRENT_PASSWORD`, `401 INVALID_GOOGLE_TOKEN`.
  - Efeitos numa transação, sob `FOR UPDATE` no usuário: `name='Conta excluída'`, `email='excluido+{id}@anon.
    invalid'`, `phone/cpf/googleSub/passwordHash = NULL`, `active=false`, `deletedAt=now()`,
    `sessionsValidAfter=now()`; cartões `active=false`, `holderName=NULL` e ciphertext destruído (Cronos
    confirma se a coluna aceita NULL ou precisa de marcador); `AuthToken` → `BLOCKED`. O CardToken no cofre da
    Cielo: **não há rota de exclusão documentada [não confirmado]** — destruir o ciphertext local já o torna
    inutilizável para nós; registrar a pergunta para a Cielo.
  - Admin (se DL2 = devolver saldo): `GET /api/admin/account-deletions?status=PENDING_REFUND` e
    `POST /api/admin/account-deletions/:id/refund` `{ amountCents, proofReference, currentPassword }` →
    lança `WalletEntry TOPUP_REFUND` (o tipo **já existe** no enum e ninguém escreve hoje) e apaga a chave Pix
    guardada. ADMIN-only, step-up por senha (`exigirSenhaAtual`, mesmo do gateway), auditado.
- **O que fica e precisa estar escrito na política:** `AuditLog.actorEmail/actorName` de linhas antigas (append-
  only; sai no expurgo por idade do N-11), `WebhookEvent` (idem), sessões/extrato pseudonimizados por 5 anos.
- **Schema (Cronos):** `User.deletedAt`; tabela `AccountDeletionRequest` (`userId`, `requestedAt`,
  `balanceCentsAtRequest`, `refundPixKeyCiphertext` cifrada com a mesma `PAYMENT_SECRETS_KEY`, `refundStatus`,
  `refundedAt`, `refundedByUserId`); `AuditAction.ACCOUNT_DELETION`. Índice único parcial de e-mail já tolera o
  e-mail sintético.
- **Design system:** seção "Privacidade e dados" no fim de `/app/perfil`; exclusão em `Dialog` de 2 passos
  (mesmo padrão do ajuste de saldo), botão `danger` — **nunca lima** (lima é ação principal, não destrutiva).
- **Aceite:** depois da exclusão o login com a senha antiga falha, o Google com a mesma conta cria **conta nova**
  (não ressuscita a anonimizada), o admin vê "Conta excluída" nas sessões antigas, a conciliação do período não
  muda nem 1 centavo (teste antes/depois em `paymentsService`), o JSON exportado não contém `ciphertext`/token
  (teste de chaves proibidas), sessão ativa → 409.

### L1.5 — Admin iniciar recarga remota (UI) ✅ confirmado (API existe, tela não)

- **Prova:** `POST /api/admin/charge-points/:id/commands/remote-start` existe (`chargePoints.routes.ts:241`,
  contrato em `types/api.ts:814`) e reaproveita `iniciarSessaoRemota`; o `ChargePointCommandsMenu.tsx` só tem
  reset/unlock/change-availability/trigger-message.
- **Valor:** suporte em campo — motorista com celular sem bateria, app com problema, técnico testando o
  carregador com uma conta de serviço.
- **Risco que encontrei e precisa ir ao Órion:** a rota já aceita **OPERATOR** (escopado só pelo carregador), e
  o motorista é conta de **rede**. Hoje, um staff do operador X pode iniciar sessão no carregador do X debitando
  a carteira de **qualquer** motorista da plataforma (basta o e-mail — a busca `GET /api/admin/drivers` aceita
  e-mail para OPERATOR). Não é hipótese de ataque sofisticado: é a funcionalidade, e a tela vai torná-la fácil.
  Ver **DL4**.
- **Esforço:** Vega **P** · Lyra **M** · Íris **P** · Órion **P**.
- **Contrato (esboço, aditivo):**
  - Corpo do remote-start ganha `reason: string` (10–200, obrigatório) → vai para `actionDetail` da auditoria.
    Continua **só carteira**: cartão exigiria pré-autorização no cartão do motorista sem ele presente — é
    cobrança "cartão não presente" iniciada por staff, porta de fraude e de chargeback.
  - `GET /api/admin/commands/:correlationId` → `200 { status: "PENDING"|"ACCEPTED"|"REJECTED"|"TIMEOUT" }`. Hoje
    `commandResultCache` é chaveado pelo `userId` do motorista (`getCommandResult(id, userId)`); passa a gravar
    também `chargePointId`/`operatorId` para o admin conferir escopo (OPERATOR de outro operador → `404`).
  - Quando L1.6 existir: e-mail ao motorista "uma recarga foi iniciada na sua conta pelo suporte de <operador>".
- **Design system:** item "Iniciar recarga" no menu de comandos → `Dialog`: conector (só online e
  `AVAILABLE`/`PREPARING`, regra única de "livre"), busca do motorista (hook `useDrivers` + a mesma regra de
  busca da tela Carteiras — extrair a busca para um componente comum em vez de copiar), saldo e dívida visíveis antes de confirmar, motivo, confirmação; depois polling de 2 s até 60 s no
  status e toast com link para a sessão.
- **Aceite:** sem `reason` → 400; OPERATOR em carregador fora do escopo → 404; motorista com dívida → mensagem
  `DRIVER_HAS_OPEN_DEBT` na tela; carregador rejeita → "O carregador recusou" (não "erro"); auditoria registra
  quem, para quem, motivo e `correlationId`.

### L1.6 — Notificações ao motorista (recarga concluída, saldo baixo, falha) ✅ confirmado (não existe)

- **Prova:** nenhum envio de e-mail/push no código; o PWA só avisa enquanto está aberto (SSE).
- **Valor:** recibo fora do app, aviso de cobrança falha **antes** de o motorista descobrir na tomada que está
  bloqueado por dívida, saldo baixo antes da próxima viagem.
- **Depende de:** **mailer da Vega (N-7)** — duro; migration do Cronos (preferências + log).
- **Esforço:** Cronos **M** · Vega **M** · Lyra **P** (preferências no perfil) · Íris **M** · Órion **P**.
- **Canal no lote 1: só e-mail.** Web push fica para F7 (precisa de chave VAPID, tabela de inscrições,
  service worker, e no iOS só funciona com o PWA instalado — custo alto para o 1º lote).
- **Eventos do lote 1:** `SESSION_COMPLETED` (resumo + link do recibo), `SESSION_PAYMENT_FAILED` (captura
  falhou/virou dívida), `SESSION_CLOSED_BY_SERVER` (F5.9 encerrou sem confirmação do carregador),
  `LOW_BALANCE` (**só no cruzamento** do limiar: saldo antes ≥ L e depois < L — nunca a cada sessão),
  `TOPUP_CREDITED` (Pix creditado), `REMOTE_START_BY_SUPPORT` (L1.5), `PASSWORD_CHANGED`, `ACCOUNT_DELETED`.
- **Mecânica (a parte que não pode errar):** fila BullMQ `notificacoes` no worker; o enfileiramento acontece
  **depois do commit** nos pontos onde o fato já existe (`finalizarSessao`, liquidação/captura que gera `Debt`,
  `encerrarSessaoPeloServidor`, `creditarTopupPix`, `walletLedger` para saldo baixo, rotas de auth) e é
  **fire-and-forget com prazo**, igual ao `publish()` do SSE — falha de Redis/SMTP **nunca** derruba transação de
  dinheiro. Idempotência por `jobId = {tipo}:{entidadeId}` + linha em `NotificationLog` com unique
  `(userId, type, entityId)`: o mesmo fato nunca vira dois e-mails, nem com retry.
- **Contrato (esboço):**
  - `GET /api/me/notification-preferences` → `{ sessionReceiptEmail: boolean, lowBalanceEnabled: boolean,
    lowBalanceThresholdCents: number }`.
  - `PATCH` idem (limiar 500–50000). E-mails de segurança e de cobrança (`PASSWORD_CHANGED`,
    `SESSION_PAYMENT_FAILED`, `ACCOUNT_DELETED`) **não são desligáveis** (são contratuais/segurança — DL5).
- **Schema (Cronos):** `NotificationPreference` (1:1 com `User`, defaults no banco) e `NotificationLog`
  (`userId`, `type`, `channel`, `entityId`, `status`, `sentAt`, `providerMessageId`, sem cópia do corpo nem do
  e-mail). Retenção do log: 12 meses (entra na regra do N-11).
- **Design system do e-mail:** HTML com CSS inline e versão texto; moldura escura com logo, miolo claro, um CTA
  (lima sobre escuro, nunca lima sobre claro); sem pixel de rastreio; rodapé com identificação da empresa
  (**precisa do CNPJ do dono**, pendência antiga) e link "gerenciar notificações".
- **Aceite:** sessão encerrada → exatamente 1 e-mail no `smtp-server` de teste mesmo com o job reprocessado 3×;
  SMTP fora → sessão fecha e cobra normal, o job reentra na fila e alerta após esgotar; saldo indo de R$ 25 para
  R$ 15 com limiar R$ 20 → 1 aviso; R$ 15 → R$ 10 → nenhum aviso novo; preferência desligada → nenhum recibo, mas
  o de falha de cobrança chega.

### L1.7 — Job de partições + retenção (N-11) — **Cronos já começou**

- **Prova:** só existem os jobs `expirarTopupsPix`, `pollTopupsPix`, `varrerPreAutorizacoesCartao`,
  `vigiarSessoes` (`upsertJobScheduler`); nenhum chama `ensure_monthly_partition`. Partições existem até
  **2027-02**.
- **Por que é bloqueante com prazo:** a partir de março/2027 o `INSERT` em `MeterSample`/`OcppMessage` não tem
  partição de destino → falha → sessão sem medição, cobrança errada. É bomba-relógio, não melhoria.
- **Esforço:** Cronos **M** (em curso) · Vega **P** (registrar o job no worker, se o Cronos não fizer) · Íris
  **P** · Órion **P**.
- **Critério de aceite que eu cobraria (sem reabrir o que o Cronos já decidiu):** job diário idempotente que
  garante **3 meses à frente** para as duas tabelas; alerta (`logger.warn({ alert })`, que o N-7 já vai entregar
  a uma pessoa) se o horizonte cair abaixo de 60 dias; expurgo por **DETACH + DROP de partição** (nunca `DELETE`
  em massa) para `MeterSample`/`OcppMessage`; `AuditLog` respeitando o piso do trigger; `WebhookEvent` por idade;
  prazos por env com os defaults de **DL6**; teste que roda o job 2× seguidas sem erro e outro que simula "hoje =
  2027-01-15" e prova que 2027-02..04 existem.
- **Interação com L1.8:** partição apagada leva a curva de medição de uma sessão em disputa. Por isso o registro
  de chargeback tira um **snapshot do dossiê** na hora (L1.8) — a retenção não precisa conhecer disputa.

### L1.8 — Estorno e chargeback (fluxo manual assistido) ✅ confirmado (nada escreve estorno hoje)

- **Prova:** `PaymentIntent.amountRefundedCents` e `WalletEntry REFUND` são **lidos** por `paymentsService.ts`
  (linhas 133 e 143) mas **nenhum código escreve** nenhum dos dois. A porta tem `cancelar()` sem valor (só
  void de pré-autorização). O Órion pôs "plano para chargeback/estorno" como condição de go-live.
- **A restrição que manda no desenho:** conta Cielo **compartilhada**, sem webhook; o Parque não pode mudar. Logo:
  1. chargeback só chega pelo **portal/e-mail da Cielo** ao titular da conta (o dono) — o InnoFlow nunca vai
     "saber sozinho";
  2. **qualquer** mudança numa venda do InnoFlow (estorno pelo portal **ou** pela API) dispara a notificação da
     Cielo para a URL do **Parque**, cujo código hoje alerta "dinheiro não conciliado" para `IF-…` (N-2). Isso
     não tem conserto do nosso lado: vira **procedimento operacional** (avisar quem lê os alertas do Parque e
     ignorar `IF-`), documentado pela Alexandria.
  3. a consulta de venda da Cielo só alcança **~3 meses** (`identificadoresAdquirente.ts`), e o chargeback chega
     depois disso com frequência — por isso `Tid`/`AuthorizationCode`/`ProofOfSale` já são gravados na hora.
- **Desenho do lote 1 (sem dinheiro saindo por API nossa):**
  - **Estorno de sessão paga com carteira** → crédito interno imediato (`WalletEntry REFUND` positivo,
    `referenceType=CHARGING_SESSION`). Não envolve Cielo.
  - **Estorno de sessão paga com cartão**, duas saídas à escolha do ADMIN no caso concreto:
    (a) **crédito na carteira** do motorista (instantâneo, sem Cielo, sem alerta no Parque) — recomendado como
    padrão quando o motorista aceita;
    (b) **devolução no cartão feita no portal da Cielo** pelo dono e **registrada** no InnoFlow; um job
    reconsulta a venda (`consultar(providerPaymentId)`) e marca `CONFIRMED` quando a Cielo mostrar o estorno.
    **[não confirmado]** como a consulta reporta estorno **parcial** (status continua 2 com valor estornado?) —
    provar no sandbox antes de confiar no job; fora da janela de 3 meses, confirmação manual com comprovante.
  - **Chargeback:** (1) achar a venda pelo `Tid`/`AuthorizationCode`/`ProofOfSale`/valor/data; (2) registrar →
    bloqueia o **modo cartão** do motorista (Pix e carteira seguem, igual ao gate do I-7) e grava um **snapshot
    do dossiê** (identidade verificada sim/não, idade da conta, horários do carregador, curva de medição, tarifa,
    identificadores da adquirente, recibo); (3) desfecho `WON`/`LOST`/`ACCEPTED`; em `LOST`/`ACCEPTED`, conforme
    **DL7**, a perda é da plataforma e/ou vira `Debt` do motorista.
  - **Conciliação não muda:** estorno e chargeback continuam **informativos** (`amountRefundedCents` e `REFUND`),
    status do intent continua `CAPTURED` — decisão §4 da F5. Relatórios ganham a linha "estornos e chargebacks" e
    um "faturamento líquido" **ao lado**, nunca dentro da identidade.
  - **F7 (depois do sandbox provar):** estorno direto pela API (`estornar(paymentId, valor)` na porta,
    `PUT /1/sales/{id}/void?amount=`) com step-up. Fica fora do lote 1 porque é a primeira rota do sistema que
    **tira** dinheiro da conta (compartilhada) — ADMIN comprometido = devolução para cartões de terceiros.
- **Esforço:** Cronos **M** · Vega **M** · Lyra **M** · Íris **M** · Órion **M**.
- **Contrato (esboço):**
  - `POST /api/admin/sessions/:id/refunds` `{ amountCents, reason, destination: "WALLET" | "CARD_VIA_PORTAL",
    portalReference?, currentPassword }` → `201 { refundId, status: "CONFIRMED" | "PENDING_CONFIRMATION" }`.
    Erros: `409 AMOUNT_EXCEEDS_REFUNDABLE` (soma dos estornos > valor cobrado), `409 SESSION_NOT_BILLED`,
    `403 INVALID_CURRENT_PASSWORD`, `404`. ADMIN-only. `WALLET` → `CONFIRMED` na hora; `CARD_VIA_PORTAL` →
    `PENDING_CONFIRMATION` até o job.
  - `GET /api/admin/reports/payments?tid=…|authorizationCode=…|proofOfSale=…` (filtros novos na rota existente —
    **estender, não duplicar**).
  - `POST /api/admin/payments/:intentId/chargebacks` `{ amountCents, notifiedAt, caseReference, reasonCode?,
    responseDeadline? }` → `201 { chargebackId, dossierId }`. `PATCH /api/admin/chargebacks/:id`
    `{ outcome: "WON"|"LOST"|"ACCEPTED", debtPolicy?: "CREATE_DEBT"|"ABSORB", currentPassword }`.
  - `GET /api/admin/chargebacks/:id/dossier` → JSON (PDF fica para quando a Lyra-2 tiver o gerador da
    apresentação — reaproveitar, não criar outro).
- **Schema (Cronos):** tabela `PaymentReversal` (`kind REFUND|CHARGEBACK`, `paymentIntentId?`, `sessionId`,
  `amountCents`, `destination`, `status`, `outcome`, `caseReference`, `reason`, `dossierSnapshot JSONB`,
  `createdByUserId`, datas) — um razão de reversões, em vez de várias colunas no intent. `PaymentIntent.
  amountRefundedCents` vira soma dos `CONFIRMED` (mantém os relatórios atuais funcionando sem mudança). Flag de
  bloqueio do modo cartão por usuário (coluna ou reaproveitar o bloqueio temporário do anti-carding —
  Vega/Cronos decidem pelo que já existe). `ChargingSession.startIp/startUserAgent` gravados no
  `POST /api/me/sessions/start` (prova para o dossiê; dado pessoal com retenção igual à da sessão — entra na
  política). `AuditAction.REFUND`/`CHARGEBACK`.
- **Aceite:** estorno na carteira aumenta o saldo e o extrato mostra "Estorno da recarga de dd/mm"; estornar
  mais do que o cobrado → 409 (inclusive com duas requisições concorrentes — teste com `Promise.all`); a
  identidade de conciliação do período continua fechando antes e depois; registrar chargeback bloqueia
  `POST /api/me/sessions/start` com `paymentMode=CARD` daquele motorista e não bloqueia carteira; o dossiê
  continua disponível depois de o N-11 apagar a partição da sessão.

### L1.9 — (recomendo juntar ao lote 1) Termos de uso, política de privacidade, aceite e contato

- **Prova:** nenhuma rota/página `/termos` ou `/privacidade`; `Register.tsx` não tem aceite; `User` não tem
  `termsAcceptedAt`; PROGRESSO §"Decisões em aberto" nº 6 diz que faltam CNPJ e encarregado (DPO).
- **Por que entra aqui:** L1.4 promete ao titular o que é retido e por quanto tempo — sem política publicada a
  exclusão não tem onde se apoiar. E o Decreto 7.962/2013 (comércio eletrônico) exige identificação do
  fornecedor e canal de atendimento visíveis.
- **Esforço:** Cronos **P** · Vega **P** · Lyra **M** · Íris **P** · Órion —. **Bloqueio real: o texto e os dados
  da empresa são do dono** (Alexandria pode redigir minuta, um advogado precisa revisar).
- **Contrato (esboço):** `GET /api/public/legal` → `{ termsVersion, privacyVersion, company: { name, cnpj,
  supportEmail, supportPhone?, dpoEmail } }` (estende `/api/public/config`, se couber, em vez de rota nova);
  `POST /api/auth/register` e `/google` passam a exigir `acceptedTermsVersion` (= a vigente, senão `409
  TERMS_VERSION_OUTDATED`); `POST /api/me/consents` `{ termsVersion, privacyVersion }` para quem já tem conta
  (modal de reaceite no próximo login). Schema: `ConsentRecord` (`userId`, `kind`, `version`, `acceptedAt`, `ip`).
- **Design system:** páginas de texto longo no `Layout` público (casca clara, tipografia de leitura); links no
  `LandingFooter` e no rodapé do `AuthShell`; página `/ajuda` com contato + FAQ (a landing já tem `Faq.tsx` —
  reaproveitar o conteúdo).
- **Aceite:** cadastro sem marcar o aceite → botão desabilitado e API 400; versão antiga → 409; usuário existente
  vê o modal uma vez e o aceite fica registrado com data e versão; as páginas abrem sem login e passam no axe.

---

## 3. Lote 1 — ordem, dependências e colisões de arquivo

### 3.1 Quem depende do mailer da Vega (N-7)

| Item | Depende do mailer? | Pode sair antes? |
|---|---|---|
| L1.1 erro de rede | não | **sim, hoje** |
| L1.2 perfil + senha | não (o aviso "senha alterada" entra depois, 1 linha) | **sim** |
| L1.3 esqueci a senha | **sim, duro** (+ SPF/DKIM do domínio) | backend do token sim; envio não |
| L1.4 LGPD | fraco (só o e-mail de confirmação) | sim, após migration do Cronos |
| L1.5 remote-start admin | fraco (aviso ao motorista) | **sim** |
| L1.6 notificações | **sim, duro** | não |
| L1.7 N-11 | não (o alerta usa o canal do N-7, mas o job não) | em curso |
| L1.8 estorno/chargeback | fraco (aviso ao motorista) | sim, após migration do Cronos |
| L1.9 termos/contato | não | sim, quando o dono mandar os dados |

**Interface que peço ao mailer da Vega (o nome do arquivo é dela):** uma função `enviarEmail({ para, assunto,
texto, html, tag })` que **só** é chamada de dentro de um job BullMQ (com retry/backoff), nunca de uma rota; e um
`layoutEmail({ titulo, corpoHtml, cta? })` com a moldura de marca. Se o N-7 já nascer assim, L1.3 e L1.6 reusam
sem tocar no módulo dela.

### 3.2 Arquivos quentes (um escritor por vez)

| Arquivo | Quem está mexendo agora | Regra para o lote 1 |
|---|---|---|
| `backend/prisma/schema.prisma` + `migrations/` | Cronos (N-11) | **um único lote de migration do lote 1, pelo Cronos, depois do N-11** — `User.deletedAt`, `AccountDeletionRequest`, `NotificationPreference`, `NotificationLog`, `PaymentReversal`, `ConsentRecord`, `ChargingSession.startIp/startUserAgent`, valores de `AuditAction` (em migration separada, por causa do `ADD VALUE`) |
| `backend/src/config/env.ts` | Vega-A (SMTP), Cronos (retenção) | blocos novos no fim, commits serializados pelo Atlas |
| `backend/src/api/app.ts` | — | só linhas de `app.use` novas; quem chegar 2º faz rebase |
| `backend/src/worker/*` (registro de jobs) | Cronos (N-11), Vega-A? | idem |
| `frontend/src/types/api.ts` | — | **a Vega-B escreve as seções do lote 1 inteiras primeiro**, e só então Lyra começa |
| `frontend/src/components/ui/*` | **Lyra-1 (gateway)** | ninguém toca até a Lyra-1 commitar; telas novas usam os componentes, não os alteram |
| `frontend/src/App.tsx` | — | rotas novas (`/app/perfil`, `/esqueci-senha`, `/redefinir-senha`, `/termos`, `/privacidade`, `/ajuda`) num único commit da Lyra que pegar o primeiro |

### 3.3 Ondas

```
Onda 0 (já)        Atlas: L1.1 (authErrors.ts)            Vega-B: contrato do lote 1 em types/api.ts
                   Vega-B: L1.2 backend (meProfile.routes.ts) + L1.5 backend (reason + GET admin/commands)
                   Órion: parecer rápido sobre o risco do L1.5 (DL4)       Alexandria: minuta L1.9 + runbook N-2
                   Dono: DL1..DL7 + dados da empresa
Onda 1 (pós N-11)  Cronos: migration única do lote 1  ──►  libera L1.4, L1.6, L1.8, L1.9 no backend
Onda 2 (pós N-7)   Vega-A: L1.3 + L1.6 (dona do mailer)    Vega-B: L1.4 + L1.8 backend
Onda 3 (Lyras)     Lyra-1 (pós gateway): L1.5 UI + L1.8 UI (admin: ChargePoints, Sessoes, Pagamentos)
                   Lyra-2 (pós PDF): L1.2 + L1.4 + prefs L1.6 (/app/perfil) e L1.3 + L1.9 (Auth/Público)
Portões            Íris por item conforme fecha; Órion obrigatório em L1.3, L1.4, L1.5, L1.8 (conta, LGPD, dinheiro)
```

Sem colisão entre Lyra-1 (só `pages/Admin/*` + `components/chargePoints`) e Lyra-2 (só `pages/App/*`,
`pages/Auth/*`, `pages/Public/*`), exceto `App.tsx` e `types/api.ts`, que seguem a regra de §3.2.

---

## 4. Decisões do dono para o lote 1 (com recomendação)

| # | Pergunta | Opções | Recomendo |
|---|---|---|---|
| **DL1** | Redefinição de senha por e-mail vale para quem? | (a) todos; (b) motorista e operador por e-mail, **ADMIN só pelo script** `user:set-password`; (c) só motorista | **(b)** — ADMIN controla gateway e carteiras; caixa de e-mail do ADMIN comprometida não pode virar posse da plataforma |
| **DL2** | Saldo positivo na exclusão da conta | (a) bloquear a exclusão até gastar o saldo; (b) excluir e **devolver o saldo por Pix manual** (ADMIN registra `TOPUP_REFUND`); (c) motorista renuncia ao saldo | **(b)** — (a) prende o titular a um serviço para exercer um direito; (c) é cláusula de risco sob o CDC |
| **DL3** | Dívida aberta na exclusão | (a) bloquear até quitar; (b) excluir e manter a dívida pseudonimizada | **(a)** — simples e honesto; a quitação por Pix já existe |
| **DL4** | Quem pode iniciar recarga remota pela tela, e pagando com o quê | (a) ADMIN e OPERATOR, carteira, motivo obrigatório (como a API já permite); (b) **só ADMIN no lote 1**, OPERATOR liberado quando o aviso por e-mail ao motorista (L1.6) existir; (c) qualquer staff, mas só para motorista que confirmar no app | **(b)** — hoje um staff de operador pode gastar a carteira de qualquer motorista da rede; (c) é o certo a longo prazo, mas é M a mais |
| **DL5** | Notificações: o que é opcional | (a) segurança e cobrança sempre; recibo e saldo baixo opcionais, **ligados por padrão**, limiar R$ 20; (b) tudo opt-in; (c) e-mail + web push já no lote 1 | **(a)** |
| **DL6** | Retenção (confirmar o que o Cronos pôs como padrão) | medições e log OCPP: 6 / **12** / 24 meses; auditoria: **5 anos**; avisos de webhook: **180 dias** | **12 meses** para `MeterSample`/`OcppMessage` (cobre a janela de chargeback e de reclamação com folga; o dossiê guarda o resto) |
| **DL7** | Chargeback perdido: quem absorve | (a) **plataforma absorve; motorista perde o modo cartão**; ADMIN pode, caso a caso, gerar dívida; (b) sempre vira dívida do motorista; (c) só registra | **(a)** — dívida automática em fraude de cartão roubado cobra a vítima errada |
| **DL8** | Estorno no cartão no lote 1 | (a) **pelo portal da Cielo + registro assistido**; (b) pela API do InnoFlow já | **(a)** — primeira saída de dinheiro por API numa conta compartilhada merece sandbox provado e step-up revisado pelo Órion |
| — | Dados da empresa para termos/rodapé/e-mail | CNPJ, razão social, e-mail de suporte, encarregado (DPO) | pendente desde 19/09; **bloqueia L1.9** e o rodapé dos e-mails |

---

## 5. Restante do levantamento (conferido no código)

Legenda: **ESSENCIAL** = bloqueia abrir ao público · **IMPORTANTE** = falta logo depois / dor operacional real ·
**DESEJÁVEL** = ganho, sem dor hoje. Itens do lote 1 omitidos.

| Funcionalidade | Estado hoje (prova) | Classe | Por quê |
|---|---|---|---|
| Canal de suporte/ajuda no PWA | FALTA — nenhuma rota `/ajuda`; FAQ só na landing | **ESSENCIAL** (vai junto do L1.9) | CDC/Decreto 7.962: canal visível; motorista travado na tomada precisa de um botão |
| Gestão de motoristas no admin: bloquear/desativar, ver sessões do motorista | PARCIAL — `drivers.routes.ts` só lista e mostra carteira; `User.active` sem rota | **IMPORTANTE** | resposta a fraude/carding (N-6) hoje exige SQL |
| Gestão de operadores e equipe (CRUD de `Operator`, criar/convidar/desativar staff) | FALTA — `operators.routes.ts` só tem `GET`; staff só nasce por seed | **IMPORTANTE** (ESSENCIAL no dia do 2º operador) | onboarding de empresa nova exige acesso ao banco |
| Verificação de e-mail no cadastro por senha | FALTA — sem `emailVerifiedAt` | **IMPORTANTE** | e-mail errado = recibo e redefinição para o vazio; base de "trocar e-mail" |
| Diagnóstico do carregador: log OCPP por carregador | FALTA — nenhuma rota lê `OcppMessage` | **IMPORTANTE** | suporte e disputa de kWh hoje só pelo banco |
| `GetConfiguration`/`ChangeConfiguration` | FALTA — só existem 5 comandos; o guia de comissionamento manda configurar no próprio equipamento | **IMPORTANTE** | `MeterValueSampleInterval`/`HeartbeatInterval` remotos; o F5.9 depende do intervalo de amostragem |
| `UpdateFirmware`/`GetDiagnostics` | FALTA (só como alvo de `TriggerMessage`, sem handler das notificações) | DESEJÁVEL | exige servidor de arquivos; o fabricante costuma fazer |
| Alertas por operador (carregador offline, falha) | PARCIAL — N-7 entrega alertas da **plataforma** ao dono | **IMPORTANTE** quando houver 2º operador | o operador X precisa saber do carregador dele, não o dono |
| "Reportar problema" no carregador (PWA → operador) | FALTA | **IMPORTANTE** | o motorista é quem vê o cabo quebrado primeiro; custo P |
| 2FA (TOTP) para ADMIN/staff | FALTA | **IMPORTANTE** | ADMIN controla gateway, carteiras e auditoria; step-up por senha é a única barreira |
| Recibo em PDF / por e-mail | PARCIAL — recibo existe na tela; e-mail vem com L1.6 | IMPORTANTE (PDF: DESEJÁVEL) | reembolso de despesa de empresa pede comprovante |
| NFS-e/fatura | FALTA — **adiado pelo dono** | decisão do dono, revisitar antes da F8 | tributação da recarga precisa de contador; abrir sem isso é risco fiscal, não técnico |
| Histórico do motorista com filtro de período e CSV | PARCIAL — `/api/me/sessions` só pagina | DESEJÁVEL | |
| Horário de funcionamento do site no mapa | PARCIAL — `Site.openingHours` existe no schema, nenhuma tela lê/escreve | IMPORTANTE (barato) | "livre agora" num posto fechado é mentira útil |
| Filtros do mapa (conector, potência, livre agora) | FALTA — `lib/stations.ts` só filtra por texto | DESEJÁVEL (IMPORTANTE com > ~20 sites) | com poucos sites a lista inteira cabe na tela |
| Favoritos | FALTA | DESEJÁVEL | |
| Avaliação de eletroposto | FALTA | DESEJÁVEL | moderação custa mais que o ganho no começo |
| Reserva de conector (`ReserveNow`) | FALTA | DESEJÁVEL | depende de suporte do firmware e de regra de cobrança de no-show; a UI já promete só "livre agora" |
| Cupons/promoções | FALTA | DESEJÁVEL | mexe na identidade de conciliação (desconto ≠ estorno); precisa de desenho próprio |
| Sessão de serviço sem cobrança (técnico) | FALTA | DESEJÁVEL | hoje resolve-se com RFID de teste + tarifa zero |
| Acerto plataforma × operador (relatório de repasse) | PARCIAL — faturamento filtra por operador | IMPORTANTE no 2º operador | "acerto por fora" precisa de número oficial |
| Multi-idioma | FALTA | DESEJÁVEL | B2C Brasil |
| Modo offline com dados | INTENCIONALMENTE AUSENTE (`NetworkOnly` em `/api/**`) | não fazer | saldo em cache é bug financeiro; só um aviso "você está offline" (DESEJÁVEL, P) |
| Instalação do PWA | EXISTE (`InstallPromptCard`, coach iOS) | — | |
| CSV de relatórios | EXISTE | — | PDF de relatório: DESEJÁVEL |
| Web push | FALTA | IMPORTANTE (F7) | sessão terminando com o motorista no shopping |

---

## 6. Fases seguintes

### F7 — operação e confiança (depois do lote 1)

| Item | Valor | Esforço C/V/L/Í/Ó | Depende | Contrato (esboço) | Aceite |
|---|---|---|---|---|---|
| **Gestão de motoristas** | resposta a fraude | –/P/M/P/P | — | `PATCH /api/admin/drivers/:id` `{ active, reason, currentPassword }` (ADMIN); `GET /api/admin/drivers/:id/sessions` | desativar derruba sessão de login e SSE (já existe `sessionsValidAfter`); sessão de recarga ativa não é cortada |
| **Operadores e equipe** | onboarding sem banco | P/M/M/M/M | L1.3 (o convite é um link do mesmo tipo do reset) | `POST/PATCH /api/admin/operators`; `POST /api/admin/staff` `{ operatorId, name, email, role }` → e-mail de convite (token de uso único, 72 h); `PATCH /api/admin/staff/:id` `{ active }` | OPERATOR não cria staff de outro operador; convite expirado → `RESET_TOKEN_INVALID` |
| **Verificação de e-mail + trocar e-mail** | entregabilidade | P/M/P/P/P | L1.3 | `POST /api/me/email/verify-request`, `POST /api/auth/email/verify` `{ token }` | conta sem verificação recebe aviso; troca de e-mail só vale após clicar no novo |
| **Diagnóstico do carregador** | suporte em campo | P/M/M/P/P | — | `GET /api/admin/charge-points/:id/ocpp-messages?from&to&action` (paginado, partição-aware); `POST .../commands/get-configuration`, `.../change-configuration` `{ key, value }` | resposta da configuração aparece na tela (usa o mesmo cache de resultado do L1.5); `basicAuthSecret` e `idTag` mascarados na listagem |
| **Reportar problema** | qualidade da rede | P/P/M/P/– | L1.6 (avisar o operador) | `POST /api/me/charge-points/:ocppIdentity/issues` `{ connectorId?, category, note }` | rate limit por usuário; aparece no admin do operador dono do carregador |
| **2FA ADMIN** | conta mais valiosa | P/M/M/M/M | — | `POST /api/auth/2fa/setup`, `/verify`, login em 2 passos | ADMIN sem 2FA não acessa gateway (configurável) |
| **Web push** | aviso fora do app | P/M/M/M/P | L1.6 | `POST/DELETE /api/me/push-subscriptions` | mesmo dedupe do `NotificationLog`, canal `PUSH` |
| **Estorno via API** | 1 clique | –/M/P/M/M | L1.8 + sandbox | estende `POST .../refunds` com `destination: "CARD"` | valor ≤ reembolsável sob lock; step-up; alerta a cada uso |
| **Horário de funcionamento** | mapa honesto | –/P/M/P/– | — | já cabe em `PATCH /api/admin/sites/:id` e `GET /api/sites` (estender) | site fechado aparece "Fechado agora", não "livre" |

### F8 — crescimento (sob demanda)

Filtros do mapa e favoritos (juntos: `GET /api/sites?connectorType=&minPowerKw=` + `/api/me/favorites`),
histórico com filtro/CSV do motorista, recibo PDF (reusar o gerador da apresentação), relatório de repasse por
operador, alertas por operador, sessão de serviço. **Cupons, reservas, avaliação e multi-idioma ficam fora** até
existir demanda medida — cada um tem custo escondido (conciliação, firmware, moderação, tradução contínua).

---

## 7. Riscos transversais

1. **E-mail é infraestrutura nova de produção.** Sem SPF/DKIM/DMARC, L1.3 e L1.6 "funcionam" em teste e falham
   para o motorista. Vulcano + dono resolvem no DNS **antes** de anunciar a redefinição.
2. **Enfileirar notificação dentro do caminho do dinheiro** é o lugar onde um erro bobo derruba cobrança. Regra:
   depois do commit, com prazo, com `catch` — exatamente como o `publish()` do SSE.
3. **Anonimização × append-only.** `AuditLog` e `WalletEntry` não aceitam UPDATE; a política de privacidade
   precisa dizer o que fica e por quê. Prometer "apagamos tudo" seria falso.
4. **Conta Cielo compartilhada.** Todo estorno gera alerta falso no Parque (N-2) enquanto o Parque não for
   alterado. Isso é procedimento, não código — e precisa estar escrito antes do primeiro estorno real.
5. **Remote-start por staff** (DL4) é hoje uma permissão mais larga do que o produto pretende.
6. **Prazo duro do N-11:** março de 2027.

---

## 8. Primeiro lote recomendado — começar já

1. **Atlas, hoje:** L1.1 (`frontend/src/lib/authErrors.ts` + teste). 1 arquivo, zero colisão.
2. **Vega-B, já:** escrever em `types/api.ts` os contratos do lote 1 inteiro (§2) e implementar o backend de
   **L1.2** (`/api/me/profile`) e **L1.5** (`reason` + `GET /api/admin/commands/:correlationId`). Nenhum dos dois
   precisa de migration, mailer ou `components/ui`.
3. **Órion, já (curto):** parecer sobre a permissão atual do remote-start para OPERATOR (DL4) — se ele concordar,
   a restrição a ADMIN entra no mesmo commit da Vega-B.
4. **Alexandria, já:** minuta de termos/política (L1.9) com lacunas marcadas para os dados do dono, e o runbook
   "estorno/chargeback com conta compartilhada" (inclui o aviso do N-2).
5. **Dono:** responder DL1–DL8 e mandar CNPJ/razão social/e-mail de suporte/encarregado.
6. **Assim que o Cronos fechar o N-11:** migration única do lote 1. **Assim que a Vega-A fechar o N-7:** L1.3 e
   L1.6. **Assim que as Lyras liberarem:** telas, na divisão da §3.3.
