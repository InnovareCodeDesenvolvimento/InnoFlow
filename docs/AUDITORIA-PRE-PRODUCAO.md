# Re-revisão de segurança pré-produção (Órion, 05/10/2026)

> Auditoria somente leitura sobre o HEAD `44b9a4e`. Transcrita pelo Atlas do relatório do Órion; os pontos marcados **[Atlas confirmou]** foram conferidos no código pelo Atlas. Nada foi testado contra Cielo/Braspag reais nem em produção.

## Veredito

- **(a) Sandbox Cielo: LIBERADO COM CONDIÇÕES** (C-S1 a C-S9).
- **(b) Produção com dinheiro real: BLOQUEADA** — não por vulnerabilidade de código conhecida, mas por provas que só o sandbox/produção dão e por ações do dono (C-P1 a C-P10). Cumpridas C-P1 a C-P8, passa a LIBERADO COM CONDIÇÕES.
- Todos os ALTO/MÉDIO das 3 auditorias anteriores (F5.9, pagamentos Cielo, página do cartão) estão **fechados no código**, exceto I-1 (parcial) e I-2 da página do cartão, que são decisão e não bug. Novos: 1 crítico condicional, 1 alto condicional, 6 médios, 5 baixos, 5 info.

## Provado (executado) × só lido

Provado: `vitest tests/unit` backend (67 arquivos, 1016 testes); rebuild do frontend em scratchpad (0 `.map`, sem MSW, sem `/__ds`, sem `mocktok`, bundle do cartão sem storage/axios/zustand/tanstack/cookie/sendBeacon); sonda ESLint `--stdin` na pasta do cartão (bloqueia o proibido, libera só `import type` de `@/types/**`); `npm audit` (backend prod: 2 moderate via ocpp-rpc; frontend prod: 5 high, todos build-time, não vão para a imagem nginx); varredura de 330 commits por segredos: nada.
Só lido: suítes de integração e E2E (sem Redis/Docker), CSP real atrás do nginx, qualquer chamada Cielo/Braspag/produção.

## Fechamento das auditorias anteriores

F5.9 ALTO-1/2/3 e M1–M8, Cielo I-1…I-7 (I-1 formato real da Cielo ainda não provado), S-1/2/4/5/6/7, Cartão I-3/S-3…S-9: **FECHADOS** (evidência por arquivo e teste no relatório do Órion; resumo em PROGRESSO.md).
Ainda abertos: Cartão **I-1 PARCIAL** (CSP enforce com curingas `*.pagador.com.br`/`*.cieloecommerce.cielo.com.br`; a Report-Only estreita ainda não foi observada nem promovida), Cartão **I-2** (decisão do dono), Cielo **S-3** (host das URLs `CIELO_*` override), **S-9/holderName em claro**, e o teto de 5 cartões com corrida (N-9).

## Achados novos

### CRÍTICO (condicional)
- **N-1. Senhas seed de produção nunca confirmadas como rotacionadas** (`backend/prisma/seed.ts:186-188`: admin123456 / staff123456 / driver123456; o seed antigo rodou em produção em 16–17/09). Se alguém ainda usa a senha pública do repositório, é ADMIN (dono do gateway Cielo, carteiras e auditoria). Não provado (o Órion não sondou produção). Correção: `npm run user:set-password` para cada conta seed, trocar o segredo do `CP-INNOELEKTRON-001` por PATCH e remover o site fixture `[test-partitioning]`. **Ação do dono/Vulcano.**

### ALTO (condicional)
- **N-2. Conta Cielo compartilhada: toda venda do InnoFlow gera alerta falso de "dinheiro não conciliado" no webhook do Parque** (`ParquedasFeiras/backend/src/routes/payments.ts:1469-1500`, rota `/webhook/cielo`). A notificação é por EC; o Parque reconsulta a venda, lê `MerchantOrderId = IF-<id>`, não acha `Order` e chama `alertarDinheiroNaoConciliado('pedido-nao-encontrado')`, cujo texto manda estornar no painel do gateway. Risco: operador do Parque estornar venda legítima do InnoFlow, ou ignorar alertas e perder um real. [Atlas confirmou: o código do Parque não trata `IF-`.] Correção no **repositório do Parque** (outro projeto, em produção): ignorar com 200 e log qualquer referência `IF-` antes do `findUnique`. **Requer autorização do dono para mexer no Parque.**

