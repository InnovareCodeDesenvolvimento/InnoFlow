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
  (branch `main`), primeiro commit com tudo de F0/F1/F3a/F3b. Decisão do
  dono: validar a base contra Postgres/Redis reais via deploy no
  **EasyPanel** (servidor dedicado, deploy a partir do GitHub — não do
  docker-compose local), em vez de exigir Docker num ambiente local.
  Checklist completo em `docs/DEPLOY-EASYPANEL.md` (envs por serviço,
  comandos de migration/seed/teste de partição, nota de proxy/WebSocket).
  **Isso é o que finalmente fecha a pendência de validação** que se
  arrastava desde F0.
