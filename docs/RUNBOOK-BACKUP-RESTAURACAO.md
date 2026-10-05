# Runbook de backup e restauração (DR) do InnoFlow

Para o dono e para quem opera o sistema. Escrito para ser seguido num dia ruim: cada passo tem o comando exato e o que esperar.

> Backup que nunca foi restaurado é uma suposição. O ciclo completo (semear, backup cifrado, apagar o banco, restaurar, conferir dados e contagens, e as recusas de chave errada / arquivo adulterado / banco em uso) roda a **cada push** no job `backup-restore` do CI (`.github/workflows/ci.yml`), em Postgres 16 e 18. Além disso, o dono faz um **ensaio de restauração por trimestre** (seção 9).

Documentos relacionados: `docs/BACKUP-FORMATO.md` (o formato byte a byte do arquivo `.dump.enc`), `docs/DEPLOY-EASYPANEL.md` (serviços, variáveis de ambiente, migrations).

---

## 1. O que é salvo e o que NÃO é

| O que | Está no backup? | Como se recupera se sumir |
|---|---|---|
| **Banco Postgres inteiro**: operadores, pontos, carregadores, motoristas, carteiras e lançamentos, sessões de carga, pagamentos, estornos, auditoria, medições (`MeterSample`), log OCPP, configurações cifradas (Cielo, SMTP, Evolution, destino do backup) | **Sim** (`pg_dump` formato custom, cifrado) | Restaurar o backup (seção 7) |
| **Redis (filas BullMQ, locks, pub/sub)** | Não, e não precisa | Reconstruível: nada de verdade mora lá. Jobs em voo se perdem; os varredores do worker (captura de cartão pendente, watchdog de sessão travada, manutenção de partições, agendador de backup) reaparecem sozinhos no boot e reprocessam o que o banco diz estar pendente. Os carregadores reconectam sozinhos (OCPP). |
| **`PAYMENT_SECRETS_KEY`** (cifra os segredos guardados no banco) | **NÃO** | **Sem cópia fora do banco, tudo que está cifrado no banco se perde** (seção 4). É o único segredo cuja perda é irrecuperável. |
| **`JWT_SECRET`** | Não | Gerar outro (`openssl rand -base64 48`). Efeito: todo mundo precisa entrar de novo. Nenhum dado se perde. |
| **Chave do backup** (a de 32 bytes que cifra o `.dump.enc`) | Não (o banco guarda só uma cópia cifrada com `PAYMENT_SECRETS_KEY`, para o agendador cifrar de madrugada) | A cópia que o dono guardou ao gerá-la. **Sem ela os backups não abrem.** |
| Credenciais da **Cielo**, SMTP, Evolution API, S3/Drive do backup | Estão **no banco, cifradas** com `PAYMENT_SECRETS_KEY` | Voltam com o restore **se** a `PAYMENT_SECRETS_KEY` for a mesma. Se não for, reentrar pela tela do admin (Cielo no portal da Cielo, SMTP/Evolution nos provedores). |
| Token de **cartão salvo** dos motoristas | Está no banco, cifrado com `PAYMENT_SECRETS_KEY` | Sem a chave original, o motorista precisa cadastrar o cartão de novo. Não há como recuperar. |
| **Variáveis de ambiente** das 3 apps (`DATABASE_URL`, `REDIS_URL`, `CORS_ALLOWED_ORIGINS`, `OCPP_TRUST_PROXY_HOPS`...) | Não | Estão no EasyPanel, em cada App. Mantenha uma cópia da LISTA (nomes e para que servem: `docs/DEPLOY-EASYPANEL.md` seção 1) e dos valores no gerenciador de senhas. |
| Imagem das apps / código | Não | Está no Git (`github.com/InnovareCodeDesenvolvimento/InnoFlow`). O EasyPanel reconstrói. |
| Domínio, DNS, certificados | Não | Fora do escopo deste runbook (registro do domínio e EasyPanel). |

---

## 2. Como o backup funciona

