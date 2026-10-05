# Gateway Cielo: Parque das Feiras x InnoFlow, o que reaproveitar

**Data:** 04/10/2026 · **Autora:** Nova (arquitetura) · **Tipo:** comparação e plano. Nenhum código foi alterado.
**Pedido do dono:** "fazer a parte do gateway de pagamentos e das credenciais Cielo igual fizemos no Parque das Feiras".

Este documento compara a integração Cielo do Parque das Feiras (`C:\Projetos\Web\ParquedasFeiras`) com a do
InnoFlow (F5). Ele faz três coisas: separa o que a Cielo **provou** lá do que nós ainda tratamos como hipótese,
diz onde copiar o desenho do Parque e onde não, e dá um plano de convergência com estimativa.

Regra de leitura: nenhum valor de credencial (MerchantId, MerchantKey, ClientId, ClientSecret, token, segredo) foi
lido ou copiado do Parque. Só foram lidos código-fonte, migrations, docs e memórias de agentes.

---

## 0. Resumo para quem tem 2 minutos

1. **O Parque cobra cartão pela Cielo em produção desde setembro/2026.** Há evidência no histórico: um pedido real
   recusado e logado (`payments.ts:1098-1102`, 19/09/2026) e um teste com hora anotada que chegou à autorização
   (`frontend/security-headers.conf:120-125`). Hosts, OAuth do Silent Order Post (SOP) e script do SOP **deixaram de
   ser suposição**. O §1 do `GO-LIVE-PAGAMENTOS.md` pode ser corrigido.
2. **Mas o Parque usa a Cielo de outro jeito:** captura automática (`Capture: true`), **sem cofre** de cartão
   (`enableTokenize: false`) e **sem Pix da Cielo** (o Pix fica com o Mercado Pago e depois com o Sicoob). Por isso
   os fatos de que o InnoFlow mais depende (pré-autorização com captura parcial, cobrar `CardToken` salvo,
   `GET /1/card/{token}`, Pix `Cielo2`) **não foram exercitados lá**. Para eles o Parque não prova nada.
3. **Achei quatro defeitos no InnoFlow que travam o primeiro teste real.** Nenhum aparece nos nossos testes, porque
   todos rodam contra o `FakeAdapter`:
   - **B1. Falta um passo no SOP.** O token OAuth é entregue direto ao navegador. A Cielo exige um 2º passo
     (`/post/api/public/v2/accesstoken`), que devolve o `AccessToken` usado pelo script.
   - **B2. O nome do header do webhook vai ser recusado.** Hoje é `x-innoelektron-webhook-secret`. O campo "Key" do
     Site Cielo **só aceita letras**: o Parque descobriu isso em 02/09/2026, quando o dono não conseguiu salvar
     `X-Webhook-Secret`.
   - **B3. O Pix aponta para o endpoint errado.** O InnoFlow chama `POST /1/pix/` com o campo `QrCodeExpiration`.
     A documentação oficial diz `POST /1/sales` com `Payment.QrCode.Expiration`.
   - **B4. A CSP da página de cartão bloqueia o SOP.** Ela não libera os hosts da Cielo. No Parque, esse mesmo erro
     derrubou o cartão em produção (commit `7a2fc04`).
4. **Um risco novo, de produto, que pode reabrir a decisão D1.** A referência oficial de "pagamento com cartão
   tokenizado" (consultada hoje) marca `SecurityCode` como **obrigatório**. Para a bandeira Mastercard ela também
   exige `InitiatedTransactionIndicator` (Card On File). O InnoFlow cobra o `CardToken` **sem CVV**, que é a base do
   "toca Iniciar e pronto". Isso precisa de resposta da Cielo antes do go-live.
5. **Do desenho do Parque, adotar:** nome de header só com letras, um botão de diagnóstico que testa as credenciais
   de verdade, classificação de falhas da Cielo (credencial, IP fora da lista, indisponível) e guardar
   `Tid`/`AuthorizationCode`/`ProofOfSale`. Depois, e opcionalmente, o par de credenciais por ambiente.
   **Não adotar:** a tabela por provedor, o provedor ativo por família de cobrança e o esquema de chave de cifragem.
   Nesses três pontos o InnoFlow já está melhor, ou o problema não existe aqui.
6. **Usar a mesma conta Cielo do Parque não é recomendável.** O principal motivo é técnico: a URL de notificação é
   por estabelecimento (EC), e as notificações de um sistema chegariam ao outro. A decisão é do dono. Os prós e
   contras estão no §4.3.

---

## 1. Como ler as marcas de confiança

| Marca | Significa |
|---|---|
| **[PROD]** | Código do Parque que roda em produção, **com evidência de execução real** (commit, incidente ou log citado) |
| **[CÓDIGO]** | Código do Parque em produção, mas sem evidência de que aquele caminho já foi exercido de verdade |
| **[SANDBOX]** | Medido pelo Parque contra o sandbox da Cielo (está registrado no comentário do código) |
| **[DOC]** | Está na documentação: no plano do Parque, que foi revisado contra a doc oficial em 17/08/2026, ou na doc oficial que eu consultei hoje (04/10/2026, `docs.cielo.com.br/ecommerce-cielo/…​.md`) |
| **[CONTRADIÇÃO]** | As fontes discordam entre si |
| **[NÃO CONFIRMADO]** | Nenhuma fonte prova. Vira pergunta para a Cielo ou teste no sandbox |

