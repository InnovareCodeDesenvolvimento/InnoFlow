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

**Publicação segura:** o EasyPanel constrói o `main`; mudanças de infraestrutura/Dockerfile entram por branch + PR com o CI verde
(que já faz `docker build` das 4 imagens). Fluxo, proteção de branch e o checklist "se o deploy falhar":
[`docs/FLUXO-DE-PUBLICACAO.md`](FLUXO-DE-PUBLICACAO.md).

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
| `ocpp-gateway` | `Dockerfile.ocpp` | 9000 | Sim, mas só para os carregadores, **por domínio próprio com HTTPS (`wss://`, decidido em 04/10/2026)** — a porta 9000 **não** é publicada crua; passo a passo na seção 4 |
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
JWT_SECRET=<gerar forte — openssl rand -base64 48 — NUNCA reusar o valor de dev do docker-compose.yml; em produção < 32 caracteres FAZ O BOOT FALHAR>
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
OCPP_TRUST_PROXY_HOPS=0                 # proxies reversos entre o carregador e a porta 9000 (com o domínio wss:// da seção 4: medir, esperado 1)
OCPP_MESSAGE_RATE_MAX=1000              # mensagens RECEBIDAS por conexão na janela abaixo; acima, a conexão é fechada (1008)
OCPP_MESSAGE_RATE_WINDOW_SECONDS=10     # janela deslizante do limite acima
```

**Limite de mensagens por conexão (N-10).** Default: 1000 mensagens em 10 s (100/s). Um
carregador normal manda ~2/s no pior caso (2 conectores com `MeterValues` a cada 1 s) e o
replay de transações guardadas offline é serial (cada CALL espera a resposta), então não chega
perto. Estourou: a conexão é fechada com código 1008 e um `warn` com `alert: "ocpp_message_flood"`
(procure por ele nos logs; o carregador reconecta sozinho). Se o firmware real (C-P9) precisar de
mais folga, suba `OCPP_MESSAGE_RATE_MAX` — não precisa de deploy de código. O gateway também fecha
(1002) a conexão após **10 mensagens malformadas seguidas** (`maxBadMessages`), e o handler de
métodos sem implementação loga só o nome da ação e o tamanho do payload, nunca o conteúdo.

`OCPP_TRUST_PROXY_HOPS` **não é** o `TRUST_PROXY_HOPS` da API (o caminho até a porta 9000 é
outro: não passa pelo nginx do frontend). Default `0` = usa só o endereço do socket — correto
só se a porta for exposta direto; **atrás de um proxy, sem configurar, todos os carregadores
compartilham o IP do proxy** e o limite por IP (30 falhas / 100 tentativas simultâneas por
janela) passa a valer para a frota inteira. **Como acertar (medir, não chutar): seção 4.4.**
**Hops a mais deixam o cliente forjar o próprio IP.** Bloqueio de uma identidade CONHECIDA gera
um `warn` com `alert: "ocpp_auth_lockout"` (procure por ele nos logs).

✅ **DECIDIDO (dono, 04/10/2026): o OCPP em produção é `wss://` (TLS)**, terminado no proxy de
borda do EasyPanel, com domínio próprio para o gateway (seção 4). Basic Auth em `ws://` trafega
a senha em claro; por isso a porta 9000 **não** é publicada crua na internet. O tráfego
proxy → container (rede interna do EasyPanel) segue em `ws://`/HTTP puro — é interno, não
exposto.

### Termos, privacidade e LGPD (L1.9 / L1.4) — envs e operação (06/10/2026)

**Envs `LEGAL_*` — agora só RESERVA (06/10/2026).** O dono cadastra razão social, CNPJ, suporte, endereço, site, encarregado (DPO) e as **versões** dos Termos/Privacidade pelo painel (**Admin > Dados da empresa**, ver a subseção abaixo) e o **painel manda**; as envs só valem enquanto nada foi salvo lá. Não é preciso definir nenhuma. As 3 apps recebem as mesmas; todas opcionais — nada derruba o boot:

| Env | Para quê | Default |
|---|---|---|
| `LEGAL_TERMS_VERSION` | versão VIGENTE dos Termos de Uso (≤ 32 caracteres) | `2026-10-05` |
| `LEGAL_PRIVACY_VERSION` | versão VIGENTE da Política de Privacidade (≤ 32 caracteres) | `2026-10-05` |
| `LEGAL_COMPANY_NAME` | razão social do controlador | vazio (`null`) |
| `LEGAL_COMPANY_CNPJ` | CNPJ (só dígitos ou com pontuação; sai formatado; dígito verificador conferido) | vazio |
| `LEGAL_SUPPORT_EMAIL` | e-mail de suporte (Decreto 7.962/2013: canal visível) | vazio |
| `LEGAL_SUPPORT_PHONE` | telefone de suporte (texto livre, ≤ 30) | vazio |
| `LEGAL_DPO_EMAIL` | e-mail do encarregado (DPO) | vazio |

- Os dados da empresa **ainda não foram informados pelo dono**: enquanto vazios, `GET /api/public/legal` devolve `null` em cada campo (a tela mostra "em breve"/esconde o bloco; nada é inventado).
  E-mail/CNPJ malformado é IGNORADO (campo sai vazio) e o log traz um aviso `[legal] variável LEGAL_* com valor inválido` com o NOME do campo.
- **Suba `LEGAL_TERMS_VERSION`/`LEGAL_PRIVACY_VERSION` no MESMO deploy em que o texto novo vai ao ar.** O cadastro (e-mail e Google) só vale com `acceptedTermsVersion` = a vigente (senão 409
  `TERMS_VERSION_OUTDATED`); quem já tem conta e aceitou a versão anterior passa a `upToDate=false` e vê o modal de reaceite no próximo login.
- O aceite é prova gravada (`ConsentRecord`, append-only) com o IP da requisição (zerado se a conta for excluída).

**Dados da empresa pelo painel (`/api/admin/company-profile`, migration `20261006140000_company_profile`).** Tabela `CompanyProfile` (singleton, sem segredo, sem step-up de senha; só ADMIN; limite de 10 salvamentos/min; auditoria `UPDATE`/`CompanyProfile`, fail-closed, com os **nomes** dos campos — razão social, CNPJ, site e versões entram com valor; e-mail/telefone de suporte, endereço e encarregado entram só como "alterado"). Contrato literal em `docs/CONTRATO-EMPRESA-ADMIN.md`.

- **Painel > env.** Os **dados da empresa** são um grupo: enquanto o painel nunca salvou, valem as envs; no primeiro salvamento o painel **importa** o que a env já informava e passa a mandar em tudo (campo apagado no painel não volta pela env). As **versões** são por campo: vazio no painel = vale a env `LEGAL_*_VERSION` (ou o padrão `2026-10-05`).
- **Mudar a versão é um ato deliberado.** Alterar a versão efetiva dos Termos ou da Privacidade exige `confirmVersionChange: true` no PUT (senão 409 `VERSION_CHANGE_NOT_CONFIRMED`, com o número de motoristas afetados): **todos** os motoristas passam a `upToDate=false`, veem o modal de reaceite no próximo acesso e o cadastro só vale com a versão nova. Troque a versão **no mesmo momento** em que o texto novo vai ao ar.
- **Cache de 30 s por processo.** A API que salva vê a mudança na hora; o worker (rodapé dos e-mails) e outras réplicas da API em até 30 s. Uma réplica atrasada pode, no máximo, recusar um aceite com `TERMS_VERSION_OUTDATED` (o front recarrega e repete) — nunca grava um aceite errado. `GET /api/public/legal` tem `Cache-Control: public, max-age=30`.
- **Banco fora do ar:** a rota pública e o rodapé dos e-mails caem na env (reserva); o aceite dos termos e a tela do admin respondem 503 `LEGAL_SETTINGS_UNAVAILABLE` (não se grava aceite contra uma versão que pode não ser a do banco).
- **CNPJ** aceito numérico e **alfanumérico** (vigente desde jul/2026), com dígito verificador conferido; fica guardado sem pontuação e é exibido formatado.

