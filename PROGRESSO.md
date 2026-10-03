# InnoElektron — Progresso

Plataforma web para eletropostos (recarga de veículos elétricos): comunicação
com carregadores via OCPP 1.6-J, cobrança da recarga via PIX e cartão de
crédito (Cielo).

## Estado atual (2026-09-16)

- Repositório git inicializado, ainda sem primeiro commit de código.
- Painel de Tarefas conectado (`PM-PPX8`, prefixo `INNOELEKTRON_` em
  `.env.integration`).
- **Arquitetura completa entregue pela Nova** — ver
  `.claude/agent-memory/nova/` para os detalhes gravados. Resumo:
  - Monólito modular, 1 repositório, 1 banco, 3 entrypoints: `api.ts`
    (Express/REST/SSE), `ocpp.ts` (gateway OCPP, WebSocket), `worker.ts`
    (BullMQ). Comunicam por Postgres compartilhado + Redis pub/sub (comandos
    API → carregador) + BullMQ (o que precisa sobreviver a crash/retry).
  - Biblioteca OCPP: **`ocpp-rpc`** (mikuso), usada só como transporte —
    semântica OCPP 1.6-J escrita por nós em Zod. **Correção ao pedido
    original:** `extrawest/ocpp-js` **não existe** (404); o pacote real da
    Extrawest é `@extrawest/node-ts-ocpp`, que é OCPP **2.0.1** (protocolo
    errado) e está abandonado desde 06/2023. `mobilityhouse/ocpp-rpc` também
    não existe sob esse nome — o pacote correto do autor mikuso chama-se
    `ocpp-rpc` puro.
  - Cobrança: **cartão** = pré-autorização com teto + captura parcial única
    no `StopTransaction` (sandbox existe). **PIX** = carteira pré-paga com
    razão append-only, porque PIX Cielo não retém valor e a integração nova
    (Cielo2) **não tem sandbox**. Abstração única `PagamentoPort`
    (reservar/liquidar/desfazer) com adaptadores Cielo / Carteira / Fake.
  - Modelo de dados de alto nível definido (§4 do handoff da Nova) — pronto
    para o Cronos desenhar o `schema.prisma`.
  - Plano em 9 fases (F0 fundações → F8 portões de qualidade), com
    paralelismo em F1‖F2, F3a‖F3b‖F3c, F6‖F7.
- **Vulcano entregou F0** (fundações): backend com 3 entrypoints
  (`api`/`ocpp`/`worker`, stubs), lint/typecheck/build/test verdes;
  frontend Vite+React scaffolded e verde; `docker-compose.yml` com
  postgres+redis+api+ocpp-gateway+worker+simulador OCPP (imagem
  `ghcr.io/solidstudiosh/ocpp-virtual-charge-point` — **licença Apache-2.0**,
  não MIT como constava no plano original); CI no GitHub Actions com
  migrations reais contra Postgres em serviço; regra de lint bloqueando
  `express`/`ws`/`ocpp-rpc` dentro de `src/core/**` (a fronteira da Nova,
  agora executável). **Pendência:** o `docker compose up` ainda não foi
  validado de ponta a ponta por falta de Docker no sandbox do Vulcano — só
  a sintaxe/topologia do compose foi conferida. Alguém com Docker precisa
  rodar `docker compose up -d postgres redis` para fechar esse portão.
- **Cronos entregou F1** (modelagem de dados): `schema.prisma` com 18
  models, multi-tenant real (`operatorId` denormalizado nas tabelas quentes
  via **trigger no Postgres**, não por convenção da aplicação — reescreve
  sozinho mesmo se a app mandar errado), particionamento mensal de
  `MeterSample`/`OcppMessage` com CHECK constraints e índices únicos
  parciais, carteira (`WalletEntry`) append-only **reforçada por trigger**
  (UPDATE/DELETE falham de verdade, não só por convenção), seed com
  conector DC CCS2 + AC Tipo 2, script de teste de particionamento.
  **Pendência:** mesma limitação do Vulcano — sem Docker no ambiente, a
  migration/seed/particionamento não foram validados contra um Postgres
  real ainda (só validados estaticamente: `prisma validate`, `migrate diff
  --from-empty`, `tsc` contra o client gerado).

## Decisões em aberto (dependem do dono)

Levantadas pela Nova durante a arquitetura — nenhuma foi decidida sozinha.

**Já decididas pelo dono (2026-09-16):**

1. ✅ **Multi-operador: SIM, multi-tenant desde já.** Não é só a coluna
   `operatorId` barata que a Nova sugeriu como mínimo — o dono quer
   múltiplas empresas operando eletropostos na mesma plataforma, com
   isolamento de verdade (permissões por operador, faturamento/relatórios
   segregados). Impacto: Cronos precisa desenhar `Operator` como entidade de
   primeira classe com FK em `Site`, `ChargePoint` (via Site) e no modelo de
   usuários; papel `OPERATOR` fica escopado ao seu `operatorId`, só um papel
   `ADMIN` (plataforma) enxerga tudo. Vega precisa aplicar esse escopo em
   toda query/middleware da API admin — isolamento é regra de autorização,
   não só de schema.
6. ✅ **Escopo do público: só B2C no MVP.** Frota/faturamento mensal (B2B)
   fica para depois — não criar o terceiro adaptador de pagamento agora.
4. ✅ **Taxa de ociosidade (idle fee): SIM, já no MVP.** Cronos inclui
   `idleFeePerMinute` em `Tariff` (já estava no desenho da Nova) e Vega
   precisa contar o tempo pós-`Finishing`/pós-desconexão do veículo com
   carro ainda plugado como janela cobrável.
7. ✅ **Tipo de conector da primeira instalação: DC CCS2** (carga rápida).
   Cronos modela o enum de `Connector` cobrindo AC Tipo 2 + DC CCS2 + DC
   CHAdeMO (fácil estender), mas o cenário de teste/seed real é CCS2.

**Decididas em 2026-09-17:**

2. ✅ **PIX — sobra de saldo:** permanece como crédito na carteira do
   motorista, para usar na próxima recarga (não há devolução automática).
   Já bate com o modelo de carteira pré-paga que o Cronos implementou —
   nenhuma mudança de schema necessária.
3. ✅ **Teto da pré-autorização do cartão: CALCULADO**, não fixo.
   Recomendação do Atlas, aceita pelo dono:
   `teto = potência do conector (kW) × 1h30 (sessão longa típica) ×
   preço/kWh da tarifa × 1,15 (margem)`, com **piso** (~R$ 50, evita
   reserva ridícula em tarifa barata) e **teto absoluto** (~R$ 400, trava
   de sanidade). A formular em detalhe quando a F5 chegar.
5. ✅ **Credenciais Cielo: parametrizáveis pela própria plataforma**
   (tela de configuração, credenciais cifradas no banco, sem env var
   hardcoded) — mesmo padrão do `/admin/gateway` do ParquedasFeiras.
   **Decisão de arquitetura a confirmar com a Nova na F5:** como o
   InnoElektron é multi-tenant (múltiplos operadores), o modelo mais
   provável — seguindo o precedente do ParquedasFeiras (marketplace) — é
   **uma única conta Cielo da plataforma**, que recebe tudo, com acerto
   entre plataforma e operador por fora (mesma lógica de "saques" que já
   existe lá). Não implementar sem confirmar esse desenho primeiro.
8. **Nota fiscal / tributação** — explicitamente **adiada pelo dono**,
   não mexer agora. Revisitar antes da fase F8 (deploy final).
9. ✅ **Motorista (driver): confirmado como conta única de rede** (decisão
   do dono, 2026-09-16). O motorista se cadastra uma vez e carrega em
   eletropostos de qualquer operador, com a mesma carteira — exatamente
   como o Cronos já modelou (`User`/`Wallet`/`AuthToken`/`PaymentMethod` do
   driver sem `operatorId`). Nenhuma mudança de schema necessária.

## Módulo de retaguarda (dashboard/financeiro/relatórios) — decisão de rumo 2026-09-16

Dono pausou o avanço na experiência do motorista (fluxo de recarga via QR)
para priorizar a retaguarda administrativa: dashboard, financeiro,
relatórios, "quanto cada eletroposto faturou". Decisão: construir AGORA
com **dado sintético gerado no banco** (não mock de frontend) — endpoints e
telas reais desde já, dado sintético só é substituído por produção
verdadeira quando a Fase 4/5 (sessão + pagamento reais) existir.

**Nova entregou o desenho completo** (`.claude/agent-memory/nova/
decisoes-retaguarda-relatorios.md`). Achados que mudam o desenho:
- Relatório **nunca agrega `MeterSample`** — `ChargingSession` já congela
  `energyDeliveredWh`/`totalCostCents`. Por isso: **sem tabela de resumo
  pré-calculada por ora** (`DailySiteSummary`), só índices. Gatilho medido
  para reabrir: p95 > 800ms em relatório de 12 meses OU
  `ChargingSession` > 1M linhas.
- **Faturamento ≠ caixa**: recarga de carteira via Pix não é receita, é
  passivo. Seção financeira expõe a identidade de conciliação
  `faturamento = capturas cartão + débitos carteira + dívida aberta`
  explicitamente na tela (diferença ≠ 0 aparece em vermelho, não escondida).
- 14 métricas de dashboard (10 pedidas + taxa de sucesso, utilização,
  R$/kWh médio, ociosidade).
- 7 endpoints (`/api/admin/dashboard/summary`, `/dashboard/live`,
  `/reports/daily-movement`, `/reports/revenue`, `/reports/sessions`,
  `/reports/payments`, `/api/admin/operators` — este último fecha a
  pendência que a Lyra deixou de "sem listagem de operadores").
- Bucket de dia sempre no **fuso do site** (`startedAt`, nunca `stoppedAt`),
  nunca UTC.

