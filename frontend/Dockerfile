# InnoElektron — frontend (serviço inno-elekton-frontend)
# Build: Vite + React + TypeScript · Serve: Nginx
# EasyPanel: Build Path = frontend

# ---- Stage 1: Build ----
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
# npm install (não npm ci): o lockfile pode ter sido gerado no Windows e
# omitir dependências nativas opcionais que o Alpine precisa para o build.
RUN npm install --prefer-offline --no-audit --no-fund

COPY . .

# VAZIO = mesma origem: o nginx deste container proxia /api para o
# container da API pela rede interna do EasyPanel (ver nginx.conf.template).
# Só defina um valor se a API tiver domínio público próprio.
ARG VITE_API_URL=""
ENV VITE_API_URL=$VITE_API_URL

RUN npm run build

# ---- Stage 2: Serve ----
FROM nginx:1.25-alpine AS runner

RUN rm /etc/nginx/conf.d/default.conf

COPY --from=builder /app/dist /usr/share/nginx/html

# O entrypoint do nginx processa /etc/nginx/templates/*.template com envsubst
# e gera /etc/nginx/conf.d/default.conf no start do container.
COPY nginx.conf.template /etc/nginx/templates/default.conf.template

# Endereço interno do serviço da API na rede do EasyPanel
# (<projeto>_<serviço>:porta). Ajuste SEM rebuild definindo a env
# API_UPSTREAM (runtime) no serviço do frontend, se o nome real divergir.
ARG API_UPSTREAM=http://innovare-code_inno-elekton-beckend:3000
ENV API_UPSTREAM=${API_UPSTREAM}

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