**Exclusão de conta e devolução do saldo (L1.4, DL2).** A exclusão é ANONIMIZAÇÃO (a pessoa some; sessões, extrato e pagamentos ficam sob um id pseudônimo por obrigação legal/fiscal). Quem exclui com
saldo informa uma chave Pix (guardada **cifrada** com a `PAYMENT_SECRETS_KEY` — por isso a rotação da chave também a re-cifra; ver o runbook de rotação) e o ADMIN devolve **por fora** e registra em
`POST /api/admin/account-deletions/:id/refund` (valor INTEGRAL, senha do ADMIN, comprovante) — o que lança o `TOPUP_REFUND` e **apaga a chave Pix**. Prazo máximo recomendado: **30 dias**; passou disso o
worker (1x por dia) emite o alerta `payment_refund_pending_overdue` (IMPORTANTE: e-mail ao dono). Sem a `PAYMENT_SECRETS_KEY` a exclusão **com saldo** responde 503 `PAYMENT_SECRETS_KEY_MISSING` (nunca
guarda a chave Pix em claro). O que sobrevive à anonimização e por quê: `AuditLog` antigo do titular (append-only; sai no expurgo por idade), `WebhookEvent`, sessões/extrato/pagamentos (5 anos), aceite dos
termos (sem IP). O IP e o User-Agent de início das sessões são **zerados** na exclusão (decisão do dono, 06/10/2026).

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
- **Allowlist de domínios em PRODUÇÃO (S-3, 05/10/2026).** Com o gateway em `production`, TODA URL de
  override — `CIELO_API_BASE_URL`, `CIELO_API_QUERY_BASE_URL`, `CIELO_SOP_OAUTH_TOKEN_URL`,
  `CIELO_SOP_ACCESS_TOKEN_URL` e `CIELO_SOP_SCRIPT_URL` — precisa ser `https://` (porta 443, sem
  usuário/senha na URL) e o host precisa ser um destes domínios **ou subdomínio** deles:
  `cieloecommerce.cielo.com.br` (API de vendas e script do SOP no Parque), `pagador.com.br` (AccessToken
  do SOP; `www.pagador.com.br` é o script que a doc oficial cita, P5) e `braspag.com.br` (OAuth do SOP).
  Fora disso o servidor **recusa construir o adaptador** (503 nas rotas, `alert:
  payment_gateway_environment_url_mismatch`) e o "Testar conexão" devolve `MISCONFIGURED` sem chamar a
  rede — a `MerchantKey` (header de toda chamada) e o `ClientSecret` (OAuth) nunca vão a um host fora
  da lista. Os **defaults** de sandbox e produção já estão dentro da lista; só quem define override é
  afetado (em geral: ninguém — não defina). Em **sandbox** o override continua livre (servidor falso/proxy
  em teste), mas o host oficial de produção segue recusado. Única exceção em produção: **loopback**
  (`localhost`, `127.x.x.x`, `::1`), que existe só para a suíte de integração rodar contra uma Cielo falsa.
  A lista mora em `DOMINIOS_CIELO_PERMITIDOS_EM_PRODUCAO` (`backend/src/core/pagamentos/configGateway.ts`).
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
   Desde o N-7 o script também cobre a **senha SMTP** e a **apikey da Evolution** da tela de comunicação (alvos `NotificationChannelConfig.*`) e, desde o backup automático, as **credenciais do S3**, o **segredo e o refresh token do Google** e a **cópia cifrada da chave do backup** (alvos `BackupConfig.*`) — sem isso, depois de remover a chave anterior o agendador não decifraria o destino de madrugada.
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

✅ **Decisões do dono confirmadas em 04/10/2026:** D2 = não cobrar sem leitura (`SESSION_NO_READING_POLICY=NO_CHARGE`), D3 = registrar o Stop tardio, alertar e absorver (sem cobrar a diferença), D7 = pode iniciar outra recarga durante a confirmação (`SESSION_ALLOW_START_WHILE_UNCONFIRMED=true`); D1 (espera de 2 h), D4 (3 tentativas de parada), D5 (24 h) e D6 (textos) nos padrões. Os padrões das tabelas acima são, portanto, os valores definitivos; nada precisa ser trocado no EasyPanel. Perdas aceitas explicitamente: M2 (queda longa seguida de volta) e M5 (carregador que recusa a parada e fica mudo, sem cobrança por D2).

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

(`ws://` aqui é a rede **interna** do EasyPanel, que não passa pela borda — é de propósito e
não contradiz a decisão de `wss://` para a internet. Para testar o caminho de produção
completo — TLS, domínio, hops — use o simulador do repositório contra o domínio público,
seção 4.5.)

## 4. Gateway OCPP em produção: `wss://` com domínio próprio (DECIDIDO 04/10/2026)

