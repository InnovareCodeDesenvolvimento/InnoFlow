# Um único Dockerfile para os 3 serviços Node do backend (api, ocpp-gateway,
# worker) — mesmo código, mesmo package.json, 3 entrypoints diferentes. O
# docker-compose.yml da raiz escolhe qual rodar via `command:` por serviço.
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

# Sobrescrito por `command:` em cada serviço do docker-compose.yml
# (start:api / start:ocpp / start:worker).
CMD ["node", "dist/entrypoints/api.js"]
