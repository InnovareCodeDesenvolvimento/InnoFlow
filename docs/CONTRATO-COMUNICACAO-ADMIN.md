# Contrato da API: Configurações de comunicação (e-mail e WhatsApp)

Contrato LITERAL das rotas `/api/admin/communication-settings` (N-7). **Fonte da verdade do backend:** `backend/src/api/routes/communicationSettings.routes.ts`, `backend/src/api/schemas/communicationSettings.schema.ts` e `backend/src/services/comunicacao/comunicacaoDto.ts`. Os tipos abaixo ainda **não estão em** `frontend/src/types/api.ts` (o único escritor desse arquivo é o Vega-B): copie-os de lá para lá, sem renomear.

Mesmo desenho e mesma segurança da tela do gateway de pagamento (F5.5): **o painel (banco) manda, as variáveis `ALERT_*` são a reserva**; segredos cifrados (AES-256-GCM, chave `PAYMENT_SECRETS_KEY`); segredo **nunca** volta em claro; PUT exige a senha atual (step-up); somente ADMIN.

Todas as rotas: `Authorization: Bearer <jwt>`, **ADMIN** (OPERATOR e DRIVER recebem `403 FORBIDDEN`; sem token `401`). Erros no envelope da casa: `{ error: string, code: string, details?: ... }`.

## Rotas

| Método e caminho | Para quê | Limite |
|---|---|---|
| `GET /api/admin/communication-settings` | Config EFETIVA (painel > env) para a tela | `adminRateLimit` geral |
| `PUT /api/admin/communication-settings` | Salva (parcial), com step-up de senha | 10/min por ADMIN |
| `POST /api/admin/communication-settings/test-email` | Envia um e-mail de teste | 5/min por ADMIN (compartilhado com o test-whatsapp) |
| `POST /api/admin/communication-settings/test-whatsapp` | Envia um WhatsApp de teste | idem |
| `POST /api/admin/communication-settings/test-smtp-connection` | **Só o handshake SMTP** (conectar, TLS, autenticar), SEM enviar mensagem | 5/min por ADMIN (mesmo balde dos testes) |
| `GET /api/admin/communication-settings/domain-check?selector=` | Diagnóstico de SPF / DKIM / DMARC do domínio do e-mail remetente | 6/min por ADMIN |

## Tipos (copiar para `frontend/src/types/api.ts`)

