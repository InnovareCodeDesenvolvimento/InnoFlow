import { z } from 'zod'

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

  SSE_HEARTBEAT_INTERVAL_SECONDS: z.coerce.number().int().positive().default(25),
  DASHBOARD_DIRTY_THROTTLE_MS: z.coerce.number().int().positive().default(5000),
})

export type Env = z.infer<typeof envSchema>

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env)
  if (!parsed.success) {
    console.error('[env] configuração inválida:', parsed.error.flatten().fieldErrors)
    process.exit(1)
  }
  return parsed.data
}

export const env = loadEnv()