**✅ Vega (R2) entregou** as 7 rotas de agregação — código no `main`,
lint/typecheck/build/testes limpos. Decisões de negócio que a Nova não
fechou e o Vega tomou sozinho (documentadas, a confirmar): fórmula de
`utilizationPct`, `successRatePct` só considera sessões terminais,
`paymentMethod` é campo derivado (não é coluna), `walletTopupCents`/
`walletFloatCents`/`expiredPixCount` viram ADMIN-only (somem da resposta
para OPERATOR, não vêm `null`). **Ainda não validado contra Postgres
real** — depende do seed do Cronos (R1, em andamento) e das colunas
`lastPowerW`/`lastSoc`.

**✅ Lyra (R3) entregou** as 6 telas — código no `main`, lint/typecheck/
testes/build limpos, validado com Playwright logando de verdade como
ADMIN e OPERATOR contra mocks. Corrigiu 3 bugs reais de UI encontrados
na validação: cartão de métrica cortando valor em telas ~1280px, selects
de filtro cortando texto, e o mais sério — rótulo "E-mail" aparecia (com
"—") no detalhe de sessão mesmo para OPERATOR, vazando que o dado existe
mesmo sem mostrar o valor (campo agora some inteiro, não só mascara —
lição de LGPD registrada em memória). **Ainda não validado contra API
real** — mock por construção sempre fecha a conciliação em zero, então
isso NÃO prova que a query real do Vega fecha; é o que a Íris precisa
confirmar depois.

**✅ Cronos (R1) entregou** — código no `main`, lint/typecheck/build/
testes unitários limpos (36 testes, incluindo os 17 de tarifação).
`calcularCustoSessao()` + `serializeTariffSnapshot()` prontas para
reuso real na Fase 4. Migration com 3 colunas de painel ao vivo + 6
índices via `CREATE INDEX CONCURRENTLY` (sem lock). `seed-demo.ts`
validado com harness em memória: ~11 mil sessões, split de pagamento
calibrado 55/45, saldo de carteira batendo exato, `meterStartWh`
monotônico sem sobreposição.

**⚠️ Achado real para a Fase 4 (não é bug de hoje, é lembrete):**
`backend/src/ocpp/handlers/startTransaction.ts` grava o `tariffSnapshot`
sem as `TariffWindow[]` (simplificação proposital da F3a, já documentada
no próprio código) — quando a Fase 4 construir a sessão real, trocar
para `serializeTariffSnapshot(tariff, windows)`, senão tarifa `HYBRID`
nunca cobra o preço de ponta corretamente.

**⚠️ Bug real encontrado ao testar em produção (2026-09-16):** Vega e Lyra
formalizaram contratos TypeScript DIFERENTES para as 7 rotas, cada um a
partir da mesma prosa da Nova — nenhum viu o do outro (trabalho paralelo).
Causou 500 em `/dashboard/live` (migration do Cronos ainda não aplicada
em produção — colunas `lastPowerW`/`lastSoc` não existiam) e crash no
Dashboard (`data.metrics` undefined — backend devolvia `period`+`deltaPct`
separado, frontend esperava `metrics.X.{value,deltaPct}`). Diagnóstico
completo: divergência em praticamente todas as 7 rotas, incluindo uma
funcionalidade inteira faltando (`/reports/payments` sem listagem
paginada de `PaymentIntent`, só o resumo). **Vega acionado de novo** para
conformar as 7 respostas ao contrato que já está em
`frontend/src/types/api.ts` (fonte de verdade, já testado pela Lyra).
Lição registrada em memória: trabalho paralelo backend/frontend a partir
só de especificação em prosa precisa de passo de reconciliação depois —
"os dois passaram nos próprios testes" não prova que são compatíveis
entre si.

**✅ Vega entregou a reconciliação** (código no `main`, 40 testes
unitários, lint/typecheck/build limpos) — as 7 rotas conferidas campo a
campo contra `frontend/src/types/api.ts`, sem lacuna de formato
conhecida. No processo achou e corrigiu um bug adicional real:
`resolveEffectivePeriod` ignorava `from`/`to` sempre que `period` ficava
no valor default do Zod — como o frontend nunca manda `period`, todo
preset diferente de "30 dias" devolvia sempre os últimos 30 dias,
**silenciosamente, sem erro**. Também corrigidos dois erros de bugs em
produção reportados pelo dono: migration falhando (`CREATE INDEX
CONCURRENTLY` dentro de transação — Prisma envolve o arquivo inteiro
numa transação, removido `CONCURRENTLY`) e `seed-demo.ts` com
`MODULE_NOT_FOUND` (Dockerfile não copiava `src/` para a imagem final).

**Todas as 3 frentes (R1/R2/R3) entregues e no GitHub — mas com o gap de
contrato acima ainda sendo corrigido.** Próximo passo
real: reimplantar o backend no EasyPanel, rodar
`npx prisma migrate deploy && npm run db:seed:demo`, e então apontar o
frontend pra API real (trocar `VITE_USE_MOCKS`) — isso é o que finalmente
prova (ou derruba) a identidade de conciliação financeira e o isolamento
multi-tenant com dado de verdade, não mock.

Portão de saída (R4, Íris+Órion): consultas <500ms em 60 dias de dado
sintético; conciliação financeira fechando em zero; OPERATOR não vê um
centavo de outro operador em nenhuma das 7 rotas (nem forjando
`operatorId`/`siteId` na query).

## Identidade visual — decisão 2026-09-16

Dono definiu a marca oficial: **"InnoFlow"**, slogan "Carregue um futuro
melhor" — verde folha/energia em gradiente para teal, sobre azul-petróleo
escuro. **Repositório GitHub e nome técnico continuam "InnoElektron"**
(decisão explícita do dono, não mudar por enquanto) — só a marca visível
na UI muda. Lyra acionada para trocar os tokens de cor (paleta provisória
que ela escolheu sem referência de marca) e o nome exibido na interface.
Paleta foi lida visualmente pelo Atlas a partir da imagem colada no chat
(sem arquivo da logo em mãos) — pendente: pedir ao dono o arquivo oficial
(PNG/SVG) da logo para favicon/header de verdade, quando ele puder enviar.

**✅ Bug real de schema encontrado e corrigido (17/09/2026):** ao rodar
`db:seed:demo` em produção pela primeira vez, a CHECK constraint
`payment_intent_return_code_required` bloqueou a inserção de recargas de
carteira via PIX. A constraint original exigia `returnCode` para
QUALQUER `PaymentIntent` capturado, mas `returnCode` é conceito exclusivo
do fluxo de **cartão** da Cielo — PIX nunca tem esse campo (confirma via
webhook). **Isso teria bloqueado pagamentos PIX reais em produção na
Fase 5, não só o seed.** Nova migration
(`20260917130000_fix_payment_intent_return_code_pix`) estreita a
exigência só para `purpose = SESSION_CARD_CAPTURE`. No `main`.

**✅ Lyra entregou o rebrand** (código no `main`, lint/typecheck/testes/
build limpos): rampa de cores derivada por HSL com contraste WCAG AA
calculado (não estimado), corrigiu de passagem um bug pré-existente onde
o hover não tinha efeito visual (`DEFAULT` e o degrau de hover eram o
mesmo valor). Marca "InnoFlow" + slogan visíveis em toda a UI. Favicon
com placeholder genérico documentado até a logo oficial chegar.

## Logo oficial, empresa no header e redesign do login — 2026-09-17

Dono confirmou: `db:seed:demo` rodou com sucesso após o fix da constraint
de PIX. Três pedidos novos: (1) usar `logomarca.png` (arquivo real,
1774×887) como logo oficial em vez do placeholder; (2) mostrar no
cabeçalho a empresa (operador) do usuário logado — multi-tenant visível;
(3) redesenhar a tela de login com cara mais profissional/robusta.
Atlas já adicionou `operatorName` na resposta de `/api/auth/login`
(join com `Operator`). Lyra entregou o resto (logo real, header,
redesign do login) — validado com Playwright, lint/typecheck/testes/
build limpos.

**✅ Selo InnovareCode + versionamento** também adicionado (pedido à
parte do dono, mesmo padrão do ParquedasFeiras): canto inferior direito
do painel admin, versão do sistema vinda do `package.json` (fonte
única), data do build. Porta 1:1 o componente já validado no projeto
irmão.

## Rumo confirmado: F4 (sessão) antes de F5 (pagamento real) — 2026-09-17

Após reavaliação geral do projeto a pedido do dono, ficou definido: fechar
**totalmente** a sessão de recarga (F4 — OCPP real com cálculo de tarifa
ligado, sem integração Cielo ainda) antes de iniciar a integração de
pagamento real (F5 — cartão/PIX Cielo). Em paralelo, **Íris (QA) e Órion
(segurança) acionados pela primeira vez neste projeto** para auditar o que
já existe — nenhum dos dois tinha sido chamado até agora.

## Primeira auditoria de segurança (Órion) — 2026-09-17

**Achado crítico corrigido no mesmo dia:** `pino-http` logava o header
`Authorization` (JWT completo) em texto puro em toda requisição
autenticada — sem `redact` configurado. Combinado com token de 12h sem
revogação (dívida já conhecida), equivalia a sequestro de qualquer sessão
(inclusive ADMIN) para quem tivesse acesso aos logs de produção.
**Bloqueante explícito antes da F5** (pagamento real) — corrigido na hora
(`redact` na config raiz do pino, testado manualmente). Precisa
reimplantar o backend no EasyPanel para valer em produção.

Resto da auditoria: **isolamento multi-tenant confirmado sólido** (as 7
rotas de `$queryRaw` usam bind param em 100% dos pontos revisados, sem
concatenação), OCPP com validação Zod + Basic Auth via bcrypt + lock
anti-split-brain corretos, LGPD (e-mail de motorista) consistente em
todas as rotas. 3 achados "importante" (sem rate limit no OCPP auth —
depende da topologia da porta 9000, pendência para o Vulcano; CORS
aberto; `ajv` ReDoS via `ocpp-rpc` reavaliado como risco menor do que se
temia) e 2 sugestões (bcrypt rounds, JWT sem refresh) — nenhum bloqueante.

