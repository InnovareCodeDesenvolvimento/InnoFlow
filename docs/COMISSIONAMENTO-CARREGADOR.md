# Comissionamento do Primeiro Carregador OCPP 1.6-J Real

📋 **Público:** gestor/operador que vai ligar o carregador real ao InnoFlow.

**Objetivo:** procedimento completo para conectar um carregador OCPP 1.6-J à
plataforma, validar funcionamento completo (BootNotification, status,
autenticação, iniciar/parar recarga, queda de energia) e detectar problemas de
firmware ANTES de abrir para motoristas.

---

## Pré-requisitos

### 1. Domínio e conectividade OCPP

**O carregador precisa alcançar a URL do gateway OCPP:**

```
ws://dominio-do-easypanel:9000/ocpp/{ocppIdentity}
ou
wss://dominio-do-easypanel:9000/ocpp/{ocppIdentity}
```

onde `ocppIdentity` é o identificador único que você vai cadastrar (ex.:
`CP-INNOELEKTRON-001`).

⚠️ **Porta 9000 — protocolo TLS em aberto (bloqueio Órion):**

Atualmente a resposta sobre se a porta 9000 será exposta crua (`ws://`) ou atrás
de TLS (`wss://`) **ainda não foi decidida** — see `docs/DEPLOY-EASYPANEL.md`
linha 158. Isto afeta diretamente a segurança:

- **`ws://` (WebSocket cru):** Basic Auth trafega a senha em texto claro. Nunca
  use em produção com dados reais sem confirmar que **uma rede privada** (VPN,
  WireGuard, firewall rigoroso) protege o carregador e o servidor.
- **`wss://` (WebSocket com TLS):** Basic Auth cifrado. O recomendado.

**Ação obrigatória antes de ligar carregador real:** confirmar com o proprietário
ou Vulcano qual será o protocolo e a topologia da porta 9000. O procedimento
abaixo assume que você já sabe o domínio e o protocolo corretos.

### 2. Credencial OCPP

O carregador autentica com **Basic Auth** — um par `{ocppIdentity, basicAuthSecret}`.

- **`ocppIdentity`**: seu identificador público (ex.: `CP-INNOELEKTRON-001`).
  Pode conter letras, números, hífen e underscore, máximo 50 caracteres. Exposto
  na API (`GET /api/sites` devolve os `ocppIdentity` de todos os carregadores da
  rede, para o motorista escanear o QR).
- **`basicAuthSecret`**: a senha, gerada na criação do carregador no painel admin.
  - Comprimento: **16 a 40 caracteres** (obrigatório).
  - Você pode usar letras, números, e caracteres especiais (mas evite acentos e
    emojis para não exceder os 72 bytes do bcrypt).
  - **Nunca é mostrada de novo** após criação — guarde num cofre/gestor de senhas.
  - Armazenada no banco de forma irreversível (bcrypt hash).

### 3. TLS no servidor (recomendado)

Se usar `wss://`, o servidor precisa de certificado HTTPS válido. No EasyPanel,
os certificados são gerados automaticamente pelo LetsEncrypt quando você
configura um domínio. Nada a fazer aqui; o EasyPanel cuida.

---

## Etapa 1: Cadastrar Site no Painel Admin

Antes de um carregador, precisa existir um **Site** (local físico onde o
carregador fica).

### Passos

1. **Abra o painel admin** (`https://innoflow.innovarecode.com.br` ou seu
   domínio) com uma conta ADMIN ou OPERATOR.

2. **Navegue para Admin → Locais (ou Sites).**

3. **Clique em "Adicionar Local"** (ou botão similar).

4. **Preencha os campos:**
   - **Nome:** o nome do local (ex.: "Eletroposto Matriz - São Paulo").
   - **Operador:** se você é OPERATOR, está pré-selecionado; se é ADMIN,
     selecione qual operador será o dono deste site.
   - **Fuso horário:** a zona de tempo do local (ex.: "America/Sao_Paulo").
     Importante para relatórios e tarifação — sessões começadas no fuso do site,
     não UTC.
   - **Localização (latitude/longitude):** coordenadas GPS, usadas no mapa do
     PWA. Se não souber ao pé da letra, aproxime; o mapa funciona com ~5 m de
     precisão.
   - **Outros campos opcionais** (endereço, contato) — preencha se o seu sistema
     exigir.

