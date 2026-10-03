# Deploy no EasyPanel — checklist

Este projeto ainda não tem sessão de recarga completa nem pagamento (isso é
fase F4/F5, ver `PROGRESSO.md`). Este primeiro deploy serve para **validar a
base** contra Postgres/Redis reais — algo que nenhum agente conseguiu fazer
ainda por falta de Docker nos ambientes de desenvolvimento.

Repositório: https://github.com/InnovareCodeDesenvolvimento/InnoFlow (branch
`main`) — migrado de `InnovareCode/InnoElektron` em 2026-09-30. **Os Apps já
criados no EasyPanel apontam para o repositório antigo**: repointe a origem
git de cada um (api, ocpp-gateway, worker, frontend) para a URL nova, senão
o deploy automático por push para de funcionar.

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
`github.com/InnovareCodeDesenvolvimento/InnoFlow`, branch `main`, **build
context** `backend/` (o Dockerfile está em `backend/Dockerfile`):

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
OCPP_AUTH_IP_MAX_CONCURRENT=100         # tentativas de um IP em andamento AO MESMO TEMPO (frota atrás de NAT reconectando junta)
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

### Gateway de pagamento (Cielo) — banco manda, env é reserva (F5.5, 02/10/2026)

**👉 LEIA O GUIA COMPLETO:** [`docs/GO-LIVE-PAGAMENTOS.md`](GO-LIVE-PAGAMENTOS.md) — contém roteiro operacional para sandbox/produção, tabela de variáveis de ambiente, alertas a monitorar, plano de rollback, e lista de decisões do dono. **Esta seção é apenas resumo técnico de como as variáveis funcionam.**

A conta Cielo da plataforma agora é configurada pela tela **Admin → Gateway de pagamento**
(`GET`/`PUT /api/admin/payment-gateway`, só ADMIN), sem editar variáveis no EasyPanel.
**Precedência:** o que foi salvo na tela (tabela `PaymentGatewayConfig`) **vale mais** que a env;
sem nada salvo, vale a env (comportamento anterior). Detalhes que evitam susto:

- **`merchantId` + `merchantKey` andam juntos** (idem `sopClientId` + `sopClientSecret`): se a tela
  salvou qualquer um do par, o par INTEIRO vem do banco — nunca "merchantId novo + chave velha do
  env". Por isso a tela exige reenviar a chave ao trocar o `merchantId` quando o par ainda vem do env.
  O segredo do header do webhook é independente (banco > `CIELO_WEBHOOK_HEADER_SECRET` > nenhum).
- **Segredos ficam cifrados no banco** (AES-256-GCM) com `PAYMENT_SECRETS_KEY`, que **só existe na
  env do servidor**. Sem ela a tela recusa gravar segredo (503 `PAYMENT_SECRETS_KEY_MISSING`); **se a
  chave for trocada/perdida, os segredos salvos não decifram e o gateway fica indisponível (503) —
  nunca cai no simulador.** Faça backup da chave junto com os demais segredos.
- **Ambiente decide as URLs.** `environment` salvo na tela escolhe `sandbox`/`production` e, junto, os
  hosts da Cielo. Se `CIELO_API_BASE_URL`/`CIELO_API_QUERY_BASE_URL` forem definidas **explicitamente**
  no servidor, elas ganham — e se contradisserem o ambiente (production com URL de sandbox, ou
  sandbox com o host oficial de produção) o servidor **recusa** (503) e loga `alert:
  payment_gateway_environment_url_mismatch`. Em geral **não defina essas duas envs**: deixe derivar.
  ⚠️ Hosts de produção (`https://api.cieloecommerce.cielo.com.br` / `https://apiquery.cieloecommerce.cielo.com.br`)
  **a confirmar na doc da Cielo antes do go-live** — não foram testados contra a conta real.
- **Virar produção** na tela exige confirmação digitada e que todo meio habilitado esteja pronto
  (`readiness`); senão 409 `GATEWAY_NOT_READY` com a lista do que falta.
- **Qualquer mudança de ambiente (sandbox ↔ produção, F5.8, M4c)** é SERIALIZADA com criações de pagamentos — 
  o lock consultivo no Postgres impede race conditions. Se houver pagamentos em trânsito, a tela responde
  **409 `GATEWAY_HAS_INFLIGHT_PAYMENTS`**: aguarde os intents finalizarem (o varredor de capturas roda a cada 60 s por padrão, `CARD_PREAUTH_SCAN_INTERVAL_MS`).