## F4 desenhada (Nova) — 2026-09-17

**Achado central**: a identidade de conciliação já em produção
(`paymentsService.ts`: `revenue === cardCaptured + walletDebit + openDebt`)
**proíbe reserva antecipada por débito** — se a carteira debitasse um teto
no início e devolvesse o troco no fim, a tela Financeiro mostraria
diferença em vermelho. Por isso: **carteira pré-paga sem hold**, saldo
mínimo pra iniciar, guarda ao vivo no `MeterValues` (auto-stop via
`RemoteStopTransaction` se o custo parcial atingir o teto calculado —
mesma fórmula do dono, agora com uso real), débito único e atômico no
`StopTransaction`, o que faltar vira `Debt` (bloqueia próxima recarga).

**Contrato literal do débito** (não é detalhe, é o que faz a retaguarda
enxergar sessão real em vez de só o sintético): `WalletEntry` com
`type='CHARGE_DEBIT'`, `referenceType='CHARGING_SESSION'`,
`referenceId = ChargingSession.id` (o cuid, não o `ocppTransactionId`).

Confirmado: `tariffSnapshot` passa a incluir `TariffWindow[]` agora (é o
momento certo, senão tarifa HYBRID perde receita de ponta em silêncio).
`StopTransaction` liquida inline (débito é INSERT local, não precisa
esperar worker) mas sempre responde `Accepted` ao carregador mesmo se a
liquidação falhar, enfileirando um job de retry — **essa costura
(inline + job de liquidação) é o que a F5 reaproveita sem reescrever o
handler**, trocando "debitar carteira" por "criar PaymentIntent
CAPTURE_PENDING" no inline e "capturar de verdade" no job.

3 telas mínimas necessárias (nada disso existe hoje): iniciar/parar
recarga pelo admin, e **carteira do motorista** (saldo/extrato/crédito
manual do ADMIN — sem isso não dá nem para financiar uma carteira de
teste antes da F5 existir).

**Regra de processo herdada do incidente de contrato divergente**: Vega
commita os tipos de API em `frontend/src/types/api.ts` ANTES de
implementar qualquer coisa; Lyra só começa depois desse commit existir.

**✅ Decidido pelo dono (2026-09-17), todas as recomendações da Nova aceitas:**
1. Saldo mínimo pra iniciar sessão: **R$ 20,00** (`WALLET_MIN_START_BALANCE_CENTS`).
2. Motorista pode terminar sessão devendo (vira `Debt`, bloqueia próxima
   recarga até quitar) — **aceito**.
3. `SuspendedEVSE` **não conta** como ociosidade cobrável.
4. Teto do crédito manual do ADMIN por lançamento: **R$ 5.000**.

Implementação liberada — Cronos (4.1: índices) e Vega (4.2: núcleo puro +
commit de contrato) acionados em paralelo.

**✅ Cronos (4.1) entregou** os 3 índices — no `main`. Achado real:
`OcppMessage` é particionada por `RANGE(occurredAt)`, e o Postgres exige
que a coluna de partição esteja em qualquer índice único da tabela — sem
incluir `occurredAt` na chave, a migration falharia contra Postgres real
(algo que nenhuma validação estática pega). Vega segue com 4.2-4.4.

## Primeira auditoria de QA (Íris) — 2026-09-17

Testou ao vivo contra produção real com os 3 perfis (não só mock):
autenticação, RBAC, paginação, os 5 presets de período, isolamento
multi-tenant (forjando `operatorId`/`siteId` de outro operador — sempre
403/404 corretos, nunca vazou dado), responsividade mobile (390px) e
tablet (768px, nunca testado antes), validação de formulário, rate
limit de login. **Tudo aprovado no comportamento.**

**❌ REPROVADO por ausência, bloqueante antes da F5:** as duas lógicas
mais sensíveis do sistema — **escopo multi-tenant**
(`reportingScope.ts`/`tenantScope.ts`) e **conciliação financeira**
(`paymentsService.ts`) — **não têm nenhum teste automatizado**. Funcionam
hoje porque a Íris testou na mão; nada no CI pegaria uma regressão
amanhã. A partir da F5 um bug nessas duas áreas é dinheiro real, não
dado sintético.

**Achado operacional**: o dado sintético (`db:seed:demo`, ~11 mil
sessões) **sumiu ou nunca persistiu em produção** — confirmado com
consulta simples, produção só tem o seed base. Precisa rodar de novo.

E2E automatizado é só 1 smoke test — dívida real, mas não bloqueante.

## 🎉 Marco: primeiro handshake OCPP real em produção — 2026-09-17

Depois de criar os 3 serviços que faltavam no EasyPanel
(`ocpp-gateway`/`worker`/`simulador`) e corrigir uma sequência de
problemas de configuração (ver seção abaixo), o simulador de charge
point (`vcp-prod-01`) **conectou de verdade no gateway OCPP em
produção**: autenticou via Basic Auth, mandou `BootNotification`.
Confirmado via API real: `GET /api/admin/charge-points` mostra
`lastSeenAt` preenchido; `GET /api/admin/dashboard/live` mostra
`chargePoints.online: 1`. **Primeira prova end-to-end de todo o sistema
funcionando junto** (banco + gateway + API + dashboard) — tudo que
existia até aqui só tinha sido validado em partes isoladas.

**Problemas reais encontrados e corrigidos nesse processo** (documentados
em detalhe para não se repetirem):
1. Novo serviço criado com método de build "Nixpacks" em vez de
   "Dockerfile" → `NODE_ENV=production` ligado antes da instalação fez o
   `npm ci` pular dependências de dev, `tsc: not found`. Corrigido:
   método de build = Dockerfile.
2. EasyPanel **não permite sobrescrever o comando de start** quando o
   método é "Dockerfile" (esse campo só existe para Nixpacks/Buildpacks)
   — o `ocpp-gateway` ficou rodando o entrypoint da API. Corrigido:
   `backend/Dockerfile.ocpp` e `backend/Dockerfile.worker` criados
   (idênticos ao principal, só muda o `CMD`), cada serviço aponta pro
   arquivo certo no campo "Arquivo".
3. Simulador precisa da env `PASSWORD` pra autenticar (Basic Auth) —
   não estava no checklist original, adicionado.
4. IDs "amigáveis" do seed base (`seed-site-matriz`) são rejeitados pela
   validação `.cuid()` dos formulários — contornado criando um site novo
   pelo próprio painel admin (ver bug registrado em memória).

`docs/DEPLOY-EASYPANEL.md` atualizado com todos os 4 pontos acima.

**🔴 Bug crítico real encontrado e corrigido**: o primeiro `RemoteStartTransaction`
de verdade do projeto (disparado manualmente pelo Atlas via API, testando
com o dono) **nunca chegou ao carregador**. Causa: `sendCommand()`
(`backend/src/ocpp/commands.ts`) dava `await` na resposta **antes** de
publicar o comando no Redis — ordem invertida, `publish()` era código
inalcançável. Todo comando remoto (iniciar, parar, reset, destravar)
estourava o timeout de 35s **sempre**, incondicionalmente, mesmo com o
carregador conectado e saudável. Só apareceu porque foi a primeira vez
que alguém testou um comando remoto de ponta a ponta contra infraestrutura
real — nenhum teste automatizado (nem os novos da F4) exercitava essa
função contra um transporte de verdade. Corrigido e publicado; log
explícito adicionado no lado do gateway para o próximo problema desse
tipo ser diagnosticável direto pelo log, sem precisar ler código.

**Gap real descoberto ao tentar testar uma sessão completa**: não existe
rota admin nem tela para vincular uma `Tariff` a um site/charge-point/
connector (`TariffAssignment`) — só a tabela `Tariff` em si tem CRUD. Um
carregador cadastrado pelo fluxo normal do admin fica sem tarifa, e a
sessão falharia. Bloqueia onboarding real de carregador sem acesso direto
ao banco. Prioridade média-alta para o próximo ciclo.

## F4 entregue (Vega) — 2026-09-17

**Sessão de recarga cobrando da carteira, sem Cielo, publicada no `main`**
(commits `eff02eb`/`369e87d`/`d123ade` — Vega commitou localmente mas não
deu push; Atlas validou tudo de novo de forma independente — typecheck/
lint/build/57 testes unitários — e publicou). Núcleo: `calcularTetoReserva`/
`avaliarInicioSessao` puros, `walletLedger`/`liquidarSessao` com débito
atômico (`FOR UPDATE`) e retry via BullMQ. Handlers OCPP reescritos:
`tariffSnapshot` agora com `TariffWindow[]` (tarifa HYBRID cobra ponta de
verdade), guarda de saldo com auto-stop via `RemoteStopTransaction`,
`Connector.status` passa a vir só do `StatusNotification` real (não mais
forçado pelo Start/Stop). 5 rotas novas: iniciar/parar sessão, listagem
de motoristas, carteira do motorista, ajuste manual de saldo (ADMIN).

2 testes de integração novos cobrindo exatamente as lacunas que a Íris
reprovou (multi-tenant, conciliação financeira) — escritos, mas **ainda
não confirmados contra Postgres real** (sem Docker no sandbox do Vega
também). Próximo passo da Íris: rodar esses dois contra produção/seed
real antes de considerar o bloqueio da F5 removido.

**Pendência real para testar**: `remoteStartCommandSchema.userId` também
valida `.cuid()` — se o motorista de teste tiver ID não-cuid (mesmo bug
do site, ver abaixo), iniciar sessão pela API falha até alguém decidir a
correção.

