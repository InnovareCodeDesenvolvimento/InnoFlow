# Contrato da API: Backup automático do banco (Admin > Backup)

Contrato LITERAL das rotas `/api/admin/backup` (+ o callback público do Google). **Fonte da verdade do backend:** `backend/src/api/routes/backup.routes.ts`, `backend/src/api/schemas/backup.schema.ts`, `backend/src/services/backup/configBackup.ts` (DTOs de config/status/chave) e `backend/src/services/backup/pedidosDeBackup.ts` (DTO de execução). Os tipos abaixo ainda **não estão em** `frontend/src/types/api.ts` (o único escritor desse arquivo é o Vega-B/Lyra): copie-os para lá, sem renomear. Formato do arquivo cifrado: `docs/BACKUP-FORMATO.md`. Operação (restaurar, ensaio, segredos): `docs/RUNBOOK-BACKUP-RESTAURACAO.md`.

Mesmo desenho e mesma segurança das telas do gateway de pagamento e da comunicação: **segredos só-escrita** (nunca voltam), **step-up de senha** do ADMIN nas alterações de alto impacto, auditoria, **somente ADMIN**.

Todas as rotas: `Authorization: Bearer <jwt>`, **ADMIN** (OPERATOR e DRIVER recebem `403 FORBIDDEN`; sem token `401 UNAUTHORIZED`). Erros no envelope da casa: `{ error: string, code: string, details?: ... }` — **trate por `code`**, nunca pelo texto.

## O que a tela precisa mostrar (resumo)

1. **Estado**: último sucesso, atrasado? (alerta vermelho), próxima execução, "rodando agora".
2. **Configuração**: ligado, hora (Brasília), frequência (1/2/7 dias), quantas cópias manter, limite de atraso em horas; **destino** (S3 ou Google Drive) com os campos de cada um; **chave de criptografia** (existe? impressão digital; botão "Gerar chave"); o que ainda falta para ligar (`problemsToEnable`).
3. **Ações**: "Testar destino", "Fazer backup agora", "Conferir backup", "Conectar com Google".
4. **Histórico** paginado (backup agendado / manual / conferência, estado, tamanho, duração, erro).
5. A **tela NÃO restaura** o banco, de propósito (um botão que apaga o banco a um clique é risco desproporcional): restaurar é por linha de comando (runbook).

## Rotas

| Método e caminho | Para quê | Step-up (senha)? | Limite |
|---|---|---|---|
| `GET /api/admin/backup/config` | Config (sem segredos) | não | geral |
| `PUT /api/admin/backup/config` | Salva (parcial) | **sim**, exceto só horário/frequência/limite de alerta ou **desligar** | 10/min por ADMIN |
| `GET /api/admin/backup/status` | Estado + última execução + execução ativa | não | geral |
| `POST /api/admin/backup/key` | Gera a chave (mostrada UMA vez) | **sim** | 10/min por ADMIN |
| `POST /api/admin/backup/run` | "Fazer backup agora" (assíncrono, 202) | não | 6 / 10 min por ADMIN (dividido com `/verify`) |
| `POST /api/admin/backup/verify` | "Conferir backup" (assíncrono, 202) | não | idem |
| `POST /api/admin/backup/test-destination` | Testa o destino (grava e apaga um arquivinho) | não | 5/min por ADMIN |
| `GET /api/admin/backup/runs` | Histórico paginado | não | geral |
| `GET /api/admin/backup/runs/:id` | Uma execução (para acompanhar o 202) | não | geral |
| `POST /api/admin/backup/google/start` | Inicia "Conectar com Google" | **sim** | 10/min por ADMIN |
| `POST /api/admin/backup/google/disconnect` | Desconecta a conta Google | **sim** | 10/min por ADMIN |
| `GET /api/backup/google/callback` | **PÚBLICA** — volta do Google (a SPA não chama; é o navegador) | — | público |