Os caminhos do Parque são relativos a `C:\Projetos\Web\ParquedasFeiras\`. Os do InnoFlow, a `C:\Projetos\Web\InnoElektron\`.

---

## 2. Fatos da Cielo: o que o Parque prova e onde o InnoFlow está

### 2.1 Hosts, credencial e erros de transporte

| # | Fato | Fonte no Parque | Confiança | Estado no InnoFlow | Ação |
|---|---|---|---|---|---|
| F1 | API transacional: `https://apisandbox.cieloecommerce.cielo.com.br` (sandbox) e `https://api.cieloecommerce.cielo.com.br` (produção). Atende `POST /1/sales`, `PUT …/capture` e `PUT …/void` | `backend/src/lib/cielo-gateway-config.ts:156-164`; `adaptadores/cielo/api.ts:302-336` | **[PROD]** (cobrança real em `routes/payments.ts:1098-1102`) | Mesmos valores em `backend/src/core/pagamentos/configGateway.ts:296-299` | Só documentação: tirar "não confirmados" do `GO-LIVE-PAGAMENTOS.md` §1 (l. 26) e §4 Fase B (l. 208-211) |
| F2 | Consulta em **outro host**: `apiquerysandbox…` e `apiquery.cieloecommerce.cielo.com.br`. Janela de 3 meses: depois disso volta 404 | `cielo-gateway-config.ts:140-164`; `adaptadores/cielo/api.ts:338-355`; `adaptadores/cielo/index.ts:476-510`; plano §4.7 (`docs/PLANO-GATEWAY-CIELO.md:856-882`) | **[CÓDIGO]** + **[DOC]** | Igual (`cieloHttpClient.ts:120-128`) | Nenhuma no host. Tratar o 404 da consulta como "fora da janela, conferir à mão" (ver C2.2) |
| F3 | `MerchantId` e `MerchantKey` vão em **cabeçalhos**. Credencial errada **não volta 401**: volta **HTTP 400** com lista `[{Code, Message}]`. Códigos `101` (MerchantId), `131` (MerchantKey ausente), `132` (MerchantKey inválida), mais `138/139/140`. O Parque também confere o texto da mensagem por regex `merchant id/key`, porque "os códigos do sandbox não são iguais aos de produção" | `adaptadores/cielo/api.ts:61-96`, `198-205`; `index.ts:34-37` | **[SANDBOX]** (sonda de 01/09/2026) | `cieloHttpClient.ts:84-87` trata todo não-2xx igual. `iniciarSessaoRemota.ts:206-215` registra só "falha ao pré-autorizar" | **Código** (C2.2): classificar como credencial e alertar o admin. O motorista continua vendo 503 |
| F4 | **403** costuma ser o IP de saída fora da lista de "IPs confiáveis" do Site Cielo, e não credencial revogada. A mensagem precisa dizer isso, senão o admin apaga uma credencial que está certa | `adaptadores/cielo/api.ts:106-118`, `279-285`; plano §4.8 (`:884-900`) | **[DOC]** | Não tratado | **Código** (C2.2) e item no checklist do dono (§4) |
| F5 | Formato da `MerchantKey`: o `MerchantId` é um GUID de 36 caracteres, a `MerchantKey` tem 40 | Não está no Parque | **[DOC]** (referência do Pix `Cielo2`, consultada hoje) | O `GO-LIVE` §4 (l. 215) diz "32+ chars" | Documentação: corrigir para "40 caracteres" |
| F6 | Sandbox e produção são servidores **separados**. Credencial de um é recusada pelo outro **com o mesmo erro** de credencial errada | `routes/admin.ts:2751-2765`; `adaptadores/cielo/sop.ts:47-58` | **[PROD]** ("travou o dono por horas" em 02/09/2026) | Não tratado | **Código** (C2.1): o diagnóstico precisa dizer o ambiente e o endereço contatado |

### 2.2 Silent Order Post (cadastro de cartão)

| # | Fato | Fonte no Parque | Confiança | Estado no InnoFlow | Ação |
|---|---|---|---|---|---|
| F7 | **Passo 1, OAuth2 na Braspag:** `https://authsandbox.braspag.com.br/oauth2/token` e `https://auth.braspag.com.br/oauth2/token`. `Authorization: Basic base64(ClientId:ClientSecret)`, corpo `grant_type=client_credentials` em form-urlencoded, sem `scope`. Credencial recusada volta **400 com `error: invalid_client`**, não 401/403 | `adaptadores/cielo/sop.ts:35-45`, `90-181`; memória `.claude/agent-memory/vega/project_sop_credencial_reportada_como_gateway_fora_do_ar.md` | **[PROD]** (incidente de 02/09/2026; cartão funcionando em 19/09) + **[DOC]** (doc oficial "integrando-com-o-sop", confere hoje) | O mecanismo bate (`cieloSopOAuth.ts:43-74`). A URL vem só da env `CIELO_SOP_OAUTH_TOKEN_URL`, sem default. Qualquer não-2xx vira erro genérico | **Código** (C1.1): default por ambiente e `invalid_client` classificado como credencial. **Documentação:** tirar "suposição" do `GO-LIVE` §1 (l. 27) |
| F8 | **Passo 2, AccessToken do SOP:** `POST https://transactionsandbox.pagador.com.br/post/api/public/v2/accesstoken` (sandbox) ou `https://transaction.pagador.com.br/…` (produção), com `Authorization: Bearer <token do passo 1>`, cabeçalho `MerchantId` e corpo `{MerchantId}`. A resposta traz `AccessToken` e `ExpiresIn`. Credencial ruim volta **401 puro, sem corpo**. HTTP 500 costuma indicar **MerchantId e ClientId de lojistas diferentes** | `adaptadores/cielo/sop.ts:63-67`, `183-261`; `routes/admin.ts:2786-2798` | **[PROD]** + **[DOC]** (a doc oficial confere hoje e diz "por padrão, 20 minutos" de validade) | **NÃO EXISTE.** `cieloAdapter.ts:155-162` devolve o `access_token` do OAuth como se fosse o `accessToken` do navegador | **Bloqueador B1, código** (C1.1) |
| F9 | **URL do script:** sandbox `https://transactionsandbox.pagador.com.br/post/scripts/silentorderpost-1.0.min.js`, produção `https://transaction.cieloecommerce.cielo.com.br/post/scripts/silentorderpost-1.0.min.js` | `frontend/src/lib/cieloSop.ts:28-38` | **[PROD]** para produção (commit `7a2fc04`) · **[CONTRADIÇÃO]**: a doc oficial de hoje cita uma URL única, `https://www.pagador.com.br/post/scripts/silentorderpost-1.0.min.js` | Env `CIELO_SOP_SCRIPT_URL` sem default | **Código** (C1.1): default por ambiente com as URLs do Parque, que estão provadas. A env continua como reserva. Perguntar à Cielo qual é a canônica |
| F10 | **Em produção, o script envia o cartão para `https://www.pagador.com.br/post/api/public/v1/card`**, um host diferente do script | `frontend/security-headers.conf:109-115`; commit `7a2fc04` | **[PROD]** (visto no console do dono) | A CSP da página isolada (`frontend/nginx.conf.template:134`) tem `script-src 'self'`, `connect-src 'self'`, `frame-src 'none'` e `form-action 'none'` | **Bloqueador B4, código** (C1.2) |
| F11 | **Como chamar o script:** é a função global `bpSop_silentOrderPost(options)`, não um construtor. Os campos são lidos do nosso DOM pelas classes `bp-sop-cardholdername`, `bp-sop-cardnumber`, `bp-sop-cardexpirationdate` e `bp-sop-cardcvv bp-sop-cardcvvc` (as duas: o manual se contradiz). Opções `environment: "sandbox"/"production"` (minúsculo) e `language: "PT"`. Callbacks: `onSuccess {PaymentToken}`, `onError {Code, Text}`, `onInvalid [{Field, Message}]` | `frontend/src/lib/cieloSop.ts:1-26`, `40-59`, `96-140`, `265-290` | **[PROD]** | `frontend/src/pagamento-cartao/sopClient.ts:44-49` só tem o mock e lança erro fora dele | **Código** (C1.2) |
| F12 | **Normalização na hora da leitura:** o número vai só com dígitos, e a validade em **`MM/AAAA`** (a Braspag recusou `MM/AA` em produção em 03/09/2026). Normalizar no último instante, porque um re-render do React desfaz o valor | `frontend/src/lib/cieloSop.ts:212-263` | **[PROD]** | Não existe (sem o caminho real) | **Código** (C1.2). Copiar o comportamento |
| F13 | **O script não devolve a bandeira.** A bandeira é detectada no navegador, no vocabulário da Cielo (`Visa`, `Master`, `Elo`, `Amex`, `Diners`, `Hipercard`, …). A regex do **Elo vem antes** das de Visa e Discover, e a do Hipercard 3841 antes da do Diners | `frontend/src/lib/cieloSop.ts:293-380` | **[PROD]** (bug achado em 19/09/2026) | O InnoFlow já detecta no navegador (`frontend/src/pagamento-cartao/cardBrand.ts`) | Revisão de código: conferir a ordem das regras do Elo contra a do Parque |
| F14 | `enableTokenize: "true"` faz o script devolver **`CardToken`** (cofre "Cartão Protegido") em vez de `PaymentToken`. No sandbox, a tokenização exige pedido ao Suporte | O Parque usa `enableTokenize: false` (`cieloSop.ts:121-130`) | **[DOC]** (doc oficial de hoje). **O Parque não exercitou** | O InnoFlow precisa do `CardToken` (D1 do dono) | **Código** (C1.2). Confirmar no sandbox o nome exato do campo no `onSuccess` |
| F15 | Cartão Protegido usa a **mesma** `MerchantId`/`MerchantKey` da cobrança (`POST /1/card`). Não tem conceito de *customer* e **não guarda CVV**. Em produção, SOP e Cartão Protegido são habilitados por autoatendimento (Site Cielo, aba Microsserviços, com 2FA). Em sandbox, o SOP depende do Atendimento Cielo | Plano §4.1 (`:434-489`), §4.5 (`:748-794`), §12 (`:1485-1501`); migration `20260901190000_credenciais_do_sop_da_cielo` | **[DOC]** | Coerente | Só documentação (§4) |