- O **agendador roda no `worker`** (a API só enfileira o pedido "fazer backup agora" / "conferir backup"). Uma cópia por dia, na hora de Brasília configurada (padrão 03h), enviada para **fora do servidor** (bucket S3 compatível ou Google Drive, configurado em Admin > Backup). Guarda as últimas 7 cópias (configurável) e nunca apaga a última que existe. Se passar do limite (padrão 36 h) sem cópia nova, dispara o alerta `backup_stale` (log do worker e canais de aviso ao dono, ver `docs/DEPLOY-EASYPANEL.md` seção 6). **O agendador morre junto com o worker:** se o worker estiver fora do ar, o alerta é o único sinal. Trate como incidente.
- O arquivo é `backup-innoflow-AAAA-MM-DD-HHhMMmSSs.dump.enc` (hora de Brasília). É o dump `pg_dump --format=custom --no-owner --no-privileges` cifrado em AES-256-GCM em fluxo. **A chave é própria do backup**, mostrada ao dono uma única vez (arquivo `.txt` com a linha `CHAVE: ...`).
- A imagem do backend (`backend/Dockerfile`, `Dockerfile.ocpp`, `Dockerfile.worker`, idênticos exceto o `CMD`) traz o cliente do Postgres **18 (com queda para o 17)**: `pg_dump`, `pg_restore`, `psql`. O cliente precisa ser da versão do servidor ou mais nova; senão o backup falha dizendo exatamente isso. O 18 copia servidores 16, 17 e 18.
- A cada semana o worker **confere** a cópia mais recente (baixa, decifra, verifica a integridade, lê o índice com `pg_restore --list`). Isso prova que o arquivo abre e está inteiro. **Não prova que restaura**: isso é o job do CI (a cada push) e o seu ensaio trimestral (seção 9).

---

## 3. RPO e RTO esperados

| | Valor | De onde vem |
|---|---|---|
| **RPO** (quanto dado se pode perder) | **até ~24 h** com a frequência padrão (diária, 03h). Pior caso: o desastre acontece logo antes da próxima cópia. Se a última falhou, até ~36 h (o alerta dispara). | Configuração em Admin > Backup. Frequência mínima hoje: diária. Para RPO menor, ligar também o backup do próprio serviço Postgres no EasyPanel, se a sua instalação oferecer (segunda camada, seção 8 do `DEPLOY-EASYPANEL.md`) ou pedir uma frequência maior ao time. |
| **RTO** (quanto tempo fora do ar) | **meta: até 2 h**, dominada pelas etapas humanas (provisionar o Postgres, baixar o arquivo, conferir). O restore em si é rápido. | **Medido localmente** (Windows, SSD, Postgres 16): banco de 689 MB (1,5 milhão de medições) vira um `.dump.enc` de 48 MB; backup em 18 s e restore em 44 s. Num VPS o tempo será diferente. **Não medido no servidor de produção real.** O ensaio trimestral (seção 9) existe para trocar esta estimativa por um número medido. |

O que o RPO significa na prática: tudo que aconteceu entre a última cópia e o desastre **não está no banco restaurado**: sessões de carga, Pix creditado, cadastros. Ver a etapa 8 da seção 7 (reconciliar com a Cielo).

---

## 4. Os segredos e onde guardar cada um

**Regra: nenhum destes segredos vai para o repositório, para o bucket de backup, nem para o mesmo lugar que o arquivo de backup.** Quem pega o bucket tem o dump cifrado; se pegasse também a chave, abriria tudo.

| Segredo | Para que serve | Se perder | Onde guardar |
|---|---|---|---|
| **`PAYMENT_SECRETS_KEY`** | Cifra no banco: credenciais da Cielo, token de cartão salvo, senha SMTP, apikey da Evolution, chaves do S3/Drive do backup, e a cópia da chave do backup. | **Irrecuperável.** Tudo isso fica ilegível: reentrar credenciais, motoristas recadastram cartão, e a cópia da chave do backup guardada no banco morre (a do dono continua valendo). | Gerenciador de senhas do dono (com 2FA) **e** uma cópia offline (pen drive/papel no cofre). Uma entrada própria, separada da chave do backup. Se houver rotação em andamento, guarde também a `PAYMENT_SECRETS_KEY_PREVIOUS` até concluir (`docs/DEPLOY-EASYPANEL.md`, "Rotação da PAYMENT_SECRETS_KEY"). |
| **Chave do backup** (`CHAVE: ...`, o `.txt` baixado em Admin > Backup) | Abre os arquivos `.dump.enc`. | Os backups existentes ficam **inúteis**. Se o sistema ainda estiver de pé, gerar uma chave nova protege os backups futuros (os antigos continuam precisando da antiga). | Gerenciador de senhas do dono **e** uma cópia offline. Anote também a **impressão digital** (8 caracteres): ela confere se a chave guardada é a certa sem expô-la. **Guarde todas as chaves antigas** junto com a atual: cada backup só abre com a chave que o cifrou. |
| **`JWT_SECRET`** | Assina as sessões (login). | Gerar outro; todos precisam entrar de novo. | Gerenciador de senhas. |
| Credenciais do bucket S3 / conta Google do Drive | Enviar e baixar os backups. | O backup para de sair. Reconfigurar em Admin > Backup. | Estão cifradas no banco; guarde também no gerenciador de senhas para o dia em que o banco não existe. |
| Senha do Postgres do EasyPanel (`DATABASE_URL`) | Conexão do sistema. | Redefinir no EasyPanel e atualizar a env nas 3 apps. | Gerenciador de senhas. |

