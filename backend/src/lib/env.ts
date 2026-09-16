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
