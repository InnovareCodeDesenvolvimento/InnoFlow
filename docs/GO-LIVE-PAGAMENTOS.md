# Go-Live Pagamentos — Guia Operacional para o Dono

**Data:** 2026-10-02  
**Status:** Sandbox liberado com restrições; Produção com dinheiro real BLOQUEADA até pré-condições  
**Audiência:** Gestor de produto/operações (não-programador), com acesso ao painel admin e conta Cielo

---

## 1. Em que pé estamos — o que foi testado no Parque das Feiras e o que ainda não foi

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

### Testado no Parque das Feiras (pronto para o InnoFlow)
- ✅ **Hosts e credencial** — [PROD] (cobrança real em 19/09/2026) `https://apisandbox.cieloecommerce.cielo.com.br` (sandbox) e `https://api.cieloecommerce.cielo.com.br` (produção); MerchantId em cabeçalho, MerchantKey de 40 caracteres
- ✅ **OAuth do Silent Order Post (passo 1)** — [PROD] + [DOC] `https://authsandbox.braspag.com.br/oauth2/token` (sandbox) e `https://auth.braspag.com.br/oauth2/token` (produção); `Authorization: Basic base64(ClientId:ClientSecret)`, corpo `grant_type=client_credentials`
- ✅ **Script do SOP** — [PROD] (testado em produção) sandbox: `https://transactionsandbox.pagador.com.br/post/scripts/silentorderpost-1.0.min.js`; produção: `https://transaction.cieloecommerce.cielo.com.br/post/scripts/silentorderpost-1.0.min.js`
- ✅ **Nome do header do webhook** — [PROD] (02/09/2026) o Site Cielo **recusa caracteres especiais, números e espaço**; aceita só **letras** (ex.: `CieloWebhookSecret` funciona, `X-Webhook-Secret` é recusado)

### NUNCA testado contra a Cielo real (bloqueadores conhecidos)
- ❌ **Passo 2 do OAuth do SOP (AccessToken)** — [PROD] no Parque; [NÃO EXISTE] no InnoFlow (`B1 — Bloqueador C1.1`)
- ❌ **Cartão Protegido sem CVV** — [DOC] a Cielo exige `SecurityCode` por referência oficial; [NÃO CONFIRMADO] se ela aceita transação sem CVV (decide D1 do dono) (`R1 — Risco para C4`)
- ❌ **Endpoint `GET /1/card/{token}`** — [NÃO CONFIRMADO] na doc oficial; o InnoFlow precisa dele mas pode migrar para dados truncados do navegador (`R2 — Risco/C1.3`)
- ❌ **Pix em `POST /1/sales`** — [DOC] endpoint correto é `POST /1/sales` com `Payment.QrCode.Expiration`; [NÃO EXISTE no InnoFlow] que usa `POST /1/pix/` (`B3 — Bloqueador C1.5`)
- ❌ **CSP para os hosts do SOP** — [PROD] no Parque faltavam hosts Cielo na CSP, derrubou cartão em produção; [NÃO CONFIGURADO] no InnoFlow (`B4 — Bloqueador C1.2`)

---

## 2. ⚠️ Conta Cielo Compartilhada com o Parque das Feiras — O que NÃO fazer

**DECISÃO DO DONO (04/10/2026):** usar a **mesma conta (EC) Cielo do Parque das Feiras** em vez de uma dedicada ao InnoFlow.

### ❌ O que NÃO fazer — lista crítica

1. **NÃO cadastrar URL de notificação no Site Cielo para o InnoFlow.** A URL de notificação é UMA por estabelecimento (EC), e já está configurada apontando para o webhook do Parque. Alterá-la quebraria a confirmação de pedidos do Parque.

2. **NÃO preencher `CIELO_WEBHOOK_PATH_TOKEN` nem `CIELO_WEBHOOK_HEADER_SECRET` no EasyPanel.** Esses cabos servem para receber webhook — como não há webhook, deixe vazios (a rota fica com um token aleatório diferente a cada boot, inacessível).

3. **NÃO alterar o nome do header no Site Cielo.** A config lá **já está do jeito correto** para o Parque; deixe como está.

4. **Rotação de `MerchantKey` exige coordenação nos DOIS sistemas no mesmo minuto.** Se a chave vaza, mudar numa sem mudar na outra deixa um sistema fora do ar enquanto o outro segue. Planeje com o operador do Parque.

### ⚠️ Bug conhecido — N-2 da auditoria (04/10/2026)

Toda venda do InnoFlow com `MerchantOrderId = IF-…` gera um alerta falso no sistema do Parque: "dinheiro não conciliado". Motivo: o Parque reconsulta a venda pela Cielo, não acha a `Order` (porque o ID começado com "IF" não existe no banco dele) e chama uma rotina de alerta.