5. **Salve.** O site é criado com status ativo.

**Nota:** Um site pode ter múltiplos carregadores. Neste guia vamos começar com um.

---

## Etapa 2: Cadastrar Carregador no Painel Admin

Agora crie o carregador dentro do site.

### Passos

1. **Dentro do site que criou, clique "Carregadores"** (ou secção similar).

2. **Clique "Adicionar Carregador".**

3. **Preencha os campos obrigatórios:**
   - **Identificador OCPP (`ocppIdentity`):** ex.: `CP-INNOELEKTRON-001`.
     Este é o nome público que o carregador vai usar na URL de conexão.
     Nunca mude depois de ligar o hardware — o carregador guarda isto em sua
     configuração.
   - **Segredo OCPP (Basic Auth):** gere uma senha forte com **16 a 40
     caracteres**. Exemplo:
     ```
     <o segredo do carregador, o mesmo cadastrado no admin>
     ```
     O painel vai validar em tempo real. **Guarde esta senha num cofre** — ela
     não é mostrada de novo.

4. **Preencha os campos opcionais de firmware** (vão preencher sozinhos depois
   do primeiro BootNotification, mas você pode preencher agora se souber):
   - **Vendor:** nome do fabricante (ex.: `Tesla`, `ChargePoint`).
   - **Model:** modelo do equipamento (ex.: `Supercharger v3`, `CT4024`).
   - **Serial Number:** número de série do poste.
   - **Firmware Version:** versão do firmware (ex.: `2.5.1`).

5. **Salve.** O carregador é criado com status **ativo**. Aparece uma linha com
   ID, identidade, status.

**O que NÃO precisa fazer aqui:**
- ❌ Não configurar chaves OCPP (`HeartbeatInterval`, `MeterValueSampleInterval`,
  etc.) — o servidor LÊ as que o carregador manda, não impõe.
- ❌ Não criar conectores manualmente — eles aparecem automáticamente quando o
  carregador se conecta (cada conector tem seu próprio `Connector.status`).

---

## Etapa 3: Configurar o Carregador Físico

Agora configure o hardware para conectar ao gateway.

### 3.1 URL e Identidade

**Campo no carregador:** "Server URL" ou "Gateway URL" ou "OCPP Server"
(nome varia por fabricante).

**Valor exato:**
```
ws://seu-dominio.com.br:9000/ocpp/CP-INNOELEKTRON-001
```

ou, com TLS:
```
wss://seu-dominio.com.br:9000/ocpp/CP-INNOELEKTRON-001
```

Troque:
- `seu-dominio.com.br` pelo domínio real do EasyPanel (ex.:
  `innoflow.innovarecode.com.br`).
- `CP-INNOELEKTRON-001` pelo `ocppIdentity` que registrou na Etapa 2.

**O carregador vai extrair a identidade da URL** (o último `/` em diante) — ele
usará isto para autenticar.

### 3.2 Autenticação (Basic Auth)

**Campo:** "Basic Auth Password" ou "Auth Password" ou "Security Password"
(nomes variam).

**Valor:** a senha que gerou na Etapa 2.
```
<o segredo do carregador, o mesmo cadastrado no admin>
```

**Como funciona:** quando o carregador se conecta, ele manda um header HTTP
```
Authorization: Basic base64(CP-INNOELEKTRON-001:<o segredo do carregador, o mesmo cadastrado no admin>)
```

O servidor valida com bcrypt e aceita ou rejeita.

### 3.3 Configurações OCPP — O que o servidor realmente usa

O carregador pode ter muitas chaves OCPP. O servidor InnoFlow **lê e respeita**
as seguintes:

| Chave | O que o servidor faz |
|-------|---------------------|
| `HeartbeatInterval` | O servidor LÊ este valor do primeiro BootNotification e expõe internamente. Carregadores acima de ~270 segundos são considerados "offline" rapidamente (ver watchdog). **Valor sugerido:** 60–120 s. |
| `MeterValueSampleInterval` | Intervalo em segundos entre MeterValues periódicos. O servidor CALCULA o intervalo real observado (usando os timestamps dos MeterValues) e valida contra o watchdog. **Valor sugerido:** 5–10 s. Valores 0 são aceitos (carregador manda amostras apenas por demanda/TriggerMessage). |
| `MeterValuesSampledData` | Lista de "medições" (energia, potência, SoC, etc.) que você quer coletar. O servidor aceita tudo o que o carregador vier oferecer — não há restrição de lista. Se configurado como vazio ou `0`, o servidor emite alerta `ocpp_meter_values_without_transaction`. |
| `ClockAlignedDataInterval` | Intervalo alinhado a "minuto redondo" (ex.: `:00`). Se configurado, o servidor observa isto nos timestamps das amostras. A validação não é rigorosa — o servidor usa isto principalmente para diagnóstico. **Padrão seguro:** deixe vazio ou desabilite. |

**Chaves que o servidor NÃO configura (você coloca direto no carregador):**

- Nenhuma — o servidor nunca **envia** `ChangeConfiguration` ou `SetChargingProfile`
  neste MVP. Tudo vem do carregador.

**Recomendação mínima para começar:**

| Chave | Valor |
|-------|-------|
| `HeartbeatInterval` | `60` (segundos) |
| `MeterValueSampleInterval` | `5` (segundos) |
| `MeterValuesSampledData` | `Energy.Active.Import.Register,Power.Active.Import,SoC` (ou deixe o padrão do carregador) |

Confirme com o manual do carregador como acessar o menu de configuração OCPP. Alguns
postes usam uma tela física, outros um navegador web na rede local, outros uma app
do fabricante.

### 3.4 Validação de configuração

**Para confirmar que tudo está certo** ANTES de conectar em produção:

```bash
# Teste local (se tiver acesso a um laptop com o simulador)
OCPP_PASSWORD='<o segredo do carregador, o mesmo cadastrado no admin>' \
  npx tsx backend/scripts/simulate-charger.ts \
  --url 'ws://seu-dominio:9000/ocpp' \
  --identity 'CP-INNOELEKTRON-001' \
  --connectors 1
```

(veja `backend/scripts/simulate-charger.ts --help` para todas as opções).

Se funcionar:
- ✅ Você verá `[ocpp] BootNotification aceito` nos logs.
- ✅ Dashboard verá o carregador online (`lastSeenAt` preenchido).
- ✅ Mapa mostrará o carregador disponível.

Se falhar, procure no log da API/gateway por mensagens com `[ocpp]`:
- `auth: bloqueado por rate limit` → identidade/senha errados, muitas tentativas.
- `auth: charge point desconhecido` → `ocppIdentity` não foi cadastrado.
- `auth: senha incorreta` → basicAuthSecret errado.
- `conexão TCP rejeitada` → porta não está aberta ou domínio errado.

---

## Etapa 4: Cadastrar Tarifas e Conectores

Quando o carregador se conecta pela primeira vez, ele anuncia seus conectores
via `StatusNotification`. Eles aparecem automaticamente no painel.

### 4.1 Conectores

1. **Admin → Locais → [seu site] → Carregadores → [seu carregador] → Conectores.**

2. Você verá os conectores que o carregador reportou (ex.: connectorId 1, 2 para
   um poste com 2 saídas).

3. **Vincule a tarifa ao carregador (ou ao site/conector).** Hoje a API existe
   (`POST /api/admin/tariff-assignments`, com `scope` = CONNECTOR, CHARGE_POINT,
   SITE ou OPERATOR), mas **a tela para fazer isso ainda NÃO existe** (pendência
   do projeto, já encaminhada ao time de frontend). Até a tela sair, peça ao Atlas
   para criar o vínculo pela API. **Não insira direto no banco:** a tabela exige
   campos que é fácil errar (o `scope` e o identificador certo para cada escopo),
   e um vínculo errado faz o sistema cobrar com a tarifa errada ou recusar a
   recarga. **Sem tarifa vinculada o QR do carregador não consegue iniciar a
   recarga**: confirme este passo antes dos testes.