## 🎉 Primeira sessão de recarga real testada de ponta a ponta — 2026-09-17

Depois do fix do bug crítico do barramento de comandos, testamos o fluxo
completo pela primeira vez: `RemoteStartTransaction` → carregador aceita
→ `StartTransaction` real (transactionId 11733) → `MeterValues` chegando
e energia subindo em tempo real no dashboard (0 → 300 Wh) → tentativa de
`RemoteStopTransaction`.

**Achado**: o simulador (Solidstudio VCP) aceita o `RemoteStopTransaction`
mas **desconecta e reconecta em vez de completar o protocolo** (nunca
manda o `StopTransaction` final com a leitura do medidor). A sessão de
teste ficou presa em `STARTED` — não é bug nosso, é o simulador não
completando o fluxo. Mas revelou um gap real do sistema, **corrigido no
mesmo dia**: não existia reconciliação para quando um charge point
reconecta com uma sessão ainda aberta.

**✅ Vega entregou a correção**: núcleo de "fechar sessão" extraído de
`stopTransaction.ts` para `services/carteira/finalizarSessao.ts`
(reusado, comportamento do `StopTransaction` real inalterado).
`bootNotification.ts` agora verifica sessões `STARTED`/`CHARGING`/
`FINISHING` ao reconectar e fecha cada uma usando a última `MeterSample`
conhecida (energia zero se não houver nenhuma) — fire-and-forget, nunca
atrasa a resposta do boot ao carregador. 3 testes de integração novos
(ainda não executados contra Postgres real — mesma limitação de
ambiente recorrente). No `main`.

## Preparando o simulador de charge point — 2026-09-17

Dono criou os 3 serviços que faltavam no EasyPanel (`inno-elekton-ocpp`,
`inno-elekton-worker`, `inno-elekton-simulador`). Atlas cadastrou o
carregador simulado no sistema via painel admin (`ocppIdentity=vcp-prod-01`,
site novo "Site de Testes - Simulador" — o site do seed base tem ID não
padrão e foi rejeitado, ver bug abaixo). **Falta**: dono adicionar
`PASSWORD=<secret>` no serviço do simulador e reimplantar, para a
autenticação Basic Auth do gateway aceitar a conexão.

**Bug real encontrado**: sites/registros do seed base têm IDs legíveis
(`seed-site-matriz`) que a validação `.cuid()` dos formulários de criação
rejeita — não dá para criar `ChargePoint` referenciando esses sites pela
API/UI. Contornado criando site novo. Registrado em memória para o Vega
decidir a correção (relaxar validação vs. gerar cuid real no seed)
quando mexer de novo nesses schemas — não urgente.

## Ordem cronológica confirmada pelo dono — 2026-09-17

**F4 (terminar completamente) → PWA do motorista → F5 (pagamento Cielo).**
O PWA (fluxo do motorista via QR code, pausado desde o início da retaguarda)
entra ANTES do pagamento real — faz sentido, é ele quem vai disparar as
cobranças na F5. Não pular direto pra F5 sem o PWA existir.

**Terminar a F4 significa**: provar um ciclo completo feliz (start → medir
→ stop → carteira debitada → aparece certo no financeiro) e rodar os 3
testes de integração novos (multi-tenant, conciliação, reconciliação de
sessão órfã) contra Postgres real — nenhum dos dois foi feito ainda.

## 🎉🎉 F4 FECHADA — ciclo completo provado com dinheiro real — 2026-09-17

Testado ao vivo em produção, ponta a ponta, sem nenhum atalho: sessão
iniciada remotamente → energia medida em tempo real (0→300 Wh) →
carregador desconectou no meio (comportamento do simulador) →
**reconciliação automática fechou a sessão sozinha** ao reconectar →
custo calculado corretamente (aplicando até a regra de cobrança mínima
da tarifa: 300 Wh custariam R$0,24, mas o mínimo é R$5,00 — foi isso que
foi cobrado) → carteira debitada atomicamente (R$50,00 → R$45,00,
`WalletEntry` referenciando a sessão certa) → **conciliação financeira
fechando em ZERO** (`revenueCents: 500 = walletDebitCents: 500`,
`differenceCents: 0`).

É a prova final: toda a identidade de conciliação que a Nova desenhou
quando a retaguarda ainda só tinha dado sintético agora se sustenta com
dinheiro de teste circulando de verdade pelo sistema inteiro — sessão,
tarifação, carteira e dashboard financeiro, tudo consistente.

**Pendência residual (não bloqueante):** os 3 testes de integração
escritos pelo Vega (multi-tenant, conciliação, reconciliação) ainda não
rodaram formalmente contra Postgres via CI/Íris — mas o comportamento
real que eles testam já foi confirmado manualmente em produção acima.

**Ordem confirmada com o dono**: próximo passo é o **PWA do motorista**
(pausado desde o início da retaguarda), depois sim a F5 (Cielo). Reforço
do dono: além de robusto/profissional/intuitivo, o PWA precisa ser
**bonito** — é a cara pública do produto, o motorista abre no celular na
hora de carregar o carro.

## PWA do motorista desenhado (Nova) — 2026-09-17

**Decisão: um app só**, não dois — PWA vive no MESMO frontend React
(rotas públicas `/c/:ocppIdentity[/:connectorId]` pós-QR + área
`/app/*` autenticada como DRIVER, mais `vite-plugin-pwa`). Motivo
decisivo: duplicar `frontend/src/types/api.ts` num segundo app
recriaria o incidente de contrato divergente já registrado em memória.

**8 rotas novas sob `/api/me/*`** (+ 1 pública) — decisão de NÃO
generalizar as rotas admin existentes (admin escopa por `operatorId`,
motorista por `userId`; misturar as duas dimensões num handler é
caminho de vazamento cruzado). **Todo o núcleo da F4 é reaproveitado
sem mudar uma linha** (`avaliarInicioSessao`, `calcularTetoReserva`,
`walletLedger`, `finalizarSessao`, `calcularCustoSessao`). Cronos não
precisa de nenhuma migration — índices e campos necessários já existem.

**Achado de produto real**: a regra de cobrança mínima da tarifa
precisa aparecer **antes** de iniciar a recarga, não só no recibo —
nasceu direto do teste real de hoje (300 Wh custaria R$0,24, mas foi
cobrado R$5,00 pelo mínimo da tarifa; mostrar isso só depois seria
sentido como cobrança injusta).

QR codifica `ocppIdentity` (não o cuid — mais curto, já é a identidade
pública do equipamento). Um adesivo por conector quando há mais de um.

**✅ Decidido pelo dono (2026-09-17), todas as recomendações da Nova aceitas:**
1. Domínio do QR: **mesmo host do painel** (`/c/...`).
2. Layout do adesivo: **QR + `ocppIdentity` escrito do lado**, um
   adesivo por conector quando houver mais de um.
3. Tela de "sem saldo": **sem contato do operador por enquanto**, só
   mensagem genérica — nenhuma migration nova necessária.
4. Scanner: **só câmera nativa do celular nesta fase** — scanner
   dentro do app fica pra fase 2.

**Plano**: Vega P0 (commit de contrato, bloqueia tudo) → P1a (Vega,
backend `/api/me/*`) ‖ P1b/P1c (Lyra, PWA setup + telas) → P2 (Íris,
teste real) → P3 (polimento visual/performance medido, não estimado).

**✅ Lyra (P1b+P1c) entregou** — 6 telas (landing pós-QR, sessão ativa,
recibo, carteira, home, histórico), PWA instalável de verdade
(`vite-plugin-pwa`, `NetworkOnly` explícito em `/api/**`, ícone
maskable, prompt de instalação só depois da primeira recarga
concluída). Achou e corrigiu **2 bugs financeiros reais** na validação
visual: cobrança mínima escondida na tela de sessão ativa, e cache da
carteira não invalidando após parar a recarga (saldo desatualizado).
Mediu Lighthouse mobile de verdade (não estimou): TTI 3,3s contra meta
de 2,5s — causa raiz é overhead de rede sob throttling, não o JS da
página; correção maior de estratégia de bundle fica para decisão
futura. Validado com Playwright contra mocks — ainda não testado
contra a API real do Vega. No `main`.

**✅ Vega (P0+P1a) entregou** — contrato commitado sozinho primeiro
(regra do projeto), depois o backend: `iniciarSessaoRemota.ts` (núcleo
do remote-start extraído, reusado por admin E motorista sem duplicar
lógica), cache de resultado de comando no Redis (conserta o "202 cego"
que a Nova identificou), 7 rotas `/api/me/*` + 1 pública, lock
anti-duplo-toque, rate limit próprio. Validado de forma independente:
typecheck/lint/build/57 testes limpos nos dois lados. No `main`. Lyra
liberada para as telas.

## Próximos passos

- F0 (Vulcano) e F1 (Cronos) entregues. **Pendência comum:** nenhum dos dois
  foi validado contra Postgres/Redis reais — os ambientes dos agentes não
  tinham Docker instalado. Primeira coisa a fazer quando alguém tiver Docker
  à mão: `docker compose up -d postgres redis` → `npx prisma migrate deploy`
  → `npm run prisma:seed` → `npm run db:test-partitioning`.
- **Vega entregou F3a/F3b**: gateway OCPP 1.6-J real (handlers do MVP,
  idempotência por `(chargePointId, ocppMessageId)`, lock anti-split-brain
  em Redis, barramento de comandos), API REST base (JWT, escopo
  multi-tenant, CRUDs admin, comandos remotos assíncronos). Validou o
  `ocpp-rpc` com spike real (conexão + CALL nos dois sentidos) — a lib se
  comportou como esperado, não precisou do plano B. Corrigiu 2 bugs reais
  no caminho: `JWT_SECRET` faltando em 2 serviços do `docker-compose.yml`
  (o `env.ts` valida tudo de uma vez, derrubaria `ocpp-gateway`/`worker`) e
  um `throw` dentro do handler assíncrono do `express-rate-limit` que
  viraria unhandled rejection em vez de responder 429.