**Até que o Parque corrija em seu próprio repositório:** avise o operador de lá que IDs começados com "IF-" são do InnoFlow e podem ser ignorados (ou automaticamente, se ele conseguir filtrar).

---

## 2. Pré-requisitos do Dono — Conta Cielo (Compartilhada) e Decisões Abertas

### Conta Cielo (sandbox e produção — SEM webhook do InnoFlow)
| Item | Ação | Prioridade |
|---|---|---|
| **Sandbox da Cielo** | Abrir ticket de suporte Cielo com os 5 itens da tabela abaixo | 🔴 P0 |
| **Produção da Cielo** | Idem, confirmando dados da empresa (CNPJ, DPO, termos) | 🔴 P0 |
| **Política de privacidade** | Atualizar com dados da empresa (CNPJ, DPO, telefone suporte) | 🟠 P1 |
| **Domínio oficial** | Confirmado: `https://innoflow.innovarecode.com.br` | ✅ |

### 7 Perguntas para a Cielo (revistas após comparação com o Parque — respondidas em parte pelo que o Parque provou)

| # | Pergunta | Por que importa | Status |
|---|---|---|---|
| P1 | **Dá para cobrar um `CardToken` do Cartão Protegido sem `SecurityCode`?** Se sim, o que precisa: autorização comercial, `cvvRequired=false` no SOP, `InitiatedTransactionIndicator` (Card On File) e em quais bandeiras? | R1. Decide se a D1 do dono (cadastra uma vez, só toca Iniciar) funciona como desenhada | ⚠️ **Crítico antes de C4** |
| P2 | Existe endpoint para consultar um `CardToken` (bandeira, final, validade)? `GET /1/card/{token}` é suportado? | R2. O cadastro de cartão hoje depende dele; sem confirmação migra para dados truncados do navegador | C1.3 |
| P3 | Qual o **prazo para capturar** uma pré-autorização de crédito, por bandeira? | F18. Guarda o prazo de espera do hold do cartão | C4 |
| P4 | O `CardToken` expira, ou é atualizado quando o cartão é reemitido? | Cartão salvo que morre sem aviso vira recusa na próxima pré-auth | C4 |
| P5 | Qual a URL **canônica** do script do SOP: `transaction.cieloecommerce.cielo.com.br/…` (a que roda no Parque) ou `www.pagador.com.br/…` (a da doc)? | R7. O script não carrega se URL errada. Default = Parque (provado); env como reserva. Precisa de confirmação. | C1.1 |
| P6 | Um mesmo CNPJ pode ter **mais de um EC**, cada um com sua URL de notificação e seus headers? | P6. Só importa se o dono quiser reaproveitar a conta do Parque (ver §2 "Conta Cielo") | 4.3 |
| P7 | A lista de IPs confiáveis vem ligada ou desligada por padrão? | R6. Se ligada e IP de saída do EasyPanel mudar, tudo responde 403 | C2.2 |

---

## 2.1 Conta Cielo Compartilhada (DECIDIDA) — Passo a passo

**DECISÃO (04/10/2026):** usar EC do Parque. O Pix é creditado por **POLLING**, não por webhook.

**Checklist:**

### Sandbox da Cielo

1. **Credenciais sandbox:**
   - [ ] Cadastro: `MerchantId` + `MerchantKey` sandbox (dos registros do Parque ou novos do suporte Cielo)
   - [ ] Chamado ao Atendimento Cielo: "Habilitar Silent Order Post (SOP) + Cartão Protegido (tokenização) + par SOP (`ClientId`/`ClientSecret`) no sandbox"

2. **Teste de SOP e cartão protegido:**
   - [ ] Primeiro Passo: OAuth contra `https://authsandbox.braspag.com.br/oauth2/token` com o `ClientId`/`ClientSecret`
   - [ ] Segundo Passo: GET do `AccessToken` contra `https://transactionsandbox.pagador.com.br/post/api/public/v2/accesstoken` (F8, C1.1 do plano Cielo)
   - [ ] Terceiro Passo: Teste do SOP no sandbox — abrir a página isolada e usar um cartão de teste

### Produção da Cielo

1. **Credenciais de produção:**
   - [ ] `MerchantId` + `MerchantKey` produção (via Site Cielo → E-commerce → Gestão API E-commerce → Credenciais)
   - [ ] Pares de SOP de produção (`ClientId`/`ClientSecret`) — **do mesmo cadastro do `MerchantId`** (pares de cadastros diferentes dão HTTP 500)

