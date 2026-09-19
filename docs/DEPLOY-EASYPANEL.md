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

⚠️ **`CORS_ALLOWED_ORIGINS` (só o App `api` precisa, os outros dois ignoram
— `ocpp-gateway` é WebSocket puro, sem Express/CORS):** achado "importante"
da auditoria do Órion, corrigido em 2026-09-17 — `cors()` sem allowlist
aceitava qualquer origem. O default sem esta env (`http://localhost:5173,
http://localhost:4173`) só cobre dev local; **sem configurar em produção com
o domínio público real do App `inno-elekton-frontend`
(`https://<algo>.easypanel.host`, confira o domínio exato na aba "Domínios"
do App no EasyPanel), toda chamada do frontend em produção quebra com 403
`CORS_FORBIDDEN`** — mesmo o Nginx proxiando `/api/*` na mesma origem
internamente (nota acima), o navegador ainda manda o header `Origin` do
domínio público do frontend, e a API confere esse header antes de responder.
Formato: lista separada por vírgula, sem barra final.

```
# Domínio OFICIAL (19/09/2026): https://innoflow.innovarecode.com.br
# Mantém o domínio antigo *.easypanel.host na lista durante a transição
# (sessões/PWA já instalados nele); remova quando ninguém mais usar.
CORS_ALLOWED_ORIGINS=https://innoflow.innovarecode.com.br,https://innovare-code-inno-elekton-frontend.6ytvem.easypanel.host
```

**Domínio oficial `https://innoflow.innovarecode.com.br`** (19/09/2026): apontado
no App `inno-elekton-frontend` (aba "Domínios" do EasyPanel; certificado HTTPS
emitido pelo próprio EasyPanel). Ao trocar/adicionar um domínio, três lugares
precisam saber — esquecer qualquer um quebra uma parte específica:

| Onde | O que quebra se esquecer |
|---|---|
| `CORS_ALLOWED_ORIGINS` (App `api`) | login/cadastro/qualquer POST → 403 "Origem não permitida" |
| Google Cloud → "Origens JavaScript autorizadas" | o botão "Continuar com o Google" mostra erro de origem |
| QR codes/adesivos dos carregadores | apontam para o domínio antigo (o QR deve codificar sempre o domínio OFICIAL: `https://innoflow.innovarecode.com.br/c/<ocppIdentity>/<conector>`) |

PWA já instalado no domínio antigo é uma instalação **separada** (origem
diferente): o motorista precisa instalar de novo a partir do domínio oficial.

**`GOOGLE_CLIENT_ID` (opcional, só o App `api` usa):** login/cadastro de
motorista com Google (2026-09-19). É o "ID do cliente OAuth" (tipo *Aplicativo
da Web*) criado no Google Cloud Console — público por desenho do Google, por
isso mora aqui e não no build do frontend: dá para ligar/desligar sem rebuild.
Sem a env (ou em branco), o botão "Entrar com Google" simplesmente não aparece
(`GET /api/public/config` devolve `googleClientId: null`) e
`POST /api/auth/google` responde 503 `GOOGLE_NOT_CONFIGURED`. No Google Cloud
Console, cadastre o domínio público do frontend em **"Origens JavaScript
autorizadas"** (sem isso o botão do Google recusa abrir) — cadastre
`https://innoflow.innovarecode.com.br` e, durante a transição, também o
domínio antigo `*.easypanel.host`.

```
GOOGLE_CLIENT_ID=<id>.apps.googleusercontent.com
```

⚠️ **`TRUST_PROXY_HOPS` (default `2`, só o App `api` usa de verdade):** sem
`app.set('trust proxy', ...)`, `req.ip` seria sempre o IP de um proxy, nunca
o do cliente — o `ipAddress` do audit log ficaria inútil e o rate limit de
login por IP contaria todos os usuários num balde só. São **2 proxies** entre o
cliente e a API (edge do EasyPanel + nginx do frontend) — o valor `1` que
estava aqui antes era um erro, medido em produção (19/09/2026): `x-forwarded-for`
chegava como `cliente, 10.11.0.16` e o IP gravado era `10.11.0.16`. Só mexer se
entrar um proxy/CDN/LB novo na frente — e conferindo um log real antes: hops a
MAIS deixa o cliente forjar o próprio IP.

⚠️ **Autenticação do gateway OCPP (Órion A1, 19/09/2026).** A identidade do carregador é
PÚBLICA (`GET /api/sites` devolve `ocppIdentity`), então a única credencial dele é o
`basicAuthSecret` — agora **16 a 40 caracteres** na criação/edição (era 8). O limite de
tentativas passou a contar FALHAS por **(identidade + IP)** e por **IP** (antes só por
identidade: qualquer um trancava o carregador real errando 5 senhas). Envs do App
`ocpp-gateway` (todas com default):

```
OCPP_AUTH_RATE_LIMIT_MAX_ATTEMPTS=5     # falhas do par identidade+IP na janela
OCPP_AUTH_IP_MAX_FAILURES=30            # falhas de um IP (qualquer identidade) na janela
OCPP_AUTH_RATE_LIMIT_WINDOW_SECONDS=300
OCPP_TRUST_PROXY_HOPS=0                 # proxies reversos entre o carregador e a porta 9000
```

