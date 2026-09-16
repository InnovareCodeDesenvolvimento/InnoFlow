# Um único Dockerfile para os 3 serviços Node do backend (api, ocpp-gateway,
# worker) — mesmo código, mesmo package.json, 3 entrypoints diferentes. O
# docker-compose.yml da raiz escolhe qual rodar via `command:` por serviço.
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npx prisma generate
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./package.json

# Sobrescrito por `command:` em cada serviço do docker-compose.yml
# (start:api / start:ocpp / start:worker).
CMD ["node", "dist/entrypoints/api.js"]