2. **Habilitar recursos:**
   - [ ] Habilitar Silent Order Post (Site Cielo → Microsserviços → SOP)
   - [ ] Habilitar Cartão Protegido (Site Cielo → Microsserviços → Cartão Protegido)
   - [ ] Habilitar Pix (Site Cielo → Meu Cadastro → Autorizações → Pix) — escolher modo (transferência automática vs. saldo): **afeta os dois sistemas**

3. **IPs confiáveis (opcional):**
   - [ ] **Adicione** (não substitua) o IP de saída do EasyPanel à lista de IPs confiáveis (Site Cielo → E-commerce → Gestão API → Configurações)
   - [ ] IPs: serviço `api` E serviço `worker` do EasyPanel (podem ser o mesmo)
   - [ ] **Não remova o IP do Parque** — a lista é compartilhada

4. **NÃO fazer (conta compartilhada):**
   - [ ] ❌ **NÃO cadastrar URL de notificação** — a URL já existe e é do Parque. O InnoFlow credita Pix por polling
   - [ ] ❌ **NÃO alterar o header do webhook** — deixe como está (do Parque)
   - [ ] ❌ **Não mudar nada de webhook** no Site Cielo — o InnoFlow não usa

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
| `CIELO_MERCHANT_ID` | ❌ Não (banco > env) | Todos 3 | Vem da Cielo (painel/ticket) | Público (ID) | Env é reserva; tela prevalece |
| `CIELO_MERCHANT_KEY` | ❌ Não (banco > env) | Todos 3 | Ticket Cielo: secreto | 🔴 Inseguro em log (veja redact) | Nunca logar! Banco cifra com `PAYMENT_SECRETS_KEY` |
| `CIELO_SANDBOX` | ❌ Não | Todos 3 | `true` (sandbox) ou `false` (produção) | Público (flag) | Default `true` (falha segura); produção = `false` |
| `CIELO_API_BASE_URL` | ❌ Não | Todos 3 | Deixar derivar da env `CIELO_SANDBOX` | Público (URL) | Valor padrão sandbox: `https://apisandbox.cieloecommerce.cielo.com.br` |
| `CIELO_API_QUERY_BASE_URL` | ❌ Não | Todos 3 | Deixar derivar | Público (URL) | Valor padrão sandbox: `https://apiquerysandbox.cieloecommerce.cielo.com.br` |
| **Cielo — Webhook (NÃO SE APLICA À CONTA COMPARTILHADA)** |
| `CIELO_WEBHOOK_PATH_TOKEN` | ❌ Deixe vazio | Todos 3 | Deixe vazio (rota com token aleatório, inacessível) | 🟡 Não aplicável | **Conta compartilhada: sem webhook do InnoFlow.** Se houver valor, a rota fica exposta mas inútil |
| `CIELO_WEBHOOK_HEADER_SECRET` | ❌ Deixe vazio | Todos 3 | Deixe vazio | 🔴 Não aplicável | **Conta compartilhada: sem webhook do InnoFlow.** O webhook que existe na conta é o do Parque; o InnoFlow não recebe nem valida notificação |
| **Cielo — Silent Order Post (cartão salvo)** |
| `CIELO_SOP_SCRIPT_URL` | ❌ Não (C1.1: terá default) | api | Sandbox: `https://transactionsandbox.pagador.com.br/post/scripts/silentorderpost-1.0.min.js` (F9 [PROD]); Produção: `https://transaction.cieloecommerce.cielo.com.br/post/scripts/silentorderpost-1.0.min.js` | Público (URL) | **Após C1.1** terá default. **Agora:** sem ela o cadastro de cartão responde 503 |
| `CIELO_SOP_CLIENT_ID` | ❌ Não (banco > env) | api | Ticket Cielo: OAuth client ID | Público (ID) | Env é reserva; tela prevalece; para `client_credentials` |
| `CIELO_SOP_CLIENT_SECRET` | ❌ Não (banco > env) | api | Ticket Cielo: OAuth secret | 🔴 Inseguro em log | Banco cifra; a tela o exige junto com `CIELO_SOP_CLIENT_ID` |
| `CIELO_SOP_OAUTH_TOKEN_URL` | ❌ Não (C1.1: terá default) | api | Sandbox: `https://authsandbox.braspag.com.br/oauth2/token` (F7 [PROD]); Produção: `https://auth.braspag.com.br/oauth2/token` | Público (URL) | **Após C1.1** terá default; **passo 2** do OAuth vem depois (C1.1, F8 [PROD]). **Agora:** sem ele o cadastro de cartão responde 503 |
| `CIELO_TIMEOUT_MS` | ❌ Não | Todos 3 | Milissegundos | Público (número) | Default 20000 (20s) para escritas (`POST/PUT`); sem ela motorista recebe 503 |
| `CIELO_QUERY_TIMEOUT_MS` | ❌ Não | Todos 3 | Milissegundos | Público (número) | Default 8000 (8s) para consultas (`GET`); mais rápido porque não bloqueia o motorista |
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

