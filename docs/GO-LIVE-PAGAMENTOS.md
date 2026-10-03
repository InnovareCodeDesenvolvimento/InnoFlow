# Go-Live Pagamentos — Guia Operacional para o Dono

**Data:** 2026-10-02  
**Status:** Sandbox liberado com restrições; Produção com dinheiro real BLOQUEADA até pré-condições  
**Audiência:** Gestor de produto/operações (não-programador), com acesso ao painel admin e conta Cielo

---

## 1. Em que pé estamos — e o que NUNCA foi testado

### Entregue e validado
- ✅ **Pix real** (QR Cielo) — testado contra `FakeAdapter` (simulador), webhook tratado como dica
- ✅ **Cartão salvo** (Silent Order Post, SAQ A-EP) — tokenização, cifragem, CRUD de cartão
- ✅ **Sessão pagando com cartão** — pré-autorização + captura parcial, auto-stop por teto
- ✅ **Configuração do gateway** — tela admin "Gateway de pagamento" (banco, prioridade sobre env)
- ✅ **Autenticação de passo-a-passo (step-up)** — PUT do gateway exige senha atual
- ✅ **Sandbox restrita a testadores** — e-mail whitelist em instância pública de produção (NODE_ENV)
- ✅ **Marca de ambiente** — `PaymentIntent` e `PaymentMethod` rastreiam `environment` (sandbox ↔ produção)
- ✅ **Cifragem versionada** — `v1:<kid>:<base64>`, suporta rotação `PAYMENT_SECRETS_KEY_PREVIOUS`
- ✅ **Rede de segurança (ALTO-1)** — varredor re-enfileira capturas PENDING > 5 min com alerta
- ✅ **Detecção de coerência** — servidor recusa se ambiente ≠ URL oficial da Cielo

### NUNCA testado contra a Cielo real
- ❌ Nenhuma chamada à API real da Cielo ocorreu
- ❌ Sandbox da Cielo: credenciais ainda não confirmadas
- ❌ Hosts de produção da Cielo (`api.cieloecommerce.cielo.com.br`): públicos, não confirmados na doc oficial
- ❌ OAuth do Silent Order Post: suposição (RFC 6749 `client_credentials`), não confirmado
- ❌ Endpoint `GET /1/card/{token}`: retorno não confirmado (bandeira, final do cartão)

---

## 2. Pré-requisitos do Dono — Conta Cielo e Decisões Abertas

### Conta Cielo (sandbox e produção)
| Item | Ação | Prioridade |
|---|---|---|
| **Sandbox da Cielo** | Abrir ticket de suporte Cielo com os 5 itens da tabela abaixo | 🔴 P0 |
| **Produção da Cielo** | Idem, confirmando dados da empresa (CNPJ, DPO, termos) | 🔴 P0 |
| **Política de privacidade** | Atualizar com dados da empresa (CNPJ, DPO, telefone suporte) | 🟠 P1 |
| **Domínio oficial** | Confirmado: `https://innoflow.innovarecode.com.br` | ✅ |
| **Recibo de testes (Sandbox)** | Transferência do crédito testador para conta real (manual ou automático?) | 🟠 P1 |

### 5 Perguntas para o comercial da Cielo (NÃO podem ser respondidas pelo código)
1. **Credencial de sandbox**: qual é o `CIELO_MERCHANT_ID` e `CIELO_MERCHANT_KEY` da conta Cielo de teste? (Formato XXX-XXX-XXX-XXX)
2. **Silent Order Post**: qual é a URL de script (`CIELO_SOP_SCRIPT_URL`) e de OAuth (`CIELO_SOP_OAUTH_TOKEN_URL`) em sandbox?
3. **Silent Order Post (OAuth)**: o fluxo é mesmo `client_credentials` (sem end-user), ou precisa autenticar de outro jeito?
4. **Consulta de cartão**: o endpoint `GET /1/card/{token}` retorna `cardNumber` (final), `cardBrand` e válidade? (Testa antes de usar: pode estar em outro endpoint)
5. **Webhook**: na transição sandbox→produção, os segredos (`merchantKey`, `webhookSecret`) da Cielo mudam, ou é só o env do lado dele?

---

## 3. Variáveis de Ambiente — Tabela Completa

📌 **Regra: banco > env > default**. O que a tela "Admin → Gateway de pagamento" salvou no banco (cifrado com `PAYMENT_SECRETS_KEY`) **prevalece** sobre env. Sem dados salvos, vale a env.

### Backend — Os 3 apps (api, ocpp-gateway, worker) compartilham validação