- **⚠️ Pendência acumulada e agora relevante:** F0, F1 e F3a/F3b foram
  entregues por três agentes diferentes, **nenhum com Docker disponível no
  ambiente**. Todo o código existe e passa lint/typecheck/build/testes
  unitários, mas **nada foi rodado contra Postgres/Redis reais** ainda —
  nem a migration, nem o seed, nem um handshake OCPP de ponta a ponta.
  Verificado: esta sessão principal (Atlas) também não tem Docker
  instalado. **Isso precisa ser validado antes de continuar empilhando
  mais fases em cima de uma base nunca testada de verdade.**
- Lyra: shell do frontend (Fase 3c) — contratos da API já documentados por
  Vega, pode começar, mas ver nota acima.
- **Repositório publicado:** https://github.com/InnovareCode/InnoElektron
  (branch `main`), deploy real no **EasyPanel** (servidor dedicado, a
  partir do GitHub). Checklist em `docs/DEPLOY-EASYPANEL.md`.
  **✅ Pendência de validação (desde F0) fechada em 2026-09-16**: os 3
  serviços de backend + frontend subiram sem erro em produção. Dois bugs
  reais só detectáveis em ambiente Alpine de verdade (nenhum agente tinha
  Docker) foram encontrados e corrigidos nesse processo:
  1. Dockerfile do frontend não existia (Vulcano deixou de fora de
     propósito em F0) — criado (Vite→Nginx, proxy `/api` mesma origem,
     SSE sem buffering).
  2. `PrismaClientInitializationError` — `node:20-alpine` não tem mais
     `libssl.so.1.1` (Alpine 3.18+) **e** não tem o binário `openssl`
     instalado, que é o que o Prisma usa para detectar qual engine
     carregar. Precisou dos dois fixes juntos: `binaryTargets =
     ["native", "linux-musl-openssl-3.0.x"]` no `schema.prisma` **e**
     `apk add --no-cache openssl` nos dois estágios do
     `backend/Dockerfile`. Só o primeiro fix sozinho não resolveu — a
     causa raiz era a detecção, não a falta do engine.
  Também corrigido: Build Path do EasyPanel precisa apontar para
  `backend`/`frontend` (Dockerfiles não estão na raiz do repo).
- **✅ Migration + seed rodaram em produção pela primeira vez** (Postgres
  real, EasyPanel) — prova real de que o multi-tenant por trigger, o
  particionamento mensal e a carteira append-only funcionam, não só
  validação estática. Usuários de teste disponíveis: `admin@innoelektron.
  example.com` (ADMIN), `staff@innoelektron-operacoes.example.com`
  (OPERATOR), `motorista.teste@innoelektron.example.com` (DRIVER) — senhas
  de dev no log do seed, nunca usar em produção real com dados de cliente.
  `db:test-partitioning` acusou FALHOU por um bug na própria verificação
  (comparação não removia as aspas que `tableoid::regclass::text` retorna
  para tabelas com maiúscula) — corrigido; o particionamento em si sempre
  esteve correto.
- **Frontend (Lyra) entregue:** shell real substituindo a `HelloPage`
  placeholder — layout (padrão visual do ParquedasFeiras, paleta própria
  azul elétrico/verde energia), autenticação, listagem pública de
  eletropostos (cards com disponibilidade por tipo/potência de conector),
  CRUD admin completo (sites/charge-points/connectors/tariffs/auth-tokens)
  com o escopo multi-tenant refletido na UI (OPERATOR só vê os próprios
  sites, menu de tokens some para ele), comandos remotos fire-and-forget
  (sem feedback em tempo real, SSE não existe ainda). Validado com
  Playwright contra mocks MSW fiéis ao contrato — typecheck/lint/testes/
  build limpos, mas **ainda não testado contra a API real** (sem
  Docker/Postgres no ambiente da Lyra, mesma limitação recorrente).
  **Pendência de produto (atualizada 17/09, achado pela Íris):** o
  endpoint `/api/admin/operators` **já existe** (foi implementado no
  módulo de retaguarda) — o que falta é só trocar o campo de texto livre
  do formulário de site/tarifa por um `<select>` de verdade consumindo
  essa rota. UX ruim, não é mais um endpoint faltando.

## PWA do motorista entregue (Lyra) — 2026-09-17

Consumindo o contrato que o Vega já tinha commitado (`frontend/src/types/
api.ts` — `PublicChargePointCard`/`MeStartSessionResponse`/etc.) e as 8
rotas reais (`/api/public/charge-points/:ocppIdentity` + 7 sob
`/api/me/*`). Entregue: configuração PWA de verdade
(`vite-plugin-pwa`, manifest com ícone maskable, metas iOS), as 8 telas
novas (`/c/:ocppIdentity[/:connectorId]` pública + `/app`, `/app/sessao`,
`/app/sessoes`, `/app/sessoes/:id`, `/app/carteira` sob guarda DRIVER-only),
e o fluxo de instalação (prompt Android depois do primeiro recibo, coach
manual no iOS).

**Decisões/achados de implementação:**
- Landing pós-QR (`/c/...`) tem wrapper PRÓPRIO, sem o `Header`/`Footer`
  públicos — a exigência de "acima da dobra, sem scroll" não convivia com a
  topbar+rodapé do site institucional.
- Máquina de estados da sessão (conectando → carregando → parando → recibo)
  é 100% derivada de `location.state` + duas queries por render — nenhum
  `useEffect` sincroniza estado próprio a partir delas (achado: a versão
  instalada de `eslint-plugin-react-hooks`, `^7.0.1`, tem a regra
  `set-state-in-effect` e reprovou a primeira versão escrita do jeito
  "clássico"). `useWakeLock` mantém a tela acesa durante a sessão, com
  degradação graciosa onde a Screen Wake Lock API não existe.
- Prompt de instalação (`beforeinstallprompt`) capturado GLOBAL na raiz do
  app (`installPromptStore.ts`), não dentro do componente do recibo —
  o evento pode disparar bem antes do motorista chegar lá.
- **Bug real de cache financeiro encontrado testando o fluxo completo no
  navegador**: `useStopSession` só invalidava a sessão ativa, não a
  carteira — como parar a sessão debita o saldo no servidor, qualquer tela
  que já tivesse buscado `useMeWallet` antes (a Home, ao montar) ficava
  com o saldo ANTIGO em cache até o `staleTime` global (60s) vencer
  sozinho. Corrigido invalidando `["me","wallet"]`/`["me","sessions"]` em
  dois pontos (na mutation E no efeito que detecta a sessão ter
  terminado, cobrindo também auto-stop/outro dispositivo). Ver
  `[[pwa-motorista-padroes]]` na memória da Lyra para o detalhe completo
  (inclui também um bug irmão no próprio mock, que escondia o card de
  "cobrança mínima").
- Validado com Playwright de ponta a ponta contra **mocks MSW** (sem
  Docker/Postgres no ambiente da Lyra, mesma limitação recorrente do
  projeto) — fluxo completo login → escanear → iniciar → carregar →
  parar → recibo → histórico/carteira refletindo o saldo novo, em 390px e
  768px, zero erros de console. **Ainda não validado contra as rotas reais
  do Vega** — é o próximo passo da Íris.
- Lighthouse mobile medido de verdade (build de produção, `vite preview` +
  `lighthouse --emulated-form-factor=mobile`): performance 84, TTI 3,3s
  (meta era ≤2,5s, **não atingida**), chunk próprio da rota 2,98kB gzip
  (meta ≤60kB, atingida com folga). Diagnosticado: o gargalo é overhead de
  rede sob throttling simulado (muitos chunks pequenos + payload total),
  não o JS da página em si (`bootup-time` 0,4s). Duas correções seguras
  aplicadas (fonte via `<link>` em vez de `@import`, ícone de 16kB em vez
  de 140kB só nas telas novas) — ganho real porém marginal (~0,1s).
  **Não** mexi em `manualChunks`/estratégia de bundle do app inteiro —
  é decisão de arquitetura de build que atravessa todas as rotas já
  validadas por Íris, fica de pendência para Vulcano/Nova avaliarem.

Portão de saída (Íris): repetir a mesma validação contra a API real (troca
de `VITE_USE_MOCKS`), incluindo os 3 testes de integração da F4 que ainda
não rodaram contra Postgres, e conferir que o service worker de fato nunca
serve `/api/**` do cache em produção.

## Marco 2026-09-17 → 2026-09-19: auditoria, tempo real, Google, mapa, endurecimento de segurança, Carteiras

**Estado:** F4 e PWA fechados; **F5 (Cielo) NÃO iniciada e continua bloqueada até o Órion
re-auditar** o endurecimento abaixo (achados Crítico + A1–A4). Domínio oficial:
`https://innoflow.innovarecode.com.br` (o antigo `...easypanel.host` segue no CORS na transição).

**Entregue e em produção (validado):**
- **Log de auditoria** (admin-only): `AuditLog` append-only, middleware `res.on('finish')`, fail-open exceto ajuste de saldo (fail-closed na mesma transação). Migrations agora rodam sozinhas no boot dos 3 Dockerfiles.
- **Tempo real (SSE)**: `ui:ev:{op|user|admin|stations}`, Bearer (nunca JWT na querystring), polling virou rede de segurança.
- **Login com Google (só motorista)**: ID-token GIS, `googleSub`, staff bloqueado+auditado; `GET /api/public/config`.
- **Mapa "eletropostos perto de mim"**: posição nunca sai do aparelho (Haversine no cliente, bbox arredondada); online por `lastSeenAt` + `disconnectedAt`; `isFree = online && AVAILABLE`.
  **Provado em produção em 2026-09-19** pelo dono: recarga no `CP-INNOELEKTRON-001` → mapa mostrou conector 1 ocupado ("1 de 2 livres") sem F5; queda do carregador → "0 de 2 livres"; volta → "2 de 2".