### MÉDIO
- **N-3. Imagens em fim de vida e containers como root** [Atlas confirmou]: `node:20-alpine` nos 3 Dockerfiles do backend e no builder do frontend, `nginx:1.25-alpine`, sem `USER`, runner copia `node_modules` com devDependencies. Correção (Vulcano): Node 22/24, `USER node`, `--omit=dev`, nginx ≥ 1.27.
- **N-4. CSP de enforce do cartão ainda com curingas** (resto do I-1). Correção: rodar T1–T3 no sandbox/produção e promover a Report-Only estreita a enforce (Lyra/Vulcano). O host do POST do cartão em sandbox nunca foi observado.
- **N-5. I-2: JWT em `localStorage` e página do cartão na mesma origem.** Recomendação abaixo.
- **N-6. Anti-carding é barreira, não garantia** (contadores em Redis, fail-open se o Redis cair; contas Google descartáveis + IPs rotativos). A taxa de recusa/chargeback recai sobre a conta Cielo compartilhada. Mitigações: antifraude na Cielo, exigir 1 recarga Pix concluída ou idade mínima de conta antes do cartão, `RESERVA_TETO_CENTS` baixo nas primeiras semanas.
- **N-7. Nenhum alerta chega a uma pessoa** — todos são `logger.warn({ alert })` no stdout do EasyPanel (`payment_void_manual_review`, `payment_capture_retry_exhausted`, `payment_authorization_stuck`, `session_cost_calculation_failed`, `payment_pix_credit_divergence`, `ocpp_auth_ip_flood`, `payment_gateway_credential_rejected`, `payment_card_testing_suspected`, `ocpp_foreign_transaction`). Correção (Vulcano): log drain filtrando `alert` para Slack/e-mail/WhatsApp + uptime check de `/health`. **Requer escolha do canal pelo dono.**
- **N-8. `GO-LIVE-PAGAMENTOS.md` contradiz a decisão do dono (conta compartilhada, sem webhook)** [Atlas confirmou: §2.1, Fase A/C e §5 ainda mandam cadastrar URL de notificação e segredo do webhook]. Um dono seguindo o checklist sobrescreveria a URL de notificação do Parque. Correção (Alexandria): reescrever para "Pix por consulta periódica; NÃO cadastrar webhook; NÃO alterar a URL do Parque; adicionar (não substituir) o IP do InnoFlow à lista de IPs confiáveis; rotacionar MerchantKey nos dois sistemas no mesmo minuto"; corrigir `CIELO_TIMEOUT_MS` (hoje 20000/8000) e o SOP "sem ela 503".

### BAIXO
- **N-9.** Teto de 5 cartões com corrida check-then-insert (`mePaymentMethods.routes.ts:105-149`); limitado por rate limit e 10 cadastros/dia.
- **N-10.** Gateway OCPP sem `maxBadMessages` nem limite de mensagens por conexão (`ocpp/server.ts:46-52`) [Atlas confirmou]; o handler coringa loga `params` crus (`ocpp/handlers/index.ts:35`).
- **N-11.** Sem job de partições (existentes vão até 2027-02) nem retenção/purga de `OcppMessage`, `MeterSample`, `AuditLog`, `WebhookEvent`; `holderName` em claro; sem rota de apagar conta (LGPD).
- **N-12.** `JWT_SECRET` < 32 caracteres só avisa (`env.ts:334`) [Atlas confirmou; o schema aceita 16]. Correção: falhar o boot em produção.
- **N-13.** S-3 (host das URLs override) e S-9/`holderName` seguem abertos.

### INFO
Criar Pix não passa pelo gate I-7 (aceitável, Pix é push); AES-GCM sem AAD; throttle de login por e-mail permite trancar conta alheia (trade-off aceito em 19/09); id_token do Google sem `nonce` (vale ~1 h se vazar); rate limits em memória só ok com 1 réplica da API.

## Respostas às perguntas do escopo

- **`POST /api/auth/google/link` / I-7:** `verifyIdToken` com audience, iss, exp e assinatura; `email_verified` estrito; recusas em ordem (conta ativa → só DRIVER → e-mail verificado → e-mail igual → sem Google já vinculado); UPDATE condicional `googleSub IS NULL` + unique (corrida dá 409); rate limit 10 falhas/15 min. Pré-sequestro: **sem caminho encontrado**. Gate `identidadeVerificada` aplicado em tokenization-session, cadastro e start CARD; padrão ligado em `NODE_ENV=production`.
- **S-9, AccessToken ~540 s no navegador: ACEITÁVEL** (só chega a motorista elegível, `no-store`, no redact do log, só tokeniza no cofre — não autoriza cobrança; residual: token roubado tokeniza cartões na conta do lojista por até 9 min).
- **Aprovação só por ReturnCode+Status; void só por desfecho CONFIRMADO; venda capturada nunca é cancelada:** confirmado. Fixtures de formato de resposta continuam inventados até o sandbox responder.
- **Webhook em conta compartilhada:** a rota segue ativa. Recomendação: **NÃO definir** `CIELO_WEBHOOK_PATH_TOKEN` nem `CIELO_WEBHOOK_HEADER_SECRET` no EasyPanel (rota inalcançável); pode ser removida depois.
- **Pix por polling:** sem caminho de duplo crédito (reconsulta + `FOR UPDATE` + índice único `ux_wallet_entry_topup_once` + auditoria na mesma transação).
- **Livros e segredos:** WalletEntry/AuditLog append-only por trigger; AES-256-GCM versionado; step-up fail-closed; lock consultivo; sandbox só para testadores com Google; FakeAdapter bloqueado em produção.
- **OCPP / F5.9:** handlers escopados por `ctx.chargePointId`; `OCPP_TRUST_PROXY_HOPS` default 0 (hops a mais deixam o cliente forjar IP); watchdog com kill-switch default false.
- **Autorização:** `/api/me/*` só por `req.user.userId`; `/api/admin/*` com `operatorScopeWhere`; Tokens/Auditoria/Gateway só-ADMIN; Zod descarta campos extras; sem regressão.
- **I-2 recomendação final:** **sandbox: aceitar**. **Produção: subdomínio dedicado** (ex.: `cartao.<domínio>`) antes de ligar dinheiro real — a página não chama a API, só recebe a sessão por `postMessage` e devolve `cardToken`/`brand`/`last4`/validade. Precisa de DNS+certificado, server block estático no nginx com a CSP existente, `targetOrigin`/`event.origin` fixos nos dois lados (`useAddCardFlow.ts`, `CardTokenizationApp.tsx`, `sopClient.ts`) e `frame-ancestors 'none'`. Residual: o script da Cielo ainda vê o PAN (inerente ao SAQ A-EP) e a CSP precisa estar estreita. Se o dono recusar: aceitar o risco registrado (o Parque opera assim).