- **Cache e consistência:** a API invalida o próprio cache ao salvar; o `worker` é outro processo e
  enxerga a mudança em **até 10 s** (TTL). Para trocar credencial com segurança, desligue o meio na
  tela, troque, religue.
- **Desligar cartão/Pix só bloqueia COMEÇOS novos** (cadastro de cartão, pré-autorização, novo Pix).
  Captura, cancelamento, webhook, varredores e crédito de Pix já gerado continuam funcionando.
- **Captura de cartão serializada por intent (F5.8, 984a96b):** lock Redis `card-capture:lock:<intentId>` 
  com TTL ≥ 60 s (máx(60 s, 6 × CIELO_TIMEOUT_MS)), impede dois executores capturando o mesmo intent.
  Perdedor lança `CapturaCartaoEmAndamentoError` (job retenta com backoff; log `warn`). Se o Redis cair,
  falha fechada — prazo 5 s para SET/DEL, melhor atrasar a cobrança que cobrar em dobro.
- O `FakeAdapter` continua **proibido em produção**: sem credencial (banco **nem** env) o gateway
  responde 503; falha ao ler/decifrar a config também (fail-closed).
- **Trocar a config exige a SENHA ATUAL do admin (F5.7, step-up).** Todo `PUT` leva `currentPassword`;
  errada (ou conta sem senha) = 403 `INVALID_CURRENT_PASSWORD`, conferida **antes** de qualquer outra
  regra. 5 senhas erradas em 15 min trancam o step-up daquele usuário (429 `RATE_LIMITED_PAYMENT_GATEWAY`,
  60 s dobrando até 15 min — vale até com a senha certa durante o trancamento). O limite mora no Redis
  (se ele cair, segue sem o limite por usuário, mas o PUT continua limitado a 10/min e a senha continua
  sendo conferida). **Alertas no log** (procure por `alert`): `payment_config_changed` (toda gravação —
  traz o id do admin e só os NOMES dos campos, nunca valores), `payment_gateway_stepup_failed` (senha
  errada) e `payment_gateway_stepup_locked`. A senha nunca é logada nem auditada.
- **Redis do throttle indisponível (F5.8, fail-closed):** se o Redis que guarda o rate limit do step-up
  cair, o `PUT` responde **503 `STEPUP_UNAVAILABLE`** SEM sequer conferir a senha (é a falha segura —
  melhor bloquear a alteração da config do que deixar um token roubado contornar o rate limit em memória).
  O admin legítimo também leva 503. Alerta: `payment_gateway_stepup_unavailable`.

#### Sandbox em servidor de produção — só para testadores (F5.7, F5.8, ALTO-2)

Se o ambiente efetivo do gateway é **sandbox** e o servidor roda com `NODE_ENV=production` (o caso de
uma instância pública ainda sem a conta real), Pix e cartão **só funcionam para os motoristas cuja
identidade está VERIFICADA e o e-mail está em `PAYMENT_SANDBOX_TESTER_EMAILS`** (lista separada por vírgula,
sem distinguir maiúsculas; ex.: `dono@empresa.com.br,teste@empresa.com.br`). Qualquer outro motorista
recebe 409 `PAYMENT_METHOD_DISABLED` (`reason: "SANDBOX_RESTRICTED"`) com a **mesma** mensagem de
"indisponível no momento" — sem revelar que existe uma lista.

**Identidade verificada significa:**
- **DRIVER (motorista):** login/vínculo com Google (entrega `email_verified` do Google) — ou seja, o e-mail na lista SÓ funciona se esse usuário fizer login com a conta Google correspondente. Um DRIVER cadastrado só com e-mail/senha NUNCA é testador, mesmo que o e-mail esteja na lista (evita que qualquer um registre o e-mail de um testador e use sandbox de graça).
- **STAFF/ADMIN:** role != DRIVER — criado pelo admin/seed, nunca se auto-registra (identidade verificada por construção).

**Por quê:** os cartões de teste da Cielo são **públicos** e o cadastro do app é **aberto**; sem esta
trava, sandbox numa instância pública seria cobrança grátis (saldo/recarga sem pagar) para qualquer um.