**O erro mais caro deste sistema** é guardar a `PAYMENT_SECRETS_KEY` só dentro do EasyPanel. Se o servidor some, a chave some junto. Confira hoje que ela existe fora dele.

---

## 5. Cópia manual (antes de uma operação arriscada)

Faça uma cópia antes de uma migration de risco, de uma restauração ou de trocar de servidor. Roda no terminal do serviço `worker` no EasyPanel (usuário `node`, sem root) ou numa máquina com Node 22 e o cliente do Postgres 18.

```sh
# a chave NUNCA vai em argumento (apareceria no `ps`). Cole-a sem eco:
stty -echo; printf 'Chave do backup: '; read -r BACKUP_KEY; stty echo; echo; export BACKUP_KEY
# /tmp é gravável pelo usuário node; o diretório da aplicação (/app) não é
sh scripts/backup-db.sh /tmp/backups
```

O script lê a `DATABASE_URL` do ambiente do serviço, copia, **cifra**, **confere de volta** (decifra o que gerou e verifica a integridade), apaga o dump em claro (a pasta de trabalho é `0700` e some sempre, mesmo com erro ou Ctrl+C) e imprime o caminho e o tamanho. Para tirar o arquivo do container: baixe pelo terminal do EasyPanel ou envie com `curl` para um destino seu. `/tmp` do container some em um redeploy.

Opções: `BACKUP_KEY_FILE=<arquivo>` (arquivo com a linha `CHAVE:`) no lugar de `BACKUP_KEY`; `--sem-cifra` para uma cópia em claro **de propósito** (sem chave o script se recusa a copiar); `BACKUP_DIR` e `BACKUP_TMP_DIR` para mudar destino e pasta de trabalho. O banco é identificado no log só por `host:porta/banco`; senha nunca aparece.

---

## 6. Antes de tudo, num incidente

1. **Não restaure por reflexo.** Primeiro entenda: o banco sumiu (serviço Postgres perdido/corrompido) ou o dado está errado (um bug, uma operação errada)? Para dado errado em poucas linhas, a **restauração parcial** (seção 8) é mais segura que sobrescrever tudo.
2. **Pare as escritas:** pare `api`, `ocpp-gateway` e `worker` no EasyPanel. Carregadores podem continuar carregando offline (depende do modelo) e reenviam o que acumularam quando reconectarem; um ensaio de restauração não precisa parar nada (seção 9).
3. **Tire uma cópia do estado atual**, se o banco ainda responde (seção 5), antes de substituir qualquer coisa. Restaurar é destrutivo e esta cópia é o seu "desfazer".
4. Separe **os três itens**: o arquivo `.dump.enc`, o arquivo da chave `.txt`, e a `PAYMENT_SECRETS_KEY` (e a `JWT_SECRET`).

---

## 7. Restauração TOTAL no EasyPanel (o banco foi perdido)

Tempo de referência: de 1 a 2 horas, na maior parte etapas humanas.

### Etapa 1. Banco novo

No EasyPanel, crie um **novo serviço Postgres** (versão **16 ou mais nova**; o backup de um servidor 16 restaura em 16, 17 e 18; um backup de servidor mais novo pode não restaurar num mais antigo, o script avisa). Nome sugerido: `innoelektron-postgres`, banco `innoelektron`. Anote a connection string. Use o **mesmo usuário** que as apps vão usar (o do `DATABASE_URL`): o dump não carrega donos (`--no-owner`), tudo fica de propriedade de quem restaura.

### Etapa 2. O arquivo e a chave

1. Baixe o `backup-innoflow-....dump.enc` mais recente do bucket S3 ou da pasta do Drive (se o último estiver suspeito, use o anterior: são 7).
2. Tenha a chave à mão. **Confira a impressão digital** (precisa de Node, nada mais):

