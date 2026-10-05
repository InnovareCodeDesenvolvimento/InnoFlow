# Formato do arquivo de backup cifrado (`*.dump.enc`) — versão 1

Este é o **contrato byte a byte** entre três coisas que precisam concordar para o backup ser restaurável:

| Quem | Onde | Papel |
|---|---|---|
| Backend (Vega) | `backend/src/lib/crypto/backupCrypto.ts` | cifra o dump no agendador e decifra na conferência semanal |
| Scripts (Vulcano) | `scripts/decrypt-backup.mjs`, `backup-db.sh`, `restore-db.sh` | decifram/cifram **sem depender do projeto** (só Node) para o dono restaurar numa máquina limpa |
| Teste | `backend/tests/unit/backupCrypto.test.ts` | prova que os dois lados abrem o que o outro cifra (vetor fixo + ida e volta + adulteração) |

É o **mesmo formato do InnoChat** (`src/modules/backup/backup-crypto.ts`): um decifrador escrito para o InnoChat abre um backup do InnoFlow e vice-versa. Se qualquer byte mudar, **suba a versão** (byte 7), o decifrador dos scripts e o vetor fixo do teste.

## O que é cifrado

O dump é o resultado de `pg_dump --format=custom --no-owner --no-privileges` (arquivo binário que começa com os 5 bytes ASCII `PGDMP`). O arquivo cifrado é esse dump **inteiro** passado por AES-256-GCM **em fluxo** (nada carrega o arquivo na memória; funciona para dumps de gigabytes).

## Layout

```
posição        tamanho   conteúdo
-----------    -------   ------------------------------------------------------------
0   .. 6         7       marca ASCII "INNOBKP"  (49 4E 4E 4F 42 4B 50)
7                1       versão do formato = 0x01
8   .. 11        4       impressão digital da chave = 4 primeiros bytes de SHA-256(chave, 32 bytes crus)
12  .. 23       12       IV (nonce do GCM), aleatório, um por arquivo
24  .. N-17      N-40    texto cifrado (AES-256-GCM do dump; mesmo tamanho do dump, sem preenchimento)
N-16 .. N-1     16       tag de autenticação do GCM
```

- `N` = tamanho total do arquivo. O tamanho do arquivo é sempre `24 + tamanho_do_dump + 16`.
- Cabeçalho = bytes 0..23 (24 bytes). A **tag fica no fim**, por isso quem decifra em fluxo precisa segurar os últimos 16 bytes até o final.
- **AAD (dado autenticado adicional) = bytes 0..11** (marca + versão + impressão digital — 12 bytes). O IV **não** entra no AAD (ele já é entrada do GCM). Trocar a impressão digital no arquivo reprova; trocar o IV também (muda o keystream e a tag não confere).
- Algoritmo: `aes-256-gcm`, chave de **32 bytes**, IV de **12 bytes**, tag de **16 bytes**.
- A chave **nunca** vai no arquivo. A impressão digital (8 hex) só permite perguntar "é a chave certa?" sem revelá-la.
- Limite: 2^36 − 64 bytes de dump por arquivo (limite do GCM com um IV só; ~64 GiB). Acima disso o cifrador recusa (`TOO_BIG`).

## A chave

- 32 bytes aleatórios (`crypto.randomBytes(32)`), **própria do backup** — independente de `JWT_SECRET`, `PAYMENT_SECRETS_KEY` (override opcional) e de qualquer outro segredo do sistema.
- Texto: hex minúsculo em **8 grupos de 8** separados por hífen, ex.: `00010203-04050607-08090a0b-0c0d0e0f-10111213-14151617-18191a1b-1c1d1e1f`. Ao ler, aceita hex com ou sem hífen/espaço, maiúsculo ou minúsculo (64 hex).
- É mostrada ao dono **uma única vez** (tela Admin > Backup) num arquivo `.txt`. A linha que os scripts leem começa com `CHAVE:` (sem diferença entre maiúsculas/minúsculas, espaços nas bordas ignorados); um arquivo que tenha **só** a chave também vale:

```
CHAVE DE CRIPTOGRAFIA DO BACKUP DO INNOFLOW

CHAVE: 00010203-04050607-08090a0b-0c0d0e0f-10111213-14151617-18191a1b-1c1d1e1f
IMPRESSAO DIGITAL: 630dcd29
GERADA EM: 2026-10-06T12:00:00.000Z
...
```

- A chave **não pode** ir por argumento de linha de comando (apareceria em `ps`). Os scripts leem de arquivo (`--chave arquivo.txt`) ou da variável de ambiente `BACKUP_KEY`.
- O sistema guarda uma **cópia cifrada** da chave (com a chave dos segredos, derivada do `JWT_SECRET`) só para o agendador conseguir cifrar de madrugada. Se o `JWT_SECRET` for trocado/perdido, essa cópia morre (o agendador falha com `KEY`: gere a chave de novo) — **a cópia do dono é o que vale**.

