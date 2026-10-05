# InnoElektron — frontend (serviço inno-elekton-frontend)
# Build: Vite + React + TypeScript · Serve: Nginx
# EasyPanel: Build Path = frontend
#
# N-3 da auditoria pré-produção (05/10/2026): Node 22 LTS no build (o 20 saiu de suporte em
# abril/2026) e nginx 1.30 (linha ESTÁVEL; o 1.25 usado antes não recebia mais correção).

# ---- Stage 1: Build ----
FROM node:22-alpine AS builder

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

# Teto do heap do Node para o build (MB). Medido: `tsc -b` PASSA com 448 MB e ABORTA com 384 ("JavaScript heap out of memory");
# o `vite build` quase nao usa heap JS (o resto do pico, ~0,6 GB, e memoria nativa do rolldown). O V8 do Node 22 costuma derivar o
# teto padrao de ~1/4 da memoria do container (2 GB -> ~512 MB, a poucos MB do piso do tsc, que sobe com o codigo; comportamento
# conhecido do V8, NAO medido num container aqui): fixar 1536 (~3,4x o piso) tira o limite artificial. NAO reserva memoria: se o servidor nao tem, o kernel mata o build e o script diz isso no fim do log.
# `scripts/build-docker.sh` roda o MESMO `npm run build` (tsc -b && vite build && vite build do cartao, nada mudou na saida),
# imprime a memoria disponivel no comeco e, se falhar, a causa provavel no fim (OOM/heap/TS/rede). Ver docs/FLUXO-DE-PUBLICACAO.md.
ARG BUILD_MAX_OLD_SPACE_MB=1536
ENV BUILD_MAX_OLD_SPACE_MB=$BUILD_MAX_OLD_SPACE_MB
RUN sh scripts/build-docker.sh

# ---- Stage 2: Serve ----
# `nginx:1.30-alpine` = linha estável do nginx (1.30.x). Acompanhe a linha estável (as pares:
# 1.30 -> 1.32...), não a mainline (ímpares), para o runner não pegar mudança de comportamento.
FROM nginx:1.30-alpine AS runner

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

# SEM `USER` aqui, de propósito (N-3): o processo MASTER do nginx sobe como root porque (1) escuta na
# porta 80 (privilegiada) e (2) o entrypoint da imagem oficial escreve o /etc/nginx/conf.d/default.conf
# gerado pelo envsubst e o /var/run/nginx.pid. Os WORKERS — os que de fato atendem requisição e tocam
# em tráfego externo — já rodam como o usuário `nginx` (diretiva `user nginx;` do nginx.conf da imagem).
# Sem Node/shell de aplicação no container, só arquivos estáticos + proxy. Para rodar 100% sem root é
# preciso trocar a base por `nginxinc/nginx-unprivileged` (escuta na 8080) E mudar a porta do proxy do
# serviço no EasyPanel de 80 para 8080 — decisão operacional do dono, não feita aqui para não derrubar
# o site (502) se a porta não for trocada junto. `nginx.conf.template` precisaria de `listen 8080;`.
EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