- A env é **opcional**: **vazia ou ausente = NINGUÉM** passa (falha segura). Não há curinga nem domínio inteiro.
- **Crie as contas dos testadores ANTES de listar o e-mail**. Se for DRIVER, a conta precisa estar ligada a um login com Google (googleSub preenchido).
- Só bloqueia **começos novos** (cadastro de cartão, pré-autorização, novo Pix). Captura, cancelamento,
  webhook, varredores e crédito de Pix já pago seguem; a carteira nunca é bloqueada.
- Em **production** (dinheiro real) a restrição não existe; em dev/CI (`NODE_ENV` ≠ production) também não.
- A tela do gateway mostra um aviso permanente enquanto `sandboxRestricted` for verdadeiro.
- A env não é lida pela tela: mudar a lista exige reiniciar a API.

#### Rotação da `PAYMENT_SECRETS_KEY` e chave perdida (F5.7, F5.8)

Os segredos de pagamento (token do cartão salvo e os 3 segredos do gateway) são cifrados com AES-256-GCM
no formato `v1:<kid>:<base64>` — o `kid` identifica a chave que cifrou (8 hex do SHA-256 da chave;
**não é a chave**). Tudo o que a aplicação grava usa **sempre a chave atual** (`PAYMENT_SECRETS_KEY`);
para **ler**, ela usa a atual ou, se existir, `PAYMENT_SECRETS_KEY_PREVIOUS`, conforme o `kid`. O formato
antigo (sem prefixo, gravado até a F5.7) continua legível: tenta a atual e depois a anterior.

**Rotacionar a chave (sem perder nada), na ordem:**

1. **Gere** a chave nova: `openssl rand -base64 32`. Guarde as DUAS (a antiga ainda é necessária) no cofre de senhas.
2. No App `api` (e `worker`, que também decifra), **troque**: `PAYMENT_SECRETS_KEY` = a chave NOVA e
   `PAYMENT_SECRETS_KEY_PREVIOUS` = a chave ANTIGA. **Reinicie** os serviços. A partir daí tudo continua
   lendo (a tela mostra `secretsDecryptable: true`) e o que for gravado já usa a chave nova.
3. No terminal do serviço `api`, rode o **dry-run** (padrão, não grava nada):
   `npm run payments:recifrar-segredos`
   — ele conta quantos valores ainda estão na chave antiga e quantos são **ilegíveis** (nenhuma chave decifra). **Importante (F5.8):** o script DECIFRA antes de contar "já na chave atual" — um corpo corrompido com o `kid` certo agora é detectado como ilegível (evita falha silenciosa).
4. Se estiver como esperado, **aplique**: `npm run payments:recifrar-segredos -- --apply`. É **idempotente**
   (pode rodar de novo), nunca imprime segredo nem ciphertext (só contagens), regrava cada valor só se ele não
   mudou desde a leitura e deixa uma linha na auditoria (ator `system`, ação `PAYMENT_CONFIG_CHANGE`,
   `actionDetail: secrets_reencrypted`). Código de saída **0** = concluído; **1** = há ilegíveis (ou valores
   alterados durante execução — rode de novo, o ilegível nunca é apagado); **2** = erro (chave ausente, argumento inválido).
5. Com **0 ilegíveis** e tudo na chave atual, **remova** `PAYMENT_SECRETS_KEY_PREVIOUS` e reinicie. Só então a chave antiga pode ser descartada.

Se `PAYMENT_SECRETS_KEY_PREVIOUS` estiver inválida (não decodifica para 32 bytes), ela é ignorada e o log traz
`alert: payment_secrets_key_previous_invalid` — a chave atual segue funcionando.