```ts
export type NotificationSeverity = 'INFO' | 'IMPORTANTE' | 'CRITICO'

/** `GET /api/admin/communication-settings` e resposta do `PUT`. SEGREDOS NUNCA VOLTAM. */
export interface CommunicationSettingsDTO {
  /** `database` = existe configuração salva no painel; `env` = tudo vem das variáveis de ambiente (reserva). */
  source: 'database' | 'env'
  email: {
    /** De onde vale o canal AGORA: painel, env, ou nenhum. */
    source: 'database' | 'env' | 'none'
    /** Intenção: ligado (no painel) ou configurado pela env. */
    enabled: boolean
    /** O canal está funcionando agora (config completa e válida). `enabled && !active` = há problema: ver `warnings`. */
    active: boolean
    host: string | null
    port: number | null
    /** `true` = TLS direto (porta 465); `false` = STARTTLS (587). */
    secure: boolean
    user: string | null
    /** Há senha SMTP salva. A senha NUNCA é devolvida (nem dica de caracteres). */
    passwordSet: boolean
    fromName: string | null
    fromAddress: string | null
    /** Destinatários dos avisos ao dono. */
    recipients: string[]
    minSeverity: NotificationSeverity
  }
  whatsapp: {
    source: 'database' | 'env' | 'none'
    enabled: boolean
    active: boolean
    /** Do painel é sempre `evolution`; da env pode ser `generic`. */
    provider: 'evolution' | 'generic' | null
    baseUrl: string | null
    instance: string | null
    apiKeySet: boolean
    /** Últimos 4 caracteres da apikey, para o admin reconhecer a chave ("…a1b2"); `null` se não há/ não decifra / veio da env. */
    apiKeyHint: string | null
    apiVersion: 1 | 2
    /** Só dígitos com DDI (ex.: "5511999999999"). */
    recipients: string[]
    minSeverity: NotificationSeverity
  }
  alerts: {
    /** Janela de dedupe em minutos (mesmo alerta+contexto avisa no máximo 1x por janela). */
    dedupeMinutes: number
    dedupeSource: 'database' | 'env'
    /** Piso global (env `ALERT_MIN_SEVERITY`, só leitura aqui): vale para qualquer canal além do mínimo de cada um. */
    globalMinSeverity: NotificationSeverity
    /** Teto de avisos por hora (env `ALERT_MAX_PER_HOUR`, só leitura aqui). */
    maxPerHour: number
  }
  /** `PAYMENT_SECRETS_KEY` configurada no servidor. `false` => não dá para salvar senha/apikey (PUT responde 503 `SECRETS_KEY_MISSING`). */
  secretsKeyConfigured: boolean
  /** `true` = segredos salvos decifram; `false` = algum NÃO decifra (chave trocada/perdida: canal desligado até salvar o segredo de novo); `null` = não há segredo salvo no banco. */
  secretsDecryptable: boolean | null
  /** Informativo: o deploy liberou destinos de rede privada (`COMMUNICATION_ALLOW_PRIVATE_HOSTS`). Não é editável pelo painel. */
  privateHostsAllowed: boolean
  /** Problemas de configuração em PT-BR, sem segredo (ex.: "e-mail ligado no painel, mas sem destinatário válido"). Mostrar como alerta na tela. */
  warnings: string[]
  /** `null` se nada foi salvo ainda. */
  updatedAt: string | null
}

/** `PUT /api/admin/communication-settings`. Campo ausente = "não mexer". `strict`: campo desconhecido é 400. */
export interface UpdateCommunicationSettingsRequest {
  email?: {
    /** Liga/desliga o canal (o painel manda: `false` desliga mesmo que a env o configure). A 1ª gravação do grupo, sem `enabled`, nasce DESLIGADA. */
    enabled?: boolean
    /** Só o endereço (nome ou IP): sem `http://`, sem porta, sem caminho. */
    host?: string
    port?: number // 1..65535
    secure?: boolean
    /** `null` limpa. */
    user?: string | null
    /** SENHA nova (troca). Para apagar a salva use `clearSecrets`. */
    password?: string
    fromName?: string | null // máx. 80
    fromAddress?: string
    recipients?: string[] // até 10 e-mails; REPLACE (a lista inteira)
    minSeverity?: NotificationSeverity
  }
  whatsapp?: {
    enabled?: boolean
    baseUrl?: string // URL da Evolution API (https em produção)
    instance?: string // letras, números, ponto, hífen e sublinhado
    /** apikey nova (troca). */
    apiKey?: string
    apiVersion?: 1 | 2
    /** Até 10 números (aceita "+55 (11) 99999-9999"; o backend normaliza para só dígitos com DDI); REPLACE. */
    recipients?: string[]
    minSeverity?: NotificationSeverity
  }
  alerts?: {
    /** 1..1440; `null` volta ao padrão da env (30). */
    dedupeMinutes?: number | null
  }
  /** Apaga um segredo salvo. */
  clearSecrets?: Array<'smtpPassword' | 'evolutionApiKey'>
  /** OBRIGATÓRIA: a senha ATUAL do ADMIN logado (step-up). Nunca vai para log/auditoria. */
  currentPassword: string
}
// Pelo menos UM entre email / whatsapp / alerts / clearSecrets; grupo vazio (`email: {}`) é 400.

