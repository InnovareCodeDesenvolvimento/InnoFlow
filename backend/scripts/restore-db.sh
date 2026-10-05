#!/usr/bin/env sh
#
# Restauração do banco do InnoFlow a partir de um backup (.dump.enc cifrado, ou .dump em claro).
#
# Uso:
#   sh scripts/restore-db.sh <arquivo.dump.enc> <url-do-banco-destino> --confirmar --chave <arquivo-da-chave>
#   sh scripts/restore-db.sh <arquivo.dump>     <url-do-banco-destino> --confirmar --aceitar-sem-cifra
#   sh scripts/restore-db.sh <arquivo.dump.enc> --listar --chave <arquivo-da-chave>      (só mostra o conteúdo; não toca em banco)
#
# Opções:
#   --confirmar                 obrigatória para restaurar: nenhuma restauração acontece por acidente de histórico do shell.
#   --chave <arquivo>           arquivo da chave (linha "CHAVE: ..."). Alternativa: variável BACKUP_KEY.
#   --aceitar-sem-cifra         aceita um arquivo SEM a marca de backup cifrado (dump em claro). Um dump forjado executaria
#                               SQL no destino, por isso a recusa é o padrão.
#   --permitir-banco-em-uso     deixa o destino ser o MESMO banco da DATABASE_URL do ambiente (ver abaixo).
#   --tolerar-erros             saída de emergência: pg_restore --clean sem transação única, seguindo nos erros (ver abaixo).
#   --listar                    só lista o conteúdo do backup.
#
# POR QUE O DESTINO É UM ARGUMENTO, E NÃO A DATABASE_URL DO AMBIENTE: restaurar é destrutivo (apaga o conteúdo atual
# antes de repor). Se o script lesse a DATABASE_URL sozinho, bastaria rodá-lo por engano no terminal de produção para
# reescrever a produção. Obrigar a digitar o destino faz a pessoa olhar para onde está mandando.
#
# BANCO EM USO: se o destino for o mesmo banco da DATABASE_URL do ambiente (comparado pelo endereço E pela identidade do
# servidor), o script RECUSA, a menos que --permitir-banco-em-uso. Esse é o caso do desastre de verdade (o banco da
# produção foi apagado e você restaura em cima dele), por isso a flag existe — mas ela é uma decisão, não um padrão.
#
# ATÔMICO POR PADRÃO: o schema public do destino é refeito e o dump restaurado numa ÚNICA transação (BEGIN ... COMMIT). Se
# qualquer coisa falhar, tudo volta atrás e o destino fica como estava. --tolerar-erros troca isso pelo comportamento antigo
# (pg_restore --clean, sem transação única, seguindo em frente nos erros e conferindo o resultado no fim): é a saída de
# emergência para um banco gerenciado em que o usuário não pode refazer o schema public.
#
# USUÁRIO: o dump não carrega donos (--no-owner), então tudo fica de propriedade de quem restaura. Restaure com o MESMO
# usuário que a aplicação usa (o da DATABASE_URL dela).
#
# CIFRADO: decifra para uma pasta temporária 0700 (decrypt-backup.mjs, exige só o Node), confere a integridade até o último
# byte, restaura e APAGA o temporário no fim, deu certo ou não. Chave errada ou arquivo adulterado param aqui, ANTES de
# tocar no destino.
#
# SENHA FORA DOS ARGUMENTOS: se a URL trouxer senha, ela é tirada da URL e vai por PGPASSWORD (só o ambiente do processo),
# e o log mostra apenas host:porta/banco. Melhor ainda: passe a URL SEM senha e exporte PGPASSWORD antes de rodar (a URL
# digitada como argumento do próprio script aparece no `ps` da máquina enquanto ele roda).
#
# RESTAURAÇÃO PARCIAL (uma tabela, uma linha): não use este script sobre a produção. Restaure num banco temporário e copie
# de lá. Passo a passo em docs/RUNBOOK-BACKUP-RESTAURACAO.md, seção "Restauração parcial".

set -eu
umask 077

AQUI="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=_pg-url.sh
. "$AQUI/_pg-url.sh"