**Chave PERDIDA (ou trocada sem a anterior):** os valores cifrados com ela são **irrecuperáveis** (é a
propriedade da criptografia, não um defeito). Sintomas: a tela do gateway mostra `secretsDecryptable: false`
(alerta vermelho), Pix/cartão respondem 503 e o log traz `alert: payment_gateway_secrets_undecryptable`. Para
recuperar: (1) coloque uma `PAYMENT_SECRETS_KEY` válida e reinicie; (2) **reenvie os 3 segredos** pela tela do
admin (`merchantKey`, `sopClientSecret`, `webhookHeaderSecret`, todos no mesmo PUT; pede a sua senha) — não é
preciso decifrar nada, o PUT só grava; (3) **os cartões salvos dos motoristas se perdem**: eles precisam
cadastrar o cartão de novo (o dry-run lista os ids dos cartões ilegíveis; não há como lê-los; valores ilegíveis
NUNCA são apagados pelo script de rotação, só contados). Pix, carteira, sessões e dívidas não dependem da chave
e seguem intactos. **Faça backup da chave** junto com os demais segredos.

**Envs que continuam SÓ no servidor** (a tela não edita; contam como "presentes" no `readiness` se
estiverem setadas): `PAYMENT_SECRETS_KEY`, `CIELO_WEBHOOK_PATH_TOKEN` (compõe a URL do webhook),
`CIELO_SOP_SCRIPT_URL`, `CIELO_SOP_OAUTH_TOKEN_URL` — e, opcionalmente, `PUBLIC_API_BASE_URL`
(ex.: `https://innoflow.innovarecode.com.br`, só para montar a `webhookUrl` mostrada na tela; sem
ela a API deriva do próprio request, respeitando `TRUST_PROXY_HOPS`). `CIELO_MERCHANT_ID`,
`CIELO_MERCHANT_KEY`, `CIELO_SOP_CLIENT_ID/SECRET`, `CIELO_WEBHOOK_HEADER_SECRET` e `CIELO_SANDBOX`
viram **reserva**: ainda funcionam, e a primeira gravação pela tela parte deles (ambiente e "habilitado
se há credenciais"), então salvar uma flag não desliga o que já funcionava.

### 1.0 Sessão Travada e Watchdog (F5.9) — KILL-SWITCH E ORDEM DE DEPLOY CRÍTICA

**👉 LEIA O GUIA COMPLETO:** [`docs/F5.9-SESSAO-TRAVADA-DESENHO.md`](F5.9-SESSAO-TRAVADA-DESENHO.md) (desenho técnico) e [`docs/AUDITORIA-F5.9.md`](AUDITORIA-F5.9.md) (achados de segurança).

F5.9 introduz um **watchdog automático** que detecta sessões de recarga que ficaram abertas sem confirmação do carregador (cenários: queda de energia, perda de conexão, silêncio do firmware). A sessão não cobra nada até ter **confirmação real** do carregador. Isto acima tudo está DESLIGADO por padrão no primeiro deploy — uma chave de kill-switch o ativa depois, e a **ordem de deploy é crítica**.

#### O que é `STOP_UNCONFIRMED` (para o dono entender):

O servidor decidiu que a sessão acabou, mas o carregador não respondeu confirmando. Exemplos:
- Carregador desligou sem avisar ("queda de energia")
- Perdeu conexão no meio da parada
- Silencioso: conector voltou a DISPONÍVEL/INDISPONÍVEL de forma estranha

Neste estado:
- ✅ A sessão **NÃO entra na receita** — nada é debitado, cartão não é capturado, pré-autorização fica congelada
- ✅ O motorista vê a sessão encerrada (recibo), **NÃO na lista de recarga ativa** (GET `/api/me/sessions/active` exclui STOP_UNCONFIRMED)
- ✅ Se D7=`true` (padrão), o motorista **pode iniciar outra recarga** enquanto aguarda confirmação (desconta um "saldo comprometido")
- ⏳ O servidor aguarda (janela G1/G2) pelo Stop enfileirado do carregador — se chegar, fecha com a leitura correta; se não, encerra com a **última amostra conhecida** ou com a **política D2** (sem nenhuma leitura)

#### Variáveis de Ambiente — Watchdog

| Variável | Padrão | O que significa | Notas |
|---|---|---|---|
| `SESSION_WATCHDOG_ENABLED` | `false` ⚠️ | Kill-switch — DESLIGADO no 1º deploy | Ativa o agendador no worker — ligar SÓ após migrations + redeploy API/gateway |
| `SESSION_WATCHDOG_INTERVAL_MS` | 60000 | Ciclo da varredura (milissegundos) | A cada 60 s o watchdog verifica as sessões abertas |
| `SESSION_WATCHDOG_BATCH_SIZE` | 100 | Quantas sessões por ciclo | Evita lock longo no banco — sessões fora do lote são vistas no próximo ciclo |
| `SESSION_CHARGER_OFFLINE_MINUTES` | 10 | Limite de offline + inatividade (R1) | Carregador offline há ≥10 min E sem atividade há ≥15 min → STOP_UNCONFIRMED |
| `SESSION_INACTIVITY_MINUTES` | 15 | Limite de inatividade (R1) | Vê em paralelo com SESSION_CHARGER_OFFLINE_MINUTES |
| `SESSION_CONNECTOR_IDLE_MINUTES` | 5 | Conector ocioso (R2) | Conector que volta a AVAILABLE/UNAVAILABLE após sessão abrir fica 5 min ocioso → STOP_UNCONFIRMED |
| `SESSION_STOP_CONFIRM_MINUTES` | 5 | Espera pelo Stop (R3) | Depois do RemoteStop, aguarda 5 min pelo StopTransaction; reenvia até 3x |
| `SESSION_STOP_MAX_ATTEMPTS` | 3 | Máximo de RemoteStop (R3, D4) | Teto de tentativas — só GUARD/WATCHDOG contam aqui, não toques humanos |
| `SESSION_METER_TRIGGER_COOLDOWN_MINUTES` | 15 | Mínimo entre TriggerMessage (R4) | Carregador mudo (online, CHARGING, sem MeterValues) → pede amostra 1x a cada 15 min |
| `SESSION_MAX_OPEN_HOURS` | 24 | Duração máxima (R5, D5) | Sessão aberta há 24 h → RemoteStop e depois STOP_UNCONFIRMED |
| `SESSION_UNCONFIRMED_GRACE_ONLINE_MINUTES` | 10 | Janela online (U2, G1) | Depois de marcar STOP_UNCONFIRMED com carregador online, aguarda 10 min — se StopTransaction não chegar, encerra com servidor |
| `SESSION_UNCONFIRMED_GRACE_OFFLINE_MINUTES` | 120 | Janela offline (U2, G2) | Depois de marcar STOP_UNCONFIRMED com carregador offline, aguarda 2 h — se StopTransaction não chegar, encerra com servidor |
| `CARD_SESSION_MAX_HOLD_HOURS` | 48 | Teto do hold do cartão | Limite que NÓS configuramos para o hold do cartão (o prazo real da Cielo é a confirmar com ela) — ao atingi-lo a sessão é encerrada à força, com alerta |
| **D2 — Sem nenhuma leitura** |
| `SESSION_NO_READING_POLICY` | `NO_CHARGE` | Política de cobrança | `NO_CHARGE`: não cobra, alerta, revisão manual. `MIN_FEE`: cobra taxa fixa + mínimo (antigo) |
| **D7 — Outra recarga durante confirmação** |
| `SESSION_ALLOW_START_WHILE_UNCONFIRMED` | `true` | Motorista inicia outra? | `true`: sim, desconta "saldo comprometido". `false`: bloqueia até confirmar |

⚠️ **Decisões do dono ainda NÃO confirmadas:** D2 (sem leitura) e D7 (outra recarga) — os padrões acima são recomendações da arquitetura. O dono precisa decidir e fazer swap nas envs **ANTES** do go-live.

#### Ordem de Deploy — **CRÍTICA**

**Esta sequência é mandatória; pular etapas ou inverter quebra o sistema no deploy rolante:**

1. **Deploy das migrations** (Postgres): roda automaticamente no boot dos 3 Dockerfiles
   ```
   - 20261003120000_f59_watchdog_baseline.sql (colunas novas em ChargingSession, enum StopUnconfirmedReason)
   - 20261003120100_f59_watchdog_indices.sql (índices para watchdog)
   - 20261003130000_f59_watchdog_backfill.sql (backfill, não encerra sessões no 1º ciclo)
   ```
   - ✅ Seguro rodar 3 Apps ao mesmo tempo (lock consultivo Prisma)
   - Backfill não causa encerramento em massa — apenas marca coluna para os ciclos futuros

2. **Deploy da API (`inno-elekton-api`):** código com handlers OCPP que entendem `STOP_UNCONFIRMED`
   - Redeploy: a imagem nova roda migrations, depois sobe a API
   - Handlers Boot, StopTransaction, MeterValues já conhecem `STOP_UNCONFIRMED` (não lançam erro)

3. **Deploy do gateway OCPP (`ocpp-gateway`):** mesmo código que a API, handlers também atualizados
   - Redeploy do container

4. **SÓ DEPOIS**: Ligar a chave no worker
   - [ ] EasyPanel → App `inno-elekton-worker`
   - [ ] Env `SESSION_WATCHDOG_ENABLED` = `true`
   - [ ] Redeploy — o worker arranca o agendador (`scheduleVigiarSessoesScan`)

**Por que tão rígido?** Se o worker novo gera `STOP_UNCONFIRMED` antes da API/gateway entenderem o novo enum (status), handlers descrevem erro cacheado (`CALL_ERROR`) e a telemetria fica travada — ver M4 em AUDITORIA-F5.9.md.

#### Rollback

Se precisar voltar atrás:
1. [ ] EasyPanel → App `inno-elekton-worker`
2. [ ] Env `SESSION_WATCHDOG_ENABLED` = `false`
3. [ ] Redeploy — o agendador é removido, watchdog para
4. Handlers e rotas continuam funcionando — sessões abertas continuam abertas, STOP_UNCONFIRMED já gravadas ficam como estão (não são revertidas)

#### Alertas novos a monitorar (procure por `alert:` nos logs)

| Alerta | Severidade | O que significa | O que fazer |
|---|---|---|---|
| `session_stop_unconfirmed` | ⚠️ | Sessão marcada STOP_UNCONFIRMED | Esperado; monitorar frequência excessiva (pode indicar carregador com problema de reconexão) |
| `session_closed_by_server` | ⚠️ | Servidor encerrou (acabou a janela G1/G2) | Normal; confirmar que a energia foi lida corretamente |
| `session_max_duration_reached` | ⚠️ | Sessão antiga demais (24 h padrão) | Normal; motorista esqueceu de parar |
| `session_closed_without_meter_reading` | 🔴 | Sem nenhuma amostra, aplicada política D2 | Se `NO_CHARGE`: revisão manual. Se `MIN_FEE`: cobrado taxa fixa + mínimo. **Raro; investigar se carregador silencioso** |
| `session_revived_after_unconfirmed` | 🔴 | MeterValues após STOP_UNCONFIRMED reanimou | Carregador continua entregando depois de queda — reanima com nova tentativa de RemoteStop |
| `session_stop_not_obeyed` | 🔴 | Stop rejeitado, energia subindo | Carregador não obedeceu o stop (firmware? bugs?) — **investigar com fabricante** |
| `session_metering_after_close` | 🔴 | MeterValues chegaram após STOPPED | Amostra tardia (muito raro); descartada, sem impacto financeiro |
| `card_session_hold_deadline` | 🔴 | Servidor forçou o encerramento porque a pré-autorização atingiu o prazo configurado (`CARD_SESSION_MAX_HOLD_HOURS`) | Conferir se a captura saiu com o valor certo e por que o carregador não confirmou a parada |
| `session_cost_calculation_failed` | 🔴 | O cálculo do custo falhou; o fechamento foi ABORTADO (nada foi cobrado nem cancelado, a sessão segue como estava) | Revisão manual da sessão: ver as datas/leituras da sessão no admin e o log do alerta |
| `ocpp_foreign_transaction` | 🔴 | Transação de carregador diferente | Um carregador citou uma transação de OUTRO carregador (ignorada). Pode ser firmware com defeito ou credencial comprometida: veja no alerta qual carregador enviou e investigue |
| `ocpp_meter_values_without_transaction` | ⚠️ | MeterValues sem ID de transação | Firmware mal configurado; amostra descartada |

### 1.1 Frontend

App `inno-elekton-frontend`: mesmo repositório, **Build Path = `frontend`**
(mesmo problema do item acima — o Dockerfile é `frontend/Dockerfile`, não a
raiz). Build multi-stage (Vite → Nginx), porta interna **80**, exposta
publicamente. **Qualquer mudança no `nginx.conf.template` exige rebuild/redeploy do frontend** — 
o arquivo é englobado na imagem Docker em tempo de build.

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

## 2. Migration e CI (automática desde 17/09/2026; Postgres 16 desde e47e2b8)

**Histórico do problema que isto corrige**: o passo de migration era manual
(rodar no shell do App depois do deploy) — já esqueceu de rodar mais de uma
vez neste projeto, e a última vez derrubou rotas novas em produção com 500
("table does not exist") sem ninguém perceber até testar ao vivo. Agora os 3
`CMD` dos Dockerfiles (`Dockerfile`/`Dockerfile.ocpp`/`Dockerfile.worker`)
rodam `npx prisma migrate deploy` automaticamente antes de subir o processo
— seguro mesmo com os 3 serviços subindo ao mesmo tempo (lock consultivo do
Prisma no Postgres, quem chega depois só espera e não reaplica nada).

**CI (GitHub Actions, e47e2b8):** roda com Postgres 16 + Redis 7 reais
(não é mock). Postgres sobe por `docker run` com `max_connections=300` 
(o default de 100 seria apertado com múltiplos workers de teste em paralelo).
CI confere versões, roda migrations, testes e **guarda contra Unhandled Rejection** 
mesmo com testes verdes (sintoma clássico de falha silenciosa). Frontend 
confere que `dist/` não contém `mockServiceWorker.js` (só de dev/E2E).

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

### 5.1 Básico (todos os deploys)

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

### 5.2 F5.9 — Watchdog de Sessão Travada (depois de ligar `SESSION_WATCHDOG_ENABLED`)

Procure por `alert:` nos logs — devem estar limpos (nenhum erro) nos primeiros ciclos. Se o simulador conecta, deixe rodar uma sessão pequena (10–30 s):

- [ ] **Sessionlogical natural:** iniciar → parar normalmente → `session_closed_by_server` com `closureSource=CHARGER` (carregador respondeu) OU `closureSource=SERVER` (servidor encerrou após confirmação)
- [ ] **Log do ciclo do watchdog:** procure por `[sessao][watchdog]` — message `rodada` com timestamp do início e fim (normal, sem erros)
- [ ] **Sem `CALL_ERROR` cacheado:** se os handlers lançam erro com enum novo antes do entender, logs trazem `alert:` de cache — não deve acontecer (ordem de deploy foi respeitada?)
- [ ] **Sem alertas críticos** `session_cost_calculation_failed`, `ocpp_foreign_transaction` — se aparecerem, anotar e investigar

#### Com carregador real ou de teste prolongado:

- [ ] **Simulação de queda**: desconecta carregador mid-sessão
  - Esperar 10 min (offline) + 15 min (inatividade) = R1 dispara
  - Sessão vai a STOP_UNCONFIRMED com motivo `CHARGER_UNREACHABLE`
  - Motorista vê recibo, lista de recarga exclui a sessão
  - Alerta `session_stop_unconfirmed` + `session_closed_by_server` (no fim, quando janela G2 vence)

- [ ] **Reconexão após queda** (M2 da auditoria):
  - Carregador volta online, manda Boot
  - Se Stop enfileirado chega antes da janela G1 vencer, fecha normalmente
  - Senão, servidor encerra com a última amostra (ou D2 se nenhuma)

- [ ] **Decisão D2** (sem leitura):
  - Carregador silencioso durante toda sessão (ou amostras perdidas)
  - `SESSION_NO_READING_POLICY=NO_CHARGE`: custo 0, alerta `session_closed_without_meter_reading`, revisão manual obrigatória
  - `SESSION_NO_READING_POLICY=MIN_FEE`: custo = taxa fixa + mínimo, comportamento antigo

- [ ] **Decisão D7** (outra recarga):
  - Iniciar sessão, depois Logout/reconectar
  - Com D7=`true`: `POST /api/me/sessions/start` **pode** criar nova sessão (desconta `provisionalCostCents` da anterior como saldo comprometido)
  - Com D7=`false`: devolve 409 `ALREADY_HAS_ACTIVE_SESSION` (com `pendingConfirmation: true` nos detalhes), bloqueia até a confirmação

**Checklist de flags pós-validação:**
- [ ] `SESSION_WATCHDOG_ENABLED=true` está ligado no worker
- [ ] Logs limpios (0 erros de deserialização do enum novo)
- [ ] Motorista consegue iniciar/parar recarga normalmente (nada quebrou)
- [ ] Alertas aparecem no padrão esperado (nenhum susto)