```sh
node scripts/decrypt-backup.mjs backup-innoflow-AAAA-MM-DD-HHhMMmSSs.dump.enc --info
# Backup cifrado do InnoFlow. Impressão digital da chave: 630dcd29
```

A impressão digital da chave que você guardou tem que ser a mesma. Se não for, é outra chave: procure a certa (as antigas) antes de continuar.

### Etapa 3. Onde rodar a restauração

Duas opções:

- **A) No terminal do serviço `worker`** (ou `api`) no EasyPanel, que já tem os scripts, o Node e o `psql`/`pg_restore` 18. Leve o arquivo para `/tmp` (por exemplo `curl -fsSL -o /tmp/backup.dump.enc "<URL pré-assinada do S3>"`). A `DATABASE_URL` do ambiente aponta para o banco **antigo**: o script a usa para **recusar** restaurar sobre ele sem o seu consentimento explícito.
- **B) No seu computador**, com o repositório, Node 22 e o cliente do Postgres 18. Abra a porta externa do novo Postgres no EasyPanel **só durante a restauração** e feche depois.

### Etapa 4. Restaurar

```sh
stty -echo; printf 'Chave do backup: '; read -r BACKUP_KEY; stty echo; echo; export BACKUP_KEY
export PGPASSWORD='<senha do novo Postgres>'        # a senha vai pelo ambiente, nunca na URL digitada
sh scripts/restore-db.sh /tmp/backup.dump.enc \
  "postgresql://USUARIO@HOST-DO-NOVO-POSTGRES:5432/innoelektron" \
  --confirmar
```

O script: decifra para uma pasta temporária `0700` (verificando a integridade até o último byte), confere o índice do dump, mostra o plano ("vai restaurar X em Y, ISTO APAGA..."), exige `--confirmar`, recusa se o destino for o banco da `DATABASE_URL` do ambiente (sem `--permitir-banco-em-uso`), **refaz o schema `public` e restaura tudo numa transação só** (ou volta tudo, ou nada muda), confere quantas tabelas voltaram e **apaga o temporário** de qualquer jeito.

- **Chave errada ou arquivo adulterado/cortado**: o script para ANTES de tocar no banco e diz o motivo (chave errada mostra as duas impressões digitais).
- **Se o destino for o MESMO banco em uso** (você recriou o banco com o mesmo endereço, ou restaura "por cima"): `--permitir-banco-em-uso`, depois de confirmar que `api`, `ocpp-gateway` e `worker` estão **parados**.
- Arquivo **sem** a marca de cifra só é aceito com `--aceitar-sem-cifra` (um dump forjado executaria SQL no destino).
- Saída esperada no fim: `[restore] tabelas no destino: 59 (o backup define 59); com pelo menos uma linha: N` e `[restore] concluído.` (os números mudam com o schema; o que importa é "no destino" igual a "o backup define").

### Etapa 5. Variáveis de ambiente e redeploy

Nas **3 apps** (`api`, `ocpp-gateway`, `worker`; todas recebem as mesmas variáveis, `lib/env.ts` valida o schema inteiro em qualquer entrypoint):

| Variável | Valor |
|---|---|
| `DATABASE_URL` | a do **novo** Postgres |
| `PAYMENT_SECRETS_KEY` | **a original** (a que estava em uso quando o backup foi feito). Se uma rotação estava em andamento, também `PAYMENT_SECRETS_KEY_PREVIOUS`. |
| `JWT_SECRET` | a original (ou uma nova: todos precisam entrar de novo) |
| `REDIS_URL` | o Redis atual, ou um novo (vazio é normal) |
| demais (`CORS_ALLOWED_ORIGINS`, `OCPP_TRUST_PROXY_HOPS`, `OCPP_PORT`, `PORT`, `NODE_ENV=production`...) | como estavam: `docs/DEPLOY-EASYPANEL.md` seção 1 |

Faça **redeploy** das 3 apps. Cada uma roda `prisma migrate deploy` no boot: com o backup de uma versão anterior do schema, as migrations pendentes são aplicadas; é seguro rodar as 3 ao mesmo tempo (lock consultivo do Prisma).

### Etapa 6. Verificação (a de verdade)

Contar linhas prova que o dump tem dados; abrir a tela prova que o negócio voltou.