ARQUIVO=""
DESTINO=""
CONFIRMACAO=""
CHAVE=""
ACEITAR_SEM_CIFRA="0"
PERMITIR_EM_USO="0"
TOLERAR_ERROS="0"
LISTAR="0"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --confirmar) CONFIRMACAO="--confirmar" ;;
    --aceitar-sem-cifra) ACEITAR_SEM_CIFRA="1" ;;
    --permitir-banco-em-uso) PERMITIR_EM_USO="1" ;;
    --tolerar-erros) TOLERAR_ERROS="1" ;;
    --listar) LISTAR="1" ;;
    --chave)
      shift
      CHAVE="${1:-}"
      if [ -z "$CHAVE" ]; then
        echo "ERRO: --chave precisa do caminho do arquivo da chave." >&2
        exit 1
      fi
      ;;
    --*)
      echo "ERRO: opção desconhecida: $1" >&2
      exit 1
      ;;
    *)
      if [ -z "$ARQUIVO" ]; then
        ARQUIVO="$1"
      elif [ -z "$DESTINO" ]; then
        DESTINO="$1"
      else
        echo "ERRO: argumento inesperado (a URL do destino pode ter sido digitada duas vezes ou com espaço)." >&2
        exit 1
      fi
      ;;
  esac
  shift
done

if [ -z "$ARQUIVO" ] || { [ "$LISTAR" != "1" ] && [ -z "$DESTINO" ]; }; then
  echo "Uso: $0 <arquivo.dump|arquivo.dump.enc> <url-do-banco-destino> --confirmar [--chave <arquivo-da-chave>]" >&2
  echo "     $0 <arquivo.dump|arquivo.dump.enc> --listar [--chave <arquivo-da-chave>]" >&2
  exit 1
fi

if [ ! -f "$ARQUIVO" ]; then
  echo "ERRO: arquivo não encontrado: $ARQUIVO" >&2
  exit 1
fi

for FERRAMENTA in pg_restore psql; do
  if ! command -v "$FERRAMENTA" >/dev/null 2>&1; then
    echo "ERRO: $FERRAMENTA não encontrado. Instale o cliente do PostgreSQL (versão igual ou mais nova que a do banco)." >&2
    exit 1
  fi
done

TEMPORARIA=""
limpar() {
  if [ -n "$TEMPORARIA" ]; then rm -rf "$TEMPORARIA"; fi
}
trap limpar EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

# Pasta temporária 0700 (dump decifrado, e o roteiro SQL do caminho para servidor antigo). Some no fim, deu certo ou não.
TEMPORARIA="$(mktemp -d "${BACKUP_TMP_DIR:-${TMPDIR:-/tmp}}/innoflow-restore.XXXXXX")"
chmod 700 "$TEMPORARIA"

# Backup cifrado? Pela marca no começo do arquivo, não pela extensão. Decifra para a pasta temporária, e o resto do script
# trabalha sobre o dump decifrado ($DUMP).
DUMP="$ARQUIVO"
if [ "$(head -c 7 "$ARQUIVO" 2>/dev/null || true)" = "INNOBKP" ]; then
  if [ -z "$CHAVE" ] && [ -z "${BACKUP_KEY:-}" ]; then
    echo "ERRO: este backup é cifrado (.dump.enc). Informe a chave com --chave <arquivo-da-chave> (ou exporte BACKUP_KEY). NADA foi alterado no destino." >&2
    exit 1
  fi
  if ! command -v node >/dev/null 2>&1; then
    echo "ERRO: node não encontrado: ele é necessário para decifrar o backup. NADA foi alterado no destino." >&2
    exit 1
  fi
  DUMP="$TEMPORARIA/restore.dump"
  echo "[restore] decifrando o backup (a verificação de integridade roda até o fim)..."
  if ! node "$AQUI/decrypt-backup.mjs" "$ARQUIVO" ${CHAVE:+--chave "$CHAVE"} --saida "$DUMP"; then
    echo "ERRO: não consegui abrir o backup com essa chave. NADA foi alterado no destino." >&2
    exit 1
  fi