### 2.3 Cobrança, captura, cancelamento

| # | Fato | Fonte no Parque | Confiança | Estado no InnoFlow | Ação |
|---|---|---|---|---|---|
| F16 | **HTTP 2xx não é aprovação.** Aprova só com `ReturnCode` ∈ {`00`, `0`, `4`, `6`} **e** um `Status` coerente. `Status 1` com `ReturnCode 51` é **negada**. O `ReturnCode` é comparado como string normalizada. `Status` desconhecido nunca vira aprovação | `adaptadores/cielo/traducao.ts:11-175`; plano §4.6 (`:796-854`) | **[CÓDIGO]** + **[DOC]** | `normalizarStatusCielo.ts:30-54` exige `00`/`4` no `Status 1` (certo). **No `Status 2` não confere o `ReturnCode`**. Os status 11, 13 e 20 caem em `FAILED` | **Código** (C2.3), endurecimento |
| F17 | **Captura parcial só uma vez por transação.** Sucesso da captura: `Status 2` com `ReturnCode "6"`. Endpoint `PUT /1/sales/{PaymentId}/capture?amount=` | **O Parque não usa** (`Capture: true`, `index.ts:243-262`) | **[DOC]** (referência oficial "capturar-apos-autorizacao", hoje) | Coerente (`cieloHttpClient.ts:108-112`) | Nenhuma. Vale o teste no sandbox |
| F18 | **Prazo para capturar uma pré-autorização** | Ausente no Parque | **[NÃO CONFIRMADO]**. A doc oficial consultada hoje não traz número. Os "5 dias úteis" em `cielo-fatos-verificados.md` ficaram sem fonte reconferida | O watchdog da F5.9 assume prazo de horas, muito abaixo de qualquer prazo plausível | Pergunta à Cielo (§4.2) |
| F19 | **Cancelar e estornar usam o mesmo endpoint**, `PUT /1/sales/{id}/void[?amount=]`. A Cielo decide pelo relógio: até 23h59 do dia da autorização devolve `Status 10` (Voided); depois, `11` (Refunded). `ReturnCode` `0`/`9` significa aprovado. `10`/`223`/`476` significa **já em andamento**: nem sucesso nem recusa, então não retentar e conciliar à mão. `40`/`41`/`53`/`101` é recusa definitiva. `103`-`107` é restrição cadastral (problema da conta). Estorno parcial só em transação **capturada**. `Reason: "HighRisk"` é obrigatório no cancelamento por fraude desde 17/04/2026 | `adaptadores/cielo/traducao.ts:257-367`; `adaptadores/cielo/index.ts:531-641`; plano §4.9 (`:902-979`) | **[CÓDIGO]** + **[DOC]**. Não há evidência no repositório de estorno real pela Cielo | `cieloAdapter.ts:80-89` lê **só o `Status`**: um `Status 11` vira `FAILED` e o `ReturnCode` é ignorado | **Código** (C2.3) |
| F20 | **Não existe chave de idempotência** (o `RequestId` serve só para rastreio). Há detecção de duplicidade do lado da Cielo numa janela de cerca de 5 s, descrita num manual de outro produto | `adaptadores/cielo/index.ts:90-103`; plano `:641-689` | **[DOC]** (a janela está **[NÃO CONFIRMADO]** para a API 3.0, Q9 do plano) | Coerente: o InnoFlow reconsulta por `MerchantOrderId` depois de timeout (`cieloAdapter.ts:36-55`) | Nenhuma |
| F21 | **`SoftDescriptor`:** até 13 caracteres, só `A-Z0-9`. Um caractere especial faz a Cielo recusar **a transação inteira** | `adaptadores/cielo/index.ts:76-86`, `162-184` | **[DOC]** + **[CÓDIGO]** | `cieloPayloads.ts:46` repassa sem higienizar (hoje ninguém preenche) | **Código** (C2.4), barato |
| F22 | **O que precisa ser guardado na hora:** `Tid`, `AuthorizationCode`, `ProofOfSale` e `SentOrderId`. O chargeback chega meses depois, quando a consulta (3 meses) já não responde | `adaptadores/cielo/index.ts:347-364` | **[CÓDIGO]** | `PaymentIntent` não tem esses campos (`backend/prisma/schema.prisma:880-960`) | **Código** (C2.5): migration pequena |
| F23 | **A taxa (MDR) não vem na API.** O FAQ oficial nega expressamente. Taxa ausente é `null`, nunca `0` | `adaptadores/cielo/index.ts:395-406` | **[DOC]** | Não aplicável hoje | Nenhuma |
| F24 | **Cobrar `CardToken` salvo sem CVV.** A referência "Criar pagamento com cartão tokenizado" (hoje) marca `CreditCard.SecurityCode` como **"required"** e documenta `InitiatedTransactionIndicator` (Card On File) como "obrigatório para bandeira Mastercard". A doc do SOP diz que existe `cvvRequired`, mas "a loja precisa de autorização da adquirente para transacionar sem CVV" | **O Parque não usa cofre** (`adaptadores/cielo/index.ts:19-21`) | **[DOC]** contra a premissa do InnoFlow, **[NÃO CONFIRMADO]** na prática | `cieloPayloads.ts:47-52` manda `CardToken` **sem** `SecurityCode` e sem indicador de Card On File | **Risco R1** (§3.4): pergunta obrigatória à Cielo antes do go-live |
| F25 | **Consultar um `CardToken`** (`GET /1/card/{token}`, para bandeira e final) | O Parque não usa | **[NÃO CONFIRMADO]**. **Não aparece** no índice oficial (`llms.txt`) consultado hoje, e a página de pagamento tokenizado não documenta nenhum GET | O cadastro de cartão **depende** dele (`mePaymentMethods.routes.ts:108`, `cieloHttpClient.ts:135-144`) | **Risco R2**. **Código** (C1.3): não depender dele |