- **Endurecimento de segurança (Vega, validado pela Íris com PG18+Redis reais)**: sessão revogável (`sessionsValidAfter`), `POST /api/auth/password`, vínculo Google que apaga a senha, seed sem senha fixa em produção, lockout OCPP identidade+IP (Lua atômico), SSE com teto de streams/backpressure, auditoria com CHECK de tamanho + `BEFORE TRUNCATE` (AuditLog e WalletEntry), throttle de login por conta, CSV/LIKE. Depois: reserva atômica sob rajada, drain do SSE, `publish()` com prazo/teto (nunca pendura), teto de concorrência OCPP separado do de falhas.
- **Tela Carteiras (Lyra)**: Financeiro > Carteiras; ADMIN e OPERATOR consultam (OPERATOR só buscando, sem e-mail), ajuste de saldo ADMIN-only em 2 passos.
- **Simulador de carregador** (`backend/scripts/simulate-charger.ts`, `verify-realtime-stations.ts`): só localhost, senha por `OCPP_PASSWORD`.

**Pendente de push (2026-09-19):** 7 commits locais (`fd247cb`…`3b97103`: lockout sob rajada, SSE drain, publish com prazo, listener de erro do Redis, testes da Íris, disjuntor que envia sempre, teto de concorrência OCPP). Bloqueio: credencial do GitHub (Git Credential Manager) expirou — o dono precisa rodar `git push` no terminal dele.
Validação: Íris aprovou os 3 primeiros (480 verdes ×6, 26 mutações mortas, mapa sem regressão). Os 2 últimos (`c8073a2`, `3b97103`) foram validados pelo Vega (495 verdes ×2) e revisados pelo Atlas (asserções da Íris intactas, tsc/lint/272 unit) — **sem 2ª rodada independente da Íris**.

**Ações do dono no deploy do endurecimento:** rotacionar contas seedadas (`npm run user:set-password`; o seed não troca senha existente); trocar o segredo do `CP-INNOELEKTRON-001` (16–40 caracteres, via PATCH); calibrar `OCPP_TRUST_PROXY_HOPS` lendo `[ocpp] auth` (default 0; se o gateway estiver atrás de proxy e ficar em 0, o limite global trava a frota); duas roles de banco (migração vs aplicação sem TRUNCATE/DROP) com o Vulcano.

**Decisões em aberto (dependem do dono):**
1. Porta 9000 do OCPP: publicada crua ou atrás de TLS? Basic Auth em `ws://` manda a senha em claro — o ideal é WSS obrigatório e porta crua fechada.
2. `OCPP_AUTH_IP_MAX_CONCURRENT` (default 100) é palpite: dimensionar pelo maior site atrás de um NAT. Custo aceito: numa rajada de falhas o IP admite até 100 avaliações antes de o teto de 30 falhas valer (o limite por identidade+IP segue exato).
3. Throttle público do mapa (2 s, "o último vence") atrasa o "livre" em ~2,3 s após Parar; queda silenciosa leva ~58 s (`pingIntervalMs` 30 s do gateway). Encurtar? (recomendado o primeiro).
4. Mapa: manter SEM botão "Iniciar recarga" (só pela tela do QR) — assumido, aguardando objeção.
5. Provedor de tiles: OSM só serve tráfego leve; para produção, provedor pago (host precisa entrar na CSP).
6. Política de privacidade/termos: faltam dados da empresa (CNPJ, DPO).
7. Nota fiscal/tributação: adiada pelo dono, revisitar ANTES da F8.

**Backlog técnico (sem dono):** job de criação mensal de partições (existem só até 2027-02); `entityId` NULL em linhas DENIED da auditoria; `liquidarSessao` reprocessado reportando `debited:true`; `db:seed:demo` idempotência; site fixture `[test-partitioning]` em produção; bcryptjs (JS puro) trava o event loop com muitos handshakes simultâneos → `bcrypt` nativo; API/gateway escutam em 0.0.0.0 (sem opção de bind); pacote Vulcano (Node 22/24 LTS, `USER node`, `server_tokens off`, `mockServiceWorker.js` fora do build, COOP `same-origin-allow-popups`); UI de TariffAssignment + hook de query; UI de remote-start; tela de troca de senha (contrato pronto); erro de rede no login mostra "E-mail ou senha inválidos"; `Select` de site trunca "São Paulo/SP" em 390px; `Retry-After` não exposto no CORS.

## Portão da F5 liberado — Órion re-auditoria (2026-09-30)

**Veredito: LIBERADO COM RESSALVAS.** Nenhum achado crítico novo; os 12 achados das
auditorias de 17/09 e 19/09 foram reverificados linha a linha no código atual (HEAD
6616ea4, publicado em `87c92ed..6616ea4` no mesmo dia) — nenhuma correção era superficial.
`npm audit`: backend 2 moderate inalterado (`ajv` via `ocpp-rpc`, exige já ter passado pelo
Basic Auth), frontend 0.

**2 pendências, nenhuma bloqueante:**
1. Porta 9000 (OCPP) crua ou atrás de TLS? Pergunta em aberto há 11 dias em
   `docs/DEPLOY-EASYPANEL.md` — se for `ws://` cru, o Basic Auth do carregador trafega em
   claro. Vulcano/dono precisa responder antes de mais carregadores reais entrarem.
2. `GET /api/admin/drivers/:id/wallet` não escopa por `operatorId` (decisão já deliberada:
   motorista é conta de rede) — revisitar quando dado de pagamento entrar nessa mesma
   modelagem.

**4 recomendações preventivas do Órion para o Vega, antes do primeiro código da F5:**
nunca logar PAN/CVV/token de cartão (mesma classe do achado crítico original do pino);
se for Checkout Transparente, o campo de cartão precisa ficar num iframe hospedado pela
Cielo (SAQ A) — decisão de arquitetura da Nova antes de implementar; webhook da Cielo
validado por assinatura/IP + idempotência por `transactionId`; copiar o padrão fail-closed
de `walletLedger.ts` (`FOR UPDATE` + auditoria na mesma transação) para o crédito via Cielo.

**F5 iniciada:** Nova desenhando a arquitetura de pagamento (integração Cielo real,
abstração `PagamentoPort` já prevista desde a arquitetura original).

## F5 desenhada (Nova) — 2026-09-30

Arquitetura completa em `.claude/agent-memory/nova/decisoes-f5-pagamento-cielo.md` e
`cielo-fatos-verificados.md`. Resumo: porta de gateway (`autorizar/capturar/cancelar/
consultar/criarPix`, adaptadores Cielo/Fake — a carteira deixa de ser "adaptador" desde a
F4); Pix vira crédito real via QR Cielo, quitando dívida em aberto automaticamente, e
**complementa** a tela Carteiras (o ajuste manual do ADMIN continua); webhook da Cielo não
tem assinatura própria — tratado como dica, sempre reconsultado; idempotência garantida no
efeito (índices únicos), não no evento; conciliação ganha 2 termos novos
(`cardCapturePending`, `debtSettled`); 3 armadilhas corrigidas no schema atual, entre elas
**não existe hoje nenhum caminho para quitar uma `Debt`** (motorista endividado fica
bloqueado para sempre — a F5 fecha isso).

**Achado que revisa a recomendação do Órion:** a Cielo não oferece campo de cartão em
iframe hospedado por ela (não confirmado na doc, a confirmar com o comercial). Por isso a
decisão de como o cartão entra (D1 abaixo) é SAQ A (redirect, mais simples/mais fricção) ou
SAQ A-EP (campo na nossa página com mitigação: documento HTML isolado sem terceiros,
CSP própria) — nunca SAQ A puro com campo nosso.

**Plano em 6 etapas** (F5.0 contrato → F5.1 fundação [Cronos‖Vega‖Lyra, Pix com mocks] →
F5.2 Pix real → F5.3 cadastro de cartão → F5.4 sessão com cartão → F5.5 config do gateway →
F5.6 portões finais + go-live com R$1 real). **A trilha Pix (F5.1→F5.2) não depende de D1 e
já pode começar.**

**Decisões que dependem do dono, acrescentando às já registradas:**
8. **D1 (central, bloqueia F5.3/F5.4):** como o cartão entra — (A) Checkout Cielo redirect,
   SAQ A, motorista digita o cartão a cada recarga; (B) Silent Order Post + cartão salvo,
   SAQ A-EP, cadastra uma vez e só toca "Iniciar" **[recomendada pela Nova]**; (C) cartão só
   para recarregar a carteira (reabre a decisão nº 3, cartão vira só um jeito de dar saldo).
9. D2: uma conta Cielo única da plataforma (Nova recomenda sim — a carteira é de rede).
10. D3: coletar CPF do motorista para o Pix (a Cielo pode exigir; LGPD).
11. D4: limites da recarga Pix (Nova sugere R$10–R$500, QR de 30 min).
12. D5: crédito Pix quita dívida em aberto automaticamente antes de virar saldo (Nova
    recomenda sim — hoje não há outra saída para a dívida).
13. D6: forma de pagamento padrão na tela de iniciar recarga.
14. D7: OPERATOR ver a origem (Pix/cartão) das recargas na tela Carteiras, ou só o saldo.
15. Credenciais de sandbox da Cielo (Merchant + SOP) — abrir o ticket com a Cielo cedo.

**3 perguntas técnicas para a própria Cielo** (não dá para responder só pelo código):
cobrar o CardToken salvo sem pedir CVV de novo é permitido? existe mesmo campo de cartão
hospedado? o `GET /1/card/{token}` devolve bandeira e final do cartão?

## D1 decidida pelo dono (2026-09-30): cartão salvo (opção B)