elif [ "$ACEITAR_SEM_CIFRA" != "1" ]; then
  # Sem a marca INNOBKP o arquivo seria tratado como dump em claro. Um dump forjado executa SQL no destino, então só segue
  # com pedido explícito (dump que você mesmo gerou com --sem-cifra, por exemplo).
  echo "ERRO: este arquivo não tem a marca de backup cifrado do InnoFlow. Pode ser um arquivo trocado. Se você tem certeza de que é um dump em claro seu, rode de novo com --aceitar-sem-cifra. NADA foi alterado no destino." >&2
  exit 1
elif [ -n "$CHAVE" ]; then
  echo "[restore] aviso: o arquivo não é cifrado, a chave foi ignorada."
fi

# Confere o dump ANTES de destruir qualquer coisa. Descobrir que o arquivo está corrompido depois de apagar o banco seria
# a pior sequência possível.
if ! SUMARIO="$(pg_restore --list "$DUMP" 2>&1)"; then
  echo "ERRO: dump ilegível ou corrompido (ou feito por um pg_dump mais novo que o pg_restore deste ambiente). O pg_restore disse: $(printf '%s' "$SUMARIO" | head -n 2 | tr '\n' ' ') NADA foi alterado no destino." >&2
  exit 1
fi

if [ "$LISTAR" = "1" ]; then
  printf '%s\n' "$SUMARIO"
  exit 0
fi

TABELAS="$(printf '%s\n' "$SUMARIO" | grep -c ' TABLE DATA ' || true)"
TABELAS_DEFINIDAS="$(printf '%s\n' "$SUMARIO" | grep -c ' TABLE public ' || true)"
DUMP_DE="$(printf '%s\n' "$SUMARIO" | sed -n -E 's/^; +Dumped from database version: *//p' | head -n 1)"
DUMP_POR="$(printf '%s\n' "$SUMARIO" | sed -n -E 's/^; +Dumped by pg_dump version: *//p' | head -n 1)"

if [ "$TABELAS" -eq 0 ]; then
  echo "ERRO: o backup não tem NENHUMA tabela com dados. NADA foi alterado no destino." >&2
  exit 1
fi

CLIENTE_MAJOR="$(versao_major "$(pg_restore --version)")"
if [ -n "$DUMP_POR" ] && [ "$(versao_major "$DUMP_POR")" -gt "$CLIENTE_MAJOR" ]; then
  echo "ERRO: o backup foi feito por um pg_dump $DUMP_POR e o pg_restore deste ambiente é o $CLIENTE_MAJOR (mais velho). Use um cliente igual ou mais novo. NADA foi alterado no destino." >&2
  exit 1
fi

# Separa a senha da URL de destino (a URL do ambiente, para comparar, só é lida em subshell mais abaixo).
preparar_url_pg "$DESTINO"
DESTINO_SEGURO="$URL_SEGURA"
BANCO_DESTINO="$(identidade_banco "$DESTINO_SEGURO")"

echo "Vai restaurar:"
echo "  arquivo : $ARQUIVO ($TABELAS tabela(s) com dados; feito por pg_dump ${DUMP_POR:-?}, de um servidor ${DUMP_DE:-?})"
echo "  destino : $BANCO_DESTINO"
echo ""
echo "ISTO APAGA o conteúdo atual do banco de destino."

if [ "$CONFIRMACAO" != "--confirmar" ]; then
  echo "" >&2
  echo "Parado: falta --confirmar. NADA foi alterado." >&2
  exit 1
fi

# O destino precisa responder ANTES de qualquer destruição (e é daqui que sai o que ele tem hoje).
if ! DESTINO_NUM="$(psql --dbname="$DESTINO_SEGURO" -X -tA -c 'SHOW server_version_num' 2>&1)"; then
  echo "ERRO: não consegui conectar ao destino ($BANCO_DESTINO): $DESTINO_NUM. NADA foi alterado." >&2
  exit 1
fi
case "$DESTINO_NUM" in
  ''|*[!0-9]*)
    echo "ERRO: resposta inesperada do destino sobre a versão do servidor: $DESTINO_NUM. NADA foi alterado." >&2
    exit 1
    ;;