"Geral" = `adminRateLimit` (300/min por IP). Respostas de `config`, `status`, `runs` e da chave levam `Cache-Control: no-store`.

## Tipos (copiar para `frontend/src/types/api.ts`)

```ts
export type BackupDestination = 'S3' | 'DRIVE'
export type BackupTrigger = 'SCHEDULED' | 'MANUAL' | 'VERIFY'
export type BackupRunStatus = 'QUEUED' | 'RUNNING' | 'SUCCESS' | 'FAILED'

/** Código do erro de uma execução (`BackupRunDTO.errorCode`). Nunca texto livre. */
export type BackupErrorCode =
  | 'CONFIG' // destino incompleto/recusado, DATABASE_URL ausente
  | 'CREDENTIAL' // o destino recusou a credencial
  | 'FOLDER' // bucket/pasta inexistente ou sem acesso
  | 'QUOTA' // sem espaço no destino
  | 'NETWORK' // rede/instabilidade do destino
  | 'OAUTH_DISCONNECTED' // Google: acesso revogado — reconectar
  | 'DUMP' // pg_dump/pg_restore falhou (cliente ausente na imagem, versão antiga...)
  | 'DUMP_TIMEOUT' // pg_dump passou do prazo
  | 'KEY' // chave do backup ausente/ilegível/diferente da do arquivo
  | 'SECRETS_KEY' // a chave dos segredos mudou (JWT_SECRET trocado; ou override PAYMENT_SECRETS_KEY): segredos do destino não decifram
  | 'TOO_BIG' // arquivo > 5 GiB (envio simples do S3)
  | 'NO_BACKUP' // conferência: destino vazio
  | 'VERIFY' // conferência reprovou (vazio, adulterado, sem marca, índice vazio)
  | 'CHECKSUM' // SHA-256 do arquivo no destino não bate com o gravado no envio
  | 'BUSY' // já havia um em andamento
  | 'INTERRUPTED' // o processo morreu no meio
  | 'NOT_PICKED_UP' // pedido manual que o worker nunca pegou (worker fora do ar)
  | 'UNKNOWN'

/** Pendências para LIGAR o automático (vazio = pode ligar). */
export type BackupProblemToEnable = 'DESTINATION_INCOMPLETE' | 'KEY_MISSING' | 'SECRETS_KEY_MISSING' | 'SECRETS_UNREADABLE'

/** `GET /api/admin/backup/config` e resposta do `PUT` e do `POST /google/disconnect`. SEGREDOS NUNCA VOLTAM. */
export interface BackupConfigDTO {
  enabled: boolean
  /** Hora cheia em Brasília (UTC-3 fixo), 0..23. */
  hourLocal: number
  /** 1 = diário, 2 = dia sim dia não, 7 = semanal. */
  frequencyDays: 1 | 2 | 7
  /** Quantas cópias manter no destino (>= 1). Nunca apaga a única/última. */
  retentionCount: number
  /** Sem sucesso há mais que isto (h), com o automático ligado, dispara o alerta de atraso. 6..720. */
  alertAfterHours: number
  /** Destino ESCOLHIDO (manda sobre o que estiver preenchido). */
  destination: BackupDestination | null
  /** O destino escolhido está completo (S3: endereço+bucket+chave+segredo; Drive: conta conectada). */
  destinationReady: boolean
  s3: {
    endpoint: string | null
    region: string | null
    bucket: string | null
    prefix: string | null
    /** Há chave de acesso / segredo salvos. NUNCA são devolvidos (nem dica de caracteres). */
    accessKeySet: boolean
    secretKeySet: boolean
  }
  drive: {
    clientId: string | null
    clientSecretSet: boolean
    /** Conta Google conectada (fluxo OAuth concluído). "Client ID preenchido" NÃO é conectado. */
    connected: boolean
    connectedAt: string | null
    accountEmail: string | null
    /** O `redirect_uri` que o dono precisa cadastrar no app do Google Cloud (null se a API não sabe o próprio endereço: defina PUBLIC_API_BASE_URL). */
    redirectUri: string | null
  }
  encryptionKey: {
    exists: boolean
    /** 8 hex: confere "é a chave certa?" sem revelar a chave. */
    fingerprint: string | null
    createdAt: string | null
    shownAt: string | null
  }
  /** A chave dos segredos está utilizável (derivada do JWT_SECRET; só é false se o override PAYMENT_SECRETS_KEY foi definido e é inválido). Sem ela não dá para guardar credenciais nem a chave. */
  secretsKeyConfigured: boolean
  /** Os segredos salvos decifram agora (false = o JWT_SECRET mudou — ou o override —: recadastrar). */
  secretsReadable: boolean
  problemsToEnable: BackupProblemToEnable[]
  updatedAt: string
}

/** Uma execução (backup agendado/manual ou conferência). */
export interface BackupRunDTO {
  id: string
  trigger: BackupTrigger
  status: BackupRunStatus
  destination: BackupDestination | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  durationMs: number | null
  /** Nome do arquivo no destino (`backup-innoflow-AAAA-MM-DD-HHhMMmSSs.dump.enc`). */
  fileName: string | null
  /** Chave do objeto no S3, ou `drive:<id>/<nome>` no Drive. Nulo em teste sem destino. */
  objectKey: string | null
  /** Tamanho do arquivo CIFRADO que subiu. */
  sizeBytes: number | null
  /** SHA-256 (hex) do arquivo cifrado que subiu. */
  checksumSha256: string | null
  tablesWithData: number | null
  /** Impressão digital da chave que cifrou (nulo = execução de teste sem destino). */
  keyFingerprint: string | null
  /** CÓDIGO do erro (só quando `status === 'FAILED'`). */
  errorCode: BackupErrorCode | null
  /** Texto fixo, pronto para mostrar, derivado do código (nunca o stderr do pg_dump). */
  errorMessage: string | null
}

/** `GET /api/admin/backup/status`. */
export interface BackupStatusDTO {
  lastSuccessAt: string | null
  lastAttemptAt: string | null
  /** Há um backup rodando agora (trava viva no banco). */
  running: boolean
  /** Atrasado: automático ligado e sem sucesso dentro de `alertAfterHours`. */
  stale: boolean
  /** Ligado e nunca saiu uma cópia. */
  neverRan: boolean
  /** Horas desde o último sucesso (null se nunca). */
  ageHours: number | null
  /** Próxima execução agendada (ISO, UTC), ou null com o automático desligado. */
  nextRunAt: string | null
  /** Pedido manual/conferência enfileirado ou rodando agora (para o spinner). */
  activeRun: BackupRunDTO | null
  lastBackupRun: BackupRunDTO | null
  lastVerifyRun: BackupRunDTO | null
}

/** `PUT /api/admin/backup/config` — tudo opcional, campo ausente = "não mexer", `null` onde permitido = limpar. `.strict()`: campo desconhecido é 400. */
export interface UpdateBackupConfigRequest {
  enabled?: boolean
  hourLocal?: number // 0..23
  frequencyDays?: 1 | 2 | 7
  retentionCount?: number // 1..365
  alertAfterHours?: number // 6..720
  destination?: BackupDestination | null
  s3?: {
    endpoint?: string // URL: https em produção; sem usuário/senha/query
    region?: string | null // ex.: us-east-1, auto
    bucket?: string
    prefix?: string | null // pasta dentro do bucket
    accessKey?: string // SÓ-ESCRITA
    secretKey?: string // SÓ-ESCRITA
  }
  drive?: {
    clientId?: string | null // trocar o Client ID DESCONECTA a conta (o escopo drive.file é por app)
    clientSecret?: string // SÓ-ESCRITA
  }
  /** Apaga um segredo salvo. Para TROCAR, mande o valor novo no campo próprio. */
  clearSecrets?: Array<'s3AccessKey' | 's3SecretKey' | 'driveClientSecret'>
  /** Senha ATUAL do ADMIN logado. Obrigatória exceto quando o PUT só traz hourLocal/frequencyDays/alertAfterHours ou `enabled: false`. */
  currentPassword?: string
}

/** `POST /api/admin/backup/key` → 201. A chave sai UMA vez: a tela deve oferecer o download do `fileText` e NÃO guardá-la. */
export interface GenerateBackupKeyRequest {
  currentPassword: string
  /** Trocar uma chave que JÁ existe exige `replace: true` E `confirmation: 'GERAR NOVA CHAVE'` (exatamente). */
  replace?: boolean
  confirmation?: string
  /** A impressão digital que a tela viu; se já mudou (outra pessoa gerou), 409 `BACKUP_KEY_CHANGED`. */
  expectedFingerprint?: string | null
}
export interface GeneratedBackupKeyResponse {
  /** A chave inteira, 8 grupos de 8 hex separados por hífen. */
  key: string
  fingerprint: string
  /** `chave-backup-innoflow-<impressão digital>.txt` */
  fileName: string
  /** Conteúdo do .txt para download (tem a linha `CHAVE: ...` que os scripts leem). */
  fileText: string
  replaced: boolean
}

/** `POST /api/admin/backup/test-destination` → SEMPRE 200 com o RESULTADO (`ok:false` não é erro da rota). */
export interface BackupTestDestinationResponse {
  ok: boolean
  destination: BackupDestination | null
  message: string
  error?: { code: BackupErrorCode; message: string }
}

/** `GET /api/admin/backup/runs?page=&pageSize=&trigger=&status=` (pageSize 1..100, padrão 20). */
export interface BackupRunsResponse {
  items: BackupRunDTO[]
  meta: { page: number; pageSize: number; total: number; totalPages: number }
}

/** `POST /api/admin/backup/google/start` → 200. Navegue (`window.location`) para `url`. */
export interface BackupGoogleStartResponse {
  url: string
  redirectUri: string | null
}
```