**Decisão do dono:** os carregadores falam `wss://` (TLS). O certificado é emitido e renovado
pelo EasyPanel (Let's Encrypt) no proxy de borda; o container `ocpp-gateway` continua
escutando HTTP/WebSocket puro na 9000, **só na rede interna**. O que era a "pergunta em aberto
da porta 9000 crua ou TLS" (D1 do Órion A1) está **fechado: TLS**.

```
carregador ──wss://ocpp.innovarecode.com.br/ocpp/<identidade> (443, TLS)──▶ proxy de borda do EasyPanel
                                                                              │  termina TLS, repassa o Upgrade,
                                                                              │  acrescenta X-Forwarded-For
                                                                              ▼  ws:// (rede interna)
                                                                    App ocpp-gateway :9000
```

Legenda do que é verificado: **[código]** = conferido lendo o código/dependência em
04/10/2026; **[a confirmar no EasyPanel]** = só o ambiente real prova — nada abaixo foi
testado contra o EasyPanel de produção (não há acesso a ele nem Docker nesta máquina).

### 4.1 O que o código faz atrás de um proxy que termina TLS (verificado)

- **[código] O gateway não sabe nem precisa saber de TLS.** `startOcppServer` sobe um
  `RPCServer` (`ocpp-rpc`) em `listen(port)`, HTTP puro (`backend/src/ocpp/server.ts`). Não há
  cert/chave no código nem env de TLS.
- **[código] Upgrade do WebSocket:** o handler `upgrade` do `ocpp-rpc` lê só o último
  segmento do path como identidade (`/ocpp/CP-X` e `/qualquer/coisa/CP-X` valem; o prefixo
  `/ocpp` é convenção, não é validado) e exige `Upgrade: websocket`. Requisição HTTP comum
  na 9000 devolve **404** (com cabeçalho `Server: ocpp-rpc/…`) — o gateway **não tem rota de
  health HTTP**; qualquer "health check" HTTP do painel falharia.
- **[código] Basic Auth** vem do cabeçalho `Authorization` do próprio handshake; o proxy só
  precisa repassá-lo (proxy HTTP padrão repassa). A senha é conferida por bcrypt contra
  `ChargePoint.basicAuthSecretHash`. Com TLS, deixa de trafegar em claro na internet.
- **[código] Keep-alive:** o servidor manda ping WebSocket a cada **30 s** (`pingIntervalMs:
  30_000`) e derruba a conexão se um ping ficar sem pong até o próximo (`ocpp-rpc`
  `_keepAlive`, `deferPingsOnActivity` desligado). Logo a conexão **nunca fica ociosa mais
  que ~30 s** no proxy — qualquer timeout de ocioso do proxy ≥ 60 s é seguro. (O Heartbeat
  OCPP de 60–120 s é outra coisa e não é o que mantém o caminho vivo.) **[a confirmar no
  EasyPanel]** que não existe timeout de ocioso menor que 60 s na borda.
- **[código] Tamanho de mensagem / timeouts:** o gateway não configura `maxPayload` (vale o
  default do `ws`, 100 MiB) nem timeout próprio de handshake (valem os defaults do `http` do
  Node). `callTimeoutMs: 30_000`. Nada disso depende de TLS; ver "mudanças de código
  sugeridas" no fim desta seção.
- **[código] IP do carregador:** `resolveHandshakeIp(remoteAddress, X-Forwarded-For,
  OCPP_TRUST_PROXY_HOPS)` monta a cadeia `[socket, ...X-Forwarded-For da direita p/ esquerda]`
  e usa o elemento de índice `hops`. IPv6 vira a chave de sub-rede /56. Com `hops = 0` o
  `X-Forwarded-For` é **ignorado** e o IP é o do socket — atrás do proxy isso é o IP interno
  do proxy, **igual para todos os carregadores**. Esse IP alimenta o rate limit de
  autenticação em Redis: par (identidade + IP), falhas por IP (30/janela) e tentativas
  simultâneas por IP (100). Com hops errado para menos, **uma frota inteira divide uma cota
  só** (um carregador com senha errada pode levar os outros a `429`); com hops errado para
  mais, **o cliente forja o IP** mandando o próprio `X-Forwarded-For`.
- **[código] O IP não é gravado em lugar nenhum** além de contadores do rate limit (TTL = janela)
  e dos logs de falha de autenticação; nenhuma outra parte do backend lê `remoteAddress`.

### 4.2 Quantos saltos? (`OCPP_TRUST_PROXY_HOPS`)

- A API usa `TRUST_PROXY_HOPS=2` porque são **dois** proxies até ela: borda do EasyPanel +
  nginx do frontend (medido em produção, 19/09/2026). **O caminho do gateway é diferente:**
  o domínio do gateway aponta direto para o App `ocpp-gateway` e **não passa pelo nginx do
  frontend**. Logo a expectativa é **1 salto** (só a borda do EasyPanel):
  `X-Forwarded-For: <IP do carregador>` e socket = IP interno da borda → cadeia
  `[borda, carregador]` → `OCPP_TRUST_PROXY_HOPS=1`.
- **Isto é uma dedução, não uma medição** — **[a confirmar no EasyPanel]**. O valor certo é o
  que a medição da seção 4.4 mostrar. Qualquer coisa a mais na frente da borda (Cloudflare com
  nuvem laranja, outro balanceador, um túnel) soma saltos: por isso o DNS do domínio do
  gateway deve ser "só DNS" (sem proxy de CDN) — ver 4.3.
- **Acoplamento perigoso:** com `OCPP_TRUST_PROXY_HOPS ≥ 1`, quem alcançar a **porta 9000
  direto** (sem passar pela borda) escolhe o próprio IP via `X-Forwarded-For` e foge do limite
  por IP. Por isso o passo "remover a publicação da porta 9000" (4.3, passo 4) **não é
  opcional**; confirme-o antes de subir os hops.

### 4.3 Passo a passo no EasyPanel (ações do dono)

1. **DNS.** Crie um registro para o domínio do gateway apontando para o **mesmo servidor/IP**
   dos outros domínios do projeto (tipo `A`, ou `CNAME` para o host que o EasyPanel indicar).
   Sugestão: `ocpp.innovarecode.com.br` — curto de propósito, porque alguns firmwares limitam
   o campo de URL (comum: 64 ou 128 caracteres; a URL final fica em ~50 caracteres com a
   identidade `CP-INNOELEKTRON-001`). Qualquer nome serve (ex.: `ocpp.innoflow.innovarecode.com.br`
   para seguir o padrão do painel). Se a zona estiver no Cloudflare: **"DNS only" (nuvem
   cinza)**, não "Proxied" — a nuvem laranja adiciona um proxy (soma 1 salto, troca o
   certificado que o carregador enxerga e tem timeout de ocioso próprio).
2. **Domínio no App `ocpp-gateway`.** App `ocpp-gateway` → aba **Domínios** → adicionar:
   host `ocpp.innovarecode.com.br`, **HTTPS ligado** (certificado automático Let's Encrypt),
   caminho `/`, **porta de destino (proxy) `9000`**, protocolo do destino **HTTP** (o container
   fala HTTP/WS puro; não marque HTTPS no destino). Os nomes exatos dos campos variam com a
   versão do EasyPanel — **[a confirmar no EasyPanel]**. Aguarde o certificado ficar válido
   (o DNS precisa estar propagado, senão o Let's Encrypt falha a validação).
3. **WebSocket.** Proxy de borda moderno repassa `Upgrade: websocket` sem configuração. Se a
   tela de domínio tiver uma opção explícita de WebSocket/upgrade, deixe **ligada**; senão não
   há o que fazer. **[a confirmar no EasyPanel]** — a prova é o teste 4.5, não a ausência de
   opção.
4. **Remover qualquer publicação crua da 9000.** App `ocpp-gateway` → aba de **Portas / Port
   mapping** (nome varia): **não pode haver mapeamento `9000 → porta do servidor`**. Se
   existir (herança do primeiro deploy), remova e reimplante. Confira também o firewall do
   servidor/provedor: 9000 **fechada** para a internet; só 443 (e 80, para o desafio do Let's
   Encrypt) abertas. Prova: de uma máquina de fora, `Test-NetConnection <IP-do-servidor>
   -Port 9000` (PowerShell) ou `nc -zv <IP-do-servidor> 9000` deve **falhar/dar timeout**.
   (O docker-compose de desenvolvimento publica `9000:9000` — isso é só dev local, nunca
   produção.)
5. **Variável do App `ocpp-gateway`:** primeiro deploy com `OCPP_TRUST_PROXY_HOPS=0` (o
   default — pode deixar a env ausente). Meça (4.4) e só então ajuste para o valor medido
   (esperado `1`); salvar a env e **reimplantar** o App (env só vale no restart).
6. **Atualize o que aponta para o gateway:** URL cadastrada nos carregadores
   (`wss://<domínio>/ocpp/<identidade>`, sem `:9000`); `WS_URL` de simuladores externos
   (o simulador interno do EasyPanel — seção 3 — pode continuar em `ws://ocpp-gateway:9000`,
   que é a rede interna e não passa pela borda).

URL final entregue ao carregador/instalador:

```
wss://ocpp.innovarecode.com.br/ocpp/<ocppIdentity>
```

(sem porta — o `wss` usa 443; o `<ocppIdentity>` é o cadastrado no painel, até 50 caracteres.)

### 4.4 Como medir os saltos com segurança (antes de confiar em `hops > 0`)

O gateway **só loga `clientIp`/`xForwardedFor` quando a autenticação FALHA** (sucesso loga só
"charge point conectado"). Então a medição certa é provocar **uma** falha controlada com
uma identidade **inexistente** (não toca no contador de nenhum carregador real; custa 1 das 30
falhas do IP na janela de 300 s):

1. Com `OCPP_TRUST_PROXY_HOPS=0` (ou ausente), de uma máquina sua, anote o seu IP público
   (`curl.exe -s https://ifconfig.me`) e rode **uma** requisição de handshake (uma linha só):

   ```
   curl.exe -i --http1.1 --max-time 10 -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" -H "Sec-WebSocket-Protocol: ocpp1.6" https://ocpp.innovarecode.com.br/ocpp/PROBE-HOPS-001
   ```

   Resposta esperada: **`HTTP/1.1 401 Unauthorized`**. `404` com corpo `404 page not found` =
   o domínio não está chegando no gateway (4.3 passo 2); `502/503` = o gateway não subiu ou a
   porta de destino está errada; `429` = você já estourou o limite (espere 5 min).
2. Nos **Logs** do App `ocpp-gateway`, procure a linha
   `[ocpp] auth: charge point desconhecido ou inativo` com `identity: PROBE-HOPS-001`. Leia:
   - `clientIp` — com hops 0 deve ser um IP **interno/privado** (o da borda; no caso da API foi
     `10.11.0.16`);
   - `xForwardedFor` — deve conter o **seu IP público** (esperado: só ele, 1 entrada).
3. **Regra de decisão:** `OCPP_TRUST_PROXY_HOPS` = o menor número que faz `clientIp` virar o
   **seu IP público**. A cadeia é `[clientIp atual, entradas do xForwardedFor da direita p/
   esquerda]`; o índice do seu IP nessa lista é o valor. Se `xForwardedFor` vier **vazio**, a
   borda não está repassando o cabeçalho — **não suba os hops** (ficaria sem efeito) e investigue.
4. Ajuste a env, reimplante e **repita a sondagem**: agora `clientIp` deve ser o seu IP público.
5. **Teste de forja (obrigatório depois de subir hops):** repita a requisição acrescentando
   `-H "X-Forwarded-For: 1.2.3.4"`. `clientIp` no log **deve continuar sendo o seu IP**
   (`xForwardedFor` mostrará `1.2.3.4, <seu IP>` ou só o seu — depende de a borda higienizar).
   Se `clientIp` virar `1.2.3.4`, os hops estão **a mais** (ou a porta 9000 está exposta crua):
   volte o valor e revise 4.3 passo 4.

### 4.5 Como verificar fim a fim (simulador)

Com o gateway no ar, o domínio válido e um carregador **de teste** cadastrado no painel (use uma
identidade própria de teste, não a do carregador físico):

```
cd backend
OCPP_PASSWORD='<segredo do carregador de teste>' npx tsx scripts/simulate-charger.ts \
  --url wss://ocpp.innovarecode.com.br/ocpp --identity <ocppIdentity-de-teste> --connectors 1
```

(`--url` é a base **sem** a identidade; a senha vai só por `OCPP_PASSWORD`, nunca por argumento.
No PowerShell: `$env:OCPP_PASSWORD='...'; npx tsx scripts/simulate-charger.ts ...`.)

O que deve aparecer:
- No simulador: conexão, `BootNotification` aceito e Heartbeats — e **sem** erro de
  certificado. Se aparecer erro de certificado, o TLS não está válido (DNS/Let's Encrypt, 4.3
  passo 2).
- Nos logs do gateway: `[ocpp] charge point conectado` (com `chargePointId`/`ocppIdentity`).
  Sucesso **não** loga o IP — por isso a medição de 4.4 usa falha provocada.
- No painel: carregador online (`lastSeenAt`/mapa), como na seção 5.1.
- Teste negativo: `OCPP_PASSWORD` errada → `[ocpp] auth: senha incorreta` com `clientIp`
  igual ao **seu** IP público (confirma os hops) e o simulador recebendo `401`. Rode com
  `--no-auto-reconnect` para não repetir a falha em laço.
- Teste de que a porta crua morreu: `ws://<IP-do-servidor>:9000/...` **não** conecta (4.3 passo 4).

### 4.6 Se colocar algo mais na frente do gateway (CDN, balanceador)

Cada proxy novo soma 1 em `OCPP_TRUST_PROXY_HOPS` e muda timeouts de ocioso: refaça 4.4 do zero.
O ping de 30 s do gateway cobre timeouts ≥ 60 s; abaixo disso a conexão cai em laço (parece
"carregador instável"). Detalhes gerais de proxy em `docs/PROXY-REVERSO.md`. Para as rotas
SSE da API (`/api/.../events`) o buffering desligado já está no `nginx.conf.template` do
frontend.

### 4.7 Mudanças de código sugeridas (NÃO feitas — fora do escopo desta tarefa)

Nenhuma é pré-requisito para o `wss://` funcionar. Em ordem de valor:

1. **Logar o IP também no sucesso (uma linha, nível `info`)** em `onClientConnected`/`auth`:
   `clientIp` + `xForwardedFor`. Hoje só a falha loga o IP, o que obriga a medição por falha
   provocada (4.4) e impede o dono de conferir os hops em produção com carregador real.
2. **`wssOptions: { maxPayload: 64 * 1024 }`** no `RPCServer` (`ocpp/server.ts`): o default do
   `ws` é 100 MiB por mensagem, e o handshake autenticado já é o único portão. Mensagens OCPP
   1.6 reais cabem folgado em 64 KiB; subir o limite só se um firmware real justificar.
3. **Aviso de boot** se `NODE_ENV=production` e `OCPP_TRUST_PROXY_HOPS=0`: hoje o default
   seguro vira "frota inteira numa cota só" atrás do proxy, em silêncio.
4. (Opcional) `HEALTHCHECK` TCP no `Dockerfile.ocpp` — a rota HTTP devolve 404 por desenho, então
   o check teria de ser de porta aberta, não de HTTP.

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
- [ ] **`wss://` de produção (seção 4):** certificado do domínio do gateway válido; o
      simulador do repositório conecta em `wss://<domínio>/ocpp` (4.5); a sondagem de hops
      (4.4) mostrou o IP público como `clientIp` e o teste de forja não o alterou; a porta
      9000 **não** responde de fora.

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

## 6. Alertas ao dono (e-mail e WhatsApp) — N-7

Até 05/10/2026 todo alerta do sistema era só uma linha com o campo `alert` no stdout do EasyPanel: ninguém era avisado. Agora **todo log com o campo `alert`** (os `logger.warn/error({ alert: '...' })` do código, sem exceção) passa por um notificador que manda **e-mail** e/ou **WhatsApp** para o dono. Funciona nos 3 serviços (api, ocpp-gateway, worker) e **vem desligado**: sem configuração não acontece nada e nada quebra.

**Onde configurar: pelo PAINEL ADMIN (caminho principal).** Servidor de e-mail (SMTP), Evolution API, destinatários, severidade mínima por canal e janela de dedupe ficam no banco (tabela `NotificationChannelConfig`), com a senha SMTP e a apikey cifradas (a mesma chave `PAYMENT_SECRETS_KEY` do gateway de pagamento), botão "Testar" para cada canal, senha atual exigida para salvar e auditoria de cada alteração — o mesmo padrão da tela do gateway Cielo (contrato da API em `docs/CONTRATO-COMUNICACAO-ADMIN.md`). **As variáveis `ALERT_*` abaixo são a RESERVA:** valem para o canal que ainda não foi configurado pelo painel (e para quando o banco estiver fora do ar); o que foi salvo no painel manda — inclusive desligar um canal que a env ligaria. Veja a seção 6.9.

### 6.1 Como funciona (resumo)

- **Ponto único:** o `hooks.logMethod` do pino em `backend/src/lib/logger.ts` enxerga todo log antes de ele ir para o stdout; só age se o objeto logado tiver `alert` (string). Nenhum ponto de chamada foi alterado, e a linha do stdout continua igual.
- **Severidade** (tabela em `backend/src/core/alertas/severidade.ts`; um teste falha se alguém criar um `alert` novo sem classificar):
  - **CRITICO** — dinheiro de cliente pode estar preso/cobrado errado, ou o pagamento inteiro está fora do ar. Exige ação em horas. Sai por **e-mail e WhatsApp**.
  - **IMPORTANTE** — alguém precisa olhar no mesmo dia (ataque já contido, dado inconsistente, configuração incoerente). Sai por **e-mail**. Alerta ainda não classificado vale IMPORTANTE.
  - **INFO** — o sistema já tratou sozinho (reconsulta/backoff). **Só fica no log.**
- **Dedupe entre os 3 processos (Redis):** o mesmo alerta com o mesmo contexto (ex.: o mesmo `paymentIntentId`) avisa **no máximo 1 vez a cada `ALERT_DEDUPE_MINUTES`** (padrão 30); o aviso seguinte diz "Ocorreu mais N vezes desde o último aviso".
- **Teto por hora (anti-tempestade):** no máximo `ALERT_MAX_PER_HOUR` avisos por hora (padrão 20; CRITICO e IMPORTANTE contam separado, então uma enxurrada de IMPORTANTE nunca engole um CRITICO). Ao estourar sai **um** aviso "tempestade de alertas" e o resto daquela hora fica em silêncio (continua nos logs). Um alerta que cair no teto fica em silêncio até a janela de dedupe dele passar.
- **Redis fora do ar:** o dedupe e o teto passam a valer só na memória de cada processo (pode chegar um aviso repetido; nunca falta aviso). O processo não cai.
- **Nunca atrapalha o sistema:** o envio é assíncrono (fila limitada de 50, 2 envios em paralelo, prazo de 5 s por conexão/chamada); uma falha do e-mail/WhatsApp vira só um log com o campo `notifier` (nunca `alert`, para não gerar laço) e não afeta requisição, OCPP nem job.
- **Conteúdo seguro:** o aviso só leva o nome do alerta, hora, serviço, a frase do log (sem e-mail/cartão/token) e uma **lista fixa de campos** (ids, códigos, contagens, centavos). Nunca token, segredo, cartão, CPF, e-mail de motorista, headers nem corpo de requisição. Campo que não está na lista é descartado.
- **Limite conhecido:** o nível de log precisa deixar passar o alerta. Com `LOG_LEVEL=error` os alertas emitidos em `warn` **não chegam** (o pino descarta o nível antes do hook) — o serviço avisa isso no boot (`[alertas] LOG_LEVEL=...`). Mantenha `LOG_LEVEL=info` (padrão) ou `warn`.
- **Quem morre não avisa:** se o processo inteiro cair (falta de memória, crash), não há log nem aviso. Para isso use o monitor externo da seção 6.6.

### 6.2 Variáveis de ambiente — RESERVA (as 3 apps — api, ocpp-gateway e worker — devem receber as MESMAS)

Use-as se preferir configurar por env, ou como rede de segurança. Se o painel já tem o canal configurado, estas variáveis daquele canal são ignoradas.

Todas opcionais. Em branco = ausente. Valor inválido nunca derruba o boot: o canal fica desligado e o motivo (sem segredo) aparece no log de boot como `[alertas] ...`.

| Variável | Padrão | Segredo? | O que faz |
|---|---|---|---|
| `ALERT_MIN_SEVERITY` | `IMPORTANTE` | Não | Piso para QUALQUER canal (`INFO`, `IMPORTANTE` ou `CRITICO`). Padrão IMPORTANTE: INFO é ruído que o sistema já resolveu sozinho; subir para `CRITICO` silencia os e-mails de IMPORTANTE. |
| `ALERT_DEDUPE_MINUTES` | `30` | Não | Janela de dedupe por alerta+contexto. |
| `ALERT_MAX_PER_HOUR` | `20` | Não | Teto de avisos por hora (por severidade). |
| `ALERT_ENV_LABEL` | `NODE_ENV` | Não | Rótulo do ambiente no assunto (ex.: `producao`). |
| `ALERT_SERVICE_NAME` | (detectado) | Não | Só para forçar o nome do serviço no aviso (normalmente detectado: `api`, `ocpp`, `worker`). |
| **E-mail (SMTP)** | | | |
| `ALERT_EMAIL_TO` | — | Não | Destinatários, separados por vírgula. |
| `ALERT_SMTP_HOST` | — | Não | Servidor SMTP. Sem `ALERT_EMAIL_TO` + `ALERT_SMTP_HOST` o canal fica desligado. |
| `ALERT_SMTP_PORT` | `587` (`465` se `SECURE=true`) | Não | |
| `ALERT_SMTP_SECURE` | `false` | Não | `true` = TLS direto (porta 465). `false` = STARTTLS (porta 587); **em produção o envio é recusado se o servidor não oferecer TLS** (a senha nunca vai em claro). |
| `ALERT_SMTP_USER` / `ALERT_SMTP_PASS` | — | **Sim (PASS)** | Login SMTP. |
| `ALERT_EMAIL_FROM` | `ALERT_SMTP_USER` (se for e-mail) | Não | Remetente, ex.: `InnoFlow <alertas@seudominio.com.br>`. |
| `ALERT_EMAIL_MIN_SEVERITY` | `IMPORTANTE` | Não | Mínimo só do e-mail. |
| **WhatsApp — Evolution API (provedor escolhido pelo dono)** | | | |
| `ALERT_WHATSAPP_PROVIDER` | `evolution` (inferido) | Não | `evolution` ou `generic`. |
| `ALERT_EVOLUTION_BASE_URL` | — | Não | URL da sua Evolution API, ex.: `https://evolution.seudominio.com.br`. **https obrigatório em produção.** |
| `ALERT_EVOLUTION_INSTANCE` | — | Não | Nome da instância (a conectada ao WhatsApp que vai enviar). |
| `ALERT_EVOLUTION_APIKEY` | — | **Sim** | Chave da API (a global `AUTHENTICATION_API_KEY` da Evolution ou o token da instância). Vai no header `apikey`. |
| `ALERT_EVOLUTION_API_VERSION` | `2` | Não | `2` (`{number,text}`) ou `1` (`{number,textMessage:{text}}`). |
| `ALERT_WHATSAPP_TO` | — | Não (é dado pessoal) | Números **só dígitos com DDI**, separados por vírgula, ex.: `5511999999999,5521988887777`. |
| `ALERT_WHATSAPP_MIN_SEVERITY` | `CRITICO` | Não | Mínimo só do WhatsApp. |
| **WhatsApp — adaptador HTTP genérico (alternativa, se um dia trocar de provedor)** | | | |
| `ALERT_WHATSAPP_WEBHOOK_URL` | — | Não | `https` em produção. Usa `ALERT_WHATSAPP_PROVIDER=generic`. |
| `ALERT_WHATSAPP_WEBHOOK_TOKEN` | — | **Sim** | Enviado como `Authorization: Bearer <token>`. |
| **Infraestrutura da configuração pelo painel (só quem faz o deploy define; NÃO há campo no painel)** | | | |
| `COMMUNICATION_ALLOW_PRIVATE_HOSTS` | `false` | Não | Em produção o painel recusa host SMTP/URL da Evolution que apontem para a rede interna (anti-SSRF). Ligue (`true`) SÓ se a Evolution roda no mesmo projeto do EasyPanel e você a acessa por um nome interno (`http://evolution:8080`): libera redes privadas e nomes internos (e `http` para eles). Loopback e metadados de nuvem (169.254.x.x) continuam SEMPRE bloqueados. |
| `COMMUNICATION_DISABLE_DB_CONFIG` | `false` | Não | `true` = os avisos usam SÓ as envs, sem ler o painel (interruptor de emergência; a tela do painel continua funcionando). Já vem `true` nos testes. |

Marque como "secreto" no EasyPanel: `ALERT_SMTP_PASS`, `ALERT_EVOLUTION_APIKEY`, `ALERT_WHATSAPP_WEBHOOK_TOKEN`. Nenhum deles vai para log, aviso nem mensagem de erro.

### 6.3 WhatsApp pela Evolution API

O notificador faz, para cada número de `ALERT_WHATSAPP_TO`:

```
POST {ALERT_EVOLUTION_BASE_URL}/message/sendText/{ALERT_EVOLUTION_INSTANCE}
apikey: <ALERT_EVOLUTION_APIKEY>
Content-Type: application/json

{ "number": "5511999999999", "text": "*[InnoFlow][CRITICO] payment_void_manual_review* (production/worker)\n..." }
```

(v1: `{ "number": "...", "textMessage": { "text": "..." } }`, escolhido por `ALERT_EVOLUTION_API_VERSION=1`.) Sem seguir redirect (a `apikey` não pode ir para outro host), prazo de 5 s, https obrigatório em produção. Se um número falhar e outro entregar, o aviso conta como entregue.

**O que foi e o que NÃO foi verificado:** rota, corpo (`number` + `text` na v2; `number` + `textMessage.text` na 1.x), exigência do header `apikey` e a resposta 201 foram conferidos no **código-fonte oficial da Evolution** (repositório `EvolutionAPI/evolution-api`: `sendMessage.router.ts`, `sendMessage.dto.ts`, `auth.guard.ts`; a 1.x no tag 1.6.0). **Não foi testado contra uma instância viva.** A documentação publicada (doc.evolution-api.com) não estava acessível na hora da implementação. Valide com o `npm run alerts:test` (6.5) antes de confiar.

Pontos de atenção na Evolution: a instância precisa estar **conectada** (estado `open`) — instância desconectada recusa o envio; em celular brasileiro antigo o número pode precisar (ou não) do 9º dígito conforme o cadastro no WhatsApp (se não chegar, teste com e sem o 9); o WhatsApp pode limitar mensagens automáticas de um número novo — use um número já em uso e peça ao(s) destinatário(s) para salvar o remetente.

**Outros provedores (Z-API, Twilio, Meta Cloud API, InnoChat):** não há adaptador específico e **não verifiquei o formato de nenhum deles** — "adaptar". O caminho barato é o adaptador genérico (`ALERT_WHATSAPP_PROVIDER=generic`): ele faz `POST` na sua URL com `Authorization: Bearer <token>` e o corpo `{ "to": "5511999999999", "text": "...", "severity": "CRITICO", "alert": "payment_void_manual_review", "service": "worker", "at": "2026-10-05T12:00:00.000Z" }`; uma ponte pequena (um fluxo n8n/Make ou um endpoint do InnoChat) converte isso para a API do provedor. Para um adaptador direto, implemente a interface `CanalDeAlerta` em `backend/src/lib/alertas/canais.ts` (um `enviar(evento)`) e registre em `criarCanalWhatsapp`.

### 6.4 E-mail (SMTP)

Qualquer SMTP serve (o do seu domínio, um serviço transacional, ou Gmail com **senha de app** — a senha normal do Gmail não funciona). Exemplo (porta 587, STARTTLS):

```
ALERT_EMAIL_TO=dono@seudominio.com.br
ALERT_SMTP_HOST=smtp.seudominio.com.br
ALERT_SMTP_PORT=587
ALERT_SMTP_USER=alertas@seudominio.com.br
ALERT_SMTP_PASS=<senha>
ALERT_EMAIL_FROM=InnoFlow <alertas@seudominio.com.br>
```

**O canal vale por servidor + remetente (desde a L1.6, 06/10/2026).** `ALERT_EMAIL_TO` (ou os destinatários do painel) é **opcional** e só decide se os **alertas ao dono** saem por e-mail. Sem destinatário o canal continua ativo para o e-mail **ao motorista** (redefinição de senha e avisos da seção 6.10) — antes isso não acontecia: o "esqueci minha senha" funcionava e nada saía. Com SMTP e remetente corretos e **nenhum** destinatário de alerta, a tela de Comunicação mostra o canal ativo com o aviso "só para mensagens ao motorista".

Assunto: `[InnoFlow][CRITICO] payment_void_manual_review (production)`. Corpo em texto puro: alerta, severidade, ambiente, serviço, hora, o que aconteceu, **o que fazer** e o contexto seguro. Confira o spam na primeira vez e marque como "não é spam"; para boa entrega, use um remetente do seu próprio domínio com SPF/DKIM configurados no provedor.

### 6.5 Como validar (faça depois de configurar)

No terminal (Console) do serviço **api** no EasyPanel:

```
npm run alerts:test
```

Ele dispara um alerta de teste (`alerts_test`, severidade INFO) **forçando** o envio por todos os canais configurados (ignora severidade mínima, dedupe e teto) e imprime, sem segredo, o resultado de cada canal: `ENVIADO` ou `FALHOU — <motivo curto>` (ex.: `smtp EAUTH 535`, `http 401`, `sem resposta em 5000ms`, `redirect 301 recusado`). Código de saída: `0` tudo enviado; `1` algum canal falhou; `2` nenhum canal configurado. "ENVIADO" significa que o SMTP/Evolution **aceitou** a mensagem — confirme na caixa de entrada e no WhatsApp.

O `alerts:test` usa a configuração EFETIVA (painel > env), a mesma dos avisos reais, e imprime de onde ela veio (`PAINEL (banco)` ou `variaveis de ambiente`). Pelo painel, o botão "Testar" de cada canal faz o mesmo para um destinatário só. Com a configuração pelo painel os três serviços leem a MESMA configuração do banco (mudança salva vale na API na hora e no worker/gateway em até ~35 s); com env, cada serviço precisa receber as mesmas variáveis. No log de boot do primeiro alerta de cada serviço aparece a linha `[alertas] avisos ao dono: email[database](...) + whatsapp/evolution[env](...)` (a origem de cada canal entre colchetes); ela reaparece quando a configuração muda. Se disser `nenhum`, o serviço não tem canal ativo (procure `[alertas] ...` de aviso logo antes).

### 6.6 Monitor externo do `/health` (sem código)

O notificador só fala quando o processo está vivo. Para "o sistema inteiro caiu", use um monitor externo gratuito (UptimeRobot, Better Stack, Hetrixtools etc.) com alerta por e-mail/WhatsApp/Telegram, intervalo de 1 a 5 minutos:

1. **API:** `GET https://<domínio-da-api>/health` — responde `200 {"status":"ok"}` só se Postgres **e** Redis respondem; `503` quando algum falha. Alerta em qualquer status diferente de 200. (Se a API não tem domínio próprio e só é alcançada pelo frontend, monitore `GET https://<domínio-do-frontend>/api/public/config` esperando 200: prova que o nginx alcança a API, mas não testa o banco.)
2. **Frontend:** `GET https://<domínio-do-frontend>/health` responde `200 ok` — **atenção:** é uma resposta fixa do nginx; prova que o frontend está de pé, não a API.
3. **Gateway OCPP e worker não têm rota HTTP de saúde.** Sinal indireto: se os carregadores ficam "offline" no mapa/painel ao mesmo tempo, o gateway caiu; o worker parado aparece como Pix pago sem crédito automático e capturas pendentes. Opcional: monitor de **porta** TCP no domínio `wss` do gateway (só prova que o proxy responde).

### 6.7 Quais alertas são críticos e o que fazer

Todos os alertas, com severidade e significado: `docs/GO-LIVE-PAGAMENTOS.md` §6 ("Alertas de Log") e `backend/src/core/alertas/severidade.ts` (fonte da severidade usada pelo aviso). Os **CRITICOS** — o aviso já traz a frase "O que fazer":

| Alerta | O que fazer |
|---|---|
| `payment_void_manual_review` | Conferir a venda no Site Cielo e cancelar/estornar a pré-autorização à mão (dinheiro do cliente preso no cartão). |
| `payment_void_skipped_already_captured` | A Cielo diz que a venda já foi capturada: conferir cobrança duplicada e estornar o excedente. |
| `payment_capture_retry_exhausted` | A captura não fechou após muitas tentativas: conferir no Site Cielo e capturar/cancelar à mão. |
| `payment_authorization_stuck` | Autorização presa: conferir no Site Cielo; se autorizada e sem sessão, cancelar. |
| `payment_pix_credit_divergence` | Pix pago com valor/pedido divergente e NÃO creditado: conferir na Cielo e creditar à mão se legítimo. |
| `session_cost_calculation_failed` | Sessão encerrada sem calcular o custo: revisar a sessão (tarifa/leituras) e cobrar ou isentar à mão. |
| `session_stop_not_obeyed` | O carregador não obedeceu o stop e segue entregando energia: desligar o carregador/disjuntor e investigar. |
| `payment_gateway_credential_rejected`, `payment_gateway_ip_not_allowed`, `payment_gateway_account_restriction` | A Cielo recusou credencial/IP/conta: todo pagamento falha até corrigir (tela do gateway; pedir liberação de IP ao suporte da Cielo). |
| `payment_gateway_environment_url_mismatch`, `payment_gateway_config_decrypt_failed`, `payment_gateway_secrets_undecryptable`, `payment_gateway_config_load_failed`, `payment_gateway_not_configured` | Pagamento fora do ar por configuração/chave de cifragem/banco: ver `GO-LIVE-PAGAMENTOS.md` §6. |
| `payment_fake_adapter_in_production` | **Desligar já:** `PAYMENT_ALLOW_FAKE_ADAPTER` ligado em produção aprova qualquer cartão sem cobrar. |

**IMPORTANTES** (e-mail): entre outros, `ocpp_auth_ip_flood`, `ocpp_message_flood`, `ocpp_foreign_transaction`, `payment_card_testing_suspected`, `google_link_repeated_failures`, `payment_config_changed` (alguém alterou a config do gateway: se não foi você, troque a senha do admin e a chave de cifragem) e os demais da tabela.

Para **mudar a severidade** de um alerta (ex.: tornar `ocpp_auth_ip_flood` CRITICO), edite a tabela em `severidade.ts` (vale após o deploy). Para receber só o essencial, use `ALERT_MIN_SEVERITY=CRITICO`.

### 6.8 Problemas comuns

- **Nada chega e o boot não mostra `[alertas] avisos ao dono ATIVOS`:** faltam variáveis neste serviço, ou há valor inválido (procure `[alertas] ...` no log de boot).
- **`[alertas] falha ao enviar o aviso ao dono` (campo `notifier: canal_falhou`):** o `motivo` diz a causa (`smtp EAUTH` = login recusado; `smtp ESOCKET`/`ETIMEDOUT` = host/porta/firewall; `http 401/403` = chave; `http 404` = instância/URL; `sem resposta em 5000ms`). Rode `npm run alerts:test` para reproduzir.
- **Chegou "tempestade de alertas":** mais de `ALERT_MAX_PER_HOUR` avisos numa hora. Abra os logs: costuma ser o gateway Cielo fora do ar, um ataque ou erro em laço.
- **Muito e-mail de IMPORTANTE:** suba `ALERT_MIN_SEVERITY=CRITICO` ou `ALERT_DEDUPE_MINUTES=120`.

---

## 7. Partições e retenção (N-11)

`MeterSample` (por `ts`) e `OcppMessage` (por `occurredAt`) são particionadas por mês. A migration inicial criou só 2026-09..2027-02 e uma partição **DEFAULT**. Passado o último mês, o `INSERT` **não falha** (a DEFAULT aceita) — mas as linhas se acumulam lá sem a poda por partição e, quando alguém tenta criar o mês depois, o `CREATE` **falha** enquanto houver linhas dele na DEFAULT. Por isso existe manutenção automática.

### 7.1 O que roda sozinho

- **Migration `20261005120000_partition_maintenance`:** cria a função SQL `ensure_partitions_ahead(tabela, meses)` e já deixa partições **até 2027-10** (12 meses à frente) nas duas tabelas.
- **Job `manter-particoes` no worker** (`worker/jobs/manterParticoesJob.ts`): roda **no boot do worker** e a cada `PARTITION_MAINTENANCE_INTERVAL_MS` (24 h). Cria o que faltar até `PARTITION_AHEAD_MONTHS` (6) meses à frente, **idempotente**, com lock consultivo no banco (duas réplicas não colidem). Se encontrar linhas na DEFAULT dentro do mês novo, **move** essas linhas para a partição antes de anexá-la. Depois, se ligada, aplica a retenção.
- Usa `ATTACH PARTITION` (lock `SHARE UPDATE EXCLUSIVE`, que **não bloqueia** o `INSERT` do OCPP) e `lock_timeout` de 10 s: se alguma transação longa segurar a tabela, a rodada desiste e a próxima tenta de novo.

### 7.2 Variáveis (worker; as demais apps ignoram)

| Variável | Padrão | Significado |
|---|---|---|
| `PARTITION_AHEAD_MONTHS` | `6` | Meses de partição a manter à frente (mín. 3). |
| `PARTITION_MAINTENANCE_INTERVAL_MS` | `86400000` | Cadência do job (mín. 60 s). |
| `RETENTION_ENABLED` | **`false`** | Liga a purga. Desligada, **nada** é apagado. |
| `RETENTION_DRY_RUN` | `false` | Com `RETENTION_ENABLED=true`: só loga o que seria removido. |
| `RETENTION_OCPP_MESSAGE_DAYS` | `365` | Prazo do log OCPP (mín. 30). |
| `RETENTION_METER_SAMPLE_DAYS` | `365` | Prazo das leituras de medidor (mín. 30). |
| `RETENTION_WEBHOOK_EVENT_DAYS` | `180` | Prazo das notificações de webhook já processadas (mín. 30). |
| `RETENTION_NOTIFICATION_LOG_DAYS` | `365` | Prazo do `NotificationLog` — o log dos e-mails ao motorista, sem dado pessoal (mín. 30). L1.6/DL6. |

### 7.3 Política de retenção (decidida pelo dono em 05/10/2026, DL6)

| Dado | Prazo | Como é removido |
|---|---|---|
| `OcppMessage`, `MeterSample` | **12 meses** | `DETACH` + `DROP` de partição **inteira**, só quando o mês inteiro já passou do prazo (prazo efetivo = 12 meses + até 1 mês). Nunca `DELETE` linha a linha; nunca a DEFAULT. |
| `WebhookEvent` (não particionada) | **180 dias** | `DELETE` em lotes de 1000, só eventos **já processados**; os não processados ficam (e há alerta). |
| `NotificationLog` (não particionada, sem dado pessoal) | **12 meses** | `DELETE` em lotes de 1000 por `createdAt`, de qualquer estado (um `PENDING` com mais de 12 meses é lixo). Mesmas guardas: só com `RETENTION_ENABLED`, respeita o `RETENTION_DRY_RUN` (só conta) e o piso de 30 dias. Evento de log: `retention_notification_log_deleted`. |
| `AuditLog` | **5 anos** | **Sem purga automática.** Não é particionada e começou em 09/2026: nada vence antes de 09/2031. O trigger só permite `DELETE` de linha > 24 meses. Antes de 2031 é preciso decidir/migrar para partição mensal (para o expurgo ser por partição inteira). |
| `WalletEntry`, `PaymentIntent`, `Debt`, `ChargingSession`, financeiro | **sem purga** | Append-only por trigger (UPDATE/DELETE/TRUNCATE). Expurgar exige decisão contábil/LGPD e intervenção manual de superusuário — fora do job, de propósito. |

**Proteção:** uma partição **não é apagada** se alguma sessão que toca aquele mês (±2 dias) ainda estiver **aberta** (não `STOPPED`, inclusive `STOP_UNCONFIRMED`/`FAULTED`), tiver **`Debt` em aberto** ou **`PaymentIntent` em andamento** (`CREATED`, `AUTHORIZED`, `CAPTURE_PENDING`, `PENDING`). Vira o alerta `retention_partition_blocked` e a próxima rodada tenta de novo. **Chargeback não protege:** o dossiê é um *snapshot* tirado ao registrar a disputa (L1.8) e não depende destas tabelas depois de salvo — **ligue `RETENTION_ENABLED` só depois que a L1.8 estiver em produção.**

### 7.4 Como ligar a retenção com segurança

1. Confirme que há **backup recente e restauração testada** (o `DROP` é irreversível).
2. Defina `RETENTION_ENABLED=true` **e** `RETENTION_DRY_RUN=true` no worker; reinicie.
3. No log do worker procure `retention_scan` e `retention_dry_run` (partição, intervalo, linhas estimadas, bytes). Confira que só aparecem meses com mais de 12 meses.
4. Troque `RETENTION_DRY_RUN=false` e reinicie. Cada remoção sai como `retention_partition_dropped`.
5. Para desligar de novo: `RETENTION_ENABLED=false`.

### 7.5 Como validar (SQL no Postgres)

```sql
-- Partições existentes e bordas (a última deve estar >= 2 meses à frente)
SELECT c.relname, pg_get_expr(c.relpartbound, c.oid)
  FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
 WHERE i.inhparent = '"MeterSample"'::regclass ORDER BY 1;   -- idem "OcppMessage"
-- A DEFAULT deve estar vazia
SELECT (SELECT count(*) FROM "MeterSample_default") AS meter, (SELECT count(*) FROM "OcppMessage_default") AS ocpp;
```

No log do worker: `partition_horizon` (por tabela, a cada rodada), `partition_created`, `retention_disabled` (retenção desligada).

### 7.6 Alertas (campo `alert` do log)

| Alerta | Significado / ação |
|---|---|
| `partition_horizon_low` | Menos de 2 meses de partições à frente: a criação automática falhou/não roda. Ver `partition_maintenance_failed` e o worker. |
| `partition_default_has_rows` | Há linhas na DEFAULT (mês sem partição, ou relógio de carregador fora do intervalo). O log traz o período; a próxima rodada move o que couber. |
| `partition_maintenance_failed`, `partition_maintenance_boot_failed`, `retention_failed` | Erro inesperado — ver o campo `err`. |
| `partition_maintenance_lock_timeout`, `retention_lock_timeout` | Outra transação segurava a tabela; repete na próxima rodada. |
| `retention_partition_blocked` | Partição velha não apagada: há sessão aberta/dívida/pagamento dependendo dela (a lista de sessões vem no log). |
| `retention_webhook_unprocessed_kept` | Webhook antigo **não processado** mantido: investigar por que não foi processado. |

### 7.7 Riscos e observações

- **`DROP` é irreversível.** A única rede é o backup; por isso a retenção nasce desligada e com dry-run.
- **LGPD:** `OcppMessage.payload` guarda o `idTag` e `MeterSample` o consumo por sessão (dado pessoal indireto); a retenção de 12 meses também é a limitação de armazenamento. Pedido de apagamento de titular (rota de apagar conta) **não está coberto** por este job.
- **Fuso:** as bordas das partições seguem o `TimeZone` do banco quando a migration inicial rodou (verificado: em `America/Cayenne` ficaram `-03`). A criação continua exatamente de onde a última partição termina, então funciona em qualquer fuso.
- **Testado em Postgres 18** (testes de integração com banco real); não rodado em PG 16 nesta entrega — a função só usa recursos antigos (`regexp_match`, `ATTACH PARTITION`, `make_interval`), mas a CI (PG 16) é quem confirma.
- **Rollback da migration:** ver o bloco comentado no fim de `20261005120000_partition_maintenance/migration.sql` (partições criadas são vazias e inofensivas).

### 6.9 Configuração pelo painel: segurança e operação

- **Quem pode:** só ADMIN. A senha atual é exigida em todo salvar (step-up, o mesmo do gateway; Redis do step-up fora do ar = salvar recusado com 503, nada gravado). Tentativas de senha erradas são limitadas e contam no mesmo balde do gateway.
- **Segredos:** a senha SMTP e a apikey da Evolution são cifradas (AES-256-GCM, `v1:<kid>:...`) com a `PAYMENT_SECRETS_KEY`; **nunca** voltam à tela (só "configurada" e os 4 últimos caracteres da apikey), nunca vão para log, resposta de erro nem auditoria. **Sem a `PAYMENT_SECRETS_KEY` no servidor não dá para salvar senha/apikey** (a tela mostra o aviso e o salvar responde 503).
- **Rotação da chave:** o script `npm run payments:recifrar-segredos` (seção "Rotação da PAYMENT_SECRETS_KEY") agora também re-cifra a senha SMTP e a apikey. Se a chave for trocada/perdida sem rotação, o canal fica desligado e a tela mostra `secretsDecryptable: false` — salve a senha/apikey de novo.
- **Trocar o destino exige reenviar o segredo:** mudar o servidor/usuário SMTP ou a URL/instância da Evolution sem informar a senha/apikey de novo é recusado — assim um acesso indevido não consegue apontar o servidor para um endereço do atacante e capturar a senha salva. Vale também para o botão "Testar" com valores ainda não salvos.
- **Anti-SSRF:** em produção, host SMTP/URL da Evolution apontando para a rede interna, loopback ou metadados de nuvem são recusados (na gravação e de novo na hora de conectar, no IP já validado — um DNS que muda entre a checagem e a conexão não passa). **Resíduo documentado:** o bloqueio vale para o que o painel configura; as envs `ALERT_*` são confiáveis (definidas por quem faz o deploy) e podem apontar para a rede interna. Redirecionamentos HTTP nunca são seguidos.
- **Auditoria:** cada salvar gera uma linha em "Auditoria" (`UPDATE` / `NotificationChannelConfig`) com antes/depois dos campos não secretos (segredo só como "alterado", destinatários só como contagem) e dispara o alerta `communication_config_changed` (IMPORTANTE) **pela configuração antiga** — se alguém trocar os destinatários, o aviso ainda chega ao dono de antes. Se não foi você: troque a senha do admin e a `PAYMENT_SECRETS_KEY`.
- **Migration:** `20261005140000_notification_channel_config` (tabela nova `NotificationChannelConfig`, singleton, aditiva) roda sozinha no boot dos 3 serviços (`prisma migrate deploy`).
- **Teste de conexão SMTP (06/10/2026):** `POST /api/admin/communication-settings/test-smtp-connection` só faz o handshake (conectar, TLS, autenticar) e **não envia mensagem**. Responde sempre 200 com `{ ok, stage: CONNECT|TLS|AUTH|OK, code, message, authenticated, durationMs }` (erro como código; o texto cru do servidor nunca aparece). Mesmas proteções do teste de e-mail: 5 por minuto, anti-SSRF, anti-exfiltração (trocar servidor/usuário exige reenviar a senha) e auditoria `OTHER` sem segredo.
- **Verificador de DNS do remetente (06/10/2026):** `GET /api/admin/communication-settings/domain-check?selector=<seletor DKIM>` consulta **SPF, DMARC e (com seletor) DKIM** do domínio do **e-mail remetente já configurado** — o domínio nunca vem do cliente e só é consultado se for um domínio público (nada de IP, `localhost` ou sufixo interno). Só lê TXT públicos pelo DNS do sistema (prazo de 4 s por consulta); falha do DNS vira `ERRO` naquele registro, nunca derruba. 6 por minuto por ADMIN. **Não configura nada:** SPF/DKIM/DMARC são registros no DNS do domínio (Registro.br, Cloudflare...). O valor exato de SPF e DKIM depende do provedor SMTP (o sistema manda pedir ao provedor e não inventa); só o DMARC traz um exemplo seguro (`v=DMARC1; p=none; rua=mailto:...`, que apenas monitora). Em produção o container precisa de saída DNS (UDP/TCP 53) para o resolvedor do sistema.

### 6.10 E-mails ao motorista (L1.6, 06/10/2026)

Além do alerta ao dono, o sistema manda e-mail **ao motorista**, pelo MESMO SMTP do painel (seção 6.4). Oito eventos, canal só e-mail (web push fica para a F7):

| Evento | Quando | Desligável? |
|---|---|---|
| `SESSION_COMPLETED` | sessão fechada com valor > 0 e SEM dívida: resumo + link do recibo | **sim** — "recibo" (`sessionReceiptEmail`) |
| `SESSION_CLOSED_BY_SERVER` | o carregador não confirmou o fim e o servidor encerrou (F5.9); sai sempre que isso acontece, mesmo com custo zero | **sim** — junto do recibo |
| `SESSION_PAYMENT_FAILED` | a cobrança virou dívida (carteira sem saldo; captura do cartão negada ou parcial) | **não** (cobrança) |
| `LOW_BALANCE` | SÓ no cruzamento do limiar: saldo antes ≥ limiar e depois < limiar (débito de sessão ou ajuste manual do ADMIN) | **sim** — `lowBalanceEnabled`; limiar `lowBalanceThresholdCents` 500–50000, padrão R$ 20,00 |
| `TOPUP_CREDITED` | Pix creditado na carteira | não (comprovante de dinheiro que entrou; o contrato não tem chave) |
| `REMOTE_START_BY_SUPPORT` | o ADMIN pediu recarga na conta do motorista (L1.5) | não (transparência; sem chave) |
| `PASSWORD_CHANGED` | troca de senha **pela própria pessoa logada** (`POST /api/auth/password`) | **não** (segurança) |
| `ACCOUNT_DELETED` | exclusão de conta (L1.4) | **não** |

**Como funciona (resumo):** o fato (fechar sessão, creditar Pix, trocar senha...) enfileira um job na fila BullMQ **`notificacoes`** *depois* do commit, em segundo plano e com prazo de 3 s — falha de Redis/SMTP **nunca** derruba nem atrasa transação de dinheiro. O **worker** decide (preferência), monta o e-mail e envia. **O worker precisa estar no ar e com as mesmas variáveis de SMTP**: sem ele os avisos ficam na fila. A idempotência é a tabela `NotificationLog` (unique `userId+tipo+canal+fato`) + um lock no Redis por fato: o mesmo fato nunca vira dois e-mails, nem com o job reprocessado. Falhou o envio → o job reentra com backoff exponencial (6 tentativas: 30 s, 1, 2, 4, 8 min). Esgotou → a linha vira `FAILED` (com um **código** de motivo, nunca a mensagem do SMTP) e sai o alerta **`communication_notification_failed`** (IMPORTANTE) — abra Admin > Comunicação e use o teste de e-mail.

**Variáveis:** nenhuma nova obrigatória. O link do e-mail usa `PUBLIC_APP_URL` (sem ela, em produção, o e-mail sai **sem botão/links** — nunca com link inventado; defina-a, é a mesma da redefinição de senha) e o rodapé usa `LEGAL_COMPANY_NAME`, `LEGAL_COMPANY_CNPJ`, `LEGAL_SUPPORT_EMAIL`, `LEGAL_SUPPORT_PHONE` (campo vazio = bloco omitido; nenhum CNPJ é inventado). A retenção do log é `RETENTION_NOTIFICATION_LOG_DAYS` (seção 7.2).

**Privacidade:** o e-mail do `ACCOUNT_DELETED` (a conta já foi anonimizada) existe só no payload do job — apagado ao concluir e ao esgotar as tentativas. O `NotificationLog` não guarda corpo, endereço nem mensagem de erro. Os logs registram só ids, tipo e código. Sem pixel de rastreio nem número de cartão.

**Limites conhecidos (honestos):**
- **Redis fora no instante do fato PERDE o aviso** (não há rascunho em banco para um varredor refazer: o contexto de alguns tipos não está no banco). O fato em si (cobrança, dívida, saldo) fica íntegro e visível no app.
- Se o processo morrer entre o SMTP aceitar a mensagem e o `UPDATE ... SENT` (milissegundos), o retry reenvia: é o preço de não perder aviso de cobrança/segurança.
- **Entregabilidade NÃO foi provada em provedor real.** Sem SPF/DKIM/DMARC do domínio do remetente (`ALERT_EMAIL_FROM`) os e-mails caem em spam — configure no provedor antes de divulgar. Teste com um Gmail e um Outlook de verdade.
- A troca de senha por **"esqueci minha senha"** continua usando o aviso próprio da L1.3 (fila local, sem retry); só a troca autenticada passa pela fila `notificacoes`.

**Como validar:** (1) Admin > Comunicação > teste de e-mail; (2) com o worker no ar, troque a senha de um motorista de teste em `/app/perfil` e confira o aviso; (3) `SELECT type, status, "statusReason", attempts FROM "NotificationLog" ORDER BY "createdAt" DESC LIMIT 20;` — `SENT` = saiu; `PENDING` com `statusReason` = tentando de novo; `FAILED` = esgotou (alerta emitido); `SKIPPED` + `PREFERENCE_OFF` = a pessoa desligou aquele aviso. **Problemas comuns:** `statusReason = EMAIL_NOT_CONFIGURED` (canal sem servidor/remetente), `SMTP_CONNECTION_FAILED` (host/porta/firewall), `SMTP_AUTH_FAILED` (login/senha de app), `SMTP_REJECTED` (remetente/destinatário recusado).

---

## 8. Backups e restauração (resumo operacional)

O passo a passo completo (o que é salvo e o que não é, RPO/RTO, restauração total no EasyPanel, restauração parcial, ensaio trimestral e checklist) está em **`docs/RUNBOOK-BACKUP-RESTAURACAO.md`**. O formato do arquivo cifrado, em `docs/BACKUP-FORMATO.md`. Aqui só o que pertence a este checklist de deploy:

- **O agendador roda no `worker`**; a API só enfileira "fazer backup agora" / "conferir backup". As 3 imagens do backend (`Dockerfile`, `Dockerfile.ocpp`, `Dockerfile.worker`) trazem o cliente do Postgres (`postgresql18-client`, com queda para o 17: `pg_dump`, `pg_restore`, `psql`), que precisa ser da versão do Postgres do EasyPanel ou mais nova. Se você subir a versão do Postgres do serviço, confira que o cliente da imagem acompanha. Atualize os **3** Dockerfiles juntos.
- O backup grava o dump em `/tmp` do container (gravável pelo usuário `node`; o diretório da aplicação não é). Precisa de espaço livre de ~2x o tamanho do dump por alguns instantes.
- **Nenhuma variável de ambiente nova é obrigatória** para o backup: destino (S3/Drive), horário e retenção são configurados em Admin > Backup e ficam cifrados no banco. Opcionais: `BACKUP_PG_BIN_DIR` (pasta dos binários do Postgres, só para desenvolvimento) e `BACKUP_ALLOW_PRIVATE_HOSTS`.
- **Guarde fora do EasyPanel:** a chave do backup (o `.txt` baixado em Admin > Backup) e a **`PAYMENT_SECRETS_KEY`**. Sem a segunda, restaurar o banco não devolve as credenciais da Cielo, o SMTP, a Evolution nem os cartões salvos. Detalhes na seção 4 do runbook.
- Faça o **ensaio de restauração a cada trimestre** (runbook, seção 9) e depois de trocar de servidor/versão do Postgres.
- **CI:** o job `backup-restore` (Postgres 16 e 18) prova o ciclo completo a cada push; é ele que avisa se uma migration nova quebrar a restauração.

### 8.1 O backup do lado da aplicação (Admin > Backup)

- **Variáveis que o backup usa** (nenhuma nova é obrigatória): `DATABASE_URL` no **worker** (é de onde o `pg_dump` lê; a senha vai ao `pg_dump` por variável de ambiente do processo filho, nunca em argumento nem em log); `PAYMENT_SECRETS_KEY` no **worker e na API** (o worker decifra as credenciais do destino e a cópia da chave do backup; a API as guarda — sem ela, salvar credencial responde 503 e o backup agendado falha com `SECRETS_KEY`); `JWT_SECRET` na API (assina o `state` do "Conectar com Google"). Para o Google Drive: `PUBLIC_API_BASE_URL` (a API monta o `redirect_uri` a cadastrar no app do Google Cloud: `https://<api>/api/backup/google/callback`) e `PUBLIC_APP_URL` (para onde o callback devolve o navegador, `.../admin/backup`). Opcionais de infraestrutura: `BACKUP_ALLOW_PRIVATE_HOSTS=true` (deixa o painel aceitar um S3 **da rede interna**, ex.: MinIO no mesmo projeto, `http://minio:9000`; sem isso, em produção, só https público — loopback e metadados de nuvem nunca) e `BACKUP_PG_BIN_DIR`.
- **Primeira configuração (checklist):** Admin > Backup → escolher o destino e salvar → **Testar destino** → **Gerar chave** e guardá-la FORA do servidor (aparece uma vez) → ligar o automático → **Fazer backup agora** → **Conferir backup**. Ligar sem destino completo ou sem chave é recusado (409). Backup com destino e sem chave **falha** (`KEY`), de propósito: nada sai do servidor sem cifra.
- **O que o backup NÃO leva (cópia separada, nunca no bucket do backup):** `PAYMENT_SECRETS_KEY` (sem ela as credenciais da Cielo, SMTP, Evolution, S3/Drive e os tokens de cartão que estão **no** banco, cifrados, ficam ilegíveis), `PAYMENT_SECRETS_KEY_PREVIOUS` enquanto durar uma rotação, `JWT_SECRET`, a **chave do backup** (o `.txt`) e **todas as chaves antigas** (cada cópia só abre com a chave que a cifrou), as envs da Cielo que ainda estejam só no ambiente (`CIELO_*`) e a senha do Postgres. **Redis não é salvo** (filas BullMQ, locks, contadores de tentativa/lockout, cache de resultado de comando, deduplicação de alertas): o que se perde são jobs em voo e contadores — o banco diz o que está pendente e os varredores do worker (captura de cartão, polling de Pix, watchdog de sessão, partições, o próprio agendador do backup) reprocessam; um pedido de "fazer backup agora" na fila pode precisar ser refeito.
- **Dois níveis de proteção do que o dono já pagou:** o agendador (diário às 03h de Brasília, configurável; se falhar, tenta de novo depois de 1 h, até 3 tentativas por horário; janela de recuperação de 12 h se o worker estava fora no horário) e os **alertas**: `backup_failed` e `backup_verify_failed` (CRÍTICO: WhatsApp+e-mail), `backup_stale` (IMPORTANTE: sem cópia há mais de 36 h com o automático ligado, no máximo 1 a cada 12 h), `backup_config_changed` (IMPORTANTE: destino/chave/conta Google mexidos). Sem e-mail/WhatsApp configurados (Admin > Comunicação) os alertas só aparecem no log do worker/API (campo `alert`). **O agendador morre junto com o worker:** o `backup_stale` também é emitido pelo worker — monitore o próprio serviço `worker` no EasyPanel.
- **Limites conhecidos:** o envio ao S3 é uma requisição só (**máx. 5 GiB** por arquivo cifrado; acima disso o backup falha com `TOO_BIG` — multipart ainda não existe); um destino por vez (S3 **ou** Drive); o Drive usa o escopo `drive.file` e o app do Google Cloud precisa estar **em produção** (em modo teste o acesso expira em 7 dias); o S3 e o Drive **reais** não foram exercitados em desenvolvimento (só servidores falsos que conferem o contrato HTTP), então faça **Testar destino**, um backup manual e **Conferir backup** logo no primeiro deploy.
- **Migration:** `20261006120000_backup_automatico` (tabelas `BackupConfig`, singleton, e `BackupRun`, aditiva) roda sozinha no boot dos 3 serviços (`prisma migrate deploy`).