### 4.2 Tarifas

Você precisa de pelo menos uma `Tariff` no site para começar a testar recargas.

1. **Admin → Tarifação (ou Tariffs).**

2. **Clique "Adicionar Tarifa"** ou similar.

3. **Configure:**
   - **Nome:** ex.: "Tarifa Teste - Rápido".
   - **Site:** seu site.
   - **Tipo:** escolha `FLAT` (taxa única por sessão), `HOURLY` (por hora),
     `ENERGY` (por kWh), `HYBRID` (energia + tempo + ociosidade), etc.
   - **Valores:** conforme o tipo.
     - `ENERGY`: R$ 1,50 por kWh (por exemplo).
     - `FLAT`: R$ 10,00 por sessão.
     - `MIN_FEE`: R$ 5,00 (mínimo cobrado se a sessão gastar menos).
   - **Horários:** se suportar (p.ex., tarifa mais cara 17h–22h), configure.

4. **Salve.**

Agora, na próxima vez que um motorista iniciar uma recarga, esta tarifação
será aplicada.

---

## Etapa 5: Roteiro de Testes de Aceitação

### Teste 1: Conexão e BootNotification

**Objetivo:** validar que o carregador se conecta e o servidor o reconhece.

1. **Ligue o carregador** (ou simule com o script acima).

2. **Dashboard admin → Acompanhamento ao vivo (Live):**
   - Carregadores online: deve contar +1.
   - Marque o relógio.

3. **Logs da API/gateway** (terminal ou EasyPanel console):
   - Procure por `[ocpp] BootNotification aceito` com o `ocppIdentity` certo.

**Sucesso:** ✅ Carregador aparece online em tempo real.

**Falha:**
- ❌ Não aparece → verifique credenciais (teste acima). Procure por `auth:`.
- ❌ Aparece mas logo sai → timeout de Heartbeat ou conexão instável (procure
  por `disconnect`).

---

### Teste 2: Status de Conector e Mapa

**Objetivo:** validar que o status do conector é lido e aparece no mapa do motorista.

1. **Painel motorista** (abra em outro navegador, com uma conta DRIVER):
   - Navegue para "Mapa" ou "Eletropostos perto de mim".
   - Procure pelo carregador que acabou de ligar — deve aparecer com todos os
     conectores como "Disponível" ou "Livre".

2. **Admin → Locais → [seu site] → Carregadores → [seu carregador]:**
   - Veja o status de cada conector (ex.: "Available", "Occupied", etc.)
   - Verifique `lastSeenAt` (deve ser "agora" ou há poucos segundos).

**Sucesso:** ✅ Conector aparece como `AVAILABLE` e está visível no mapa.

**Falha:**
- ❌ Carregador online, mas conector offline → o carregador não mandou
  `StatusNotification` para o conector 1. Procure no log por `StatusNotification`
  — a confirmar com o fabricante se o firmware está mandando isto.

---

### Teste 3: Autenticação Tap-to-Stop (RFID/Cartão)

**Objetivo:** validar que o carregador aceita o fluxo de autorização.

**⚠️ A confirmar com o firmware:**
Este teste depende de o carregador suportar o campo `idTag` no `Authorize` (OCPP 1.6).

1. **Teste manual (sem motorista ainda):**
   - Alguns carregadores têm um menu para simular um tap de cartão.
   - Mande um Authorize fakeado:
     ```bash
     # Se o carregador tiver debug/API local:
     curl -X POST http://carregador.local/debug/authorize \
       -d '{"idTag": "TEST-CARD-001"}'
     ```

2. **Procure no log do servidor** por `Authorize`:
   - `[ocpp] Authorize aceito` ou similar → ✅ funciona.
   - `[ocpp] Authorize: IdToken desconhecido` → ✅ esperado (é um teste).

**Nota:** Em produção isto será disparado pelo PWA do motorista (escanear QR),
não por uma física. Aqui é só validar que o carregador fala OCPP corretamente.

---

### Teste 4: Iniciar Recarga pelo Admin