**Checagem de dados em produção (uma vez, antes de ligar o sandbox para testadores):** contas antigas que diferem só pela caixa do e-mail (o cadastro novo não as cria, mas as de antes continuam existindo; num login com Google a escolha entre elas seria arbitrária). Peça a quem tem acesso ao banco de produção para rodar:

```sql
select lower(email), count(*) from "User" group by 1 having count(*) > 1;
```

Resultado vazio = tudo certo. Se aparecer alguma linha, avise o Atlas antes de seguir (é preciso decidir qual conta fica).

**Pré-condição:** contas de testador **CRIADAS E COM IDENTIDADE VERIFICADA** ANTES de listar no `PAYMENT_SANDBOX_TESTER_EMAILS`. Ver regra abaixo.

**Regra (F5.8, ALTO-2):** Um DRIVER cadastrado só com e-mail/senha (`POST /api/auth/register` NÃO confirma o endereço) **NUNCA** é testador, mesmo com o e-mail na lista — senão qualquer um que soubesse o e-mail de um testador usaria o sandbox de graça. Testador = e-mail na lista E identidade verificada:
- **Login com Google:** `googleSub != null` (Google entregou email_verified) ✅
- **Staff/Admin:** role != DRIVER (criado pelo admin/seed, nunca auto-registra) ✅

**Checklist:**

- [ ] **Validar credenciais de sandbox** — na tela "Admin → Gateway de pagamento":
  - [ ] Selecionar ambiente = `Sandbox`
  - [ ] Digitar `merchantId` + `merchantKey` da Cielo (sandbox)
  - [ ] Digitar `sopClientId` + `sopClientSecret` do SOP (sandbox)
  - [ ] **Deixar em branco** os campos de segredo do webhook (conta compartilhada: não há webhook do InnoFlow)
  - [ ] Clicar "Salvar" (exige senha atual do admin — step-up)
  - [ ] Confirmar que NÃO aparece o alerta vermelho "Segredos salvos ilegíveis" no topo da tela (chave de cifragem OK) e que o aviso "Ambiente SANDBOX em servidor de produção" aparece

- [ ] **Configurar lista de testadores** — env `PAYMENT_SANDBOX_TESTER_EMAILS`:
  - [ ] Garantir que as contas deles existam. Motorista (DRIVER): a conta precisa ter entrado pelo menos uma vez com **Google** no app (identidade verificada) — cadastro só com senha não vale. Staff/admin não precisa de Google. Só depois liste o e-mail.
  - [ ] Listar e-mails: `PAYMENT_SANDBOX_TESTER_EMAILS=dono@empresa.com.br,teste@empresa.com.br`
  - [ ] Reiniciar a API (env é lida apenas no boot) — lista vazia ou ausente = NINGUÉM passa (falha segura)

- [ ] **Pix no sandbox — criar QR e polling** (a Cielo NÃO tem sandbox de Pix: o pagamento no Pix nunca confirma em sandbox, mas a criação do QR e o polling funcionam). Prova de verdade do crédito só na Fase C, em produção, com R$ 10 reais. Se a criação do QR falhar, anote a mensagem do log e siga: não bloqueia o resto.
  - [ ] Login com conta de testador
  - [ ] Na PWA: ir para "Carteira → Adicionar saldo" → "Pix"
  - [ ] Gerar QR Pix (modal com QR ou copia-e-cola)
  - [ ] **Como funciona o crédito (sem webhook):** o sistema consulta a Cielo a cada 15 segundos (varredor `poll-topups-pix`) perguntando se o Pix foi pago. A consulta tem backoff: primeiros 60 segundos varre a cada 15s, até 5 minutos a cada 30s, até 30 minutos a cada 60s, depois a cada 120s. O QR vale 30 minutos (padrão)

- [ ] **Testar cadastro de cartão** (cada testador — só se identidade verificada, ver regra acima):
  - [ ] PWA → "Meus cartões"
  - [ ] "Adicionar cartão" — abre página isolada com campo de cartão da Cielo (SOP)
  - [ ] Usar o cartão de teste que a documentação de sandbox da Cielo indicar (nunca um cartão real)
  - [ ] Confirmar cadastro
  - [ ] **Observar:** cartão aparece na lista "Meus cartões" (últimos 4 dígitos)

- [ ] **Testar recarga com cartão salvo** (cada testador):
  - [ ] Escanear QR de carregador pelo PWA (ou usar URL da landing pós-QR)
  - [ ] Em "Forma de pagamento", escolher o cartão salvo (o padrão já vem marcado)
  - [ ] Iniciar recarga e parar → no recibo o status vai de "Cobrança em processamento" para "Cobrado"
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