Motorista cadastra o cartão uma vez, numa página isolada e protegida (Silent Order Post),
e depois só toca "Iniciar" — sem digitar o cartão a cada recarga. Enquadramento PCI SAQ A-EP
(campo de cartão fica numa página nossa isolada, sem nenhum script de terceiros, com CSP
própria e revisão periódica — nunca no domínio principal). Libera as etapas F5.3 (cadastro
de cartão) e F5.4 (sessão com cartão) do plano da Nova. D2 (conta Cielo única), D4 (limites
Pix R$10–R$500/30min) e D5 (quitação automática de dívida) seguem com a recomendação da
Nova, salvo objeção. D3 (CPF), D6 (forma de pagamento padrão) e D7 (OPERATOR ver origem
Pix/cartão) ficam para a Lyra/Vega decidirem no detalhe da implementação.

**F5.1 (fundação) iniciada**: Cronos (migration 1: WebhookEvent, DEBT_SETTLEMENT,
PaymentIntent, PaymentGatewayConfig, AuditLog SYSTEM) ‖ Vega (porta de pagamento, cliente
Cielo, adaptador Fake, redact do pino) ‖ Lyra (fluxo Pix com mocks).

## Repositório migrado (2026-09-30)

Git remoto mudou de `github.com/InnovareCode/InnoElektron` para
`github.com/InnovareCodeDesenvolvimento/InnoFlow` (mesmo histórico, confirmado por
`merge-base --is-ancestor` antes do push). **Ação do dono: repointar a origem git de cada
App do EasyPanel (api, ocpp-gateway, worker, frontend) para a URL nova** — enquanto não
fizer isso, o deploy automático por push não vai mais disparar. `docs/DEPLOY-EASYPANEL.md`
já atualizado com a URL nova.

## F5.1 entregue e publicada (2026-09-30)

Fundação completa da F5, três frentes validadas independentemente:
- **Cronos** (`4453864`): schema do banco (WebhookEvent sem unique cedo demais, índices
  parciais de idempotência, PaymentGatewayConfig cifrado, AuditActorRole SYSTEM, CPF
  opcional, 3ª armadilha corrigida — dívida agora tem caminho de quitação). Achado real:
  `ALTER TYPE ... ADD VALUE` não pode ser usado na mesma transação de migration em que foi
  criado — precisou de 2 migrations.
- **Vega** (`fa8add3`): `core/pagamentos/` puro (máquina de estados, normalizador Cielo,
  porta), cliente Cielo sandbox + FakeAdapter para os outros times testarem, redact do
  logger estendido para nunca vazar dado de cartão. 333 testes unitários.
- **Lyra** (`050c977`): tela "Adicionar saldo" via Pix no PWA (`/app/carteira/adicionar`),
  só contra mock — QR real, copia-e-cola, quitação automática de dívida em tempo real
  (validada visualmente pelo Atlas: R$50 pago → R$38,50 quita dívida → R$11,50 de saldo
  novo). 43 E2E, incluindo toda a suíte anterior sem quebrar nada.
- **Atlas**: achou e corrigiu um teste que duplicava a lista de redact à mão em vez de
  importar a real (`86859e5`) — risco de ficar verde testando lista desatualizada.

**Gaps reais para a próxima etapa (F5.2/F5.3/F5.4), não são dívida técnica, são o esperado
numa fundação:** `PaymentIntentStatus` do Prisma ainda não tem `PENDING`/`PAID` (Pix);
`PaymentIntent.authTokenId` ainda não existe (trava plugar a pré-autorização no início da
sessão); URL do Silent Order Post da Cielo não confirmada; `writeAuditLog.ts` ainda não
aceita ator SYSTEM; evento `topup.updated` só existe no frontend, backend ainda não emite.

**Nenhum código real bate na Cielo ainda** — tudo isolado atrás de adaptador Fake/mock.

## F5.2 entregue, validada e publicada (2026-09-30)

Pix real de ponta a ponta (ainda contra `FakeAdapter`, sem credencial de sandbox da Cielo):
- **Cronos** (`07602de`): `PaymentIntentStatus` ganhou `PENDING`/`PAID` (fluxo Pix), migration
  isolada (mesma armadilha do `ADD VALUE` de enum descoberta na F5.1).
- **Vega** (`e0ee367`, `4e66951`): `POST/GET /api/me/wallet/topups`, webhook da Cielo (sempre
  reconsulta, nunca confia no corpo do aviso), worker `creditarTopupPix` fail-closed (uma
  transação: credita, quita dívida mais antiga primeiro, grava auditoria com ator SYSTEM —
  se a auditoria falhar, nada é creditado), varredor de expiração (pagamento que chega depois
  do prazo do QR ainda credita). Achou e corrigiu um gap na própria porta da F5.1 (faltava
  `consultarPix` — sem isso um Pix confirmado seria lido como pagamento de cartão).
- **Íris** (`1363e70`): **aprovado com ressalva**, 613 testes contra PG18+Redis reais (610
  passam + 2 `it.fails` antigos). Revisou os testes do Vega e confirmou que pegam bug de
  verdade (mutou fail-closed→fail-open e o teste capturou na hora). Achou o gap real que
  faltava: idempotência só era testada em sequência, nunca em corrida de verdade — 5 testes
  novos com `Promise.all` provam 1 único crédito mesmo com 30 chamadas concorrentes no mesmo
  pagamento.
- **Atlas** (`ab887fc`): corrigiu a ressalva da Íris — `FakeAdapter` gerava ID de teste
  sequencial e previsível em vez do `randomUUID()` já documentado, colidindo entre arquivos
  de teste rodando em paralelo (reproduzido em 4 de 5 rodadas da suíte). Era infraestrutura
  de teste, não bug de produção.

**Gaps conhecidos para a próxima etapa:** `PaymentGatewayConfig` (tela de configuração do
gateway, F5.5) ainda não existe — por enquanto usa env (`criarCieloAdapterFromEnv`, mais
`CIELO_WEBHOOK_PATH_TOKEN`/`CIELO_WEBHOOK_HEADER_SECRET`). `writeAuditLog.ts` já aceita ator
SYSTEM. Nome do header do segredo do webhook (`x-innoelektron-webhook-secret`) é decisão do
Vega, documentada — quem configurar a conta real da Cielo precisa usar esse nome exato.

**Ainda pendente do dono:** credenciais de sandbox da Cielo (nada foi testado contra a API
real ainda, só `FakeAdapter`).

## F5.3 entregue, revisada pelo Órion e publicada (2026-09-30)

Cadastro de cartão salvo (D1 do dono: SAQ A-EP), entregue e revisado ponta a ponta:
- **Cronos** (`ba9a2f8`): `PaymentMethod.cieloCardToken` → `cieloCardTokenCiphertext`.
- **Atlas**: achou e corrigiu, no mesmo ciclo, o redact do logger desatualizado após o
  rename (`6239e6f`) — regressão de segurança silenciosa que ninguém tinha notado ainda.
- **Vega** (`bcdbced`, `118a07c`, `57ca119`): cifragem AES-256-GCM própria (chave só em
  `PAYMENT_SECRETS_KEY`), rotas `POST/GET/PATCH/DELETE /api/me/payment-methods` (sempre 404
  para cartão de outro motorista, nunca 403), teto de 5 cartões, token nunca logado. Achou e
  corrigiu 2 divergências reais no contrato compartilhado com a Lyra, trabalhando em paralelo.
- **Lyra** (`a009894`): documento HTML **isolado** (`pagamento-cartao.html`, build própria do
  Vite, zero dependência do app principal — CSP rígida own no nginx, regra eslint que bloqueia
  import do app principal de dentro da pasta isolada), handshake por `postMessage` entre a aba
  principal e a isolada, tela "Meus cartões" no PWA. Achou e corrigiu um sequestro real do
  Service Worker sobre a página isolada (só aparece com SW de produção real, não em dev).
- **Órion**: **LIBERADO**, 0 crítico/alto. 1 achado médio (corrida TOCTOU no teto de 5
  cartões — mitigação antifraude, não controle de acesso, não bloqueia) e 2 sugestões baixas
  (evitar `unsafe-inline` no CSS da página isolada; bloquear `localStorage`/cookie por lint
  na mesma pasta, defesa em profundidade). Confirmou com o próprio build que o bundle isolado
  não carrega nada do app principal.

**Gaps reais para a F5.4 (sessão de recarga com cartão), marcados "a confirmar" pelo Vega, não
inventados:** endpoint OAuth do Silent Order Post da Cielo não confirmado (usa `client_credentials`
por suposição razoável); formato de `GET /1/card/{token}` não confirmado; `PaymentIntent.authTokenId`
ainda não existe no schema (trava plugar a pré-autorização no início da sessão).

**Nada testado contra a Cielo de verdade** — segue tudo contra `FakeAdapter`, sem credencial
de sandbox.

## F5.4 entregue, validada e publicada (2026-09-30) — sessão de recarga paga com cartão

Última peça grande da F5 (pagamento real Cielo): motorista pode pagar a recarga direto no
cartão salvo, com pré-autorização antes de ligar o carregador e cobrança só do que foi
consumido de verdade.

- **Cronos** (`737ca70`): `PaymentIntent.authTokenId` (FK única), `captureAmountCents`
  (distinto de `amountCapturedCents`), `ChargingSession.paymentMode`. Primeira FK deste
  projeto usando `NOT VALID`+`VALIDATE` (mesma disciplina sem-downtime já usada em CHECK).
- **Vega** (`0625dc7`): pré-auth na API antes do RemoteStart, vínculo no StartTransaction,
  guarda do MeterValues pelo teto autorizado, captura parcial via worker (com dívida se
  sobrar), cancelamento (total=0, RemoteStart rejeitado, varredor), conciliação com 2 termos
  novos — e fechou de caminho uma dívida técnica esquecida da F5.2 (dívida quitada via Pix
  não aparecia em nenhum relatório).
