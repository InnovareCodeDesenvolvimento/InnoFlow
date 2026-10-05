#!/usr/bin/env sh
# Funções compartilhadas por backup-db.sh e restore-db.sh (carregado com `.`, não é para rodar sozinho).
#
# Por que existe: a URL do banco traz a senha, e passar a URL inteira como argumento do pg_dump/pg_restore/psql
# a deixaria visível no `ps` de qualquer usuário da máquina (e em log de CI, se alguém ecoar o comando).
# Aqui a senha é separada da URL e vai pela variável de ambiente PGPASSWORD (só o ambiente do processo).

# preparar_url_pg <url>
#   Define URL_SEGURA: a URL SEM senha e SEM os parâmetros que só o Prisma entende (?schema=public,
#   connection_limit, pgbouncer...: o libpq recusa esses parâmetros e o pg_dump falharia com "invalid URI query
#   parameter"). Se a URL trouxer senha, exporta PGPASSWORD com ela já decodificada (%XX -> caractere).
#   Sem senha na URL vale o PGPASSWORD que já estiver no ambiente.
preparar_url_pg() {
  _pg_url="$1"
  _pg_senha="$(printf '%s' "$_pg_url" | sed -n -E 's#^[A-Za-z][A-Za-z0-9+.-]*://[^:@/]+:([^@]*)@.*#\1#p')"
  if [ -n "$_pg_senha" ]; then
    # printf é builtin e sed/awk leem da entrada padrão: a senha nunca vira argumento de processo.
    PGPASSWORD="$(printf '%s' "$_pg_senha" | LC_ALL=C awk '{
      hex = "0123456789ABCDEF"; out = ""; s = $0; n = length(s); i = 1
      while (i <= n) {
        c = substr(s, i, 1)
        if (c == "%" && i + 2 <= n) {
          a = index(hex, toupper(substr(s, i + 1, 1))) - 1
          b = index(hex, toupper(substr(s, i + 2, 1))) - 1
          if (a >= 0 && b >= 0) { out = out sprintf("%c", a * 16 + b); i += 3; continue }
        }
        out = out c; i++
      }
      printf "%s", out
    }')"
    export PGPASSWORD
    _pg_url="$(printf '%s' "$_pg_url" | sed -E 's#^([A-Za-z][A-Za-z0-9+.-]*://[^:@/]+):[^@]*@#\1@#')"
  fi
  # shellcheck disable=SC2034  # lida por quem carrega este arquivo
  URL_SEGURA="$(printf '%s' "$_pg_url" | awk '{
    i = index($0, "?")
    if (i == 0) { print $0; next }
    base = substr($0, 1, i - 1); q = substr($0, i + 1)
    n = split(q, parts, "&"); out = ""
    for (k = 1; k <= n; k++) {
      split(parts[k], kv, "=")
      if (kv[1] ~ /^(schema|connection_limit|pool_timeout|pgbouncer|socket_timeout|statement_cache_size|sslaccept)$/) continue
      out = out (out == "" ? "" : "&") parts[k]
    }
    print (out == "" ? base : base "?" out)
  }')"
  unset _pg_url _pg_senha
}

# identidade_banco <url>
#   Imprime "host:porta/banco" normalizado (minúsculas, porta padrão 5432, localhost/127.0.0.1/::1 tratados como um só).
#   Serve para comparar dois destinos SEM expor usuário nem senha, e para mostrar ao operador para onde está indo.
identidade_banco() {
  printf '%s' "$1" | sed -E 's#^[A-Za-z][A-Za-z0-9+.-]*://##; s#^[^@/]*@##; s#\?.*$##' | tr '[:upper:]' '[:lower:]' | awk '{
    hp = $0; db = ""
    i = index(hp, "/")
    if (i > 0) { db = substr(hp, i + 1); hp = substr(hp, 1, i - 1) }
    if (hp ~ /^\[/) { j = index(hp, "]"); host = substr(hp, 1, j); porta = substr(hp, j + 2) }
    else { j = index(hp, ":"); if (j > 0) { host = substr(hp, 1, j - 1); porta = substr(hp, j + 1) } else { host = hp; porta = "" } }
    if (porta == "") porta = "5432"
    if (host == "127.0.0.1" || host == "[::1]" || host == "") host = "localhost"
    print host ":" porta "/" db
  }'
}

# versao_major <texto>  ->  primeiro número inteiro do texto ("pg_dump (PostgreSQL) 18.1" -> 18)
versao_major() {
  printf '%s' "$1" | sed -E 's/^[^0-9]*([0-9]+).*/\1/'
}