## Algoritmo do decifrador (para quem reimplementa)

1. Ler os 24 primeiros bytes. Se `bytes[0..6] != "INNOBKP"` → **não é backup cifrado nosso** (um dump em claro começa com `PGDMP`). Reprovar **cedo** (não esperar 24 bytes se os primeiros já diferem).
2. `bytes[7]` deve ser `1`; senão → versão não suportada.
3. `bytes[8..11]` (em hex) deve ser igual aos 4 primeiros bytes de `SHA-256(chave)`; senão → **chave errada** (e a mensagem mostra as duas impressões digitais, a do arquivo e a da chave informada).
4. `decipher = aes-256-gcm(chave, iv = bytes[12..23])`, `setAAD(bytes[0..11])`.
5. Alimentar o decifrador com os bytes `24 .. N-17`; o **último pedaço de 16 bytes do arquivo é a tag** (segurar sempre os 16 últimos bytes recebidos até o fim do fluxo).
6. No fim: `setAuthTag(tag)` e `final()`. Se lançar → **arquivo adulterado, cortado ou corrompido — não use**.
7. **O texto decifrado só vale depois do passo 6.** Em fluxo, o GCM entrega bytes antes de provar que são íntegros: grave num arquivo temporário e só renomeie para o nome final depois de `final()` passar; em qualquer erro apague o temporário. (O backend faz exatamente isso em `decryptFile`.)

Arquivos com menos de 24 bytes, ou sem os 16 bytes finais, são "cortados".

## Códigos de erro do decifrador do backend

`NOT_ENCRYPTED` (não é nosso), `UNSUPPORTED_VERSION`, `WRONG_KEY` (impressão digital não bate), `AUTH_FAILED` (tag não confere), `TRUNCATED` (cortado), `BAD_KEY` (chave não tem 32 bytes), `TOO_BIG` (só no cifrar). Os scripts do Vulcano usam os códigos de saída do InnoChat: `0` ok, `1` erro de uso, `2` chave errada, `3` arquivo adulterado/cortado/não cifrado.

## Vetor fixo (para conferir qualquer implementação)

- Chave: bytes `00 01 02 ... 1f` (32 bytes) → impressão digital `630dcd29`.
- Dump (52 bytes ASCII): `PGDMP-vetor-fixo-InnoFlow: dados de teste 0123456789`
- Arquivo cifrado (92 bytes = 24 + 52 + 16), IV = `f807afc63f469e11d7319de2`:

```
494e4e4f424b5001630dcd29f807afc63f469e11d7319de26c83d30b7549b1767cb152053bf76f40
d8972e6c8c365ccae02ed6a01ffe57701f4fb85a1ad88af5d8818c36d1d9b530ff06f45ed54619b1
de9bfc0dcebca48622ad1288
```
(as três linhas acima formam **um único** hex de 184 caracteres)

Esse vetor foi produzido pelo `decrypt-backup.mjs --cifrar` do **InnoChat** (a fonte do formato), não pelo código do InnoFlow — e o teste confere os dois sentidos: o InnoFlow abre o vetor e, com o mesmo IV, produz os mesmos 92 bytes.

## Nome do arquivo e do objeto no destino

`backup-innoflow-AAAA-MM-DD-HHhMMmSSs.dump.enc` (hora de Brasília; segundos evitam colisão). A retenção e a conferência só tocam em objetos cujo nome começa com `backup-` e termina em `.dump.enc` (ou `.dump`, de cópias sem cifra) — qualquer outro arquivo no mesmo bucket/pasta é ignorado.

## Restaurar (resumo; o passo a passo fica em `docs/DEPLOY-EASYPANEL.md`, seção Backups)

1. Baixar o `.dump.enc` do destino (S3/Drive).
2. `node scripts/decrypt-backup.mjs backup-....dump.enc --chave chave-backup-innoflow-XXXXXXXX.txt` → gera o `.dump` (só depois da verificação de integridade).
3. `pg_restore --no-owner --no-privileges --dbname=<banco novo> backup-....dump` (ou `./scripts/restore-db.sh ... --confirmar --chave ...`).
4. **Antes de subir a aplicação no banco restaurado**: conferir o `JWT_SECRET` (e a `PAYMENT_SECRETS_KEY`, se usada como override; ver a seção "O que NÃO está no backup"). Sem o `JWT_SECRET` original, as credenciais da Cielo, a senha SMTP, a apikey da Evolution e os tokens de cartão guardados no banco **não decifram**.
