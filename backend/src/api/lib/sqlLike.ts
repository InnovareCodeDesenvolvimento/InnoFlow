/**
 * Escapa os metacaracteres de `LIKE`/`ILIKE` (`%`, `_` e a própria `\`) para tratar o termo do
 * usuário como TEXTO LITERAL (Órion M9, 2026-09-19): `/admin/drivers?search=%%%` virava
 * `ILIKE '%%%%%'` e o OPERATOR listava a rede inteira contornando o mínimo de 3 caracteres. O
 * escape padrão do Postgres para LIKE/ILIKE é a barra invertida. O chamador coloca os `%` de
 * "contém" FORA do valor escapado: `%${escapeLike(termo)}%`.
 */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, '\\$&')
}