1. `GET /health` da API responde; log do worker sem `alert:` novos. Procure `partition_horizon` (o worker recria as partições que faltarem).
2. **Entrar** no painel admin (se a `JWT_SECRET` mudou, é normal pedir login).
3. **Admin > Backup**: a impressão digital da chave bate com a guardada. Rode **Fazer backup agora** e espere ficar verde: isto prova que o sistema restaurado também consegue fazer backup (destino, `PAYMENT_SECRETS_KEY`, `pg_dump`). **Se aparecer erro de chave (`KEY`)**: a `PAYMENT_SECRETS_KEY` não é a original; gere uma chave de backup nova (as cópias antigas continuam precisando da antiga: guarde as duas).
4. **Admin > Gateway de pagamento**: as credenciais da Cielo aparecem preenchidas (só de escrita). Se estiverem vazias/ilegíveis, a `PAYMENT_SECRETS_KEY` não é a original: reentrar as credenciais.
5. **Carregadores**: a lista de pontos mostra os carregadores voltando a ficar online (eles reconectam sozinhos; leva alguns minutos). Sessões em andamento antes do desastre podem aparecer "em confirmação": o watchdog de sessão travada (se ligado) as reconcilia.
6. Abra por amostra: **um motorista real e o saldo da carteira**, o histórico de sessões dele, uma tarifa, um operador. Compare com o que o negócio conhece.
7. SQL de sanidade (no Postgres novo):

```sql
SELECT count(*) FROM "Operator"; SELECT count(*) FROM "User"; SELECT count(*) FROM "ChargingSession";
SELECT max("createdAt") FROM "WalletEntry";   -- até quando vão os dados (o RPO desta restauração)
SELECT (SELECT count(*) FROM "MeterSample_default") AS meter, (SELECT count(*) FROM "OcppMessage_default") AS ocpp;  -- deve ser 0
```

### Etapa 7. Religar

Abra a porta externa do Postgres de volta (se abriu), remova o serviço Postgres antigo **só depois** de uns dias estáveis, e reative qualquer agendamento que você tenha pausado.

### Etapa 8. Reconciliar a janela perdida (RPO)

O que aconteceu **depois do último backup e antes do desastre** não está no banco restaurado, mas **pode existir na Cielo e nos carregadores**:

1. Anote o `max("createdAt")` da etapa 6 e o horário do desastre.
2. No **portal da Cielo**, liste as transações (Pix e cartão) dessa janela e compare com o banco: Pix pago e não creditado na carteira do motorista, cobranças de cartão sem sessão correspondente. Resolva caso a caso (crédito manual de carteira com motivo, ou estorno pela Cielo). A conferência é manual: o sistema restaurado não sabe do que aconteceu na janela. A conta Cielo é compartilhada com o Parque, então filtre só as transações do InnoFlow (ver `docs/GATEWAY-CIELO-PARQUE-VS-INNOFLOW.md`).
3. Carregadores que guardaram transações offline reenviam `StopTransaction` ao reconectar: confira as sessões abertas do período.
4. Avise os motoristas afetados, se houver.

### Etapa 9. Registrar

Registre o incidente: causa, janela de dados perdida, quanto tempo levou (este é o seu RTO real: guarde o número), o que faltou neste runbook. Atualize-o.

---

## 8. Restauração PARCIAL (uma tabela, algumas linhas)

**Nunca use `restore-db.sh` para isso sobre a produção**: ele refaz o schema inteiro. O caminho seguro é restaurar o backup num banco **temporário** e copiar de lá só o que falta.

```sh
# 1. banco temporário (qualquer Postgres que você controle; NÃO é o banco de produção)
export PGPASSWORD='<senha>'
psql "postgresql://USUARIO@HOST:5432/postgres" -c 'CREATE DATABASE innoelektron_parcial'
sh scripts/restore-db.sh backup-....dump.enc "postgresql://USUARIO@HOST:5432/innoelektron_parcial" --confirmar --chave chave.txt

# 2. encontre as linhas que você quer de volta
psql "postgresql://USUARIO@HOST:5432/innoelektron_parcial" -c "SELECT id, name, email FROM \"User\" WHERE email = 'motorista@exemplo.com'"

# 3. exporte SÓ essas linhas (uma linha de comando, \copy é do psql)
psql "postgresql://USUARIO@HOST:5432/innoelektron_parcial" -c "\copy (SELECT * FROM \"MeterSample\" WHERE \"sessionId\" = 'ID' ) TO 'linhas.csv' WITH (FORMAT csv, HEADER)"

# 4. importe na produção, numa transação, DEPOIS de conferir o CSV
psql "<url da produção>" -v ON_ERROR_STOP=1 -1 -c "\copy \"MeterSample\" FROM 'linhas.csv' WITH (FORMAT csv, HEADER)"
```

