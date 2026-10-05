import { isIP } from 'node:net'
import { z } from 'zod'

/**
 * `PUT /api/admin/communication-settings` e `POST .../test-email|test-whatsapp` — contrato literal em `docs/CONTRATO-COMUNICACAO-ADMIN.md`.
 * Campo ausente = "não mexer". `.strict()` em todos os níveis: campo desconhecido é 400 (nada de ignorar um typo em silêncio). Segredos só passam por `trim()` das bordas.
 * `null` explícito (onde permitido) = "limpar o campo". As regras de destino (SSRF, https) são do serviço — dependem do ambiente e do que já está salvo.
 */

const severidade = z.enum(['INFO', 'IMPORTANTE', 'CRITICO'])
const emailTexto = z.string().trim().toLowerCase().email().max(254)
/** Host puro (nome ou IP), sem esquema, porta, caminho nem credencial. IPv6 entra sem colchetes. */
const hostSmtp = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9.:_-]+$/, 'Informe só o endereço do servidor (sem http://, porta ou caminho).')
  // `:` só faz sentido num IPv6 literal; `smtp.exemplo.com:587` é host com porta (a porta tem campo próprio).
  .refine((v) => !v.includes(':') || isIP(v) === 6, 'Informe só o endereço do servidor (a porta tem campo próprio).')
const nomeInstancia = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/, 'A instância só aceita letras, números, ponto, hífen e sublinhado.')

const emailSchema = z
  .object({
    enabled: z.boolean().optional(),
    host: hostSmtp.optional(),
    port: z.number().int().min(1).max(65535).optional(),
    secure: z.boolean().optional(),
    user: z.string().trim().min(1).max(254).nullable().optional(),
    password: z.string().min(1).max(512).optional(),
    fromName: z.string().trim().min(1).max(80).nullable().optional(),
    fromAddress: emailTexto.optional(),
    recipients: z.array(emailTexto).max(10).optional(),
    minSeverity: severidade.optional(),
  })
  .strict()

const whatsappSchema = z
  .object({
    enabled: z.boolean().optional(),
    baseUrl: z.string().trim().url().max(300).optional(),
    instance: nomeInstancia.optional(),
    apiKey: z.string().min(1).max(512).optional(),
    apiVersion: z.union([z.literal(1), z.literal(2)]).optional(),
    recipients: z.array(z.string().trim().min(8).max(25)).max(10).optional(),
    minSeverity: severidade.optional(),
  })
  .strict()

const alertasSchema = z.object({ dedupeMinutes: z.number().int().min(1).max(1440).nullable().optional() }).strict()

export const updateCommunicationSettingsSchema = z
  .object({
    email: emailSchema.optional(),
    whatsapp: whatsappSchema.optional(),
    alerts: alertasSchema.optional(),
    /** Apaga um segredo salvo (a senha SMTP / a apikey). Para TROCAR, mande o valor novo em `password`/`apiKey`. */
    clearSecrets: z.array(z.enum(['smtpPassword', 'evolutionApiKey'])).max(2).optional(),
    // Step-up (mesmo mecanismo do gateway): a senha ATUAL do ADMIN logado, obrigatória em todo PUT. Sem trim; a rota a extrai e descarta do corpo.
    currentPassword: z.string().min(1, 'Informe a senha atual.').max(200),
  })
  .strict()
  .refine((b) => b.email !== undefined || b.whatsapp !== undefined || b.alerts !== undefined || (b.clearSecrets?.length ?? 0) > 0, { message: 'Informe ao menos um campo para alterar.' })
  .refine((b) => [b.email, b.whatsapp, b.alerts].every((g) => g === undefined || Object.keys(g).length > 0) , { message: 'Grupo vazio: omita-o ou informe ao menos um campo.' })

export type UpdateCommunicationSettingsInput = z.infer<typeof updateCommunicationSettingsSchema>
/** O corpo SEM a senha — é o que o serviço recebe. */
export type UpdateCommunicationSettingsBody = Omit<UpdateCommunicationSettingsInput, 'currentPassword'>

/** Config "ainda não salva" que o teste pode receber no corpo (mesmos nomes do PUT, sem `enabled`/destinatários/severidade). */
const testeEmailConfig = emailSchema.pick({ host: true, port: true, secure: true, user: true, password: true, fromName: true, fromAddress: true }).strict()
const testeWhatsappConfig = whatsappSchema.pick({ baseUrl: true, instance: true, apiKey: true, apiVersion: true }).strict()

export const testEmailSchema = z.object({ to: emailTexto.optional(), config: testeEmailConfig.optional() }).strict()
export const testWhatsappSchema = z.object({ to: z.string().trim().min(8).max(25).optional(), config: testeWhatsappConfig.optional() }).strict()

export type TestEmailInput = z.infer<typeof testEmailSchema>
export type TestWhatsappInput = z.infer<typeof testWhatsappSchema>