**Objetivo:** validar que `RemoteStartTransaction` funciona de ponta a ponta.

1. **Admin → Locais → [seu site] → Carregadores → [seu carregador].**

2. **Clique no carregador → Conectores → Conector 1 → Ação "Iniciar Recarga"**
   (ou botão similar — a interface pode variar conforme a versão).

3. **Selecione um motorista** de teste (ou use o da seed: `motorista.teste@innoelektron.example.com`).

4. **Clique "Iniciar"** e **marque o relógio**.

5. **Procure nos logs:** `RemoteStartTransaction` com resultado (Accepted/Rejected).

6. **Validações:**
   - **Tela do carregador:** status do conector passa a `Preparing`, depois
     `Charging`. A confirmar com o fabricante — cada poste mostra isto diferente.
   - **Dashboard motorista:** a sessão ativa deve aparecer em "Minha recarga" ou
     "Sessão ativa", mostrando energia crescendo em tempo real (0 Wh → ...Wh).
   - **Dashboard admin:** energia e custo parcial aparecendo em tempo real.

**Sucesso:** ✅ RemoteStart foi para o carregador, conector trocou de status,
energia começou a crescer.

**Falha:**
- ❌ RemoteStart rejeitado (`Rejected`) → conector não estava Available. Procure
  por "conector ocupado" ou status errado.
- ❌ RemoteStart timeout (sem resposta em ~35s) → o carregador não respondeu.
  Procure no log por `callTimeoutMs`. Confirme conectividade e que o firmware
  entende OCPP.
- ❌ Energia não cresceu → o carregador não mandou `MeterValues`. Procure no log
  por `MeterValues` — confirme que o intervalo `MeterValueSampleInterval` não é
  zero ou muito grande.

---

### Teste 5: Parar Recarga pelo Admin

**Objetivo:** validar `RemoteStopTransaction` e fechamento da sessão.

1. **Dashboard admin → mesma sessão aberta → clique "Parar".**

2. **Marque o relógio** e o **custo/energia no parar**.

3. **Procure nos logs:** `RemoteStopTransaction` com resultado.

4. **Validações:**
   - **Tela do carregador:** status passa a `Finishing`, depois volta a `Available`.
   - **Log:** `StopTransaction` recebido com o `meterStop` real.
   - **Dashboard motorista:** sessão some de "Ativa" e aparece em "Histórico".
     Recibo mostrando custo total = energia × tarifa + taxas.
   - **Dashboard admin → Financeiro:** receita entra na linha (carteira foi debitada
     ou cartão foi capturado, conforme a forma de pagamento).
   - **Banco:** `ChargingSession.status = STOPPED`, `totalCostCents` preenchido,
     `WalletEntry` com débito (se era carteira) ou `PaymentIntent.status =
     CAPTURED` (se era cartão).

**Sucesso:** ✅ Stop foi executado, sessão fechou com cobrança correta.

**Falha:**
- ❌ RemoteStop rejeitado → firmware não obedece. Procure em `remoteStopTransaction.ts`
  por lógica de rejeição. Comportamento esperado neste MVP: aceitar o comando e
  ir para `STOP_UNCONFIRMED` se não chegar `StopTransaction` em tempo (watchdog
  fechará depois).
- ❌ Cobrança errada → validar tarifação. Procure em `calcularCustoSessao` ou
  reexamine a tarifa (mínimo, energia, tempo — qual está errado).
- ❌ Recibo não aparece → cache ou refresh. Tente F5 no navegador.

---

### Teste 6: Queda de Energia e Reconexão

**Objetivo:** validar o comportamento quando o carregador perde conexão no meio da
sessão (cenário M5/M6 — sessão travada).

**⚠️ Dependência de firmware:**
Este teste exige que o carregador suporte uma das duas opções:
- **Queda real:** desplugue o carregador ou corte energia (se for seguro).
- **Simulação:** alguns carregadores têm um modo de teste que simula reconexão
  sem Boot verdadeiro.

1. **Inicie uma recarga** (veja Teste 4).

2. **Deixe rodar por ~10 segundos** (energia acumulando).