export type TestChannelErrorCode =
  | 'DESTINATION_BLOCKED' // endereço aponta para rede interna/reservada
  | 'SMTP_AUTH_FAILED'
  | 'SMTP_CONNECTION_FAILED'
  | 'SMTP_TLS_REQUIRED'
  | 'SMTP_REJECTED'
  | 'WHATSAPP_AUTH_FAILED' // 401/403: apikey errada
  | 'WHATSAPP_INSTANCE_OR_URL_NOT_FOUND' // 404
  | 'WHATSAPP_REJECTED' // outro 4xx (número, versão da API)
  | 'WHATSAPP_REDIRECT' // a URL redireciona (não seguimos)
  | 'WHATSAPP_PROVIDER_ERROR' // 5xx
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'INVALID_CONFIGURATION' // falta destinatário, host, remetente, segredo ilegível...

/** `POST .../test-email` — corpo opcional. Sem `config`, testa a config SALVA (painel > env). */
export interface TestEmailRequest {
  /** Destinatário do teste; padrão: o 1º destinatário de alertas salvo. */
  to?: string
  /** Config AINDA NÃO SALVA para testar (não persiste nada). Mesmos nomes do PUT. */
  config?: { host?: string; port?: number; secure?: boolean; user?: string | null; password?: string; fromName?: string | null; fromAddress?: string }
}

/** `POST .../test-whatsapp` */
export interface TestWhatsappRequest {
  /** Número do teste (só dígitos com DDI); padrão: o 1º destinatário salvo. */
  to?: string
  config?: { baseUrl?: string; instance?: string; apiKey?: string; apiVersion?: 1 | 2 }
}

/** Resposta dos dois testes. SEMPRE `200`: erro do provedor é o RESULTADO do teste (`ok: false`), não erro da rota. */
export interface TestChannelResult {
  channel: 'email' | 'whatsapp'
  ok: boolean
  testedAt: string
  durationMs: number
  /** Destinatário MASCARADO (`d***@dominio.com`, `5511*****9999`); `null` se não chegou a escolher. */
  to: string | null
  error: { code: TestChannelErrorCode; message: string } | null
}

/**
 * `POST /api/admin/communication-settings/test-smtp-connection` — corpo OPCIONAL `{ config?: { host?, port?, secure?, user?, password?, fromName?, fromAddress? } }` (os mesmos nomes do
 * `test-email`, mas SEM `to`: nenhum e-mail é enviado). Sem `config`, testa a config SALVA (painel > env). Campo desconhecido = 400 `VALIDATION_ERROR`.
 * Faz só o handshake: conecta, negocia TLS e autentica (`verify()` do transporte) e fecha. Prazo de ~5 s por etapa.
 */
export interface TestSmtpConnectionRequest {
  config?: { host?: string; port?: number; secure?: boolean; user?: string | null; password?: string; fromName?: string | null; fromAddress?: string }
}

/** Etapa em que o handshake PAROU (`OK` = passou por tudo). */
export type SmtpConnectionStage = 'CONNECT' | 'TLS' | 'AUTH' | 'OK'

/**
 * Resposta do `test-smtp-connection`. SEMPRE `200` (erro do servidor SMTP é o RESULTADO, não erro da rota; 400 só para `SECRET_REQUIRED_FOR_NEW_DESTINATION`, 429 e 503 de leitura).
 * `code` reaproveita `TestChannelErrorCode`: `DESTINATION_BLOCKED` / `SMTP_CONNECTION_FAILED` / `INVALID_CONFIGURATION` => `stage: 'CONNECT'`; `SMTP_TLS_REQUIRED` => `'TLS'`;
 * `SMTP_AUTH_FAILED` => `'AUTH'`. Nunca traz o texto cru do servidor, senha, usuário nem host.
 */