- [ ] **F5.9 (Watchdog de sessão travada):** ✅ Deploy completado e testado
  - [ ] Migrations rodadas (3 novas, aplicadas no boot)
  - [ ] API e gateway OCPP atualizados (entendem `STOP_UNCONFIRMED`)
  - [ ] Worker rodando com `SESSION_WATCHDOG_ENABLED=true`
  - [ ] Alertas novos monitorados (procure por `alert:` dos tipos `session_*`, `card_session_hold_deadline`, `ocpp_foreign_transaction`)
  - **Por quê:** sem o watchdog, sessão com cartão que o carregador não confirma fica aberta para sempre — pré-autorização prisioneira por 48 h, saldo comprometido congelado, motorista não consegue sair

- [ ] **Porta 9000 do OCPP:** ✅ Responder: crua `ws://` ou WSS (`wss://`)? 
  - [ ] Se crua: fechar a porta 9000 direta do mundo; carregadores vêm do seu lado (firewall/IP whitelist)
  - [ ] Se WSS: certificado TLS instalado e carregadores falam `wss://...`
  - [ ] **CRÍTICO:** Basic Auth do carregador agora protege medições que viram cobrança de cartão real

- [ ] **Deploy do backend novo:** código pronto (está em `main` do GitHub)
  - [ ] Confirmar branch `main` está sincronizado com EasyPanel
  - [ ] Redeploy dos 3 apps: `api`, `ocpp-gateway`, `worker`
  - [ ] Confirmar que as migrations rodaram: o container sobe sem erro e, depois do primeiro salvar na tela do gateway, ela mostra "Configuração salva nesta tela" com a data da alteração
  - [ ] **Verificar o Redis do throttle está saudável** (F5.8): se cair, o step-up do PUT do gateway responde 503 `STEPUP_UNAVAILABLE` (fail-closed — admin legítimo também não consegue alterar). Alerta `payment_gateway_stepup_unavailable`

- [ ] **Hosts da Cielo (produção):** confirmar com Cielo
  - [ ] `https://api.cieloecommerce.cielo.com.br` (não sandbox)
  - [ ] `https://apiquery.cieloecommerce.cielo.com.br` (não sandbox)
  - [ ] ⚠️ Não testados; usar com cautela e monitorar erros

- [ ] **Credenciais de produção da Cielo:** em mãos
  - [ ] `merchantId` de produção (GUID de 36 caracteres)
  - [ ] `merchantKey` de produção (40 caracteres) — [DOC] (F5, referência Pix Cielo2)
  - [ ] `sopClientId` + `sopClientSecret` de produção (do mesmo cadastro que o `merchantId`)

- [ ] **Cartões e pagamentos de sandbox** (nada manual a fazer):
  - [ ] Cartões salvos e pagamentos criados em sandbox ficam marcados SANDBOX no banco: ao virar para produção eles somem da lista do motorista e não podem ser usados
  - [ ] A virada para produção é BLOQUEADA enquanto houver pagamentos em andamento (criações paralelas — F5.8, M4c). **409 `GATEWAY_HAS_INFLIGHT_PAYMENTS`** com a contagem de intents: aguarde liquidarem
  - [ ] **Cartão escolhido antes da mudança de ambiente:** se o motorista escolheu um cartão salvo em sandbox e a troca para produção ocorreu depois, a pré-autorização recebe **503 `PAYMENT_GATEWAY_UNAVAILABLE`** (o cartão não existe no novo ambiente)
  - [ ] Os motoristas precisarão cadastrar o cartão real de novo (em "Meus cartões")

- [ ] **Segredos de pagamento gerados:**
  - [ ] `PAYMENT_SECRETS_KEY`: `openssl rand -base64 32` (novo, guarde em 2 lugares)
  - [ ] `PAYMENT_SECRETS_KEY_PREVIOUS`: deixe vazio (só pra rotação depois)
  - [ ] Backup da chave nova em 2 lugares (co-founder tem uma cópia, DPO tem outra)

- [ ] **Varredores aguardando:**
  - [ ] Job `varrerPreAutorizacoesCartaoJob` ativo (cancela pré-auth abandonadas)
  - [ ] Rede de segurança das capturas (re-enfileira capturas travadas): roda dentro do mesmo job periódico de pré-autorizações
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

**Regra:** começar com **valores MÍNIMOS** (Pix R$ 10 = mínimo da recarga; no cartão a pré-autorização sai do piso de `RESERVA_PISO_CENTS`, hoje R$ 50).