`OCPP_TRUST_PROXY_HOPS` **não é** o `TRUST_PROXY_HOPS` da API (o caminho até a porta 9000 é
outro). Default `0` = usa só o endereço do socket — correto se a porta for exposta direto;
**atrás de um proxy, sem configurar, todos os carregadores compartilham o IP do proxy** e o
limite por IP passa a valer para a frota inteira. Para acertar: conecte UM carregador e leia o
log `[ocpp] auth: ...` (campos `clientIp` e `xForwardedFor`); só então ajuste os hops —
**hops a mais deixam o cliente forjar o próprio IP**. Bloqueio de uma identidade CONHECIDA gera
um `warn` com `alert: "ocpp_auth_lockout"` (procure por ele nos logs). Pergunta em aberto
(Vulcano): a porta 9000 é publicada crua ou atrás de TLS (WSS)? Basic Auth em `ws://` trafega a
senha em claro; o ideal é WSS obrigatório e a porta crua não exposta.

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

Qualquer rota SSE sob `/api/` terminada em `/events` (hoje: `/api/admin/events`,
`/api/me/events`) já tem uma regra genérica no `nginx.conf.template` com
buffering desligado e timeout longo — sem isso o Nginx seguraria os eventos
até fechar a conexão e o front nunca veria nada em tempo real. Achado real
17/09/2026: o bloco genérico de `/api/` usava `location ^~ /api/`, que faz o
Nginx pular TODA checagem de regex — mesmo com a rota certa, o bloco SSE
nunca seria alcançado. Corrigido; não reintroduza `^~` ali sem entender essa
consequência (comentário detalhado no próprio arquivo).

## 2. Migration (automática desde 17/09/2026 — não precisa mais rodar na mão)

**Histórico do problema que isto corrige**: o passo de migration era manual
(rodar no shell do App depois do deploy) — já esqueceu de rodar mais de uma
vez neste projeto, e a última vez derrubou rotas novas em produção com 500
("table does not exist") sem ninguém perceber até testar ao vivo. Agora os 3
`CMD` dos Dockerfiles (`Dockerfile`/`Dockerfile.ocpp`/`Dockerfile.worker`)
rodam `npx prisma migrate deploy` automaticamente antes de subir o processo
— seguro mesmo com os 3 serviços subindo ao mesmo tempo (lock consultivo do
Prisma no Postgres, quem chega depois só espera e não reaplica nada).

Ainda assim, o seed **não** roda sozinho (é dado de teste, não faz sentido em
todo boot) — rodar manualmente só quando quiser popular dados de teste:

```sh
npm run prisma:seed        # opcional — cria dados de teste (operator, site,
                            # charge point CP-INNOELEKTRON-001 com 1 conector
                            # DC CCS2 + 1 AC Tipo 2, tarifa com idle fee)
npm run db:test-partitioning   # confirma que a partição mensal está funcionando
```

⚠️ **Credenciais do seed em PRODUÇÃO (Órion C1, 19/09/2026).** Com
`NODE_ENV=production` o seed **nunca** usa senha padrão (as antigas —
`admin123456`, `staff123456`, `driver123456`, `changeme-basic-auth-secret` —
estão públicas no repositório). Cada credencial vem de uma env, e o que não
tiver env é **pulado com um aviso** (o usuário/carregador simplesmente não é
criado):

| Env | Cria | Regra |
|---|---|---|
| `SEED_ADMIN_PASSWORD` | `admin@innoelektron.example.com` (ADMIN) | mínimo 12 caracteres |
| `SEED_STAFF_PASSWORD` | `staff@innoelektron-operacoes.example.com` (OPERATOR) | mínimo 12 |
| `SEED_DRIVER_PASSWORD` | `motorista.teste@innoelektron.example.com` (DRIVER, com R$ 50 de teste) | mínimo 12 |
| `SEED_CHARGEPOINT_SECRET` | carregador `CP-INNOELEKTRON-001` (+ conectores e vínculo de tarifa) | 16 a 40 caracteres |

Passe-as só na linha do comando (não como env permanente do serviço) e nunca
as repita em log/chat: `SEED_ADMIN_PASSWORD='...' npm run prisma:seed`. Valores
por env **nunca são impressos**. O seed é idempotente e **não troca a senha de
uma conta que já existe** — para uma base que já foi semeada com as senhas
antigas, ROTACIONE com `NEW_PASSWORD='...' npm run user:set-password --
<e-mail>` (ou `--deactivate` para desativar a conta) e troque o segredo do
carregador com `PATCH /api/admin/charge-points/:id` (`basicAuthSecret`, 16 a 40
caracteres). Rotacionar também derruba as sessões abertas (`sessionsValidAfter`).

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
- [ ] `POST /api/auth/login` com um usuário do seed devolve um JWT — em produção
      com a senha que VOCÊ passou em `SEED_ADMIN_PASSWORD` (nunca a padrão; ver
      o aviso sobre credenciais do seed acima). Depois, troque-a pela tela/rota de
      senha (`POST /api/auth/password`).
- [ ] `GET /api/admin/charge-points` (com o JWT do ADMIN) mostra o
      `CP-INNOELEKTRON-001` do seed.
- [ ] Se subiu o simulador: ele conecta no `ocpp-gateway` e o `StatusNotification`
      aparece refletido no banco (consulta direta ou via `GET
      /api/admin/charge-points/:id`).

**Isto fecha a pendência que vem se arrastando desde F0**: é a primeira vez
que a migration, o seed e o handshake OCPP rodam contra um Postgres/Redis
reais, não só validação estática.