export interface TestSmtpConnectionResult {
  ok: boolean
  stage: SmtpConnectionStage
  code: TestChannelErrorCode | null
  /** Texto fixo em PT-BR escrito por nós, pronto para exibir; `null` quando `ok`. */
  message: string | null
  /** `true` = o login com usuário e senha foi feito e aceito; `false` = o servidor foi usado sem autenticar (nada configurado) ou o login falhou. */
  authenticated: boolean
  testedAt: string
  durationMs: number
}

export type DnsRecordStatus = 'OK' | 'ATENCAO' | 'AUSENTE' | 'ERRO'

/** Um registro verificado. `ERRO` = a CONSULTA falhou (DNS fora/lento); não quer dizer que o registro esteja errado. */
export interface DnsRecordCheck {
  status: DnsRecordStatus
  /** Nome DNS consultado (ex.: `_dmarc.empresa.com.br`); `null` = não consultado (DKIM sem seletor). */
  nomeConsultado: string | null
  /** O TXT público encontrado, truncado em 300 caracteres (+ "…"); `null` quando não há. */
  valorEncontrado: string | null
  /** Texto em PT-BR simples, pronto para exibir, dizendo o que está bom ou o que fazer. */
  recomendacao: string
}

/** O que cadastrar no DNS. SPF e DKIM NÃO têm `valorSugerido` de propósito: o valor exato depende do provedor SMTP (peça a ele). Só o DMARC traz um exemplo seguro (p=none: só monitora). */
export interface DnsInstruction {
  /** Nome (host) do registro. No DKIM sem seletor vem como `<seletor>._domainkey.<domínio>`. */
  nome: string
  tipo: 'TXT' | 'TXT ou CNAME'
  valorSugerido: string | null
  texto: string
}

/**
 * `GET /api/admin/communication-settings/domain-check?selector=<seletor DKIM, opcional>` -> 200 (nunca 500 por falha de DNS). `Cache-Control: no-store`.
 * O domínio é o do e-mail remetente JÁ CONFIGURADO (painel > env) — a tela NÃO envia domínio (query desconhecida = 400). `selector`: letras, dígitos e hífen, 1 a 63 (senão 400
 * `VALIDATION_ERROR`, `details: [{ path: 'selector', message }]`); vazio = não informado. Só lê TXT públicos; não configura nada (é DNS do domínio, fora do InnoFlow).
 */
export interface DomainCheckResponse {
  /** `false` = não há e-mail remetente configurado (ou o domínio dele não é público): NADA foi consultado e `spf/dkim/dmarc/instructions` vêm `null` — mostrar o aviso de `warnings`. */
  senderConfigured: boolean
  domain: string | null
  /** Nome amigável do provedor SMTP reconhecido pelo host (ex.: "Google (Gmail / Workspace)"); `null` = não reconhecido. */
  smtpProvider: string | null
  /** Pior resultado entre SPF, DMARC e (se houve seletor) DKIM: ERRO > AUSENTE > ATENCAO > OK. `null` quando nada foi consultado. */
  overallStatus: DnsRecordStatus | null
  spf: DnsRecordCheck | null
  /** Sem `selector`: `status: 'ATENCAO'`, `nomeConsultado: null` e a recomendação explica o que é o seletor (não conta no `overallStatus`). */
  dkim: DnsRecordCheck | null
  /** Se o próprio nome não tem DMARC mas o domínio principal tem, o resultado é o do principal (`nomeConsultado` mostra qual; a recomendação diz "herdado"). */
  dmarc: DnsRecordCheck | null
  /** Avisos gerais em PT-BR (e-mail gratuito tipo @gmail.com, provedor não reconhecido, falta remetente). */
  warnings: string[]
  instructions: { spf: DnsInstruction; dkim: DnsInstruction; dmarc: DnsInstruction } | null
  /** Aviso fixo: isto é configurado no DNS do domínio (Registro.br, Cloudflare...), não aqui; a mudança leva de minutos a horas. Exibir junto. */
  note: string
  checkedAt: string
}