**Como baixar temporariamente os pisos (se necessário, para testes):**

| Limite | Env | Padrão | Observação |
|---|---|---|---|
| Saldo mínimo pra iniciar sessão | `WALLET_MIN_START_BALANCE_CENTS` | 2000 (R$ 20) | Motorista precisa ter em carteira antes de iniciar; trocar exige redeploy |
| Piso da pré-autorização (cartão) | `RESERVA_PISO_CENTS` (App api) | 5000 (R$ 50) | Baixe temporariamente (ex.: 1000 = R$ 10) para testar com valor pequeno; o teto é `RESERVA_TETO_CENTS` (40000 = R$ 400). Depois devolva ao padrão |
| Valor do Pix | (sem variável) | R$ 10 a R$ 500 | Limites fixos no código; o motorista escolhe o valor dentro deles |

**Testes:**

- [ ] **Pix de R$ 10** (valor mínimo):
  - [ ] Gerar novo QR na PWA (cada QR de 30 min é único)
  - [ ] Motorista paga via Pix real no seu app de banco
  - [ ] **Sistema detecta crédito via polling:** procure nos logs por `poll-topups-pix` e `[pollTopupsPix] Pix creditados por polling`. O varredor rodando a cada 15 segundos pergunta à Cielo se o Pix foi pago.
  - [ ] Crédito aparece na carteira do motorista (em tempo real pela primeira consulta, em até 15 segundos caso o varredor se atrase)
  - [ ] **Reconciliar:** o Pix credita a carteira (não é faturamento de sessão); confira o extrato da carteira do motorista em Admin → Carteiras

- [ ] **Cartão de R$ 50+** (piso de pré-auth):
  - [ ] Iniciar sessão com cartão salvo
  - [ ] Conferir no log que pré-autorização foi criada (`paymentIntent.status = AUTHORIZED`)
  - [ ] Parar recarga → captura parcial é enfileirada
  - [ ] Captura executada: o varredor de pré-autorizações roda em segundo plano (sem webhook do InnoFlow); conferir nos logs a captura e o `paymentIntent.status`
  - [ ] **Conferir recibo:** valor cobrado bate com o calculado (energia + mínimo tarifa)
  - [ ] **Reconciliar:** Admin → Financeiro (conciliação): a diferença entre faturamento e o que foi contabilizado (cartão capturado + captura pendente + carteira + dívida quitada + dívida aberta) deve ser ZERO

- [ ] **Extrato Cielo:**
  - [ ] Logar na conta de produção da Cielo (portal deles)
  - [ ] Verificar que Pix + cartão aparecem listados no extrato (nomes das operações, IDs)
  - [ ] Valores coincidem com o que o sistema relata

---

## 5. Rotações de Segredos — Pós-Deploy

### Conta Compartilhada — Segredo de Webhook (NÃO APLICÁVEL)

**Conta compartilhada: não há webhook do InnoFlow, portanto não há segredo de webhook para rotar.**

Se precisar rotar a `MerchantKey` por suspeita de vazamento, coordene com o operador do Parque (ver próxima seção).

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
   - Confirmar nos logs que não há `alert: payment_secrets_key_previous_invalid` nem `alert: payment_gateway_secrets_undecryptable`

4. **Recifrar** (terminal, no serviço `api`, F5.8):
   ```bash
   npm run payments:recifrar-segredos          # dry-run (não altera nada)
   npm run payments:recifrar-segredos -- --apply  # aplica (idempotente) — o "--" é obrigatório, senão o npm engole o --apply
   ```
   - Saída `0` = sucesso
   - Saída `1` = há segredos ilegíveis (chave anterior inválida OU corpo corrompido com o kid certo — o script DECIFRA antes de contar "já na atual", detectando corrupção)
   - Saída `2` = erro (chave ausente, argumento errado)
   - **ATENÇÃO:** valores ilegíveis **nunca são apagados** — a rotação só pode ser dada como concluída com `ilegíveis = 0`

5. **Remover chave antiga** (após confirmação):
   - Deletar `PAYMENT_SECRETS_KEY_PREVIOUS` do EasyPanel
   - Redeploy
   - Só então descartar a chave antiga do cofre (mantém-se 2 backups da nova)

**Resultado:** cartões salvos antigos seguem funcionando; novos já usam chave nova.

### Rotação de `MerchantKey` / `SOP Secret` (Cielo) — Coordenação Obrigatória

**Quando:** após qualquer suspeita de vazamento ou rotina anual.

**⚠️ IMPORTANTE — Conta compartilhada:** A `MerchantKey` é compartilhada com o Parque das Feiras. **Rotacionar num sistema SEM rotacionar no outro no mesmo minuto deixa um dos dois fora do ar.**