### 2.4 Webhook (Post de Notificação)

| # | Fato | Fonte no Parque | Confiança | Estado no InnoFlow | Ação |
|---|---|---|---|---|---|
| F26 | O corpo é **JSON** com `PaymentId` e `ChangeType`. O lojista cadastra a URL no Site Cielo (*E-commerce > Gestão API E-commerce > Configurações > URL de notificações*, com 2FA), em **HTTPS na porta 443, até 255 caracteres**. Até **3 cabeçalhos** estáticos (chave até 256, valor até 1500). Retentativa a cada 30 min, 3 vezes. A Cielo testa a URL ao salvar. ChangeTypes: `1` status, `5` cancelamento negado, `7` chargeback, `25` estorno parcial | Plano §4.3 (`:570-639`); `adaptadores/cielo/index.ts:116-129` | **[DOC]** | Coerente | Nenhuma |
| F27 | **O campo "Key" do header no Site Cielo recusa espaço, número e caractere especial.** `X-Webhook-Secret` não pôde ser salvo e o Parque trocou para `CieloWebhookSecret`. Uma instalação antiga com nome inválido descarta **todas** as notificações sem aviso | `backend/src/lib/cielo-gateway-config.ts:26-59` | **[PROD]** (dono no Site Cielo, 02/09/2026) | `WEBHOOK_SECRET_HEADER_NAME = 'x-innoelektron-webhook-secret'` (`webhookCieloSecrets.ts:14`), repetido em `logRedactPaths.ts:21` e no `GO-LIVE` §5 (l. 295 e 309) | **Bloqueador B2, código** (C1.4) |
| F28 | **O ping de validação da URL** chega sem `PaymentId`/`ChangeType`. O Parque responde **200 antes** de conferir o segredo, para a URL ser aceita | `adaptadores/cielo/index.ts:646-673`; `routes/payments.ts:1807-1813` | **[CÓDIGO]**. Não achei registro de o ping ter sido observado | `webhooksCielo.routes.ts:33` aplica `validateBody` **antes** de tudo, então um ping vazio recebe **400** | **Código** (C1.4), como precaução |
| F29 | **O header é um portão, não uma prova.** O corpo nunca vale como verdade: sempre reconsultar com a nossa credencial | `routes/payments.ts:1781-1788` | **[CÓDIGO]** | Igual (decisão §3 da F5) | Nenhuma |

### 2.5 Pix

| # | Fato | Fonte no Parque | Confiança | Estado no InnoFlow | Ação |
|---|---|---|---|---|---|
| F30 | **Pix `Cielo2` é `POST /1/sales`** (não `/1/pix`), com `Payment.Type: "Pix"`, `Payment.Provider: "Cielo2"` e **`Payment.QrCode.Expiration`** (segundos, padrão 86400, **máximo 24 h**). A resposta traz `QrCodeString`, `QrCodeBase64Image`, `PaymentId`, `SentOrderId`, `Status 12` e `ReturnCode "0"` | Plano §4.2 (`:491-524`) | **[DOC]** (plano + referência oficial "cielo2-gerar-qr-code-pix", hoje). **O Parque não usa Pix da Cielo** | `cieloHttpClient.ts:130-133` usa `POST /1/pix/`. `cieloPayloads.ts:57-86` usa `Payment.QrCodeExpiration` | **Bloqueador B3, código** (C1.5) |
| F31 | **O Pix `Cielo2` não tem sandbox** (no sandbox antigo fica sempre pendente). Não existe status de "expirado". `PUT /1/sales/{id}/void` remove um QR não pago. A devolução tem prazo de 90 dias e **só acontece se houver saldo na conta Pix**: quem está em transferência automática não consegue devolver. Habilitar o Pix é autoatendimento (*Meu Cadastro > Autorizações > Pix*) | Plano §4.2 (`:514-568`), §11 (`:1397-1411`) | **[DOC]** | Coerente com a regra "Pix só pré-pago" | Ação do dono (§4) |
| F32 | **Por que o Parque não usa o Pix da Cielo:** o código registra só "decisão do dono" (`adaptadores/cielo/index.ts:9-17`; migration `20260901120000_gateway_por_familia_de_cobranca`). O motivo não está escrito em lugar nenhum que eu tenha lido | — | **Inferência minha, não fato:** prováveis motivos são a falta de sandbox (F31), a devolução que depende de saldo (F31) e o MED, que o Sicoob detecta melhor (`.claude/agent-memory/nova/project_sicoob_pix.md`) | — | Se o dono quiser, perguntar a ele mesmo. **Não muda nada no InnoFlow**: aqui o Pix só recarrega carteira, e devolução é rara |