## Condições

### Sandbox Cielo (antes de ligar testadores)
- **C-S1.** Confirmar rotação das senhas seed (N-1).
- **C-S2.** Nos 3 apps: `NODE_ENV=production`, `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET` ≥ 32.
- **C-S3.** `PAYMENT_SECRETS_KEY` em api e worker (backup em 2 lugares); `CORS_ALLOWED_ORIGINS` na api; `GOOGLE_CLIENT_ID` na api com origens JS autorizadas.
- **C-S4.** Salvar o gateway como **sandbox**; `PAYMENT_SANDBOX_TESTER_EMAILS` (contas que já entraram com Google); reiniciar a API.
- **C-S5.** NÃO definir `CIELO_WEBHOOK_PATH_TOKEN`, `CIELO_WEBHOOK_HEADER_SECRET`, `CIELO_API_BASE_URL`, `CIELO_API_QUERY_BASE_URL`, `PAYMENT_ALLOW_FAKE_ADAPTER`; `CARD_REQUIRE_VERIFIED_IDENTITY` não pode ser `false`; NÃO cadastrar URL de notificação no Site Cielo.
- **C-S6.** Ordem: (1) rebuild do frontend e subir api e ocpp-gateway (migration `20261004120000` roda no boot); (2) `SESSION_WATCHDOG_ENABLED=false` no primeiro deploy; (3) só depois ligar o watchdog e subir o worker.
- **C-S7.** Rodar T1–T8 do `AUDITORIA-PAGINA-CARTAO.md` e a "Prova no sandbox" do `AUDITORIA-PAGAMENTOS-CIELO.md`, anotando corpo real de `GET /1/sales?merchantOrderId=`, ReturnCode de pré-autorização/captura/void/GET pós-captura, host real do POST do SOP, nome do campo `CardToken`, se `GET /1/card` existe. Cada resposta nova vira teste.
- **C-S8.** Antes de testar com o Parque ao lado: corrigir N-2 no Parque ou avisar o operador de lá.
- **C-S9.** Corrigir o GO-LIVE (N-8) antes de o dono executar a Fase A.

### Produção (todas as de sandbox mais)
- **C-P1.** N-1 confirmado e N-2 corrigido.
- **C-P2.** Provas do sandbox gravadas, fixtures trocados por corpos reais; venda de baixo valor (captura e void) e Pix de R$ 10 reconciliados com o extrato Cielo.
- **C-P3.** Porta 9000 em wss (DEPLOY §4.3), porta crua fechada, `OCPP_TRUST_PROXY_HOPS` medido (§4.4).
- **C-P4.** CSP estreita promovida a enforce depois de T1–T3 (N-4) e decisão do subdomínio (N-5).
- **C-P5.** Node 22/24, `USER node`, nginx atual (N-3).
- **C-P6.** Canal de alerta ativo (N-7).
- **C-P7.** Antifraude Cielo e política de carding (N-6); IP adicionado (não substituído) à lista de confiáveis; plano de rotação da MerchantKey nos dois sistemas.
- **C-P8.** Tela do gateway com `environment: production` e `secretsDecryptable: true`; `PAYMENT_ALLOW_FAKE_ADAPTER` ausente.
- **C-P9.** F5.9 com carregador real (perguntas do desenho §7: ordem Boot × Stop enfileirado, `messageId`, TriggerMessage, `MeterValueSampleInterval`, RTC).
- **C-P10.** Recomendados (não bloqueiam): partições e retenção (N-11), `maxBadMessages` (N-10), `JWT_SECRET` ≥ 32 obrigatório (N-12).

## Pendências

Não provado: tudo contra Cielo/Braspag reais (formatos, ReturnCodes, host do SOP, `CardToken`, tolerância do script a número só com dígitos, cobrança de `CardToken` sem CVV); CSP/headers atrás do nginx real; suítes de integração e E2E nesta máquina; comportamento do Parque em produção; patch atual de `node:20-alpine`; estado real das senhas seed e das envs do EasyPanel.
Exige o dono: N-1; subdomínio (I-2); wss na 9000; lista de testadores Google; firmware real; antifraude/carding; prazo de captura da pré-autorização e URL canônica do script do SOP com a Cielo (muda o `script-src`).