**Processo (coordenado com o operador do Parque):**

1. **Avise o Parque:** avise que vai rotacionar a chave, estipule horário sincronizado (mesmo minuto)
2. **Gerar novos valores** (via painel Cielo):
   - Abrir painel Cielo → E-commerce → Gestão API → Credenciais
   - Gerar nova `MerchantKey` (você escolhe por quanto tempo a antiga continua valendo: já, +1h, +24h ou +3 dias)
   - Fazer o mesmo com `ClientSecret` do SOP (Braspag)
3. **Simultaneamente em InnoFlow E Parque:**
   - Tela "Admin → Gateway de pagamento" (InnoFlow):
     - Deixar `merchantId` igual, trocar `merchantKey`
     - Deixar `sopClientId` igual, trocar `sopClientSecret`
     - Clicar "Salvar" (step-up + senha)
   - Painel da Cielo (Parque): atualizar com os mesmos valores
4. **Banco cifra** com `PAYMENT_SECRETS_KEY` (não precisa `recifrar`, é novo)
5. **Confirmar com o Parque:** após 1 minuto, ambos devem conseguir fazer uma transação de teste

---

## 6. Alertas de Log — O que Monitorar

**Procure por `alert:` nos logs do EasyPanel.** Cada um significa algo específico; alguns são críticos.

### Alertas de Sessão Travada (F5.9) que impactam pagamentos

F5.9 (watchdog) só interfere **quando cartão está envolvido** — Pix é independente. Sessões que ficam STOP_UNCONFIRMED podem impactar:
- **Pré-autorização (CARD):** fica congelada em AUTHORIZED até a sessão ser confirmada pelo servidor ou o carregador enviar StopTransaction
- **Saldo comprometido (WALLET com D7):** outro início desconta o `provisionalCostCents` como reserva — se essa estimativa for errada, o saldo real fica diferente

| Alerta F5.9 | Severidade | Impacto em pagamentos | O que fazer |
|---|---|---|---|
| `session_stop_unconfirmed` | ⚠️ | Nenhum direto; pré-auth fica AUTHORIZED, não vai para CAPTURE_PENDING ainda | Monitor frequência — muitas pode indicar carregador com reconexão instável |
| `session_cost_calculation_failed` | 🔴 | Custo provisório desconhecido (NULL) — saldo comprometido pode estar errado | Investigar timezones, timestamp de amostra; se persistir, escalate |
| `session_closed_without_meter_reading` | 🔴 | **Com `MIN_FEE`**: energia cobrada por `MIN_FEE`; com `NO_CHARGE`: 0 (revisão manual) | **Importante:** confirmar que D2 (`SESSION_NO_READING_POLICY`) está como o dono decidiu |
| `session_revived_after_unconfirmed` | 🔴 | Sessão reanimou (carregador entregou mais) → novo RemoteStop → pode refazer fechamento | Raro; no pior caso, `unbilledCostCents` registra a diferença (pura auditoria, não afeta receita) |
| `card_session_hold_deadline` | 🔴 | Servidor forçou o encerramento por atingir o prazo configurado do hold do cartão, usando a melhor leitura disponível | Conferir a captura e a leitura usada; investigar por que o carregador não confirmou |

### Alertas de Pagamento (F5 — Cielo)

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
| `payment_webhook_secret_weak` | — NÃO SE APLICA | Conta compartilhada: sem webhook do InnoFlow | Não há segredo de webhook para rotar |
| `payment_webhook_secret_decrypt_failed` | — NÃO SE APLICA | Conta compartilhada: sem webhook do InnoFlow | Não há segredo de webhook para decifrar |
| `payment_gateway_stepup_unavailable` | 🔴 Crítico | Redis do throttle fora do ar (fail-closed, F5.8) | Verificar Redis; o admin não consegue alterar o gateway enquanto estiver fora |
| `payment_gateway_stepup_failed` | 🟡 Aviso | Admin digitou a senha errada no step-up | Normal; tente de novo com a senha correta |
| `payment_gateway_stepup_locked` | ⚠️ Importante | Admin está trancado no step-up (muitas falhas: 5 em 15 min) | Aguardar dobrando de 60 s até 15 min; o limite mora no Redis (se o Redis cair, o servidor recusa com 503 em vez de afrouxar: ver `payment_gateway_stepup_unavailable`) |
| `payment_capture_sweep_scan_truncated` | 🟠 Importante | Varredor atingiu teto de 2000 intents scaneados sem juntar um lote (muito com teto atingido) | Investigar capturas esgotadas travadas; pode haver pendentes acionáveis além do teto |

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
   - ✅ Varredores e jobs continuam funcionando (finalizar o que já começou)

