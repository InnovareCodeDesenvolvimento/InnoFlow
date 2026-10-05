import { z } from 'zod'
import { paginationQuerySchema } from './pagination.schema'

/**
 * Contrato literal em `docs/CONTRATO-BACKUP-ADMIN.md`. `.strict()` em todos os níveis: campo desconhecido é 400 (nada de ignorar um typo em silêncio). Campo ausente = "não mexer";
 * `null` explícito (onde permitido) = "limpar". SEGREDOS são só-escrita: entram aqui e NUNCA voltam em nenhuma resposta. As regras que dependem do ambiente/estado salvo (SSRF,
 * destino completo, chave existente) são do serviço.
 */

const temCaractereDeControle = (v: string): boolean => [...v].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)
const textoSemControle = (max: number) => z.string().trim().min(1).max(max).refine((v) => !temCaractereDeControle(v), 'Não pode conter caracteres de controle.')

const s3Schema = z
  .object({
    /** URL do endpoint (https em produção). Ex.: https://s3.us-east-1.amazonaws.com, https://<conta>.r2.cloudflarestorage.com */
    endpoint: z.string().trim().min(1).max(300).optional(),
    region: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9-]{1,40}$/, 'Região inválida (ex.: us-east-1, auto).')
      .nullable()
      .optional(),
    bucket: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$/, 'Nome de bucket inválido.')
      .optional(),
    /** Pasta dentro do bucket (opcional). Barras nas pontas e `..` são descartados. */
    prefix: z
      .string()
      .trim()
      .max(200)
      .regex(/^[A-Za-z0-9._\-/ ]*$/, 'O prefixo só aceita letras, números, ponto, hífen, sublinhado, espaço e barra.')
      .nullable()
      .optional(),
    accessKey: textoSemControle(256).optional(),
    secretKey: textoSemControle(512).optional(),
  })
  .strict()

const driveSchema = z
  .object({
    clientId: z.string().trim().min(1).max(300).nullable().optional(),
    clientSecret: textoSemControle(512).optional(),
  })
  .strict()

export const updateBackupConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    hourLocal: z.number().int().min(0).max(23).optional(),
    frequencyDays: z.union([z.literal(1), z.literal(2), z.literal(7)]).optional(),
    retentionCount: z.number().int().min(1).max(365).optional(),
    /** Mínimo de 6 h: limite curto transforma o alerta em barulho diário, e alerta barulhento é silenciado. */
    alertAfterHours: z.number().int().min(6).max(720).optional(),
    destination: z.enum(['S3', 'DRIVE']).nullable().optional(),
    s3: s3Schema.optional(),
    drive: driveSchema.optional(),
    /** Apaga um segredo salvo. Para TROCAR, mande o valor novo no campo próprio. */
    clearSecrets: z.array(z.enum(['s3AccessKey', 's3SecretKey', 'driveClientSecret'])).max(3).optional(),
    /** Step-up: a senha ATUAL do ADMIN logado. Obrigatória exceto quando o PUT só mexe em horário/frequência/alerta ou DESLIGA o automático (a rota extrai e descarta do corpo). */
    currentPassword: z.string().min(1).max(200).optional(),
  })
  .strict()

export type UpdateBackupConfigInput = z.infer<typeof updateBackupConfigSchema>
/** O corpo sem a senha (a rota a retira de `req.body` antes de entregar ao serviço). */
export type UpdateBackupConfigBody = Omit<UpdateBackupConfigInput, 'currentPassword'>

export const generateBackupKeySchema = z
  .object({
    /** Trocar uma chave que já existe exige `replace: true` E a frase `confirmation` = "GERAR NOVA CHAVE" (perder a antiga é definitivo). */
    replace: z.boolean().optional(),
    confirmation: z.string().max(40).optional(),
    /** Impressão digital da chave que a tela viu: se já mudou (outra pessoa gerou), 409 BACKUP_KEY_CHANGED em vez de trocar uma chave que a pessoa não viu. */
    expectedFingerprint: z
      .string()
      .regex(/^[0-9a-f]{8}$/)
      .nullable()
      .optional(),
    currentPassword: z.string().min(1, 'Informe a senha atual.').max(200),
  })
  .strict()
export type GenerateBackupKeyInput = z.infer<typeof generateBackupKeySchema>

export const stepUpOnlySchema = z.object({ currentPassword: z.string().min(1, 'Informe a senha atual.').max(200) }).strict()
export type StepUpOnlyInput = z.infer<typeof stepUpOnlySchema>

export const emptyBodySchema = z.object({}).strict()

export const listBackupRunsQuerySchema = paginationQuerySchema.extend({
  trigger: z.enum(['SCHEDULED', 'MANUAL', 'VERIFY']).optional(),
  status: z.enum(['QUEUED', 'RUNNING', 'SUCCESS', 'FAILED']).optional(),
})
export type ListBackupRunsQuery = z.infer<typeof listBackupRunsQuerySchema>

export const backupRunParamsSchema = z.object({ id: z.string().cuid() })