## Fluxos

### Salvar a configuração

1. `GET /config` ao abrir a tela. Mostre `problemsToEnable` como lista do que falta para ligar.
2. `PUT /config` com **só o que mudou**. Se for alteração de alto impacto (qualquer coisa além de horário/frequência/alerta/desligar), peça a senha atual e mande `currentPassword`. Sem ela: `400 CURRENT_PASSWORD_REQUIRED`. Errada: `403 INVALID_CURRENT_PASSWORD`. Tentativas erradas demais: `429 RATE_LIMITED_BACKUP` + header `Retry-After` (segundos). Redis do throttle fora: `503 STEPUP_UNAVAILABLE` (nada é gravado).
3. **Segredos são só-escrita**: o campo de segredo da tela fica vazio e mostra "salvo" (`accessKeySet`/`secretKeySet`/`clientSecretSet`). Enviar vazio/ausente MANTÉM o que está salvo; para apagar use `clearSecrets`.
4. **Trocar o endereço do bucket** (host diferente) com credencial salva exige reenviar `accessKey` **e** `secretKey` (senão `400 SECRET_REQUIRED_FOR_NEW_DESTINATION`).
5. **Ligar** (`enabled: true`) exige destino completo (`409 BACKUP_DESTINATION_MISSING`) e chave gerada (`409 BACKUP_KEY_MISSING`). Desligar não pede senha.