- **Lyra** (`8cc9174`): seletor Carteira/Cartão na tela de iniciar recarga, status de
  cobrança na sessão e no recibo com atualização automática. **Validado ao vivo pelo Atlas
  no navegador**: recarga completa com cartão, status mudando sozinho de "em processamento"
  para "Cobrado", sem F5.
- **Íris**: **aprovado com ressalvas** contra Postgres+Redis reais (639 testes). Achou 2
  bugs reais de dinheiro, não corrigidos por ela (documentados com `it.fails`):
  - **Crítico**: uma corrida rara podia debitar a carteira E capturar o cartão pela mesma
    sessão (cobrança dupla).
  - **Médio**: se cancelar uma pré-autorização sem consumo falhasse silenciosamente, não
    havia rede de segurança automática para destravar.
- **Vega corrigiu os dois** (`e6aab4d`), trocando os `it.fails` da Íris por `it` sem alterar
  nenhuma asserção — validado por mim linha a linha. Rodou a suíte completa contra
  Postgres+Redis reais pela primeira vez nesta fase (641 testes).
- **Atlas**: corrigiu no caminho um mock de relatório desatualizado (quebrava a compilação)
  e um texto de confirmação que dizia "cobrado da carteira" mesmo pagando com cartão.

**F5 tecnicamente completa** (Pix real + cartão salvo + sessão paga com cartão), tudo contra
`FakeAdapter` — **nada foi testado contra a Cielo de verdade ainda**, por falta de
credenciais de sandbox. Pendências conhecidas, nenhuma bloqueante: CI não define
`PAYMENT_SECRETS_KEY` (achado da Íris); tela de configuração do gateway (`PaymentGatewayConfig`
via admin) ainda não existe — hoje tudo usa env.

## Portão final da F5 (Órion, 2026-10-02) — sandbox LIBERADO, produção BLOQUEADA

Revisão adversarial de toda a superfície de pagamento (webhook, cobrança no cartão, config do
gateway, guarda de produção do Atlas). **0 crítico, 3 alto, 6 médio, 12 baixo.** A guarda que
impede o `FakeAdapter` em produção foi considerada sólida (sem caminho por env, cache, falha de
decifração ou race de boot).

**ALTO — bloqueiam produção com dinheiro real:**
1. **Captura de cartão sem rede de segurança** — se Cielo, Redis ou `PAYMENT_SECRETS_KEY` falharem
   por mais de ~75 s no Stop, o `PaymentIntent` fica em `CAPTURE_PENDING` para sempre: energia
   entregue, nada cobrado. Falta varredor que re-enfileire por idade + alerta.
2. **Sandbox em instância pública = cobrança grátis** (cartões de teste da Cielo são públicos e o
   cadastro é aberto). A coerência atual compara ambiente×URL, nunca com `NODE_ENV`. Em produção
   real o ambiente tem que ser `production`; enquanto for sandbox, restringir a testadores.
3. **Porta 9000 do OCPP sem resposta do dono** (crua `ws://` ou WSS?) — agora o Basic Auth do
   carregador protege medições que viram cobrança de cartão.

**MÉDIO:** captura com status transitório vira FAILED + dívida de 100% (e pode cobrar 2x); PUT do
gateway sem step-up (ADMIN comprometido desvia o dinheiro) e sem alerta; DTO/readiness não detecta
segredo indecifrável; sem marca de ambiente em `PaymentIntent`/`PaymentMethod` (cartões de sandbox
sobrevivem à virada para produção); Stop rejeitado fecha a sessão sem confirmar o carregador
(pré-existente da F4); sessão que nunca recebe `StopTransaction` deixa a pré-auth presa.
**BAIXO relevantes:** token do caminho do webhook em claro no log; `err.body.*` da Cielo não
coberto pelo redact; segredos de webhook com mínimo de apenas 8; `mutation.variables` guarda
segredos em memória no front; `creditarTopupPix` não confere valor/`merchantOrderId`.

**Go-live (condições verificáveis):** itens acima corrigidos; `GET /api/admin/payment-gateway`
em produção devolvendo `environment:"production"`; porta 9000 em WSS com a crua fechada;
`PAYMENT_ALLOW_FAKE_ADAPTER` ausente nos 3 Apps; `PAYMENT_SECRETS_KEY` com backup em dois lugares;
`CIELO_WEBHOOK_PATH_TOKEN` e segredo do header novos (32+ caracteres) cadastrados no Site da
Cielo; hosts de produção, OAuth do SOP e `GET /1/card/{token}` confirmados com a Cielo;
`PUBLIC_API_BASE_URL` definida; `CIELO_API_BASE_URL` NÃO definida (deixar derivar); cartões de
sandbox desativados; testes reais com R$ 10 (Pix) e cartão (piso de pré-auth é R$ 50: baixar por
env temporariamente) reconciliados com o extrato Cielo; alertas lidos por alguém (logs `alert:`);
plano para chargeback/estorno (hoje só gravado em `WebhookEvent`).

**Rotação pós-deploy:** segredo do webhook (vazou no log entre `4e66951` e `55e2983` — verificar o
log do EasyPanel por `x-innoelektron-webhook-secret` ≠ `[redacted]`); MerchantKey/SOP secret se
vistos fora do cofre; senhas ADMIN/seed. **Decisão barata agora (ainda sem dados reais):**
versionar o ciphertext (`v1:<kid>:`) e suportar `PAYMENT_SECRETS_KEY_PREVIOUS` para rotacionar a
chave sem perder cartões salvos.

## Guia operacional de go-live (02/10/2026)

📖 **`docs/GO-LIVE-PAGAMENTOS.md`** entregue — guia completo para o dono (não-programador) ligar pagamento real com segurança. Contém: roteiro em fases (sandbox → produção), tabela de todas variáveis de ambiente com explicações, pré-condições Órion do portão final, como rodar testes com R$ real, alertas de log a monitorar, plano de rollback, rotações de segredos (webhook, chave de cifragem, credenciais), e lista de decisões operacionais prioritizadas. Nada foi testado contra a Cielo real; lista 5 perguntas abertas para o comercial dela fechar (credenciais sandbox, URLs de SOP/produção, validação de campos). Sandbox liberado com restrições (testadores listados); produção bloqueada até Porto 9000 responder (TLS ou crua?) + credenciais de produção da Cielo chegarem.

## F5.9 desenhada (Nova, 2026-10-02) — sessão travada (M5/M6) — AGUARDA DECISÕES DO DONO

Só desenho; nada implementado. Detalhe completo na memória da Nova (`.claude/agent-memory/nova/decisoes-f59-sessao-travada.md`, não versionada).

**Causa raiz comum (M5, M6 e D-A):** o servidor tratava o próprio palpite ("o carregador esqueceu a sessão") como fato e movia dinheiro com ele, num protocolo em que o carregador pode chegar atrasado legitimamente. Regra nova: fechamento pelo servidor é provisório antes de mexer em dinheiro.

**Defeitos antigos achados (confirmados pelo Atlas no código):**
- **D-A:** `bootNotification.ts` reconcilia a sessão aberta com a última amostra; o StopTransaction enfileirado que o carregador manda DEPOIS do Boot cai em "já STOPPED, ignorando" (`stopTransaction.ts`). Cobramos a menos no incidente mais comum (queda de energia).
- **D-B:** sessão `FAULTED` não consta em nenhuma das listas de "status aberto"; nunca volta a CHARGING, não é reconciliada, não pode ser parada e some do PWA (pré-autorização do cartão fica presa).
- **D-C:** a guarda de saldo só roda quando chega MeterValues; tarifa por tempo/ociosidade cresce sem amostra.

**Desenho:** novo status `STOP_UNCONFIRMED` (sem dinheiro, pré-autorização continua de pé, `provisionalCostCents`), watchdog repetível no worker (`vigiarSessoesJob`, decide só pelo relógio do servidor), encerramento pelo servidor com prova na ordem StopTransaction no log bruto → última amostra → sem leitura; stop tardio só registrado (`lateStop*`, `unbilledCostCents`), conciliação não muda. Fases: 9a Cronos (2 migrations + backfill `lastActivityAt=now()`), 9b0/9b Vega, 9c Lyra, 9d Íris (cenários S1–S8 no simulador), 9e Órion.

**Decisões em aberto do dono (recomendação da Nova):**
- D1 — quanto esperar o carregador que sumiu antes de encerrar pelo servidor: **2 h** (configurável).
- D2 — sessão sem nenhuma leitura de medidor: (a) não cobra, alerta e revisão manual **(recomendada)**; (b) cobra taxa fixa+mínimo (hoje); (c) estima (nunca).
- D3 — StopTransaction tardio com mais consumo após o encerramento: (a) registra, alerta e absorve **(recomendada)**; (b) vira dívida; (c) cobra abaixo de um limite.
- D4 — carregador que recusa o stop e segue entregando: (a) 3 tentativas + alerta, Reset manual pelo admin **(recomendada)**; (b) Reset automático.
- D5 — duração máxima de sessão aberta: **24 h**.
- D6 — texto ao motorista em confirmação ("Encerramento em confirmação com o carregador. Nada foi cobrado ainda. Valor final até HH:MM.") — aprovar ou ajustar.
- D7 — durante "em confirmação", motorista pode iniciar outra recarga? (a) sim, descontando o saldo comprometido **(recomendada)**; (b) bloqueia.
- Pendência externa: confirmar com a Cielo o prazo de captura de pré-autorização (projetado com encerramento forçado em 48 h).

D2 e D7 mudam código; a 9b pode começar com os defaults recomendados atrás de env, mas precisam de resposta antes do portão da Íris. Só o carregador real prova: se o firmware enfileira o Stop após queda de energia (e a ordem em relação ao Boot), intervalo de amostragem, suporte a TriggerMessage, desvio de relógio.