---

## 3. Diferenças de desenho: o que adotar

### 3.1 Tabela de decisão

| # | Tema | Parque das Feiras | InnoFlow hoje | Melhor para o InnoFlow | Decisão |
|---|---|---|---|---|---|
| D1 | **Credenciais por ambiente** | **Dois pares lado a lado** (`test*` e produção) para a cobrança e para o SOP, escolhidos pelo `environment` gravado (`cielo-gateway-config.ts:247-308`). Dá para testar o par que **não** está ativo (`credenciaisParaTeste`, `:340-381`). O segredo do webhook é **um só** para os dois ambientes (comentário da migration `20260817190000`) | **Um conjunto** + `environment` (`schema.prisma:1109-1130`). Virar o ambiente obriga a digitar tudo de novo. Volta para o sandbox bloqueada se houver pagamento em andamento | **Parque**, mas com prioridade baixa. O ganho de verdade é poder **testar a credencial de produção antes de virar**, e o botão de diagnóstico (D7) já entrega a maior parte disso | **ADOTAR depois** (fase C3, opcional). Antes disso, adotar D7 |
| D2 | Tabela própria por provedor | `PaymentGatewayConfig` genérica + `CieloGatewayCredentials` 1:1, porque há três provedores (MP, Cielo, Sicoob) | Singleton `id=1` com colunas da Cielo | **InnoFlow.** Só existe um provedor e nenhum outro no roteiro. Generalizar agora seria custo sem uso | **NÃO ADOTAR.** Reabrir se um 2º provedor entrar |
| D3 | Provedor ativo por família (cartão/Pix) | `activePaymentProviderCartao/Pix` + registro de adaptadores (`routes/admin.ts:2438-2713`) | `cardEnabled`/`pixEnabled` | **InnoFlow.** As flags já fazem o "desligar a família", e tudo passa pela Cielo | **NÃO ADOTAR.** Reabrir se o dono quiser o Pix fora da Cielo |
| D4 | Chave de cifragem | `ENCRYPTION_KEY` única, com fallback derivado do `JWT_SECRET` (`backend/src/lib/crypto.ts:12-14`, `48-65`). Sem rotação: o procedimento é "troca e digita tudo de novo", e a tabela do `docs/RUNBOOK.md:617-628` nem lista as colunas da Cielo | `PAYMENT_SECRETS_KEY` dedicada, formato versionado `v1:<kid>:…`, `_PREVIOUS` e script `payments:recifrar-segredos` | **InnoFlow**, com folga | **NÃO ADOTAR.** (Aviso ao Parque, fora do escopo: o runbook dele está incompleto) |
| D5 | Step-up ao salvar credencial | **Não tem** no gateway. Só a manutenção pede a senha de novo (`routes/maintenance.ts:74`, `:99`) | Senha atual exigida, com limite no Redis e falha fechada | **InnoFlow** | **MANTER** |
| D6 | Autenticação do webhook | Só o header. **Nome fixo, só com letras.** O valor é gerado no servidor (`randomBytes(32)` em hex), mostrado **uma única vez**, com rota para gerar de novo e `writeLimiter` (`routes/admin.ts:2387-2436`). Responde 403 para segredo errado | Token no caminho (env) + header (banco ou env). O valor é digitado ou gerado no navegador (`crypto.getRandomValues`, alfanumérico de 40, `frontend/src/lib/paymentGateway.ts:112-139`). Responde 401 | **Misto.** O token no caminho do InnoFlow é uma camada a mais e fica. Do Parque, adotar o **nome só com letras** (obrigatório) e o **200 para o ping** | **ADOTAR o nome e o ping** (C1.4). Gerar o valor no servidor: opcional, o gerador do navegador já é seguro |
| D7 | Diagnóstico em um clique | `POST /api/admin/gateway/cielo/testar-formulario` executa **de verdade** o OAuth e o accesstoken com o par salvo do ambiente escolhido. Sempre responde 200 com `{ok, passo, motivo, mensagem}`, informa ambiente e endereço contatado e nunca devolve segredo (`routes/admin.ts:2715-2900`). Nasceu de "um dia inteiro de cartão morto" | Não existe. O primeiro sinal de credencial errada aparece quando o motorista tenta pagar | **Parque** | **ADOTAR** (C2.1), estendido para testar também a `MerchantKey` |
| D8 | Classificação das falhas da Cielo | Tipos de falha da porta: `credencial_invalida`, `indisponivel`, `payload_recusado`, `excesso_de_chamadas`, `fora_da_janela_de_consulta`. Texto próprio para o 403 de IP. `invalid_client` tratado à parte | `CieloHttpError` com `httpStatus` e só | **Parque** | **ADOTAR** (C2.2), só nos logs e alertas do admin. A mensagem ao motorista não muda |
| D9 | Leitura do resultado do void/estorno | Três desfechos (`solicitado`/`recusado`/`indefinido`) pelo `ReturnCode` | Só o `Status` | **Parque.** Um `void` de pré-autorização que volte `Status 11` ou `ReturnCode 476` hoje vira `FAILED` | **ADOTAR** (C2.3) |
| D10 | Cache da credencial | 30 s, invalidado no PUT | 10 s, invalidado no PUT, com contador de geração contra corrida | Equivalentes | Manter |
| D11 | Coerência entre ambiente e URL | Deriva a URL do ambiente, sem conferir | Confere e se recusa a montar o adaptador se não bater (`pagamentoPortInstance.ts:54-64`) | **InnoFlow** | Manter |
| D12 | Sandbox numa instância pública | Não trata | Restringe a uma lista de testadores com identidade verificada | **InnoFlow** | Manter |
| D13 | Dados guardados da transação | `Tid`, `AuthorizationCode`, `ProofOfSale`, `SentOrderId` | Só `cieloPaymentId` e `returnCode` | **Parque** | **ADOTAR** (C2.5) |

