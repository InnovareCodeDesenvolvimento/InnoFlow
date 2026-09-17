# Deploy no EasyPanel — checklist

Este projeto ainda não tem sessão de recarga completa nem pagamento (isso é
fase F4/F5, ver `PROGRESSO.md`). Este primeiro deploy serve para **validar a
base** contra Postgres/Redis reais — algo que nenhum agente conseguiu fazer
ainda por falta de Docker nos ambientes de desenvolvimento.

Repositório: https://github.com/InnovareCode/InnoElektron (branch `main`).

## 0. Bancos gerenciados

Crie no EasyPanel (como serviços de banco, não como App):

- **Postgres 16** — nome sugerido `innoelektron-postgres`. Anote a
  `DATABASE_URL` que o EasyPanel gera (formato
  `postgresql://usuario:senha@host:porta/banco` — o banco deve se chamar
  `innoelektron` para bater com o que o Prisma espera, ou ajuste a env
  abaixo).
- **Redis 7** — nome sugerido `innoelektron-redis`. Anote a `REDIS_URL`
  (`redis://host:porta`).

## 1. Três Apps a partir do MESMO repositório

`api`, `ocpp-gateway` e `worker` são o mesmo `backend/Dockerfile` — o que
muda é só o comando de start. Crie 3 Apps no EasyPanel, todos apontando para
`github.com/InnovareCode/InnoElektron`, branch `main`, **build context**
`backend/` (o Dockerfile está em `backend/Dockerfile`):

| App | Dockerfile (campo "Arquivo") | Porta interna | Exposta publicamente? |
|---|---|---|---|
| `api` | `Dockerfile` | 3000 | Sim (é a API REST/SSE que o frontend consome) |
| `ocpp-gateway` | `Dockerfile.ocpp` | 9000 | Sim, mas só para os carregadores (WebSocket) — ver nota de proxy abaixo |
| `worker` | `Dockerfile.worker` | — | Não, não escuta porta HTTP |

⚠️ **Build Path obrigatório:** os Dockerfiles ficam em `backend/`,
**não na raiz do repositório**. Na aba **Fonte** de cada um dos 3 Apps,
defina o **Build Path** (diretório de build) como `backend` — sem isso o
EasyPanel procura `Dockerfile` na raiz e o build falha com `failed to read
dockerfile: open Dockerfile: no such file or directory` (erro real visto no
primeiro deploy, 16/09/2026).

⚠️ **Método de build = Dockerfile, não Nixpacks/Buildpacks/Railpack.**
Nixpacks tenta autodetectar Node e roda a instalação com `NODE_ENV=production`
já ligado — isso faz o `npm ci` pular as dependências de desenvolvimento
(incluindo o `tsc`) e o build quebra com `tsc: not found`. Selecione
**Dockerfile** no bloco "Construção" da aba Fonte.

⚠️ **Comando de start não é configurável quando o método é "Dockerfile"**
— esse campo só aparece para Nixpacks/Buildpacks. Por isso existem **três
Dockerfiles** em `backend/` (`Dockerfile`, `Dockerfile.ocpp`,
`Dockerfile.worker`), idênticos exceto pelo `CMD` final — aponte o campo
**"Arquivo"** (mesmo bloco "Construção") para o Dockerfile certo de cada
serviço, conforme a tabela acima. Achado real em produção (17/09/2026): o
`ocpp-gateway` ficou rodando o entrypoint da API porque esse campo não
existia e o Dockerfile único sempre roda `api.js` por padrão.

### Variáveis de ambiente (as 3 apps precisam de TODAS — `lib/env.ts`
valida o schema inteiro em qualquer entrypoint, mesmo o que não usa direto):

```
NODE_ENV=production
DATABASE_URL=<a do Postgres do EasyPanel>
REDIS_URL=<a do Redis do EasyPanel>
JWT_SECRET=<gerar forte — openssl rand -base64 32 — NUNCA reusar o valor de dev do docker-compose.yml>
JWT_EXPIRES_IN=12h
PORT=3000
OCPP_PORT=9000
```

