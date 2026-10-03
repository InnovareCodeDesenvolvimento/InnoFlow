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
FROM node:20-alpine AS builder
# Alpine (node:20-alpine) nao vem com o binario `openssl` instalado. Sem ele,
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
RUN npm run build

FROM node:20-alpine AS runner
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/node_modules ./node_modules
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

# Sobrescrito por `command:` em cada serviço do docker-compose.yml
# (start:api / start:ocpp / start:worker).
#
# `npx prisma migrate deploy &&` — achado real em produção, 17/09/2026: as
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
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/entrypoints/api.js"]