### 3.2 O que conferi e o que não conferi

- Conferi **lendo o código** os dois lados de cada linha da tabela acima. Não rodei nenhum teste dos dois projetos e
  não fiz nenhuma chamada à Cielo.
- As três páginas da doc oficial citadas como "hoje" eu busquei e resumi com uma ferramenta de leitura de página. Não
  vi os exemplos que a Cielo publica como imagem (o Parque já tropeçou nisso, `frontend/src/lib/cieloSop.ts:7-25`).
  Antes de virar código, essas três páginas devem ser relidas por quem for implementar.

### 3.3 Como fica a porta

A porta do InnoFlow (`PagamentoPort`: `autorizar`, `capturar`, `cancelar`, `consultar`, `consultarPorPedido`,
`criarPix`, `consultarPix`, `sessaoTokenizacao`, `consultarCartaoTokenizado`) **não precisa mudar de forma** para
nenhum item da fase C1. Três ajustes de contrato entram nas fases C1 e C2:

- `SessaoTokenizacao.accessToken` passa a ser o **`AccessToken` do SOP** (passo 2), não o token OAuth. O formato do
  campo é o mesmo; muda o significado.
- `ResultadoCancelamento` ganha um desfecho `'IN_PROGRESS'` ou equivalente para os códigos `10`/`223`/`476` (C2.3).
  Hoje esse caso cai em `FAILED`.
- O cadastro de cartão (`POST /api/me/payment-methods`) passa a aceitar `last4`, `expiryMonth` e `expiryYear`
  vindos da página isolada, junto com o `cardToken` e a `brand` (C1.3). Isso é PAN **truncado**: o PCI DSS
  permite guardar e transmitir. O `GET /1/card` vira só conferência de melhor esforço.

### 3.4 Riscos, do mais caro para o mais barato

| # | Risco | Efeito se acontecer | Mitigação |
|---|---|---|---|
| R1 | **A Cielo exige o CVV para cobrar o `CardToken`** (F24) | O modelo "cadastra uma vez e só toca Iniciar" (D1 do dono) **não funciona** do jeito que está: toda pré-autorização volta recusada | Perguntar antes de qualquer outra coisa (§4.2, P1). Saídas possíveis, cada uma com custo: (a) autorização da Cielo para transacionar sem CVV, com os indicadores de Card On File; (b) pedir o CVV a cada recarga na página isolada, um campo a mais, ainda SAQ A-EP; (c) voltar à D1 do dono. **Decisão do dono se (a) não sair** |
| R2 | `GET /1/card/{token}` não existe (F25) | Todo cadastro de cartão falha com `CARD_VERIFICATION_FAILED` | C1.3: dados truncados vindos do navegador; o GET deixa de ser obrigatório |
| R3 | Pix sem sandbox (F31) | O fluxo do Pix só se prova com dinheiro real | Já previsto: R$ 10 em produção, na fase C do `GO-LIVE` |
| R4 | O SOP ou o cofre no sandbox dependem de chamado ao Atendimento Cielo (F14, F15) | O teste do cartão no sandbox espera um prazo externo | O dono abre o chamado **hoje**, junto com o pedido de credenciais |
| R5 | CSP derruba o cartão (F10) | Cartão morto em produção sem erro visível. Aconteceu com o Parque | C1.2: liberar os domínios inteiros (`*.pagador.com.br`, `*.cieloecommerce.cielo.com.br`) e **testar com hora anotada logo depois do deploy**, conferindo o relato da CSP daquele minuto |
| R6 | Lista de IPs confiáveis ligada e IP de saída do EasyPanel mudando | Tudo responde 403 de uma vez | C2.2 (mensagem certa) + checklist do dono |
| R7 | Divergência sobre a URL do script (F9) | O script não carrega | Default igual ao do Parque (provado) e env como reserva. Perguntar à Cielo |

---

## 3.5 Plano de convergência em fases

Estimativas em dias de uma pessoa, com testes. **Nada aqui foi implementado.**

### Fase C0: documentação e defaults sem regra de negócio (0,5 d) · Alexandria + Atlas · sem dependência

- `docs/GO-LIVE-PAGAMENTOS.md`:
  - §1 (l. 23-28): tirar "não confirmado" de hosts e OAuth, citando este documento.
  - §2 (l. 42-47): trocar as 5 perguntas pela lista revista do §4.2.
  - §3 (l. 72-75): as URLs do SOP passam a ter default.
  - §4 (l. 215): `MerchantKey` tem 40 caracteres.
  - §5 (l. 295, 309): o nome do header muda, mas **só depois da C1.4**.
- Atualizar `.claude/agent-memory/nova/cielo-fatos-verificados.md` e `referencia-parquedasfeiras.md`. A segunda
  dizia que o Parque não tinha código Cielo, e isso está **desatualizado** desde 01/09/2026.

### Fase C1: bloqueadores do primeiro teste no sandbox (3 a 4,5 d) · Vega (back) e Lyra (página isolada) em paralelo, com o contrato do §3.3 · depende de C0

| Item | O que muda | Onde | Estimativa |
|---|---|---|---|
| C1.1 | SOP em dois passos (OAuth e accesstoken) com URLs derivadas do ambiente (F7, F8, F9). `invalid_client` vira falha de credencial. Expiração vem do `ExpiresIn`, com folga. As envs `CIELO_SOP_OAUTH_TOKEN_URL` e `CIELO_SOP_SCRIPT_URL` viram reserva opcional, e a prontidão (`configGateway.ts:171-172`) deixa de exigir as duas | `cieloSopOAuth.ts`, `cieloAdapter.ts:144-163`, `core/pagamentos/configGateway.ts` | 1 d |
| C1.2 | `sopClient.ts` real: `bpSop_silentOrderPost` com `enableTokenize: "true"`, classes `bp-sop-*`, número só com dígitos, validade `MM/AAAA`, `environment` minúsculo, `CardToken` no `onSuccess` (nome do campo a confirmar no sandbox). CSP da página isolada com `*.pagador.com.br` e `*.cieloecommerce.cielo.com.br` em `script-src`, `connect-src`, `frame-src` e `form-action` | `frontend/src/pagamento-cartao/sopClient.ts`, `CardForm`, `frontend/nginx.conf.template:134` | 1 a 1,5 d |
| C1.3 | O cadastro de cartão deixa de depender de `GET /1/card` (R2): a página isolada envia `last4` e a validade. O GET vira conferência de melhor esforço, e um 404 dele não bloqueia **se** a Cielo confirmar que o endpoint não existe | `mePaymentMethods.routes.ts`, `mePaymentMethods.schema.ts`, `cieloAdapter.ts:174-185`, `useAddCardFlow.ts` | 0,5 d |
| C1.4 | Header do webhook **só com letras** (ex.: `InnoFlowWebhookSecret`). Atualizar a redação de log (`logRedactPaths.ts:21`), a tela e o `GO-LIVE` §5. Ping sem `PaymentId`/`ChangeType` recebe **200** depois do token do caminho e antes do `validateBody` | `webhookCieloSecrets.ts:14`, `webhooksCielo.routes.ts:31-54`, `logRedactPaths.ts` | 0,5 d |
| C1.5 | Pix: `POST /1/sales` com `Payment.QrCode.Expiration`, no máximo 86400. Hoje usamos 30 min, então está dentro do limite | `cieloHttpClient.ts:130-133`, `cieloPayloads.ts:57-86` | 0,5 d |

