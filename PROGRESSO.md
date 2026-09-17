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
completando o fluxo. Mas revelou um **gap real do sistema**: não existe
reconciliação para quando um charge point reconecta com uma sessão ainda
aberta — em produção real isso também aconteceria com queda de energia,
mau contato, reinício de firmware. Registrado em memória para quando a
robustez de produção da sessão for revisitada.

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