| Variável | Obrigatória? | Onde | Como gerar | Seguro/Inseguro | Notas |
|---|---|---|---|---|---|
| `NODE_ENV` | ✅ Sim | Todos 3 | `production` em produção real | Seguro | **Nunca mude**: é a guarda contra `PAYMENT_ALLOW_FAKE_ADAPTER` |
| `PAYMENT_SECRETS_KEY` | ✅ Sim (cartão/gateway) | api, worker | `openssl rand -base64 32` (AES-256) | Seguro, 32 bytes | Ausente → cartão/gateway falham 503 |
| `PAYMENT_SECRETS_KEY_PREVIOUS` | ❌ Não (rotação) | api, worker | Chave antiga, durante rotação | Seguro, 32 bytes | OPCIONAL; remova após `npm run payments:recifrar-segredos --apply` |
| **Cielo — Sandbox** |
| `CIELO_MERCHANT_ID` | ❌ Não (banco > env) | Todos 3 | Ticket Cielo: formato XXX-XXX-XXX-XXX | Público (ID) | Env é reserva; tela prevalece |
| `CIELO_MERCHANT_KEY` | ❌ Não (banco > env) | Todos 3 | Ticket Cielo: secreto | 🔴 Inseguro em log (veja redact) | Nunca logar! Banco cifra com `PAYMENT_SECRETS_KEY` |
| `CIELO_SANDBOX` | ❌ Não | Todos 3 | `true` (sandbox) ou `false` (produção) | Público (flag) | Default `true` (falha segura); produção = `false` |
| `CIELO_API_BASE_URL` | ❌ Não | Todos 3 | Deixar derivar da env `CIELO_SANDBOX` | Público (URL) | Valor padrão sandbox: `https://apisandbox.cieloecommerce.cielo.com.br` |
| `CIELO_API_QUERY_BASE_URL` | ❌ Não | Todos 3 | Deixar derivar | Público (URL) | Valor padrão sandbox: `https://apiquerysandbox.cieloecommerce.cielo.com.br` |
| **Cielo — Webhook** |
| `CIELO_WEBHOOK_PATH_TOKEN` | ❌ Não | Todos 3 | `openssl rand -hex 24` (48 hex) | 🟡 Importante | Roteia a requisição; mínimo 8 chars (alerta se < 32) |
| `CIELO_WEBHOOK_HEADER_SECRET` | ❌ Não | Todos 3 | `openssl rand -hex 16` (32 hex) | 🔴 Inseguro em log | Tempo constante; mínimo 8 (alerta se < 32); banco cifra |
| **Cielo — Silent Order Post (cartão salvo)** |
| `CIELO_SOP_SCRIPT_URL` | ❌ Não | api | Ticket Cielo: URL do script de tokenização | Público (CDN) | Ex: `https://ecommerce.cielo.com.br/checkout/token-sop.js` (a confirmar) |
| `CIELO_SOP_CLIENT_ID` | ❌ Não | api | Ticket Cielo: OAuth client ID | Público (ID) | Env é reserva; tela prevalece; para `client_credentials` |
| `CIELO_SOP_CLIENT_SECRET` | ❌ Não | api | Ticket Cielo: OAuth secret | 🔴 Inseguro em log | Banco cifra; a tela o exige junto com `CIELO_SOP_CLIENT_ID` |
| `CIELO_SOP_OAUTH_TOKEN_URL` | ❌ Não | api | Ticket Cielo: endpoint OAuth | Público (URL) | Ex: `https://sop.sandbox.cielo.com.br/oauth/token` (a confirmar) |
| `CIELO_TIMEOUT_MS` | ❌ Não | Todos 3 | Milissegundos | Público (número) | Default 8000 (8s); motorista está esperando (HTTP síncrono) |
| **Pagamento — Guarda Fake/Produção** |
| `PAYMENT_ALLOW_FAKE_ADAPTER` | ❌ Não | Todos 3 | `false` (padrão, obrigatório) | Público (flag) | 🔴 **NUNCA `true` em produção real**; aprova qualquer cartão, não cobra |
| **Pagamento — Pix** |
| `PIX_TOPUP_EXPIRES_MINUTES` | ❌ Não | Todos 3 | Minutos | Público (número) | Default 30 min; Nova recomendou (não 24h padrão Cielo) |
| `TOPUP_PIX_MAX_PENDING_PER_USER` | ❌ Não | Todos 3 | Número de Pix em aberto | Público (número) | Default 1; evita confusão de qual QR pagar |
| `TOPUP_PIX_EXPIRY_SCAN_INTERVAL_MS` | ❌ Não | worker | Milissegundos | Público (número) | Default 60000 (60s); varredor de Pix expirados |
| **Pagamento — Cartão (sessão)** |
| `CARD_PREAUTH_SCAN_INTERVAL_MS` | ❌ Não | worker | Milissegundos | Público (número) | Default 60000; varredor de pré-auth abandonadas |
| `CARD_PREAUTH_ABANDON_MINUTES` | ❌ Não | Todos 3 | Minutos | Público (número) | Default 5; sessão longa típica → cancela pré-auth |
| `CARD_CAPTURE_RETRY_AFTER_MINUTES` | ❌ Não | Todos 3 | Minutos | Público (número) | Default 5; intervalo mínimo entre re-enfileiramentos (ALTO-1) |
| `CARD_CAPTURE_MAX_SWEEP_RETRIES` | ❌ Não | Todos 3 | Número | Público (número) | Default 100 (~8 h); ao atingir, só alerta (`payment_capture_retry_exhausted`) |
| **Carteira — Saldo mínimo e limites** |
| `WALLET_MIN_START_BALANCE_CENTS` | ❌ Não | Todos 3 | Centavos (100 = R$ 1,00) | Público (número) | Default 2000 (R$ 20,00); motorista precisa disso pra iniciar |
| `RESERVA_PISO_CENTS` | ❌ Não | Todos 3 | Centavos | Público (número) | Default 5000 (R$ 50,00); mínimo estimado (guarda de MeterValues) |
| `RESERVA_TETO_CENTS` | ❌ Não | Todos 3 | Centavos | Público (número) | Default 40000 (R$ 400,00); máximo estimado |
| **API — CORS e proxy** |
| `CORS_ALLOWED_ORIGINS` | ✅ Sim | api | Lista CSV: `https://innoflow.innovarecode.com.br` | Público (URLs) | Fail-CLOSED; sem configurar, frontend quebra 403 |
| `TRUST_PROXY_HOPS` | ❌ Não | api | Número (0–5) | Público (número) | Default 2 (edge EasyPanel + nginx frontend); hops > correto forja IP |
| `PUBLIC_API_BASE_URL` | ❌ Não | api | URL completa, ex `https://innoflow.innovarecode.com.br` | Público (URL) | OPCIONAL; sem ela, deriva do `Host` da request |
| **OCPP (gateway)** |
| `OCPP_PORT` | ❌ Não | ocpp-gateway | Porta TCP (default 9000) | Público (número) | WebSocket; carregadores conectam aqui |
| `OCPP_AUTH_RATE_LIMIT_MAX_ATTEMPTS` | ❌ Não | ocpp-gateway | Número (default 5) | Público (número) | Falhas por (identidade + IP) na janela |
| `OCPP_AUTH_IP_MAX_FAILURES` | ❌ Não | ocpp-gateway | Número (default 30) | Público (número) | Falhas globais de um IP na janela |
| `OCPP_AUTH_IP_MAX_CONCURRENT` | ❌ Não | ocpp-gateway | Número (default 100) | Público (número) | Tentativas simultâneas de um IP (frota atrás NAT) |
| `OCPP_TRUST_PROXY_HOPS` | ❌ Não | ocpp-gateway | Número (0–5, default 0) | Público (número) | 0 = porta exposta direto; > 0 = atrás de proxy (consulte log primeiro) |
| **Pagamento — Sandbox restrito (ALTO-2)** |
| `PAYMENT_SANDBOX_TESTER_EMAILS` | ❌ Não | api | CSV de e-mails (ex: `dono@emp.com,teste@emp.com`) | 🟡 Importante (dados pessoais) | Em `NODE_ENV=production` com ambiente=sandbox: APENAS esses e-mails conseguem usar |
| **Autenticação — JWT e Google** |
| `JWT_SECRET` | ✅ Sim | Todos 3 | `openssl rand -base64 48` (48 base64) | 🔴 Inseguro | Mínimo 16, recomendado ≥ 32 chars; **nunca reusar dev** |
| `JWT_EXPIRES_IN` | ❌ Não | Todos 3 | Duração, ex `12h` | Público (string) | Default 12h; trocar a chave derruba sessões abertas |
| `GOOGLE_CLIENT_ID` | ❌ Não (login Google) | api | OAuth 2.0 client ID (Google Cloud Console) | Público (ID) | Ex: `123456789.apps.googleusercontent.com`; sem ela, login Google desligado |
| **Relatórios e SSE** |
| `REPORTING_TIMEZONE` | ❌ Não | Todos 3 | IANA timezone, ex `America/Sao_Paulo` | Público (string) | Default `America/Sao_Paulo`; fuso dos relatórios quando não escopado |
| `SSE_HEARTBEAT_INTERVAL_SECONDS` | ❌ Não | api | Segundos (default 25) | Público (número) | Heartbeat `:ping` para nginx não cortar conexão |
| `SSE_MAX_STREAMS_PER_USER` | ❌ Não | api | Número (default 5) | Público (número) | Teto SSE por usuário (novo expulsa antigo, gracioso) |
| `SSE_MAX_STREAMS_PER_IP` | ❌ Não | api | Número (default 50) | Público (número) | Teto SSE por IP (novo é rejeitado, fail-closed) |
| `SSE_MAX_STREAMS_TOTAL` | ❌ Não | api | Número (default 2000) | Público (número) | Teto global de streams SSE simultâneos |
| `DASHBOARD_DIRTY_THROTTLE_MS` | ❌ Não | api | Milissegundos (default 5000) | Público (número) | Throttle do evento `dashboard.dirty` (nunca recalcula a cada evento) |
| **Auditoria** |
| `AUDIT_LOG_CHANGES_MAX_BYTES` | ❌ Não | Todos 3 | Bytes (default 8192) | Público (número) | Teto de diff gravado em `AuditLog.changes` (acima disso: `{truncated: true}`) |

