# Backend do serviço `api` — mesmo código-fonte de `Dockerfile.ocpp` e
# `Dockerfile.worker` (3 entrypoints do mesmo package.json), só muda o CMD
# final de cada um. No docker-compose.yml local, os 3 usam ESTE arquivo e o
# `command:` de cada serviço escolhe o entrypoint. No EasyPanel, como o
# método de build "Dockerfile" não permite sobrescrever o comando de start
# pela interface, cada serviço aponta pro Dockerfile certo (`Dockerfile`,
# `Dockerfile.ocpp` ou `Dockerfile.worker`) no campo "Arquivo" da aba Fonte —
# achado real em produção, 17/09/2026 (o `inno-elekton-ocpp` ficou rodando o
# entrypoint da API porque não havia como sobrescrever o CMD do Dockerfile
# único). Editou algo aqui? Copie a mudança pros outros dois — CI não pega
# divergência entre eles.
#
# N-3 da auditoria pré-produção (05/10/2026): Node 22 LTS (o 20 saiu de suporte
# em abril/2026), runner SEM devDependencies e rodando como `node` (não root).
# Estágios: builder (compila TS) -> prod-deps (só dependências de produção) ->
# runner (o que de fato roda).

# ---- Estágio 1: builder — instala TUDO (devDependencies inclusive) e compila ----
FROM node:22-alpine AS builder
# Alpine (node:22-alpine) nao vem com o binario `openssl` instalado. Sem ele,
# a propria deteccao de versao do OpenSSL que o Prisma roda (tanto aqui no
# `generate` quanto no runner abaixo, em runtime) falha silenciosamente e
# assume por padrao "openssl-1.1.x" (legado) mesmo com binaryTargets
# apontando linux-musl-openssl-3.0.x no schema.prisma — resultado: ele
# carrega o engine ERRADO mesmo tendo gerado o certo. Doc oficial do Prisma
# para Alpine: https://pris.ly/d/system-requirements (erro real visto em
# producao, 16/09/2026, mesmo depois de fixar binaryTargets).
RUN apk add --no-cache openssl
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npx prisma generate
# Teto do heap do Node so neste passo (nao afeta `npm ci`/runtime). Medido: `tsc` do backend PASSA com 512 MB e ABORTA com 384
# ("JavaScript heap out of memory", exit 134); o piso (~450 MB) sobe com o codigo e o padrao do V8 em container pequeno pode ficar
# perto dele. 1536 MB = ~3x o piso; nao reserva memoria. Mesma regra do frontend/Dockerfile. Copie a mudanca aos 3 Dockerfiles.
RUN NODE_OPTIONS=--max-old-space-size=1536 npm run build

# ---- Estágio 2: prod-deps — node_modules SÓ de produção (sem eslint/vitest/tsc/@types) ----
# Estágio próprio em vez de `npm prune` no builder: o `npm ci --omit=dev` parte do zero e é
# determinístico, e o client do Prisma é gerado de novo aqui (explícito) para não depender de
# o prune preservar `node_modules/.prisma`. Precisa de `openssl` pelo mesmo motivo do builder
# (detecção do Prisma) e do `prisma/` ANTES do `npm ci` (o postinstall do @prisma/client
# procura o schema).
# O que sobra de propósito, e por quê: `prisma` (CLI) — o CMD roda `prisma migrate deploy` a
# cada boot; `tsx` — seed e scripts operacionais (`npm run prisma:seed`, `user:set-password`,
# `payments:recifrar-segredos`, `db:seed:demo`, ver docs/DEPLOY-EASYPANEL.md) rodam no shell do
# serviço, em produção, direto do código-fonte. Por isso ambos estão em `dependencies` (o `tsx`
# foi promovido de devDependencies em 05/10/2026, N-3).
FROM node:22-alpine AS prod-deps
RUN apk add --no-cache openssl
WORKDIR /app
COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm ci --omit=dev
RUN npx prisma generate

