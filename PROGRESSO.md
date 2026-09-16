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

**Ainda em aberto:**

2. **PIX:** confirmar o modelo de carteira pré-paga, e o que fazer com sobra
   de saldo. Devolução por PIX só funciona se houver saldo disponível na
   conta Pix do lojista — se a conta for de transferência automática, não
   dá para devolver.
3. **Teto da pré-autorização do cartão:** valor fixo (ex. R$ 200) ou
   estimado por tarifa × capacidade típica do carregador? Afeta a UX — a
   Cielo não permite autorização incremental, então ao atingir o teto a
   recarga para.
5. **Credenciais Cielo:** quem abre a conta sandbox (autoatendimento) e
   quem cadastra a URL de notificação no Site Cielo Gestão (exige 2FA pelo
   app — só o dono pode fazer, não dá para delegar ao código).
8. **Nota fiscal / tributação** da venda de recarga — fora do escopo técnico
   levantado até aqui, precisa de resposta antes da fase F8 (deploy).
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

**Rodando em paralelo agora (R1/R2/R3):**
- Cronos: `calcularCustoSessao()` (função pura, será reusada pelo Vega na
  Fase 4 real — dívida evitada de propósito), índices de relatório, 3
  colunas de painel ao vivo em `ChargingSession`, `seed-demo.ts`
  (determinístico, prefixo `demo-`, ~8-15 mil sessões sintéticas em 60
  dias com variação realista).
- Vega: as 7 rotas de agregação, escopo multi-tenant em `$queryRaw`
  (operatorId como parâmetro obrigatório, nunca concatenado), exportação
  CSV.
- Lyra: 6 telas (Dashboard, Financeiro, Movimento Diário, Faturamento,
  Sessões, Pagamentos) contra fixtures MSW fiéis ao contrato, prontas
  para trocar por API real quando R1/R2 terminarem.

Portão de saída (R4, Íris+Órion): consultas <500ms em 60 dias de dado
sintético; conciliação financeira fechando em zero; OPERATOR não vê um
centavo de outro operador em nenhuma das 7 rotas (nem forjando
`operatorId`/`siteId` na query).

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
  **Pendência de produto:** não existe endpoint `/api/admin/operators` —
  o campo `operatorId` no formulário de site/tarifa é texto livre para o
  ADMIN, ruim de usar; decidir se vale criar a rota de listagem.