`OCPP_NODE_ID` pode ficar vazio (cada processo gera um UUID próprio no boot).

## 1.1 Frontend

App `inno-elekton-frontend`: mesmo repositório, **Build Path = `frontend`**
(mesmo problema do item acima — o Dockerfile é `frontend/Dockerfile`, não a
raiz). Build multi-stage (Vite → Nginx), porta interna **80**, exposta
publicamente.

O Nginx dentro do container já resolve `/api/*` **na mesma origem**,
proxiando pela rede interna do EasyPanel para o serviço da API — sem CORS,
sem precisar de subdomínio para a API. Isso depende de uma env/build-arg:

```
API_UPSTREAM=http://<projeto>_<nome-do-servico-da-api>:3000
```

O `frontend/Dockerfile` já tem um valor padrão
(`http://innovare-code_inno-elekton-beckend:3000`, baseado nos nomes de
serviço vistos no seu painel) — **confira se bate com o nome real do
serviço da API no seu projeto EasyPanel**; se divergir, sobrescreva a env
`API_UPSTREAM` no serviço do frontend (não precisa rebuild, é lida em
runtime pelo entrypoint do Nginx).

A rota de sessão ao vivo (`/api/sessions/:id/stream`, SSE) já tem uma
regra própria no `nginx.conf.template` com buffering desligado — sem isso o
Nginx seguraria os eventos até fechar a conexão e o front nunca veria nada
em tempo real.

## 2. Rodar a migration (uma vez, antes do primeiro boot valer a pena)

No shell do App `api` (ou via "Run command" do EasyPanel), depois do primeiro
deploy:

```sh
npx prisma migrate deploy
npm run prisma:seed        # opcional — cria dados de teste (operator, site,
                            # charge point CP-INNOELEKTRON-001 com 1 conector
                            # DC CCS2 + 1 AC Tipo 2, tarifa com idle fee)
npm run db:test-partitioning   # confirma que a partição mensal está funcionando
```

Se qualquer um desses falhar, é a primeira vez que a base é testada de
verdade contra um Postgres real — reporte o erro, não é esperado que passe
"quase".

## 3. Simulador de charge point (opcional, mas recomendado pro primeiro teste)

Ainda não há hardware real. Para provar que o `ocpp-gateway` aceita conexões
de verdade, suba também a imagem `ghcr.io/solidstudiosh/ocpp-virtual-charge-point:latest`
como um 4º App (não vem do nosso repositório, é imagem pública), com:

```
WS_URL=ws://<host interno do ocpp-gateway>:9000
CP_ID=vcp-easypanel-01
ENTRY_POINT=index_16.ts
ADMIN_PORT=9999
```

## 4. Se colocar um proxy/domínio na frente do `ocpp-gateway`

OCPP mantém WebSocket persistente com heartbeat (padrão do MVP: 120s). Se o
EasyPanel ou algo na frente dele faz proxy reverso, confirme:
- Upgrade de WebSocket habilitado.
- Timeout de leitura/idle **maior** que o heartbeat (ex. 300s).
- Isso também vale para as rotas SSE da API (`/api/sessions/:id/stream`) —
  desligar buffering.

Detalhes técnicos completos em `docs/PROXY-REVERSO.md`.

## 5. Smoke test pós-deploy

- [ ] `GET https://<domínio-da-api>/health` responde `ok` e confirma conexão
      com Postgres e Redis.
- [ ] `POST /api/auth/login` com um dos usuários do seed (senhas impressas no
      log do `npm run prisma:seed`) devolve um JWT.
- [ ] `GET /api/admin/charge-points` (com o JWT do ADMIN) mostra o
      `CP-INNOELEKTRON-001` do seed.
- [ ] Se subiu o simulador: ele conecta no `ocpp-gateway` e o `StatusNotification`
      aparece refletido no banco (consulta direta ou via `GET
      /api/admin/charge-points/:id`).

**Isto fecha a pendência que vem se arrastando desde F0**: é a primeira vez
que a migration, o seed e o handshake OCPP rodam contra um Postgres/Redis
reais, não só validação estática.