### Banco de dados — Variáveis já conhecidas
```bash
DATABASE_URL=postgresql://usuario:senha@host:5432/innoelektron
REDIS_URL=redis://host:6379
```

---

## 4. Roteiro em Fases — Sandbox → Produção

### Fase A: SANDBOX — Testar com Cielo (lista de testadores)

**Pré-condição:** contas de testador CRIADAS no painel admin ANTES de listar no `PAYMENT_SANDBOX_TESTER_EMAILS`.

**Checklist:**

- [ ] **Validar credenciais de sandbox** — na tela "Admin → Gateway de pagamento":
  - [ ] Selecionar ambiente = `Sandbox`
  - [ ] Digitar `merchantId` + `merchantKey` da Cielo
  - [ ] Digitar `sopClientId` + `sopClientSecret` do SOP
  - [ ] Digitar segredos do webhook: `CIELO_WEBHOOK_PATH_TOKEN` (path) e segredo do header
  - [ ] Clicar "Salvar" (exige senha atual do admin — step-up)
  - [ ] Confirmar que a tela mostra `secretsDecryptable: true` (chave de cifragem OK)

- [ ] **Configurar lista de testadores** — env `PAYMENT_SANDBOX_TESTER_EMAILS`:
  - [ ] Criar as contas deles no painel (login/carteira vazias)
  - [ ] Listar e-mails: `PAYMENT_SANDBOX_TESTER_EMAILS=dono@empresa.com.br,teste@empresa.com.br`
  - [ ] Reiniciar a API (env é lida apenas no boot)