3. **Force queda de energia** (ou desplugue o WiFi/Ethernet do carregador).

4. **Observe:**
   - **Admin:** carregador sai de "Online" para "Offline" (ou "Última conexão há Xs").
   - **Motorista:** sessão ainda aparece como "Ativa" (não desaparece na hora).
   - **Log:** procure por `[ocpp] charge point desconectado`.

5. **Ligue o carregador de volta** (ou reconecte a rede) — **marque quanto tempo
   esperou**.

6. **Procure nos logs de reconexão:**
   - `[ocpp] BootNotification aceito` → o carregador mandou Boot DEPOIS de voltar
     (queda real com firmware que cumpre OCPP 1.6).
   - E logo depois: `StopTransaction` enfileirado com a energia que foi medida
     ANTES da queda (leitura real do firmware).

7. **Validações:**
   - ✅ Sessão fecha automaticamente (watchdog marcou `STOP_UNCONFIRMED` no
     offline, depois viu o Stop que chegou e finalizou com a leitura correta).
   - ✅ Cobrança é apenas até o ponto de queda, nunca estima.
   - ✅ Motorista vê sessão com recibo correto (energia real).
   - ✅ Relatório financeiro fecha (receita = carteira debitada ou cartão capturado).

**Notas da F5.9 (decisões do dono, 04/10/2026):**
- Se o servidor não receber `StopTransaction` dentro de 2 horas, ele encerra a
  sessão com base na última amostra (não estima, não cobra mais).
- Se a última amostra for bem antes da queda, o servidor marca a diferença em
  `unbilledCostCents` (informativo, nunca cobra).
- Se não houver nenhuma amostra, a sessão não é cobrada (decisão D2).

---

### Teste 7: Carregar na Carteira Pré-paga (PWA)

**Objetivo:** validar que o motorista consegue fazer uma recarga real via PWA.

1. **Motorista:** login no app mobile via PWA (ou abra em celular
   `https://innoflow.innovarecode.com.br`).

2. **Navegue para "Mapa"** → encontre o carregador que está online → **clique
   em "Carregar"**.

3. **QR code ou link automático:** você será levado para a tela de recarga do
   conector.

4. **Valide saldo:** se o motorista tem R$ 50,00 de carteira pré-paga, o app deve
   mostrar "Saldo: R$ 50,00" e deixar iniciar (mínimo é R$ 20,00 por padrão).

5. **Clique "Iniciar Recarga"** e **marque relógio**.

6. **Procure nos logs da API:** `POST /api/me/sessions/start` aceito com ID da
   sessão.

7. **Validações:**
   - ✅ Conector trocou de status (Preparing → Charging).
   - ✅ PWA mostra "Carregando" com energia crescendo em tempo real (atualiza a
     cada MeterValue).
   - ✅ Custo parcial sendo calculado (aparece como "Custo estimado: R$ X,XX").
   - ✅ Admin vê a mesma sessão em "Cargas ativas".

8. **Clique "Parar Recarga"** depois de alguns segundos.

9. **Validações:**
   - ✅ PWA trocou para "Parando..." e logo "Recarga concluída".
   - ✅ Recibo mostra: energia (kWh), custo final, saldo restante.
   - ✅ Carteira do motorista foi debitada (saldo diminuiu de R$ 50 para R$
     ~45 ou menos, conforme o consumo).
   - ✅ Dashboard financeiro refletiu a receita.

**Sucesso:** 🎉 Ciclo completo de recarga funcionando.

---

## Etapa 6: Perguntas que Só o Firmware Real Responde

Existem comportamentos que não conseguimos validar sem o hardware. **Leve estas
questões para o fabricante do carregador ou para um teste com unidade real:**

### Pergunta 1: Ordem de Boot × Stop Enfileirado

**Cenário:** Queda de energia no meio de uma sessão. O carregador foi medindo, e
quando cai, guarda tudo em memória não volátil. Ao voltar a energia:

**Pergunta:** O firmware manda o `BootNotification` primeiro e SÓ DEPOIS o
`StopTransaction` enfileirado? Ou ao contrário?