### Fase C2: diagnóstico e robustez (2,5 a 3,5 d) · Vega, Lyra na tela, Íris valida · pode rodar junto com o sandbox

| Item | O que muda | Estimativa |
|---|---|---|
| C2.1 | `POST /api/admin/payment-gateway/test` (só admin, com limite de taxa, sem gravar nada): passo 1 OAuth, passo 2 accesstoken e passo 3 conferência da `MerchantKey`. **Hipótese a medir no sandbox:** um `GET /1/sales/{GUID inexistente}` responderia 404 com credencial boa e 400 com código `132` com credencial ruim. Se não discriminar, o passo 3 sai. Sempre 200 com `{ok, passo, motivo, mensagem, ambiente, endereço}`, nunca com segredo. Botão "Testar conexão" na tela | 1 d |
| C2.2 | Taxonomia de falhas no `cieloHttpClient`: 400 com códigos `101/131/132/138/139/140` ou texto "merchant id/key" é credencial; 403 é "confira a lista de IPs antes de trocar a credencial"; 429; 5xx e rede são indisponibilidade; 404 na consulta é "fora da janela". Alertas `payment_gateway_credential_rejected` e `payment_gateway_ip_not_allowed`. **O motorista continua vendo 503** | 0,5 a 1 d |
| C2.3 | Normalizador: no `Status 2`, exigir `ReturnCode` de aprovação. Mapear o `11` (estornado) e não deixar cair em `FAILED`. No `cancelar()`, ler o `ReturnCode` (`0`/`9` ok, `10`/`223`/`476` em andamento, `40`/`41`/`53`/`101` recusa definitiva, `103`-`107` problema de conta). Testes com as tabelas do Parque (`traducao.ts`) como oráculo | 0,5 d |
| C2.4 | Higienizar o `SoftDescriptor` (13 caracteres, `A-Z0-9`) | 0,1 d |
| C2.5 | Migration aditiva em `PaymentIntent`: `cieloTid`, `cieloAuthorizationCode`, `cieloProofOfSale`, todas anuláveis. Mudam só os metadados da tabela, sem reescrevê-la nem tirar o sistema do ar. Gravar na autorização e na captura | 0,5 d (Cronos + Vega) |

### Fase C3, opcional: par de credenciais por ambiente (1,5 a 2 d) · Cronos, Vega e Lyra · depende de C2.1

Colunas `test*` ao lado das de produção, mais `environment` como seletor. Isso é o D1 do Parque. O botão de teste
recebe o ambiente. A trava de "pagamento em andamento", a marca de ambiente nos intents e cartões e o
`confirmProduction` **continuam como estão**. Recomendo fazer **só se** o botão de teste da C2.1 não bastar na
prática.

### Fase C4: sandbox real e depois produção · Íris, dono · depende do dono (§4) e de C1

Rodar a Fase A do `GO-LIVE` com credenciais reais. Primeiro teste: cadastrar um cartão e iniciar uma recarga. Ele
responde R1, R2 e F14 de uma vez. Depois disso, a Fase C do `GO-LIVE` (R$ 10 em Pix, piso de pré-autorização no
cartão).

**Total do código:** C1 + C2 dão **5,5 a 8 dias**. Com C3, de 7 a 10. O caminho crítico não é o código: são as
respostas da Cielo (R1) e o chamado do sandbox (R4).

---

## 4. O que o dono precisa fornecer ou fazer

### 4.1 Na Cielo (Site Cielo, com 2FA no app Cielo Gestão)

1. **Decidir a conta (EC)**: ver o §4.3 antes de qualquer coisa.
2. **Sandbox:** fazer o cadastro gratuito, que entrega `MerchantId` e `MerchantKey`. Abrir **um chamado ao
   Atendimento Cielo** pedindo SOP e tokenização (Cartão Protegido) **no sandbox**, mais o par SOP
   (`ClientId`/`ClientSecret`) do sandbox. **Este é o item com prazo externo: abrir hoje.**
3. **Produção:**
   - Credenciais em *E-commerce > Gestão API E-commerce > Credenciais* (perfil Administrador ou Analista). Na
     rotação, a Cielo deixa escolher por quanto tempo a credencial antiga continua valendo: já, +1 h, +24 h ou +3 dias.
   - Habilitar **Silent Order Post** e **Cartão Protegido** na aba *Microsserviços*.
   - O par SOP (Braspag) de produção tem de vir **do mesmo cadastro** do `MerchantId`. Pares de cadastros
     diferentes dão HTTP 500 no 2º passo (F8).
4. **Pix:** habilitar em *Meu Cadastro > Autorizações > Pix* e escolher o **modo da conta Pix**. Em "transferência
   automática", a devolução falha por falta de saldo (F31). É decisão de fluxo de caixa.
5. **URL de notificação:** cadastrar em *E-commerce > Gestão API E-commerce > Configurações*. A URL completa e o
   **nome** do header aparecem na tela do gateway do InnoFlow **depois da C1.4**. Antes disso o Site Cielo vai
   recusar o nome atual (B2).
6. **IPs confiáveis:** se ligar a lista, cadastrar o IP de saída do serviço `api` (e do `worker`) do EasyPanel. Saber
   que esse IP pode mudar quando o container for recriado.