- [ ] **Testar Pix** (cada testador):
  - [ ] Login com conta de testador
  - [ ] Na PWA: ir para "Carteira → Adicionar saldo"
  - [ ] Gerar QR Pix (modal com QR ou copia-e-cola)
  - [ ] Pagar o QR via app Pix real (testador transfere de verdade)
  - [ ] **Observar:** na tela da PWA, o status muda de "Aguardando" para "Pago" (webhook chegou e crédito foi aplicado)
  - [ ] **Conferir:** saldo aparece na carteira após o pagamento

- [ ] **Testar cadastro de cartão** (cada testador):
  - [ ] PWA → "Meus cartões"
  - [ ] "Adicionar cartão" — abre página isolada com campo de cartão da Cielo
  - [ ] Usar cartão de teste da Cielo (números fictícios: `4111111111111111`)
  - [ ] Confirmar cadastro
  - [ ] **Observar:** cartão aparece na lista "Meus cartões" (últimos 4 dígitos)

- [ ] **Testar recarga com cartão salvo** (cada testador):
  - [ ] Escanear QR de carregador pelo PWA (ou usar URL da landing pós-QR)
  - [ ] Selecionar "Pagar com cartão salvo"
  - [ ] Iniciar recarga → status muda de "Pré-autorizado" para "Processando" → "Cobrado"
  - [ ] **Conferir recibo:** valor cobrado bate com energia consumida (pode ter mínimo da tarifa)
  - [ ] **Conferir carteira:** saldo reflete o débito (no admin, ver tabela "Carteiras")

- [ ] **Monitorar logs** — procurar por `alert:` (não devem haver alertas de erro):
  - [ ] `payment_capture_pending_stale` (captura travada): 0
  - [ ] `payment_capture_retry_exhausted` (varredor desistiu): 0
  - [ ] `payment_gateway_secrets_undecryptable` (chave perdida): 0
  - [ ] Qualquer erro de Cielo: 0

---

### Fase B: Transição para PRODUÇÃO (pré-condições Órion)

**Bloqueantes (Órion portão final, 2026-10-02):**

- [ ] **Porta 9000 do OCPP:** ✅ Responder: crua `ws://` ou WSS (`wss://`)? 
  - [ ] Se crua: fechar a porta 9000 direta do mundo; carregadores vêm do seu lado (firewall/IP whitelist)
  - [ ] Se WSS: certificado TLS instalado e carregadores falam `wss://...`
  - [ ] **CRÍTICO:** Basic Auth do carregador agora protege medições que viram cobrança de cartão real

- [ ] **Deploy do backend novo:** código pronto (está em `main` do GitHub)
  - [ ] Confirmar branch `main` está sincronizado com EasyPanel
  - [ ] Redeploy dos 3 apps: `api`, `ocpp-gateway`, `worker`
  - [ ] Confirmar migration rodou: `SELECT COUNT(*) FROM PaymentGatewayConfig;` (deve ter 1 linha após salvar tela)

