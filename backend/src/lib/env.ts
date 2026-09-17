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