export type CommunicationSettingsErrorCode =
  | 'VALIDATION_ERROR' // 400 (details: [{ path, message }])
  | 'INVALID_CURRENT_PASSWORD' // 403 — step-up
  | 'RATE_LIMITED_PAYMENT_GATEWAY' // 429 — tentativas ERRADAS de senha demais (mesmo código/balde do gateway), header Retry-After
  | 'RATE_LIMITED_COMMUNICATION_SETTINGS' // 429 — limite por minuto do PUT/testes/verificador de DNS
  | 'STEPUP_UNAVAILABLE' // 503 — Redis do step-up fora (fail-closed): nada foi gravado
  | 'SECRETS_KEY_MISSING' // 503 — servidor sem PAYMENT_SECRETS_KEY: não dá para guardar senha/apikey
  | 'COMMUNICATION_SETTINGS_UNAVAILABLE' // 503 — não deu para ler a config no banco (só GET/testes)
  | 'DESTINATION_NOT_ALLOWED' // 400 — details: [{ field: 'email.host' | 'whatsapp.baseUrl', reason: 'LOOPBACK' | 'REDE_PRIVADA' | 'NOME_INTERNO' | 'ENDERECO_DE_METADADOS' | 'ENDERECO_NAO_ROTEAVEL' | 'HOST_INVALIDO' | 'HTTPS_REQUIRED' | 'INVALID_URL' }]
  | 'SECRET_REQUIRED_FOR_NEW_DESTINATION' // 400 — trocar host/usuário SMTP ou URL/instância da Evolution exige reenviar a senha/apikey (details: [{ field: 'email.password' | 'whatsapp.apiKey' | 'config.password' | 'config.apiKey' }])
  | 'CHANNEL_INCOMPLETE' // 409 — não dá para LIGAR o canal: details: [{ channel: 'email' | 'whatsapp', problems: string[] }]; nada foi gravado