- [ ] **Hosts da Cielo (produção):** confirmar com Cielo
  - [ ] `https://api.cieloecommerce.cielo.com.br` (não sandbox)
  - [ ] `https://apiquery.cieloecommerce.cielo.com.br` (não sandbox)
  - [ ] ⚠️ Não testados; usar com cautela e monitorar erros

- [ ] **Credenciais de produção da Cielo:** em mãos
  - [ ] `merchantId` de produção
  - [ ] `merchantKey` de produção (32+ chars)
  - [ ] `sopClientId` + `sopClientSecret` de produção
  - [ ] Segredos de webhook NOVOS de produção (32+ chars cada): `CIELO_WEBHOOK_PATH_TOKEN`, segredo do header

- [ ] **Cartões de sandbox desativados:**
  - [ ] Antes de mudar para produção, listar todos os cartões salvos em sandbox (dev pode tê-los feito)
  - [ ] Admin → "Meus cartões" → deletar qualquer um que comece com `4111` (teste)
  - [ ] Motoristas precisarão recadastrar com cartão real

- [ ] **Segredos de pagamento gerados:**
  - [ ] `PAYMENT_SECRETS_KEY`: `openssl rand -base64 32` (novo, guarde em 2 lugares)
  - [ ] `PAYMENT_SECRETS_KEY_PREVIOUS`: deixe vazio (só pra rotação depois)
  - [ ] Backup da chave nova em 2 lugares (co-founder tem uma cópia, DPO tem outra)

- [ ] **Varredores aguardando:**
  - [ ] Job `varrerPreAutorizacoesCartaoJob` ativo (cancela pré-auth abandonadas)
  - [ ] Job `reenfileirarCapturasPendentes` ativo (rede de segurança ALTO-1, re-enfileira capturas travadas)
  - [ ] Job `expirarTopupsPixJob` ativo (expira Pix não pagos)
  - [ ] Todos são `repeatable` (BullMQ) — não precisa liga-desliga, rodam automaticamente

- [ ] **Rotação de segredos já realizada:**
  - [ ] Alterar senhas padrão do seed (`SEED_ADMIN_PASSWORD`, `SEED_DRIVER_PASSWORD`, etc.) — nunca deixar as do repositório
  - [ ] Secreto do carregador simulado (`CP-INNOELEKTRON-001`): trocar via PATCH se ainda existir

**Condições a confirmar no painel:**

- [ ] Tela "Admin → Gateway de pagamento" mostra:
  - [ ] `environment: production` (não sandbox)
  - [ ] `secretsDecryptable: true` (chave de cifragem OK)
  - [ ] Pix habilitado: `enabled = true`
  - [ ] Cartão habilitado: `enabled = true`
  - [ ] Nenhum alerta em vermelho

---

### Fase C: Testes reais com valor mínimo — Reconciliação contra Cielo

**Regra:** começar com **valores MÍNIMOS** (PIX R$ 10, cartão R$ 50 = piso de pré-auth).

**Como baixar temporariamente os pisos (se necessário, para testes):**

| Limite | Env | Padrão | Observação |
|---|---|---|---|
| Saldo mínimo pra iniciar sessão | `WALLET_MIN_START_BALANCE_CENTS` | 2000 (R$ 20) | Motorista precisa ter em carteira antes de iniciar; trocar exige redeploy |
| Piso de pré-autorização (cartão) | (derivado de tarifa, não há env) | ~R$ 50 (varia) | Não pode ser ajustado; é mínimo da pré-auth calculado |
| Piso de Pix | (nenhum, é quanto o motorista quiser entre os limites) | — | Pode estar entre R$ 10 e R$ 500 (recomendação Nova); sem env fixa |

**Testes:**

- [ ] **Pix de R$ 10** (valor mínimo):
  - [ ] Gerar novo QR na PWA (cada QR de 30 min é único)
  - [ ] Motorista paga via Pix real
  - [ ] Webhook Cielo chega (procure por `POST /api/webhooks/cielo/...` nos logs)
  - [ ] Crédito aparece na carteira MENOS o piso mínimo da tarifa (se houver)
  - [ ] **Reconciliar:** abrir relatório "Movimentação" do admin, conferir que `faturamento = cartCapturePending + walletDebit`

- [ ] **Cartão de R$ 50+** (piso de pré-auth):
  - [ ] Iniciar sessão com cartão salvo
  - [ ] Conferir no log que pré-autorização foi criada (`paymentIntent.status = AUTHORIZED`)
  - [ ] Parar recarga → captura parcial é enfileirada
  - [ ] Webhook de captura chega (ou varredor executa em background)
  - [ ] **Conferir recibo:** valor cobrado bate com o calculado (energia + mínimo tarifa)
  - [ ] **Reconciliar:** admin → "Relatório Financeiro" → `differenceCents` deve estar em 0 (faturamento fecha)