# ---- Estágio 3: runner — não-root, sem devDependencies ----
FROM node:22-alpine AS runner
RUN apk add --no-cache openssl
# Cliente do PostgreSQL (pg_dump, pg_restore, psql) para o backup (job do worker e scripts/backup-db.sh, restore-db.sh,
# ver docs/RUNBOOK-BACKUP-RESTAURACAO.md). REGRA: o cliente tem de ser da MESMA versão do servidor ou mais nova; cliente
# mais velho que o banco se RECUSA a copiar. O 18 copia servidores 16, 17 e 18; se a Alpine desta imagem não o tiver, cai
# no 17 (copia servidores 16 e 17, mas não o 18: se o banco for 18, o backup falha dizendo exatamente o que atualizar). Na Alpine 3.22+ os
# binários moram em /usr/libexec/postgresqlNN e os atalhos em /usr/bin vêm do gatilho do pacote postgresql-common; o
# `pg_dump --version` abaixo (e o do estágio não-root, depois do USER) é a prova de que o atalho existe e roda.
RUN (apk add --no-cache postgresql18-client || apk add --no-cache postgresql17-client) \
  && pg_dump --version && pg_restore --version && psql --version
WORKDIR /app
ENV NODE_ENV=production
# `--chown=node:node` só no node_modules: o Prisma CLI/engines podem precisar escrever ali
# (ex.: baixar um engine faltante) e o app roda como `node`. O resto (dist, src, prisma,
# scripts) fica de root, somente leitura para o processo — o app não escreve em disco
# (só stdout; conferido em src/), então nada mais precisa ser gravável. HOME=/home/node
# (do usuário `node`) cobre o cache do Prisma/npm/tsx.
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./package.json
# seed.ts/seed-demo.ts rodam via `tsx` direto do código-fonte, não do build
# compilado (dist/) — e seed-demo.ts importa de src/core/tarifacao/. Sem
# copiar src/, "tsx prisma/seed-demo.ts" falha em produção com
# MODULE_NOT_FOUND (erro real visto em produção, 16/09/2026), mesmo com
# tudo compilado certo em dist/.
COPY --from=builder /app/src ./src
# scripts administrativos rodados à mão no terminal do serviço (F5.7: `npm run payments:recifrar-segredos` — rotação da PAYMENT_SECRETS_KEY, via tsx).
COPY --from=builder /app/scripts ./scripts

# Daqui em diante, não-root. Portas 3000 (api) e 9000 (ocpp) são > 1024: não precisam de root.
USER node

# O backup roda como `node`: confirma que o cliente executa sem root e que há onde gravar o dump temporário (/tmp).
RUN pg_dump --version && pg_restore --version && psql --version && tmp="$(mktemp -d)" && test -w "$tmp" && rm -rf "$tmp"

# Sobrescrito por `command:` em cada serviço do docker-compose.yml
# (start:api / start:ocpp / start:worker).
#
# `prisma migrate deploy &&` — achado real em produção, 17/09/2026: as
# migrations nunca rodavam sozinhas no deploy (só existia o passo manual
# documentado em docs/DEPLOY-EASYPANEL.md, "rodar no shell do App depois do
# deploy") — já esqueceram de rodar mais de uma vez, e a última vez derrubou
# duas rotas novas com 500 ("table does not exist") sem ninguém perceber até
# testar ao vivo. `migrate deploy` é seguro de rodar toda vez que o container
# sobe (idempotente: sem migration pendente, não faz nada) e seguro mesmo
# concorrente entre os 3 serviços (api/ocpp/worker sobem ao mesmo tempo,
# nenhuma ordem garantida entre eles) — o Prisma usa um lock consultivo no
# Postgres, quem chega depois só espera e não reaplica nada. Copie esta
# mesma mudança pros outros dois Dockerfiles — CI não pega divergência entre
# eles (mesmo aviso do comentário no topo deste arquivo).
#
# `node_modules/.bin/prisma` em vez de `npx prisma` (05/10/2026): se o binário local sumisse,
# o `npx` tentaria baixar o `prisma` MAIS RECENTE da internet (hoje, outra major — o schema é
# Prisma 5) e rodaria migration com ele. Chamando o binário direto, a falta dele é erro alto
# e imediato, não uma migration com a versão errada.
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && node dist/entrypoints/api.js"]