**Por quê:** OCPP 1.6 permite qualquer ordem, mas a implementação atual espera
Boot antes de Stop (garantindo que a sessão está marcada "em confirmação").

**Como medir:**
- Logs do servidor: procure por `[ocpp] BootNotification` e `[ocpp]
  StopTransaction` em sequência.
- Se a ordem for consistente (sempre Boot → Stop), está tudo bem.
- Se for inconsistente ou inversa, isto precisa ser compensado no firmware ou
  documentado como limitação.

**Decisão:**
- ✅ Se funcionar com a ordem esperada: sem restrição, carregador aprovado.
- ⚠️ Se funcionar com ordem inversa: precisa de ajuste de firmware ou workaround
  no servidor.

---

### Pergunta 2: Reuso de `messageId`

**Cenário:** A mesma mensagem OCPP é retransmitida (p.ex., por timeout de rede).

**Pergunta:** O carregador incrementa o `messageId` (ex.: msg-001, msg-002, ...) a
cada mensagem, ou reutiliza em retransmissões?

**Por quê:** O servidor usa `(chargePointId, ocppMessageId)` como chave de
idempotência. Se o `messageId` mudar a cada retransmissão, o servidor tratar-se-á
como nova transação, podendo gerar duplicação.

**Como medir:**
- Ative a bandeira `--verbose` no simulador para ver os `messageId` brutos.
- Simule perda de pacote (desconecte WiFi no meio de um MeterValues, reconecte
  em 2 segundos).
- Procure no log `[ocpp] OcppMessage` por `messageId` repetido.

**Decisão:**
- ✅ Reutiliza `messageId` em retransmissões: correto, idempotência funciona.
- ⚠️ Incrementa a cada vez: precisa de ajuste de firmware.

---

### Pergunta 3: `MeterValueSampleInterval` com Zero

**Cenário:** Você configura `MeterValueSampleInterval = 0`.

**Pergunta:** O firmware para de mandar MeterValues periódicos e só responde a
`TriggerMessage(MeterValues)`? Ou ignora a configuração?

**Por quê:** Um intervalo zero significa "não envie amostras periódicas, aguarde
comando". Isto é válido em OCPP, mas nem todo firmware implementa.

**Como medir:**
- Configure o carregador com `MeterValueSampleInterval = 0`.
- Inicie uma recarga.
- Procure no log: há MeterValues chegando? Se sim, o firmware ignorou.
- Se não, o firmware obedece.
- Mande um `TriggerMessage(MeterValues)` (o servidor pode fazer isto via admin,
  ou use a API).
- Espera-se um MeterValues extra em resposta.

**Decisão:**
- ✅ Obedece intervalo zero, responde a TriggerMessage: aprovado.
- ⚠️ Ignora intervalo zero: use um valor > 0 (não é bloqueante, só leva mais
  mensagens).

---

### Pergunta 4: Suporte a `TriggerMessage`

**Pergunta:** O firmware responde ao comando OCPP `TriggerMessage` (usado para
pedir uma amostra fora da hora)?

**Por quê:** O watchdog do servidor (F5.9) usa isto para "acordar" carregadores
mudos que deixaram de enviar MeterValues. Sem suporte, o servidor vai levar mais
tempo para detectar estagnação.

**Como medir:**
- Admin → Teste manual de `TriggerMessage` (se houver menu de debug).
- Ou procure no log por `TriggerMessage` — o servidor loga a resposta.
- Procure por `OK` ou `NotImplemented`.

**Decisão:**
- ✅ Suporta: melhor cobertura de watchdog.
- ⚠️ Não suporta: watchdog ainda funciona, mas por timeout (mais lento, ~15 min).

---

### Pergunta 5: Relógio/RTC do Carregador

**Pergunta:** O carregador tem um relógio de tempo real (RTC)? Está correto?

**Por quê:** O servidor usa o timestamp dos MeterValues (do carregador) para
calcular sessões e diferenças. Se o relógio está 5 horas atrasado, a sessão pode
calcular com datas erradas.

**Como medir:**
- Procure no log por `MeterSample.ts` (timestamp de cada amostra).
- Compara com o relógio do servidor (este sim sempre certo, via NTP).
- Se diferença > 5 minutos, há descompasso.