- [ ] **Extrato Cielo:**
  - [ ] Logar na conta de produção da Cielo (portal deles)
  - [ ] Verificar que Pix + cartão aparecem listados no extrato (nomes das operações, IDs)
  - [ ] Valores coincidem com o que o sistema relata

---

## 5. Rotações de Segredos — Pós-Deploy

### Segredo do webhook VAZOU em log — Busca e rotação

**Período crítico:** entre os commits `4e66951` (Pix real) e `55e2983` (redact adicionado).

**Como verificar logs do EasyPanel:**
1. Abrir EasyPanel → App `inno-elekton-api` → aba "Logs"
2. Procurar por `x-innoelektron-webhook-secret` (o header name é literalmente este)
3. Se o valor aparecer como texto (não como `[redacted]`), o segredo vazou

**Se vazou:**
1. Gere um novo segredo no terminal:
   ```bash
   openssl rand -hex 24
   ```
2. Atualize na tela "Admin → Gateway de pagamento":
   - Campo "Segredo do webhook (header)"
   - Digitar novo valor
   - Clicar "Salvar" (step-up com senha)
3. Atualize na **conta Cielo** (painel deles):
   - Webhook settings
   - Cole o mesmo segredo no header esperado: `x-innoelektron-webhook-secret`
4. Teste: gerar novo Pix e verificar nos logs que segredo sai como `[redacted]`

### Rotação de `PAYMENT_SECRETS_KEY` (cartão + gateway)

**Quando:** anualmente, ou se suspeitar comprometimento da chave.

**Processo (ordem CRÍTICA):**

1. **Gerar chave nova:**
   ```bash
   openssl rand -base64 32
   ```
   Guarde as DUAS (antiga + nova) no cofre de senhas.

2. **Atualizar envs** (EasyPanel → app `inno-elekton-api` + `inno-elekton-worker`):
   - `PAYMENT_SECRETS_KEY` = nova chave
   - `PAYMENT_SECRETS_KEY_PREVIOUS` = chave antiga
   - Salvar (sem fazer deploy ainda)

3. **Redeploy** (EasyPanel "Deploy" ou push para GitHub):
   - Aguarde reiniciar ambos os serviços
   - Confirmar nos logs que não há `alert: payment_secrets_key_invalid`

4. **Recifrar** (terminal, no serviço `api`):
   ```bash
   npm run payments:recifrar-segredos          # dry-run (não altera nada)
   npm run payments:recifrar-segredos --apply  # aplica (idempotente)
   ```
   - Saída `0` = sucesso
   - Saída `1` = há segredos ilegíveis (chave anterior inválida — corrigir, depois reexecutar)
   - Saída `2` = erro (chave ausente, argumento errado)

5. **Remover chave antiga** (após confirmação):
   - Deletar `PAYMENT_SECRETS_KEY_PREVIOUS` do EasyPanel
   - Redeploy
   - Só então descartar a chave antiga do cofre (mantém-se 2 backups da nova)

**Resultado:** cartões salvos antigos seguem funcionando; novos já usam chave nova.

### Rotação de `MerchantKey` / `SOP Secret` (Cielo)

**Quando:** após qualquer suspeita de vazamento ou rotina anual.

**Processo:**

1. Gerar novos valores (via painel Cielo)
2. Tela "Admin → Gateway de pagamento":
   - Deixar `merchantId` igual, trocar `merchantKey`
   - Deixar `sopClientId` igual, trocar `sopClientSecret`
   - Clicar "Salvar" (step-up + senha)
3. Banco cifra com `PAYMENT_SECRETS_KEY` (não precisa `recifrar`, é novo)
4. **Atualizar o painel Cielo** (webhook settings) com os segredos novos

---

## 6. Alertas de Log — O que Monitorar

**Procure por `alert:` nos logs do EasyPanel.** Cada um significa algo específico; alguns são críticos.