3. **Voltar:**
   - [ ] Ligar o flag de novo na tela (mesmo passo, `enabled = true`)
   - [ ] Motoristas conseguem usar novamente

### Retroceder para Sandbox (BLOQUEADO com pagamentos vivos, F5.8, M4c)

**Cenário:** descobrir problema em produção; quer voltar para sandbox pra debugar.

**Limitação:** quando há `PaymentIntent` com `status = CAPTURE_PENDING` ou Pix `PENDING`, a tela bloqueia a mudança:
```
409 GATEWAY_HAS_INFLIGHT_PAYMENTS: {"count": 3}
```

**Por quê:** criações paralelas de intents usam lock consultivo no Postgres — ou o intent entra na contagem (e bloqueia a troca) ou espera a troca commitar. Sem isso, um Pix criado no meio da transição nasceria no ambiente antigo, vivo, depois que o efetivo já virou (pago e não creditado).

**O que fazer:**
1. Aguardar os 3 intents finalizarem (o varredor de capturas roda a cada 60 s por padrão, `CARD_PREAUTH_SCAN_INTERVAL_MS`)
2. Manualmente investigar quais estão travadas (via SQL ou logs Cielo)
3. **Só então** pode trocar ambiente para sandbox (tela deixa mudar)

**Nota:** não há "reset" de pagamentos — a transição de ambiente é bloqueada de propósito (evita confundir sandbox com produção). Se precisar testar sandbox de novo depois, usar outra instância ou nova base.

---

## 8. Chargeback / Estorno — Processo Manual (por enquanto)

**Status atual:** o InnoFlow NÃO recebe notificações da Cielo (conta compartilhada com o Parque: a URL de notificação é do Parque). Chargeback e estorno só aparecem no painel da Cielo e no webhook do Parque; nada é gravado no InnoFlow e não há processamento automático.

**Quando houver chargeback ou estorno (a Cielo avisa o webhook do Parque, não o InnoFlow):**

1. **Não chega nada ao InnoFlow.** O dono descobre pelo painel da Cielo (e, se o Parque registrar, por lá).
2. **Não há alerta automático para isso hoje:** o dono precisa olhar o painel da Cielo nos primeiros dias (conferir chargebacks e estornos de vendas com referência `IF-`)
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
   - [ ] Os 4 Apps (api, ocpp-gateway, worker, frontend) já apontam para `github.com/InnovareCodeDesenvolvimento/InnoFlow`?
   - [ ] Senão, repointer manualmente (campo "Git" de cada App)

4. **Deploy de código novo**
   - [ ] Main branch tem F5.7 (rotação, step-up, sandbox, M4)?
   - [ ] Redeploy dos 3 apps: `api`, `ocpp-gateway`, `worker`

### 🟠 **P1 — DECISÕES CRÍTICAS DO DONO — F5.9 (Watchdog)**

- [x] **D2 — Sessão sem nenhuma leitura de medidor** (carregador silencioso) — **DECIDIDO pelo dono em 04/10/2026: NÃO cobrar (`NO_CHARGE`, que é o padrão; nada a alterar no EasyPanel)**:
  - **Opção A (padrão):** `SESSION_NO_READING_POLICY=NO_CHARGE` — não cobra nada, alerta para revisão manual, motorista não é culpado
  - **Opção B:** `SESSION_NO_READING_POLICY=MIN_FEE` — cobra taxa fixa + mínimo da tarifa (comportamento antigo)
  - **Decisão (04/10/2026):** Opção A, `NO_CHARGE`
  - **Por quê:** afeta sessões onde o carregador some completamente (sem nem uma amostra); D2a = risco zero de cobrança indevida, D2b = recebe algo sempre (pode ser injusto se não houve energia)

- [x] **D7 — Motorista inicia outra recarga durante a anterior estar em confirmação** (STOP_UNCONFIRMED) — **DECIDIDO pelo dono em 04/10/2026: aceita o padrão (`true`, pode iniciar descontando o saldo comprometido; nada a alterar no EasyPanel)**:
  - **Opção A (padrão):** `SESSION_ALLOW_START_WHILE_UNCONFIRMED=true` — sim, desconta o "saldo comprometido" (custo provisório) como reserva
  - **Opção B:** `SESSION_ALLOW_START_WHILE_UNCONFIRMED=false` — bloqueia, motorista tem que esperar confirmação
  - **Decisão (04/10/2026):** Opção A, `true`
  - **Por quê:** afeta experiência do motorista; D7a = mais flexível mas depende de `provisionalCostCents` estar certo (vê M3 em auditoria se errado); D7b = conservador, motor espera

### 🟠 **P2 — Antes da tela de testes com motoristas reais**

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