Cuidados específicos deste schema:
- **`WalletEntry` e `AuditLog` são somente-anexar** (gatilhos barram `UPDATE` e `DELETE`): dá para **inserir** lançamentos que faltam, nunca alterar os existentes. O saldo é a soma dos lançamentos, não um campo: ao reinserir, respeite a ordem e o `balanceAfterCents`, e registre a correção como ajuste manual pela tela do admin sempre que possível (fica na auditoria).
- Respeite as **chaves estrangeiras**: para devolver uma sessão de carga, o carregador, o motorista e a tarifa precisam existir no destino. Importe as tabelas pai primeiro.
- `MeterSample` e `OcppMessage` são **particionadas por mês** e a chave de partição faz parte da chave primária: importe pela tabela-pai (`"MeterSample"`), nunca direto numa partição; o mês precisa ter partição (a `DEFAULT` pega o resto).
- Colunas cifradas (`...Ciphertext`) só são legíveis com a `PAYMENT_SECRETS_KEY` **original**.
- Só quer inspecionar o backup sem restaurar nada? `sh scripts/restore-db.sh backup.dump.enc --listar --chave chave.txt` lista o conteúdo; `node scripts/decrypt-backup.mjs backup.dump.enc --chave chave.txt` gera o `.dump` ao lado (sem sobrescrever nada que exista) para você usar com `pg_restore --list` / `-t`.
- Apague o banco temporário depois: ele contém os dados de todos os motoristas.

---

## 9. Ensaio de restauração trimestral (obrigatório) e checklist

**Quando:** a cada trimestre (jan, abr, jul, out), mais uma vez depois de qualquer mudança grande (troca de servidor Postgres, de versão major do Postgres, da `PAYMENT_SECRETS_KEY`, do destino do backup). Marque na agenda.

**Onde:** num Postgres **descartável** (um serviço temporário no EasyPanel, ou o seu computador), **nunca** em produção e sem parar nada.

**Roteiro (30 a 60 minutos):**

```sh
# 0. cronômetro: anote a hora de início
# 1. baixe o backup MAIS RECENTE do bucket/Drive (não o que está na sua máquina: o caminho real)
node scripts/decrypt-backup.mjs backup-....dump.enc --info            # impressão digital == a da chave guardada?
# 2. restaure num banco novo (não precisa de --permitir-banco-em-uso: é outro banco)
export PGPASSWORD='<senha do descartável>'
sh scripts/restore-db.sh backup-....dump.enc "postgresql://USUARIO@HOST:5432/ensaio" --confirmar --chave chave-guardada.txt
# 3. (opcional, forte) suba o backend contra ele e entre no painel:
#    DATABASE_URL=postgresql://USUARIO@HOST:5432/ensaio  (api local)  ->  abrir o painel e conferir
```

**Checklist do ensaio** (marque tudo; o que falhar vira correção, não nota de rodapé):

- [ ] O arquivo veio do **destino real** (bucket/Drive), não de uma cópia local.
- [ ] A impressão digital do arquivo **bate** com a da chave que está no gerenciador de senhas / cópia offline.
- [ ] A **chave guardada** abre o arquivo (a de verdade, a que está no cofre, não a que está aberta na tela).
- [ ] `restore-db.sh` terminou com `concluído` e "tabelas no destino" igual a "o backup define".
- [ ] `SELECT max("createdAt") FROM "WalletEntry"` mostra uma data de **menos de 36 h** atrás (o backup é recente).
- [ ] Um motorista conhecido e o saldo dele conferem; uma sessão recente existe.
- [ ] A `PAYMENT_SECRETS_KEY` guardada **decifra** os segredos do banco restaurado (por exemplo, subir o backend contra o banco do ensaio e abrir Admin > Gateway de pagamento: credenciais preenchidas, não erro).
- [ ] **Tempo total medido** (do passo 0 até conferir): registre aqui o número e compare com a meta de 2 h da seção 3: ______
- [ ] O Postgres descartável foi **apagado** (contém dados de todos os motoristas).
- [ ] Data do ensaio e resultado anotados: ______

---

## 10. Problemas comuns