### Gerar a chave (a única vez em que ela sai do servidor)

`POST /key` com a senha → `201` com `key`, `fingerprint`, `fileName` e `fileText`. **Mostre a chave uma vez, ofereça o download do `.txt` e peça para guardar fora do servidor** (gerenciador de senhas + cópia offline); explique que sem ela os backups não abrem e que ela **não substitui** o `JWT_SECRET` (dele deriva a chave dos segredos; sem ele, o restore não devolve as credenciais da Cielo etc.). O sistema guarda só uma cópia cifrada para o agendador.
Trocar uma chave existente: `replace: true` + `confirmation: "GERAR NOVA CHAVE"` (a tela pede para digitar) + `expectedFingerprint` (o que ela mostrava). As cópias antigas continuam precisando da chave antiga — avise.

### Fazer backup agora / Conferir (assíncronos)

`POST /run` e `POST /verify` respondem **202** com um `BackupRunDTO` em `QUEUED`. O **worker** executa. Acompanhe com `GET /runs/:id` (ou `GET /status` → `activeRun`) a cada 2–3 s até `status` ser `SUCCESS` ou `FAILED`. Se ficar `QUEUED` por mais de ~15 min o agendador fecha como `FAILED` / `NOT_PICKED_UP` (worker fora do ar).
Erros: `409 BACKUP_BUSY` (já há um em andamento: desabilite os botões enquanto `activeRun`/`running`), `409 BACKUP_DESTINATION_MISSING` (destino escolhido e incompleto, ou conferir sem destino), `503 QUEUE_UNAVAILABLE` (Redis/fila fora), `429 RATE_LIMITED_BACKUP`.
"Fazer backup agora" **sem nenhum destino escolhido** é um TESTE do `pg_dump` (dumpa, confere e descarta; `objectKey: null`) e não conta como cópia.