esac
DESTINO_MAJOR=$((DESTINO_NUM / 10000))
if [ -n "$DUMP_DE" ] && [ "$(versao_major "$DUMP_DE")" -gt "$DESTINO_MAJOR" ]; then
  echo "[restore] aviso: o backup veio de um PostgreSQL $DUMP_DE e o destino é o $DESTINO_MAJOR (mais velho). Pode funcionar, mas se o pg_restore reclamar de sintaxe, crie o destino com a versão do backup ou mais nova."
fi

# Banco em uso? Duas conferências: pelo endereço digitado e pela identidade do servidor (pega apelido de host, IP vs nome).
EM_USO="0"
if [ -n "${DATABASE_URL:-}" ]; then
  if [ "$(identidade_banco "$DATABASE_URL")" = "$BANCO_DESTINO" ]; then
    EM_USO="1"
  else
    ID_AMBIENTE="$( (preparar_url_pg "$DATABASE_URL"; psql --dbname="$URL_SEGURA" -X -tA -c "SELECT (pg_control_system()).system_identifier || '|' || current_database()" 2>/dev/null) || true)"
    ID_DESTINO="$(psql --dbname="$DESTINO_SEGURO" -X -tA -c "SELECT (pg_control_system()).system_identifier || '|' || current_database()" 2>/dev/null || true)"
    if [ -n "$ID_AMBIENTE" ] && [ "$ID_AMBIENTE" = "$ID_DESTINO" ]; then EM_USO="1"; fi
  fi
else
  echo "[restore] aviso: DATABASE_URL não está definida neste terminal; não dá para conferir se o destino é o banco em uso."
fi
if [ "$EM_USO" = "1" ]; then
  if [ "$PERMITIR_EM_USO" != "1" ]; then
    echo "ERRO: o destino ($BANCO_DESTINO) é o MESMO banco da DATABASE_URL deste ambiente, isto é, o banco em uso pela aplicação. Restaurar aqui apaga os dados vivos. Se é isso mesmo que você quer (desastre: o banco foi perdido), pare api, ocpp-gateway e worker, e rode de novo com --permitir-banco-em-uso. NADA foi alterado." >&2
    exit 1
  fi
  echo "[restore] aviso: restaurando sobre o banco em uso (--permitir-banco-em-uso). Confirme que api, ocpp-gateway e worker estão PARADOS."
fi

EXISTENTES="$(psql --dbname="$DESTINO_SEGURO" -X -tA -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p')" 2>/dev/null || echo "?")"
echo "[restore] o destino tem hoje $EXISTENTES tabela(s) no schema public, que serão substituídas."
if [ "$TOLERAR_ERROS" = "1" ]; then
  echo "[restore] restaurando em modo --tolerar-erros (SEM transação única: um erro no meio pode deixar o destino pela metade)..."
else
  echo "[restore] restaurando (transação única: tudo ou nada)..."
fi

# COMO RESTAURA, e por quê não é `pg_restore --clean` sobre o banco:
#  * `pg_restore --clean --if-exists` NÃO consegue substituir este schema quando o banco já tem dados: as tabelas
#    particionadas (MeterSample, OcppMessage) com partição padrão falham em "cannot drop inherited constraint" e o
#    banco fica pela metade (reproduzido contra PostgreSQL 16 e 18). O que funciona, e é o que o backup assume, é restaurar
#    num schema VAZIO. Então o schema public é refeito (DROP SCHEMA ... CASCADE; CREATE SCHEMA) DENTRO da mesma transação
#    do restore: ou volta tudo, ou nada muda.
#  * O roteiro SQL sai do pg_restore sem conectar (--file=-) e vai por um pipe ao psql, que o executa com ON_ERROR_STOP.
#    O COMMIT só é escrito se o pg_restore terminou com sucesso: se ele cair no meio, o roteiro vai cortado, o psql perde a
#    conexão com a transação aberta e o servidor desfaz tudo (nunca se confirma um roteiro pela metade).
#  * `SET transaction_timeout` (que o pg_restore 17+ escreve e só o servidor 17+ conhece) é removido do roteiro: com o
#    cliente 18 contra o banco 16 o pg_restore direto abortava por esse parâmetro (reproduzido com o 18.6 contra o 16.11).
#  * --no-owner / --no-privileges: o dump foi feito assim, então TUDO fica de propriedade do usuário que restaura. Restaure
#    com o MESMO usuário que a aplicação usa (o da DATABASE_URL dela), senão a aplicação não enxerga o que foi restaurado.
ESTADO="$TEMPORARIA/status-pg-restore"
set +e
if [ "$TOLERAR_ERROS" = "1" ]; then
  # Saída de emergência: o jeito antigo, sem transação única; segue em frente nos erros e confere o resultado no fim.
  pg_restore --dbname="$DESTINO_SEGURO" --clean --if-exists --no-owner --no-privileges "$DUMP"
  CODIGO=$?
