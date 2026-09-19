/**
 * Limites de tamanho e de escopo do log de auditoria (Órion A4, 2026-09-19). A tabela é
 * imutável por 24 meses (trigger append-only): campo sem teto = um atacante enche o disco
 * PARA SEMPRE (User-Agent e URL chegam a ~16 KB por linha). Puro (sem Prisma/env) — testável
 * sem banco; os mesmos números estão como CHECK no Postgres (migration
 * 20260919170000_audit_hardening), então um caminho que esqueça de truncar falha ALTO no
 * banco em vez de gravar lixo.
 */

export const AUDIT_FIELD_LIMITS = { path: 255, userAgent: 512, entityId: 128 } as const

/** Trunca por unidades UTF-16 (<= caracteres do Postgres `char_length`, que conta code points). `null`/`undefined` passam. */
function truncar(value: string | null | undefined, max: number): string | null | undefined {
  return typeof value === 'string' && value.length > max ? value.slice(0, max) : value
}

export interface CamposLimitaveis {
  path: string
  userAgent?: string | null
  entityId?: string | null
}

export function limitarCamposDeAuditoria<T extends CamposLimitaveis>(input: T): T {
  return {
    ...input,
    path: truncar(input.path, AUDIT_FIELD_LIMITS.path) as string,
    userAgent: truncar(input.userAgent, AUDIT_FIELD_LIMITS.userAgent),
    entityId: truncar(input.entityId, AUDIT_FIELD_LIMITS.entityId),
  }
}

/**
 * Quem gera linha `DENIED`. `DENIED` (403/404) de ADMIN/OPERATOR é o sinal de segurança mais
 * valioso do log (OPERATOR tentando o recurso de outro tenant). Já qualquer DRIVER batendo em
 * `/api/admin/*` NÃO é usuário do painel (a Nova excluiu DRIVER do escopo): é 403 garantido, e
 * gravar cada tentativa deixava QUALQUER conta cadastrada inflar a tabela imutável.
 */
export function deveGravarAuditoria(actorRole: 'ADMIN' | 'OPERATOR' | 'DRIVER', outcome: 'SUCCESS' | 'DENIED' | 'FAILED'): boolean {
  if (actorRole === 'DRIVER' && outcome === 'DENIED') return false
  return true
}