```

## Comportamentos que a tela precisa respeitar

1. **Ordem de erros do PUT:** 400 validação → 403/429/503 step-up → regras de negócio (400 destino proibido / 400 segredo obrigatório / 409 canal incompleto / 503 sem chave de cifragem). Nada é gravado em nenhum erro.
2. **Segredo:** a tela nunca recebe senha/apikey. Mostrar "Senha configurada" (`passwordSet`) e, na apikey, `apiKeyHint` ("…a1b2"). Campo vazio no formulário = "não mexer" (não enviar a chave `password`/`apiKey`). Para apagar: `clearSecrets`.
3. **Trocar o destino de um segredo:** se o admin troca `host`/`user` do SMTP ou `baseUrl`/`instance` da Evolution e há segredo salvo, a tela **precisa pedir o segredo de novo** (senão o backend responde `400 SECRET_REQUIRED_FOR_NEW_DESTINATION`). Vale também para os testes com `config`.
4. **Ligar um canal:** a 1ª gravação de um grupo nasce `enabled: false`. Para ligar, `enabled: true` com host + remetente (e-mail; **destinatários de alerta são opcionais desde a L1.6** — sem eles o canal fica ativo só para o e-mail transacional ao motorista, os alertas ao dono por e-mail não são enviados e `warnings` avisa) / URL + instância + apikey + ao menos um número (WhatsApp); senão `409 CHANNEL_INCOMPLETE` com a lista de pendências. O padrão de severidade é e-mail `IMPORTANTE`, WhatsApp `CRITICO`.
5. **Testar antes de salvar:** `test-email`/`test-whatsapp` aceitam `config` com os valores digitados e ainda não salvos; não persistem nada. O resultado traz `ok` e, se falhou, `error.code` + `error.message` (PT-BR, pronto para exibir).
6. **Rede interna:** em produção, host SMTP/URL da Evolution que apontam para rede interna/loopback/metadados são recusados (`DESTINATION_NOT_ALLOWED`); `https` é obrigatório (exceto `privateHostsAllowed`, liberado pelo deploy). Use o endereço PÚBLICO do serviço.
7. **Quando vale:** a API enxerga a mudança na hora; worker e gateway OCPP em até ~35 s (cache de 30 s + 5 s do notificador). Avisar na tela ("a mudança vale para todos os serviços em até 1 minuto").
8. **Auditoria:** cada PUT gera UMA linha em `AuditLog` (`action: 'UPDATE'`, `entityType: 'NotificationChannelConfig'`, `actionDetail: 'communication_settings'`), com antes/depois dos campos não secretos, segredos só como `{ changed: true }` e destinatários só como contagem. Cada teste gera uma linha `OTHER` (`test_email:ok|<código>`). Quem altera a config também dispara o alerta `communication_config_changed` (IMPORTANTE), enviado pela configuração ANTERIOR.
9. **Teste de conexão (sem enviar e-mail):** `test-smtp-connection` é o botão "Testar conexão" (o `test-email` continua sendo "Enviar e-mail de teste"). Mostre a etapa em que parou (`stage`: Conectar → Segurança (TLS) → Login → OK) e a `message`. `authenticated: false` com `ok: true` significa "conectou, mas sem login" (usuário/senha não configurados). Nunca existe dica da senha (o DTO só tem `passwordSet`). Vale a regra 3 (trocar host/usuário exige reenviar a senha) e a regra 5 (aceita `config` não salva).
10. **Verificador de DNS:** a tela mostra o diagnóstico e as instruções, **não** configura nada (SPF/DKIM/DMARC são registros no DNS do domínio, onde ele foi registrado). Não existe campo "domínio": ele sai do e-mail remetente salvo (se o admin acabou de digitar outro remetente, salvar antes de verificar). O seletor DKIM é opcional (o provedor SMTP informa ao ativar o DKIM); sem ele o DKIM aparece como "ATENCAO — informe o seletor". Para SPF e DKIM a tela **não deve inventar valor**: use `instructions.*.texto` ("peça ao provedor"); só o DMARC tem `valorSugerido` pronto para copiar. Depois de alterar o DNS a propagação leva de minutos a horas: o botão "Verificar de novo" é limitado a 6 por minuto (`429 RATE_LIMITED_COMMUNICATION_SETTINGS`). `ERRO` num registro = a consulta falhou, pedir para tentar de novo (não é "registro errado").
11. **Auditoria dos novos:** `test-smtp-connection` gera uma linha `OTHER` com `actionDetail: 'test_smtp_connection:ok|<código>'` (sem corpo, sem segredo). O verificador de DNS é leitura e não gera auditoria.

## Exemplos

`PUT` mínimo para ligar o e-mail:

```json
{
  "currentPassword": "<senha do admin>",
  "email": {
    "enabled": true,
    "host": "smtp.seudominio.com.br",
    "port": 587,
    "secure": false,
    "user": "alertas@seudominio.com.br",
    "password": "<senha SMTP>",
    "fromName": "InnoFlow",
    "fromAddress": "alertas@seudominio.com.br",
    "recipients": ["dono@seudominio.com.br"]
  }
}
```

`PUT` para ligar o WhatsApp (Evolution):

```json
{
  "currentPassword": "<senha do admin>",
  "whatsapp": {
    "enabled": true,
    "baseUrl": "https://evolution.seudominio.com.br",
    "instance": "innoflow",
    "apiKey": "<apikey da Evolution>",
    "apiVersion": 2,
    "recipients": ["5511999999999"]
  }
}
```

Resposta de teste com falha:

```json
{ "channel": "whatsapp", "ok": false, "testedAt": "2026-10-05T15:00:00.000Z", "durationMs": 312, "to": "5511*****9999",
  "error": { "code": "WHATSAPP_AUTH_FAILED", "message": "A Evolution API recusou a apikey. Confira a chave (global ou da instância)." } }
```
