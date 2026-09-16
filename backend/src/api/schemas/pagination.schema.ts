import { z } from 'zod'

/**
 * Paginação padrão de toda rota que lista recursos — NUNCA devolver "todos
 * os registros" sem limite. `pageSize` máximo de 100 evita um cliente (ou
 * script mal intencionado) pedir a tabela inteira de uma vez.
 */
export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})

export type PaginationQuery = z.infer<typeof paginationQuerySchema>

export function paginationMeta(page: number, pageSize: number, total: number) {
  return { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) }
}