### Testar destino

`POST /test-destination` (sem corpo) → 200. `ok: true` = gravou e apagou um arquivinho de teste (S3) / abriu a pasta (Drive). `ok: false` traz `error.code` + `error.message` (texto fixo). Sempre salve e só então teste.

### Conectar com Google (Drive)

Pré-requisito: o dono cria um app OAuth no Google Cloud (tipo "aplicativo da Web"), cadastra o `drive.redirectUri` (mostre-o na tela com botão copiar), e salva **Client ID** e **Client Secret** via `PUT /config` (`drive.clientId`, `drive.clientSecret`). Dica na tela: o app do Google Cloud precisa estar **"Em produção"** — em modo "Teste" o acesso expira em 7 dias e o backup para (`OAUTH_DISCONNECTED`).

1. `POST /google/start` (senha) → `{ url }`. Navegue para `url` (`window.location.assign`). Só ADMIN consegue gerar essa URL.
2. O Google devolve o navegador ao **callback da API** (`GET /api/backup/google/callback`), que grava a conexão e faz `302` para o **frontend**:
   `{PUBLIC_APP_URL}/admin/backup?google=ok` — sucesso (recarregue `GET /config`; `drive.connected = true`);
   `{PUBLIC_APP_URL}/admin/backup?google=erro&motivo=<código>` — falha. **A Lyra precisa tratar estes dois parâmetros na rota `/admin/backup`** e limpá-los da URL depois.
3. Códigos de `motivo` (traduza na tela; nenhum traz mensagem crua do Google): `invalid_state` (link expirado, já usado ou inválido: tente de novo), `access_denied` (a pessoa negou o acesso), `refused_by_google`, `no_code`, `bad_credentials` (Client ID/Secret errados ou revogados), `no_refresh_token` (o Google não devolveu o acesso de longa duração: remova o app em myaccount.google.com/permissions e conecte de novo), `account_check_failed`, `folder_create_failed`, `secrets_key_missing` (servidor sem PAYMENT_SECRETS_KEY), `network`, `unknown`.
4. Depois de conectado: `PUT /config` com `destination: 'DRIVE'` (senha) e **Testar destino**. A pasta "Backups InnoFlow" é criada pelo sistema no Drive do dono (o escopo `drive.file` só enxerga o que o próprio app criou).
5. `POST /google/disconnect` (senha) → revoga no Google (melhor esforço) e limpa a conexão; Client ID/Secret ficam. Resposta = `BackupConfigDTO`. Com o automático ligado e destino Drive, desconectar faz o backup agendado **falhar** (`CONFIG`) até reconectar — avise.