| Sintoma | Causa e o que fazer |
|---|---|
| `o pg_dump deste ambiente é da versão X e o banco é o PostgreSQL Y` | O cliente da imagem é mais velho que o servidor (o servidor foi atualizado antes da imagem). Suba o pacote em `backend/Dockerfile*` (`postgresql18-client` ou mais novo) nos **3** Dockerfiles. |
| Backup agendado falha com `DUMP` | Ver o log do worker (`[backup]`). Causas: cliente mais velho que o servidor (acima); `/tmp` sem espaço (o dump em claro e o cifrado coexistem por instantes: precisa de ~2x o tamanho do dump); banco inacessível. |
| `não consegui criar o destino './backups'` | O diretório da aplicação é somente leitura para o usuário `node` (de propósito). Use `/tmp/backups`. |
| `Chave errada: este backup foi cifrado com a chave de impressão digital A, e a chave informada é a B` | É outra chave. Procure no cofre a de impressão digital `A` (chaves antigas existem para isto). |
| `Falha na verificação: o arquivo foi alterado, está corrompido ou está incompleto` | O arquivo não é íntegro: download incompleto, disco cheio, ou alteração. **Não use.** Baixe de novo ou use a cópia anterior. |
| `o destino ... é o MESMO banco da DATABASE_URL deste ambiente` | Proteção. Se é um ensaio, aponte para outro banco. Se é o desastre de verdade e as 3 apps estão paradas, use `--permitir-banco-em-uso`. |
| `permission denied for schema public` / `must be owner of schema public` ao restaurar | O usuário do destino não é dono do schema `public` (banco gerenciado). Restaure com o usuário dono, ou, em último caso, `--tolerar-erros` (sem transação única: um erro no meio pode deixar o destino pela metade; só use com o destino descartável). |
| `unrecognized configuration parameter "transaction_timeout"` | Só aparece com `--tolerar-erros` e cliente 17+ contra servidor 16: é o `pg_restore` pedindo um parâmetro que o servidor antigo não conhece. É ignorável. O caminho padrão já o contorna. |
| O restore terminou mas o sistema acusa "permission denied" nas tabelas | Você restaurou com um usuário diferente do da `DATABASE_URL` das apps (o dump não carrega donos). Restaure de novo com o usuário certo. |
| `psql: argumento extra de linha de comando ... ignorado` (Windows, cliente 16) | psql antigo no Windows não aceita opções depois da URL. Os scripts usam `--dbname=` justamente para isto; se você montar um comando à mão, coloque as opções antes da URL. |

---

## 11. Referência dos scripts (`backend/scripts/`)

Todos rodam com `sh` (POSIX; testado em dash, bash e busybox ash). Mensagens em português; **senha nunca em argumento nem em log**; arquivos temporários sempre apagados.

| Script | Para que serve |
|---|---|
| `backup-db.sh` | Cópia por linha de comando. Cifra por padrão (`BACKUP_KEY_FILE` ou `BACKUP_KEY`); sem chave recusa, a menos que `--sem-cifra`. Confere o dump e o arquivo cifrado de volta. Verifica a versão do cliente contra a do servidor. |
| `restore-db.sh` | Restauração. Destino **sempre** explícito; exige `--confirmar`; recusa banco em uso sem `--permitir-banco-em-uso`; atômica; `--listar`, `--chave`, `--aceitar-sem-cifra`, `--tolerar-erros`. |
| `decrypt-backup.mjs` | Cifra/decifra/verifica o `.dump.enc` **sem depender do projeto** (só Node). `--chave`, `--saida`, `--verificar`, `--info`, `--cifrar`. Códigos de saída: `0` ok, `1` uso, `2` chave errada, `3` adulterado/cortado/não cifrado. |
| `backup-smoke.mjs` | Prova do ciclo no CI: `semear`, `conferir` (dados atípicos: acento, emoji, decimal, data com fuso, JSON, gatilhos de somente-anexar) e `contagens` (retrato exato do banco para comparar antes x depois). Exige o Prisma Client (só no CI/dev). |
| `_pg-url.sh` | Funções compartilhadas (tira a senha da URL e os parâmetros do Prisma, compara destinos). Não rode direto. |

Variáveis: `DATABASE_URL`, `BACKUP_KEY_FILE`, `BACKUP_KEY`, `BACKUP_DIR`, `BACKUP_TMP_DIR`, `PGPASSWORD` (do destino do restore).