else
  {
    echo "BEGIN;"
    echo "SET client_min_messages = warning;"
    echo "DROP SCHEMA IF EXISTS public CASCADE;"
    echo "CREATE SCHEMA public;"
    echo "GRANT USAGE ON SCHEMA public TO PUBLIC;"
    pg_restore --no-owner --no-privileges --file=- "$DUMP"
    RC=$?
    echo "$RC" > "$ESTADO"
    if [ "$RC" -eq 0 ]; then echo "COMMIT;"; else echo "ROLLBACK;"; fi
  } | sed '/^SET transaction_timeout = 0;$/d' | psql --dbname="$DESTINO_SEGURO" -X -q -v ON_ERROR_STOP=1 >/dev/null
  CODIGO=$?
  RC_RESTORE="$(cat "$ESTADO" 2>/dev/null || echo 1)"
  if [ "$CODIGO" -eq 0 ] && [ "$RC_RESTORE" != "0" ]; then CODIGO="$RC_RESTORE"; fi
fi
set -e

if [ "$CODIGO" -ne 0 ]; then
  if [ "$TOLERAR_ERROS" = "1" ]; then
    echo "[restore] pg_restore terminou com avisos (código $CODIGO): conferindo o resultado..."
  else
    echo "ERRO: a restauração falhou (código $CODIGO). Como ela é atômica, o destino ficou COMO ESTAVA. Leia a mensagem acima. Se o motivo for permissão sobre o schema public (banco gerenciado), use --tolerar-erros." >&2
    exit 1
  fi
fi

# A prova real: as tabelas voltaram, e com linhas? (Contagem exata: EXISTS por tabela, não estatística do autovacuum.)
RESTAURADAS="$(psql --dbname="$DESTINO_SEGURO" -X -tA -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p')" 2>/dev/null || echo "?")"
COM_LINHAS="$(psql --dbname="$DESTINO_SEGURO" -X -tA -c "SELECT count(*) FROM information_schema.tables t WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND (xpath('/row/e/text()', query_to_xml(format('select exists(select 1 from %I.%I) as e', t.table_schema, t.table_name), false, true, '')))[1]::text = 'true'" 2>/dev/null || echo "?")"

echo "[restore] tabelas no destino: $RESTAURADAS (o backup define $TABELAS_DEFINIDAS); com pelo menos uma linha: $COM_LINHAS"

if [ "$COM_LINHAS" = "0" ]; then
  echo "ERRO: o banco de destino ficou VAZIO. A restauração não valeu." >&2
  exit 1
fi
if [ "$RESTAURADAS" != "?" ] && [ "$RESTAURADAS" -lt "$TABELAS_DEFINIDAS" ]; then
  echo "ERRO: faltam tabelas no destino ($RESTAURADAS de $TABELAS_DEFINIDAS). A restauração ficou incompleta." >&2
  exit 1
fi

echo "[restore] concluído."
echo ""
echo "Próximo passo: suba api, ocpp-gateway e worker. Cada um roda 'prisma migrate deploy' no boot e alinha o schema,"
echo "caso o backup seja de uma versão anterior. Depois confira o sistema de verdade (docs/RUNBOOK-BACKUP-RESTAURACAO.md)."