Se `drive.redirectUri` vier `null`, a API não conhece o próprio endereço público: o deploy precisa definir `PUBLIC_API_BASE_URL` (e `PUBLIC_APP_URL` para o redirecionamento final).

## Erros por rota (códigos além dos gerais `UNAUTHORIZED`/`FORBIDDEN`/`VALIDATION_ERROR`/`RATE_LIMITED`/`INTERNAL_ERROR`)

| Código | HTTP | Onde | Significado / o que fazer |
|---|---|---|---|
| `CURRENT_PASSWORD_REQUIRED` | 400 | PUT config | Alteração de alto impacto sem `currentPassword`: peça a senha |
| `INVALID_CURRENT_PASSWORD` | 403 | PUT config, key, google/* | Senha errada (não é 401: o interceptor do frontend desloga em 401) |
| `RATE_LIMITED_BACKUP` | 429 | todas as escritas/ações | Muitas tentativas (limite por ADMIN ou tranca da senha); use `Retry-After` |
| `STEPUP_UNAVAILABLE` | 503 | PUT config, key, google/* | Não deu para confirmar a senha agora (Redis); nada foi gravado: tente de novo |
| `SECRETS_KEY_MISSING` | 503 | PUT config (com credencial), key | A chave dos segredos está indisponível (override `PAYMENT_SECRETS_KEY` inválido): não dá para guardar segredos |
| `INVALID_URL` / `HTTPS_REQUIRED` / `URL_HAS_CREDENTIALS` / `URL_HAS_EXTRAS` | 400 | PUT config (`s3.endpoint`) | Endereço do bucket inválido (precisa https em produção, sem usuário/senha, sem `?`/`#`) |
| `DESTINATION_NOT_ALLOWED` | 400 | PUT config (`s3.endpoint`) | Aponta para a rede interna/metadados/loopback: use o endereço público do provedor (`details[0].field`) |
| `SECRET_REQUIRED_FOR_NEW_DESTINATION` | 400 | PUT config | Trocou o endereço do bucket sem reenviar `accessKey` e `secretKey` |
| `BACKUP_DESTINATION_MISSING` | 409 | PUT (ligar), run, verify | Destino escolhido e incompleto (ou nenhum, para conferir) |
| `BACKUP_KEY_MISSING` | 409 | PUT (ligar) | Gere a chave antes de ligar |
| `BACKUP_KEY_EXISTS` | 409 | POST key | Já existe chave: para trocar use `replace` + confirmação |
| `BACKUP_KEY_CONFIRMATION_REQUIRED` | 400 | POST key | Faltou a frase exata `GERAR NOVA CHAVE` |
| `BACKUP_KEY_CHANGED` | 409 | POST key | Outra pessoa gerou a chave: recarregue a tela |
| `BACKUP_BUSY` | 409 | run, verify, key (trocar) | Já há um backup/conferência em andamento |
| `QUEUE_UNAVAILABLE` | 503 | run, verify | A fila (Redis) está fora; a execução foi marcada FAILED/NOT_PICKED_UP |
| `DRIVE_OAUTH_CREDENTIALS_MISSING` | 409 | google/start | Salve Client ID e Client Secret antes |
| `PUBLIC_URL_UNKNOWN` | 409 | google/start | O deploy não definiu `PUBLIC_API_BASE_URL` |
| `NOT_FOUND` | 404 | runs/:id | Execução inexistente |

## Alertas que o dono recebe (e-mail/WhatsApp, quando configurados em Comunicação; senão só log)

`backup_failed` (CRÍTICO — backup agendado falhou/foi abandonado), `backup_verify_failed` (CRÍTICO — conferência semanal reprovou), `backup_stale` (IMPORTANTE — sem cópia há mais de `alertAfterHours`, no máximo 1 a cada 12 h), `backup_config_changed` (IMPORTANTE — destino/chave/conta Google mexidos: se não foi você, é sinal de invasão), `backup_prune_failed` (INFO). Backup **manual** que falha NÃO alerta: aparece no histórico.