**Ação:**
- ✅ Se diferença < 5 min: aceitável (pode variar pelo fuso).
- ⚠️ Se > 5 min: sincronize o relógio do carregador (manual ou NTP, depende do
  firmware).

---

## Etapa 7: Checklist de "Pronto para Abrir ao Público"

Quando todos os testes acima passarem, você está pronto para ligar o carregador de
verdade (com motoristas reais e dinheiro real).

### Pré-Implementação

- [ ] **Domínio e TLS confirmados** com proprietário ou Vulcano. Porta 9000 será
      `ws://` ou `wss://`?
- [ ] **Segredos guardados** em cofre seguro (basicAuthSecret, credenciais de admin,
      certificados).
- [ ] **Firewall configurado:** porta 9000 acessível de onde o carregador está
      (confirmar com TI/rede).

### Configuração de Hardware

- [ ] **URL do gateway** cadastrada no carregador (domínio + identidade + protocolo
      certos).
- [ ] **Credencial OCPP** (basicAuthSecret) guardada e testada.
- [ ] **Chaves OCPP** (`HeartbeatInterval`, `MeterValueSampleInterval`, etc.)
      configuradas conforme recomendação.
- [ ] **Relógio do carregador** sincronizado (diferença < 5 min do servidor).

### Testes de Aceitação

- [ ] **Teste 1: Conexão** — carregador online no dashboard.
- [ ] **Teste 2: Status** — conector aparece no mapa como disponível.
- [ ] **Teste 3: Autenticação** — Authorize (RFID) funciona.
- [ ] **Teste 4: RemoteStart** — recarga inicia pelo admin, energia sobe.
- [ ] **Teste 5: RemoteStop** — recarga para corretamente, cobrança fecha.
- [ ] **Teste 6: Queda de energia** — carregador volta, sessão fecha com leitura
      correta, sem cobrança dupla.
- [ ] **Teste 7: PWA** — motorista de teste consegue carregar de verdade, carteira
      foi debitada.

### Antes de Go-Live

- [ ] **Alertas monitorados:** procure em logs por `alert:` e `ALERTA:` — não há
      avisos críticos não tratados.
- [ ] **Financeiro fechando:** receita = carteira debitada. Ver dashboard admin
      → Financeiro. Diferença deve ser 0.
- [ ] **Comportamento de firmware confirmado** nas 5 perguntas acima (ou documentado
      como "a confirmar").
- [ ] **Kill-switch de watchdog:** confirme que `SESSION_WATCHDOG_ENABLED` está
      `false` por enquanto (ativa manualmente depois, em janela de manutenção).

### Plano de Rollback

Se algo der errado após ir ao ar:

1. **Desligar o carregador:** remova da rede elétrica ou feche no painel admin
   (marque como `active: false`).

2. **Investigar:** procure no log (terminal ou EasyPanel) por erros de OCPP ou
   financeiro.

3. **Corrigir:**
   - Se é configuração do carregador → reconfigurar firmware.
   - Se é código do servidor → revert de deploy (git revert + redeploy).

4. **Avisar motoristas:** qualquer sessão afetada precisa ser revisada manualmente
   (usar admin para ajustar saldo se necessário).

---

## Referências

- **Código OCPP do servidor:** `backend/src/ocpp/` (handlers, schemas, autenticação).
- **Documentação F5.9:** `docs/F5.9-SESSAO-TRAVADA-DESENHO.md` (máquina de
  estados, watchdog, tratamento de queda).
- **Auditoria F5.9:** `docs/AUDITORIA-F5.9.md` (achados de segurança).
- **Deploy:** `docs/DEPLOY-EASYPANEL.md` (variáveis de ambiente, configuração de
  produção).
- **Simulador:** `backend/scripts/simulate-charger.ts --help` (ferramenta para
  testar cenários sem hardware).

---

**Versão:** 1.0 (04/10/2026)
**Verificado contra:** commit principal HEAD, PROGRESSO.md até 04/10/2026, decisões
do dono confirmadas D1–D7.