| Alert | Severidade | O que significa | O que fazer |
|---|---|---|---|
| `ocpp_auth_lockout` | ⚠️ Importante | Carregador bloqueado por falhas de senha (tentativas esgotadas) | Conferir carregador/senha; PATCH para resetar `basicAuthSecret` se comprometido |
| `ocpp_auth_ip_flood` | 🔴 Crítico | IP tentando autenticar muitas vezes (possível ataque) | Checar logs pra IP de origem; firewall pode bloquear esse IP |
| `payment_secrets_key_previous_invalid` | 🟡 Aviso | `PAYMENT_SECRETS_KEY_PREVIOUS` não decifica (typo ou corruptela) | Corrigir valor no EasyPanel ou deletar se rotação completa |
| `payment_intent_environment_mismatch` | 🟡 Aviso | Intent criado em sandbox, sistema virou production (ou vice-versa) | Não é usual; procurar por race no código; rede de segurança pula o intent |
| `payment_config_changed` | 📋 Auditoria | Admin salvou mudança no gateway (traz nome dos campos, nunca valores) | Normal; confira que foi o admin esperado (`actorUserId` no log) |
| `login_account_locked` | ⚠️ Importante | Usuário trancado por falhas repetidas de login (throttle) | Tentar novamente depois de 60s dobrando até 15 min; ajustar senha se esqueceu |
| `payment_gateway_config_load_failed` | 🔴 Crítico | Falha ao carregar config do banco (Postgres fora?) | Checar Postgres + Redis; Pix/cartão respondem 503 até resolver |
| `payment_gateway_secrets_undecryptable` | 🔴 Crítico | Segredos salvos não decifram (chave perdida, trocar sem anterior) | Reenviar credenciais pela tela (exige novo login Cielo de verdade) |
| `payment_gateway_environment_url_mismatch` | 🔴 Crítico | Incoerência: sandbox com URL de produção, ou vice-versa | Env `CIELO_API_BASE_URL` contradiz `environment` (remover a env, deixar derivar) |
| `payment_gateway_config_decrypt_failed` | 🔴 Crítico | Credenciais não decifram (chave trocada sem `_PREVIOUS`?) | Reenviar credenciais; usar `PAYMENT_SECRETS_KEY_PREVIOUS` se houver |
| `payment_fake_adapter_in_production` | 🔴 **CRÍTICO** | Simulador rodando EM PRODUÇÃO (`NODE_ENV=production` + `PAYMENT_ALLOW_FAKE_ADAPTER=true`) | 🛑 **DESLIGAR IMEDIATAMENTE.** Remover `PAYMENT_ALLOW_FAKE_ADAPTER` (ou `false`) e redeploy |
| `payment_gateway_not_configured` | 🟡 Aviso | Produção sem credenciais Cielo (nem banco nem env) | Pix/cartão ficam 503; salvar credenciais pela tela |
| `payment_capture_retry_exhausted` | 🔴 Crítico | Varredor desistiu de recapturar (energia entregue, cartão não cobrado) | Investigar: Cielo fora? `PAYMENT_SECRETS_KEY` perdida? Consultar com suporte Cielo |
| `payment_capture_pending_stale` | 🟡 Aviso | Captura travada há > 1 h (ou 🔴 Crítico > 24 h) | Investigar a mesma causa de `retry_exhausted`; varredor tenta recuperar |
| `payment_webhook_secret_weak` | 🟠 Importante | Segredo do webhook < 32 caracteres (mínimo recomendado) | Gerar novo: `openssl rand -hex 16` (32 hex) e salvar na tela |
| `payment_webhook_secret_decrypt_failed` | 🔴 Crítico | Segredo do webhook não decifra (chave perdida?) | Reenviar segredo pela tela do gateway (step-up) |

**Alertas esperados (não mexer):**
- `payment_config_changed` — cada vez que salvar tela do gateway; auditoria normal

**Alertas suspeitos (investigar):**
- Nenhum `payment_*` durante 24 h em produção (pode significar ninguém está usando, ou Cielo fora)

---

## 7. Plano de Volta Atrás (Rollback)

### Desligar Pix / Cartão sem perder dados

**Cenário:** descobrir bug crítico em produção; precisa desligar meio de pagamento MAS sessões/Pix em andamento podem estar no meio do caminho.

**Processo:**

1. Tela "Admin → Gateway de pagamento":
   - [ ] Desligar "Pix habilitado" OU "Cartão habilitado" (marcar `enabled = false`)
   - [ ] Clicar "Salvar" (step-up + senha)

2. **Efeito:**
   - ✅ Novos motoristas NÃO conseguem pagar com esse meio (recebem `409 PAYMENT_METHOD_DISABLED`)
   - ✅ Carteira/Pix/cartão salvos não são deletados (apenas desabilitados)
   - ✅ Webhook / varredor / jobs continuam funcionando (finalizar o que já começou)

3. **Voltar:**
   - [ ] Ligar o flag de novo na tela (mesmo passo, `enabled = true`)
   - [ ] Motoristas conseguem usar novamente

### Retroceder para Sandbox (BLOQUEADO com pagamentos vivos)

**Cenário:** descobrir problema em produção; quer voltar para sandbox pra debugar.

**Limitação:** quando há `PaymentIntent` com `status = CAPTURE_PENDING` ou Pix `PENDING`, a tela bloqueia a mudança:
```
409 GATEWAY_HAS_INFLIGHT_PAYMENTS: {"count": 3}
```

**O que fazer:**
1. Aguardar os 3 intents finalizarem (capturas são re-enfileiradas a cada 5 min)
2. Manualmente investigar quais estão travadas (via SQL ou logs Cielo)
3. **Só então** pode trocar ambiente para sandbox (tela deixa mudar)

**Nota:** não há "reset" de pagamentos — a transição de ambiente é bloqueada de propósito (evita confundir sandbox com produção). Se precisar testar sandbox de novo depois, usar outra instância ou nova base.

---