### 4.2 Perguntas para a Cielo, revistas (as respondidas pelo Parque saíram)

| # | Pergunta | Por que importa |
|---|---|---|
| P1 | **Dá para cobrar um `CardToken` do Cartão Protegido sem `SecurityCode`?** Se sim, o que precisa: autorização comercial, `cvvRequired=false` no SOP, `InitiatedTransactionIndicator` (Card On File) e em quais bandeiras? | R1. Decide se a D1 do dono funciona como foi desenhada |
| P2 | Existe endpoint para consultar um `CardToken` (bandeira, final, validade)? `GET /1/card/{token}` é suportado? | R2 |
| P3 | Qual o **prazo para capturar** uma pré-autorização de crédito, por bandeira? | F18 |
| P4 | O `CardToken` expira, ou é atualizado quando o cartão é reemitido? | Cartão salvo que morre sem aviso vira recusa |
| P5 | Qual a URL **canônica** do script do SOP: `transaction.cieloecommerce.cielo.com.br/…` (a que roda no Parque) ou `www.pagador.com.br/…` (a da doc)? | R7 |
| P6 | Um mesmo CNPJ pode ter **mais de um EC**, cada um com sua URL de notificação e seus headers? | Só importa se o dono quiser a mesma empresa nos dois sistemas (§4.3) |
| P7 | A lista de IPs confiáveis vem ligada ou desligada por padrão? | R6 |

### 4.3 Usar a mesma conta Cielo do Parque das Feiras? (decisão do dono)

Este é um ponto **diferente** da D2 já decidida (uma conta única da **plataforma InnoFlow**, e não uma por
operador). A pergunta agora é se o InnoFlow pode **reaproveitar o EC do Parque das Feiras**.

| | Prós | Contras |
|---|---|---|
| Prazo | Afiliação comercial já feita, MDR já negociado, SOP já habilitado em produção | O **Cartão Protegido não está habilitado** lá (o Parque não usa cofre), então seria preciso habilitar de qualquer jeito. O ganho de prazo é pequeno: a habilitação na API leva "até 5 dias úteis" e é autoatendimento |
| Webhook | — | **Contra técnico forte.** A URL de notificação é **por EC** (uma por estabelecimento, Q5 do plano do Parque, sem confirmação de que possa haver mais de uma). As notificações de Pix e cartão do InnoFlow iriam para o endpoint do Parque, ou o contrário. Os dois **dividiriam** os 3 headers. Um dos sistemas perderia as confirmações |
| Credenciais | — | **A mesma `MerchantKey` nos dois sistemas.** Um vazamento em qualquer um compromete os dois, e rotacionar num obriga a rotacionar no outro no mesmo minuto. A lista de IPs confiáveis também é compartilhada |
| Dinheiro e conciliação | Um extrato só | **Receita de recarga de carro elétrico e venda da loja no mesmo extrato e no mesmo CNPJ.** Separar exigiria conciliação manual por `MerchantOrderId`. Chargebacks e devoluções ficam misturados. Se o EC do Parque é de outra empresa (o titular da loja), entra dinheiro de um negócio na conta de outro, e isso é questão fiscal e contratual, não técnica |
| Pix | — | O modo da conta Pix é **por CNPJ**. A escolha de um sistema vale para o outro |
| Fatura do cartão | — | O `SoftDescriptor` é por transação, então dá para diferenciar. Mas o nome do estabelecimento no extrato do motorista seria o do Parque |

**Recomendação da Nova: conta (EC) própria do InnoFlow.** Se o dono quiser usar a mesma **empresa**, o caminho é
pedir à Cielo um **segundo EC no mesmo CNPJ** (P6), e não compartilhar o EC. Sem a resposta da P6, compartilhar o EC
quebra o webhook de um dos dois sistemas.

### 4.4 No EasyPanel

| Variável | Serviço | Quando |
|---|---|---|
| `PAYMENT_SECRETS_KEY` | api e worker | **Opcional desde 05/10/2026** (override): a chave dos segredos é derivada do `JWT_SECRET` (como no InnoChat). Guarde o `JWT_SECRET` em dois lugares fora do EasyPanel |
| `CIELO_WEBHOOK_PATH_TOKEN` (`openssl rand -hex 24`) | api | Antes de cadastrar a URL na Cielo |
| `PAYMENT_SANDBOX_TESTER_EMAILS` | api | Fase A do `GO-LIVE` |
| `CIELO_SOP_SCRIPT_URL` e `CIELO_SOP_OAUTH_TOKEN_URL` | api | **Deixam de ser obrigatórias depois da C1.1.** Só preencher se a Cielo responder outra URL na P5 |

As credenciais (`MerchantId`, `MerchantKey`, `ClientId`, `ClientSecret`, segredo do header) são digitadas **na tela**
"Admin → Gateway de pagamento", que pede a senha atual. Não vão em env.

---

## 5. Referências

- Parque das Feiras: `backend/src/lib/cielo-gateway-config.ts`, `backend/src/lib/pagamentos/adaptadores/cielo/{api,index,sop,traducao}.ts`,
  `backend/src/routes/admin.ts:2253-2900`, `backend/src/routes/payments.ts:1759-1890`,
  `frontend/src/lib/cieloSop.ts`, `frontend/security-headers.conf`, `docs/PLANO-GATEWAY-CIELO.md`,
  `docs/PLANO-SICOOB-PIX.md`, `docs/RUNBOOK.md:611-714`, migrations `20260817190000`, `20260901120000` e
  `20260901190000`, commits `7a2fc04` e `272da8b`, memórias em `.claude/agent-memory/{nova,vega}/`.
- Doc oficial consultada em 04/10/2026 (acrescentando `.md` à URL):
  `ecommerce-cielo/docs/integrando-com-o-sop`, `ecommerce-cielo/reference/cielo2-gerar-qr-code-pix`,
  `ecommerce-cielo/reference/cartao-tokenizado-api`, `ecommerce-cielo/reference/capturar-apos-autorizacao`,
  `ecommerce-cielo/llms.txt`.
- InnoFlow: `backend/src/services/pagamentos/*`, `backend/src/core/pagamentos/*`,
  `backend/src/api/routes/webhooksCielo.routes.ts`, `frontend/src/pagamento-cartao/*`,
  `frontend/nginx.conf.template`, `docs/GO-LIVE-PAGAMENTOS.md`.
