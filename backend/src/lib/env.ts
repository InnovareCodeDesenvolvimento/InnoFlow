import { z } from 'zod'
import { envBoolean } from './envBoolean'

/**
 * Validação de variáveis de ambiente — falha rápido no boot em vez de
 * quebrar em produção na primeira query/conexão que precisar delas.
 *
 * Cada entrypoint (api.ts/ocpp.ts/worker.ts) só usa o subconjunto que
 * precisa, mas validamos tudo de uma vez: mais simples que 3 schemas
 * parciais, e um `.env` incompleto aparece cedo, não só quando o processo
 * errado sobe.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.string().default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL é obrigatório'),
  REDIS_URL: z.string().min(1, 'REDIS_URL é obrigatório'),

  PORT: z.coerce.number().int().positive().default(3000),
  OCPP_PORT: z.coerce.number().int().positive().default(9000),

  // Auth da API REST (JWT). Sem default de propósito — segredo fraco/ausente
  // em produção não pode passar despercebido; falha o boot.
  JWT_SECRET: z.string().min(16, 'JWT_SECRET é obrigatório e precisa ter pelo menos 16 caracteres'),
  JWT_EXPIRES_IN: z.string().default('12h'),

  // Identidade deste processo no barramento de comandos OCPP (Redis) e no
  // lock anti-split-brain (ocpp:conn:{chargePointId}). Default: um UUID novo
  // por processo — só precisa ser estável se algum dia quisermos afinidade
  // determinística entre réplicas (não é o caso agora).
  OCPP_NODE_ID: z.string().optional(),

  // Fuso padrão dos relatórios/dashboard administrativo (módulo de
  // retaguarda) quando o cliente não manda `?tz=` e a query não é escopada a
  // um único site (relatório "por eletroposto" usa Site.timezone). Tem
  // default de propósito — campo novo obrigatório sem default derrubaria os
  // 3 entrypoints no boot (ver bug-env-eager-todos-entrypoints.md).
  REPORTING_TIMEZONE: z.string().trim().min(1).default('America/Sao_Paulo'),

  // F4 (2026-09-17) — carteira pré-paga sem hold. Defaults de propósito
  // (mesma lição do bug-env-eager-todos-entrypoints.md): um campo novo
  // obrigatório sem default derrubaria os 3 entrypoints no boot, não só quem
  // de fato usa. Valor real de produção pode ser ajustado por env sem
  // redeploy de código.
  //
  // Saldo mínimo para AUTORIZAR o início de uma sessão — decisão do dono,
  // 2026-09-17: R$ 20,00.
  WALLET_MIN_START_BALANCE_CENTS: z.coerce.number().int().min(0).default(2000),
  // Clamp do teto de custo estimado (`calcularTetoReserva`) — usado só como
  // referência para a guarda ao vivo do MeterValues, NUNCA reservado/debitado
  // antecipadamente (ver decisão da Nova sobre a identidade de conciliação).
  RESERVA_PISO_CENTS: z.coerce.number().int().positive().default(5000),
  RESERVA_TETO_CENTS: z.coerce.number().int().positive().default(40000),

  // Achado da auditoria do Órion (2026-09-17, "importante"): `cors()` sem
  // args aceita QUALQUER origem. Allowlist explícita, separada por vírgula.
  // Default cobre só o dev local (Vite `5173`, `vite preview` `4173`) — em
  // produção o valor real (domínio `*.easypanel.host` do frontend) tem que
  // vir da env. Fail-CLOSED de propósito: esquecer de configurar em produção
  // derruba o frontend na hora (sintoma óbvio no navegador — erro de CORS no
  // console), o que é preferível a abrir silenciosamente para qualquer
  // origem.
  CORS_ALLOWED_ORIGINS: z
    .string()
    .default('http://localhost:5173,http://localhost:4173')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),

  // Rate limit do auth OCPP (achado "importante" do Órion) — mesmo espírito
  // do rate limit de login da API REST (`middleware/rateLimit.ts`): N
  // tentativas falhas por identidade/janela, contador em Redis (o gateway
  // roda em processo separado da API, precisa de estado compartilhado).
  OCPP_AUTH_RATE_LIMIT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  OCPP_AUTH_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(300),
  // Órion A1 (2026-09-19): o contador por identidade sozinho deixava um atacante TRAVAR o carregador
  // real (identidade é pública em `GET /api/sites`). Agora: `OCPP_AUTH_RATE_LIMIT_MAX_ATTEMPTS` vale
  // por (identidade + IP) e este é o limite GLOBAL de falhas por IP (cobre identidade inexistente).
  // Alto de propósito: um IP legítimo (frota atrás de NAT) quase não falha.
  OCPP_AUTH_IP_MAX_FAILURES: z.coerce.number().int().positive().default(30),
  // Tentativas de autenticação de um IP EM ANDAMENTO ao mesmo tempo (banco + bcrypt de cada uma). Separado
  // do limite de falhas de propósito: uma frota atrás de um mesmo NAT reconectando junta (restart do
  // gateway) tem dezenas de handshakes legítimos simultâneos e nenhuma falha. Dimensione para o maior
  // site atrás de um IP; acima disto o excedente leva 429 e o carregador tenta de novo no backoff. Custo:
  // uma rajada de tentativas que FALHAM pode produzir até este número de falhas de uma vez antes de o
  // bloqueio por falhas valer (ver `core/ocpp/authRateLimiter.ts`).
  OCPP_AUTH_IP_MAX_CONCURRENT: z.coerce.number().int().positive().default(100),
  // Quantos proxies reversos há entre o carregador e a porta do gateway (9000) — resolve o IP do
  // handshake a partir do X-Forwarded-For (mesma semântica de `TRUST_PROXY_HOPS` da API, mas o
  // caminho até a porta 9000 é OUTRO). Default 0 = confia só no endereço do socket (seguro se a
  // porta é exposta direto; o X-Forwarded-For seria forjável). Atrás de proxy, sem configurar, todos
  // os carregadores compartilham o IP do proxy — ver o log `[ocpp] auth` (clientIp/xForwardedFor)
  // para conferir o valor certo ANTES de confiar em hops > 0.
  OCPP_TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),

  // Achado da Nova (log de auditoria, 2026-09-17): `app.set('trust proxy')`
  // nunca existiu neste backend. Sem isto, `req.ip` em produção é sempre o
  // IP do container do proxy do EasyPanel (nginx do frontend -> rede interna
  // -> container da API) — o campo `ipAddress` do audit log nasceria sempre
  // igual (inútil) e o rate limit de login por IP conta a internet inteira
  // num balde só. Número de hops (não `true` cego).
  //
  // CORRIGIDO 19/09/2026 (evidência de produção): o default era 1 ("nginx do
  // frontend é o único proxy") e estava ERRADO — são 2 proxies entre o
  // cliente e o Express: o edge do EasyPanel e o nginx do frontend. Log real:
  // `x-forwarded-for: "179.104.42.35, 10.11.0.16"` + socket `10.11.0.16`, e o
  // audit log gravou `ipAddress: "10.11.0.16"` (IP do proxy, não do cliente)
  // — com isso o rate limit de login por IP continuava contando TODOS os
  // usuários num balde só. Reproduzido: hops=1 -> 10.11.0.16; hops=2 ->
  // 179.104.42.35 (e um cliente forjando X-Forwarded-For NÃO vira o IP dele).
  // Se a topologia mudar (CDN/LB novo na frente), reconfira com um log real
  // antes de mexer: hops a MAIS deixa o cliente forjar o próprio IP.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(2),

  // Log de auditoria (Nova, 2026-09-17) — teto de tamanho do diff gravado em
  // `AuditLog.changes` (allowlist por entidade, nunca payload cru). Acima
  // disso grava só `{ truncated: true }` em vez do diff.
  AUDIT_LOG_CHANGES_MAX_BYTES: z.coerce.number().int().positive().default(8192),

  // Canal SSE (tempo real) — intervalo de heartbeat (`:ping`) para o nginx
  // não cortar a conexão por inatividade (janela de proxy é bem maior, mas
  // não vale deixar a conexão muda por tanto tempo) e throttle mínimo do
  // evento `dashboard.dirty` (nunca recalcula agregado por evento — só
  // invalida a query no máximo nesta cadência).
  // Login/cadastro de motorista com Google (2026-09-19). OPCIONAL: sem ele o
  // login com Google fica desligado (`GET /api/public/config` devolve `null`,
  // `POST /api/auth/google` responde 503 `GOOGLE_NOT_CONFIGURED`). O client ID
  // é PÚBLICO por desenho do Google — mora aqui (não no build do frontend)
  // para dar pra ligar/desligar sem rebuild. `preprocess` transforma string
  // vazia em `undefined`: o EasyPanel guarda uma env "em branco" como `""`, e
  // `.min(1)` puro derrubaria o boot dos 3 entrypoints por causa de uma
  // feature opcional (mesma lição de bug-env-eager-todos-entrypoints.md).
  GOOGLE_CLIENT_ID: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().min(1).optional()),

  // F5.1 (30/09/2026) — cliente Cielo (gateway de pagamento real, ver
  // .claude/agent-memory/nova/decisoes-f5-pagamento-cielo.md). Credenciais
  // OPCIONAIS de propósito (mesma lição de bug-env-eager-todos-entrypoints.md):
  // sem elas, o `CieloAdapter` falha ao ser CONSTRUÍDO/USADO (erro explícito
  // no ponto de uso), não no boot dos 3 entrypoints — a F5.1 não pluga isto
  // em nenhuma rota ainda. Hosts default apontam para o SANDBOX oficial da
  // Cielo (API 3.0); produção troca só a env, sem rebuild.
  CIELO_MERCHANT_ID: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().min(1).optional()),
  CIELO_MERCHANT_KEY: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().min(1).optional()),
  CIELO_API_BASE_URL: z.string().trim().min(1).default('https://apisandbox.cieloecommerce.cielo.com.br'),
  CIELO_API_QUERY_BASE_URL: z.string().trim().min(1).default('https://apiquerysandbox.cieloecommerce.cielo.com.br'),
  // `envBoolean`, NÃO `z.coerce.boolean()` — este tratava "false"/"0" como true (ver `envBoolean.ts`).
  // Default `true` (sandbox) de propósito: esquecer a env nunca aponta para produção.
  CIELO_SANDBOX: envBoolean(true),
  // Opt-in EXPLÍCITO para usar o `FakeAdapter` em produção (default false). O Fake aprova QUALQUER cartão e não
  // cobra nada — sem esta env, produção sem `CIELO_MERCHANT_ID`/`CIELO_MERCHANT_KEY` bloqueia Pix/cartão (503).
  // Ver `core/pagamentos/decidirAdaptador.ts`. Só ligue para demonstrar o fluxo sabendo que NADA é cobrado.
  PAYMENT_ALLOW_FAKE_ADAPTER: envBoolean(false),
  // F5.3 (30/09/2026) — sessão de tokenização de cartão (Silent Order Post,
  // D1 do dono: cartão salvo, SAQ A-EP). Substitui `CIELO_SOP_POST_URL` da
  // F5.1 (nunca chegou a ser configurada/usada): o contrato real que o
  // frontend consome (`MeCardTokenizationSessionResponse`) pede `scriptUrl`
  // (a página isolada da Lyra carrega o script da Cielo, não faz POST de
  // formulário pelo nosso backend) + um `accessToken` de sessão. Nenhuma das
  // 4 envs abaixo foi confirmada contra doc/sandbox real (sem credencial) —
  // `CieloAdapter.sessaoTokenizacao()` lança erro claro se faltar alguma, em
  // vez de inventar URL/mecanismo. `sopClientId`/`sopClientSecret` espelham
  // o par que o Cronos já previu em `PaymentGatewayConfig` (OAuth
  // client_credentials — ver `services/pagamentos/cieloSopOAuth.ts`).
  CIELO_SOP_SCRIPT_URL: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().url().optional()),
  CIELO_SOP_CLIENT_ID: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().min(1).optional()),
  CIELO_SOP_CLIENT_SECRET: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().min(1).optional()),
  CIELO_SOP_OAUTH_TOKEN_URL: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().url().optional()),
  // Timeout de chamada — curto de propósito: o motorista está esperando num
  // HTTP síncrono (`POST /api/me/sessions/start`, decisão #2 da Nova), não
  // faz sentido segurá-lo por dezenas de segundos. Timeout NÃO deve disparar
  // retry cego — a API 3.0 da Cielo não tem chave de idempotência; o
  // caminho certo é reconsultar por `MerchantOrderId` (ver `PagamentoPort`).
  CIELO_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),

  // F5.2 (30/09/2026) — recarga de carteira via Pix real. Expiração do QR:
  // Nova recomendou 30 min (NÃO o default de 86400s/24h da própria Cielo) —
  // ver decisoes-f5-pagamento-cielo.md. Configurável por env sem redeploy.
  PIX_TOPUP_EXPIRES_MINUTES: z.coerce.number().int().positive().default(30),
  // Quantas recargas Pix PENDING um motorista pode ter em aberto ao mesmo
  // tempo — 1 por padrão (gerar um novo Pix enquanto o anterior ainda pode
  // ser pago seria confuso: qual QR o motorista deveria pagar?).
  TOPUP_PIX_MAX_PENDING_PER_USER: z.coerce.number().int().positive().default(1),
  // Cadência do varredor de expiração (BullMQ repeatable, `worker/jobs/
  // expirarTopupsPixJob.ts`) — reconsulta a Cielo ANTES de marcar EXPIRED
  // (decisão da tarefa: pagamento que chega depois do prazo do QR ainda
  // credita, o dinheiro entrou e não dá pra recusar).
  TOPUP_PIX_EXPIRY_SCAN_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),

  // Webhook da Cielo (`POST /api/webhooks/cielo/:pathToken`, público, sem
  // JWT — F5.2). OPCIONAIS com default GERADO por processo (mesmo padrão de
  // `OCPP_NODE_ID` já usado neste projeto: `env.X || randomUUID()` no ponto
  // de uso, não aqui) — sem configurar em produção, o segredo vira um UUID
  // novo a cada boot, o que na prática significa "ninguém de fora consegue
  // chamar esta rota até alguém configurar de verdade" (fail-CLOSED por
  // desenho, mesmo espírito de CORS_ALLOWED_ORIGINS). `pathToken` é só
  // ROTEAMENTO (comparado por igualdade simples); `webhookHeaderSecret` é o
  // segredo de verdade (comparado em tempo constante, ver
  // `core/pagamentos/verificarSegredoWebhook.ts`).
  CIELO_WEBHOOK_PATH_TOKEN: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().min(8).optional()),
  CIELO_WEBHOOK_HEADER_SECRET: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().min(8).optional()),

  // F5.3 (30/09/2026) — chave de cifragem AES-256-GCM dos segredos de
  // pagamento (`PaymentMethod.cieloCardTokenCiphertext` agora; depois
  // `PaymentGatewayConfig.*Ciphertext`, F5.5 — ver `lib/crypto/paymentSecrets.ts`
  // e o comentário do model `PaymentGatewayConfig` no `schema.prisma`,
  // Cronos). A chave NUNCA vive no banco. OPCIONAL/sem default de propósito
  // (mesma lição de bug-env-eager-todos-entrypoints.md): ausente não derruba
  // o boot dos 3 entrypoints — só quem tenta cifrar/decifrar (cadastro de
  // cartão) falha, com erro claro. Gerar com `openssl rand -base64 32`
  // (precisa decodificar para exatos 32 bytes — AES-256).
  PAYMENT_SECRETS_KEY: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().min(1).optional()),

  // F5.4 (30/09/2026) — sessão de recarga cobrando de cartão (pré-auth +
  // captura parcial via PaymentIntent). Cadência do varredor de
  // pré-autorizações (`worker/jobs/varrerPreAutorizacoesCartaoJob.ts`) — mesmo
  // padrão/default de `TOPUP_PIX_EXPIRY_SCAN_INTERVAL_MS`.
  CARD_PREAUTH_SCAN_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  // Quanto tempo uma pré-autorização AUTHORIZED pode ficar sem `StartTransaction`
  // vinculado antes do varredor cancelá-la (VOIDED) — decisão do dono,
  // 2026-09-17, documentada em decisoes-f5-pagamento-cielo.md (mesma premissa
  // de "sessão longa típica" usada em `calcularTetoReserva`). Também usado
  // como o primeiro horizonte de desistência de um intent `CREATED` que nunca
  // recebeu resposta da Cielo (reconsultado antes; ver `varrerPreAutorizacoesCartao.ts`).
  CARD_PREAUTH_ABANDON_MINUTES: z.coerce.number().int().positive().default(5),

  SSE_HEARTBEAT_INTERVAL_SECONDS: z.coerce.number().int().positive().default(25),
  // Teto de streams SSE simultâneos (Órion A2). Por usuário EXPULSA o mais antigo (não tranca quem
  // trocou de rede); por IP e total REJEITAM o novo. Ver `core/realtime/streamLimiter.ts`.
  SSE_MAX_STREAMS_PER_USER: z.coerce.number().int().positive().default(5),
  SSE_MAX_STREAMS_PER_IP: z.coerce.number().int().positive().default(50),
  SSE_MAX_STREAMS_TOTAL: z.coerce.number().int().positive().default(2000),
  DASHBOARD_DIRTY_THROTTLE_MS: z.coerce.number().int().positive().default(5000),
})

export type Env = z.infer<typeof envSchema>

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env)
  if (!parsed.success) {
    console.error('[env] configuração inválida:', parsed.error.flatten().fieldErrors)
    process.exit(1)
  }
  // Órion: JWT_SECRET assina TODAS as sessões (HS256) — abaixo de 32 caracteres é fraco demais para
  // um segredo de assinatura. Só AVISO, de propósito: o schema continua aceitando >= 16 (um boot
  // derrubado por um segredo que já está em produção seria pior que o aviso). Gere um novo com
  // `openssl rand -base64 48` e troque quando puder — trocar o segredo derruba todas as sessões.
  if (parsed.data.JWT_SECRET.length < 32) {
    console.warn(`[env] AVISO: JWT_SECRET tem ${parsed.data.JWT_SECRET.length} caracteres — recomendado >= 32 (openssl rand -base64 48). Trocar derruba as sessões abertas.`)
  }
  return parsed.data
}

export const env = loadEnv()