## 8. Chargeback / Estorno — Processo Manual (por enquanto)

**Status atual:** chargeback/estorno só são **gravados** em `WebhookEvent` (tabela append-only); não há processamento automático.

**Quando a Cielo avisa (webhook `ChangeType 7 = Chargeback` ou `25 = Estorno`):**

1. **Webhook chega**, sistema grava em `WebhookEvent` com `changeType` + dados
2. **Alertar dono:** procurar por `payment_webhook_received` no log para diagnóstico
3. **Processo manual** (decidir com DPO/compliance):
   - Debitador (estorno): reembolsar para carteira do motorista
   - Chargeback: reverter tudo (carteira, session, auditoria) — operação complexa, requer investigação caso-a-caso
4. **Registrar na auditoria:** manualmente via admin, com contexto (e-mail do motorista, motivo)

**Observação:** não há tela de "Disputas" ainda — isso entra em roadmap futuro (F6+).

---

## 9. Lista de Decisões Operacionais Prioritizadas (do PROGRESSO.md)

Retirada do fim do PROGRESSO.md, compilada para ação do dono. Ordene por prioridade:

### 🔴 **P0 — Bloqueantes de go-live (não testado)**

1. **Porta 9000 do OCPP** (decide TLS)
   - [ ] Responder: crua `ws://` ou WSS?
   - [ ] Se TLS: certificado, carregadores usam `wss://`
   - [ ] Se crua: fechar ao mundo, só IP whitelist interna
   - **Por quê:** Basic Auth trafega em claro em `ws://`

2. **Credenciais de sandbox Cielo** (5 perguntas acima)
   - [ ] Abrir ticket com suporte Cielo
   - [ ] Testar contra sandbox com as credenciais reais (hoje só FakeAdapter)

3. **Repositório apontado no EasyPanel**
   - [ ] Todos 3 Apps (api, ocpp, worker, frontend) já apontam para `github.com/InnovareCodeDesenvolvimento/InnoFlow`?
   - [ ] Senão, repointer manualmente (campo "Git" de cada App)

4. **Deploy de código novo**
   - [ ] Main branch tem F5.7 (rotação, step-up, sandbox, M4)?
   - [ ] Redeploy dos 3 apps: `api`, `ocpp-gateway`, `worker`

### 🟠 **P1 — Antes da tela de testes com motoristas reais**

5. **Dados da empresa (CNPJ, DPO, etc.)**
   - [ ] Atualizados na política de privacidade do site
   - [ ] Compartilhados com Cielo (ticket de produção)

6. **Domínio oficial confirmado**
   - [ ] `https://innoflow.innovarecode.com.br` (já é)
   - [ ] QR codes de adesivos calibrados para o domínio oficial (não o antigo `.easypanel.host`)

7. **Limites de teste ajustados (se necessário)**
   - [ ] `WALLET_MIN_START_BALANCE_CENTS`: mantém R$ 20 padrão? ou reduz pra testes?
   - [ ] Depois que validar, devolver pro default

### 🟢 **P2 — Melhorias / Complements (roadmap)**

8. **Política de privacidade finalizada**
   - [ ] Inclui CNPJ, DPO, contato suporte
   - [ ] Revisada por compliance/legal

9. **Nota fiscal / tributação** (adiado; revisitar antes de F8)
   - [ ] Não fazer agora
   - [ ] Revisitar quando escalar: lojistas, movimentação financeira real, etc.

10. **UI de TariffAssignment + hook de query** (gap descoberto em F4)
    - [ ] Admin não consegue vincular tarifa a carregador novo (só pelo banco)
    - [ ] Fica para depois (roadmap posterior)

---

## Apêndice: Testes Automatizados Rodando em CI

Todas as rotas de pagamento têm testes unitários/integração no `main`:

```bash
npm run test   # Roda contra FakeAdapter (não toca Cielo real)
npm run test:integration  # Contra Postgres+Redis reais (CI)
```

**Cobertura:**
- ✅ Idempotência de Pix (Promise.all, 30 pagamentos simultâneos no mesmo Pix)
- ✅ Captura parcial + cobrança dupla (bug já corrigido)
- ✅ Erro de rede no stop (sessão não fecha, varredor recupera)
- ✅ Cifragem/decifragem de segredos
- ❌ NUNCA contra a Cielo real (sem credencial)

---

## Referências

- **Código:** `backend/src/services/pagamentos/*` (porta, adaptadores, webhook)
- **Schema:** `backend/prisma/schema.prisma` (models `PaymentIntent`, `PaymentMethod`, `PaymentGatewayConfig`, `WebhookEvent`)
- **Auditoria:** `.claude/agent-memory/orion/auditoria-2026-10-02-portao-final-f5.md`
- **F5 em detalhe:** `.claude/agent-memory/vega/innoelektron-f5-*-*.md` (F5.1–F5.7)
- **Deploy:** `docs/DEPLOY-EASYPANEL.md`
