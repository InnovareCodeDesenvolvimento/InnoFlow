#!/usr/bin/env sh
#
# Backup do banco do InnoFlow por linha de comando. O backup AGENDADO roda dentro do worker (Admin > Backup); este
# script serve ao CI, a uma cópia manual antes de uma operação arriscada (migration, restauração) e a quem quer ter o
# arquivo em mãos. Roda igual no terminal do serviço no EasyPanel (usuário `node`, sem root) e numa máquina comum.
#
# Gera um dump no formato CUSTOM do PostgreSQL (-Fc): já vem comprimido e permite restaurar uma tabela isolada, coisa
# que um .sql puro não permite. Por padrão o arquivo SAI CIFRADO (AES-256-GCM, o mesmo formato do backup do painel,
# ver docs/BACKUP-FORMATO.md): o dump tem CPF, e-mail, telefone e tokens de pagamento de todos os motoristas.
#
# Uso:
#   BACKUP_KEY_FILE=<arquivo-da-chave> DATABASE_URL=postgresql://... sh scripts/backup-db.sh [destino]
#   BACKUP_KEY=<chave> DATABASE_URL=postgresql://... sh scripts/backup-db.sh [destino]
#   DATABASE_URL=postgresql://... sh scripts/backup-db.sh --sem-cifra [destino]      (dump em claro, de propósito)
#
# Destino: argumento, ou $BACKUP_DIR, ou ./backups (ignorado pelo Git). No container do EasyPanel o diretório da
# aplicação é somente leitura para o usuário `node`: use um caminho gravável, ex. `sh scripts/backup-db.sh /tmp/backups`.
#
# Variáveis:
#   DATABASE_URL     banco a copiar (obrigatória). A senha NUNCA vai em argumento de processo nem aparece no log.
#   BACKUP_KEY_FILE  arquivo com a linha "CHAVE: ..." (a chave do backup, ver docs/BACKUP-FORMATO.md).
#   BACKUP_KEY       a chave em si, alternativa ao arquivo (a chave nunca vai em argumento).
#   BACKUP_DIR       destino padrão.
#   BACKUP_TMP_DIR   onde o dump em claro vive durante o trabalho (padrão: $TMPDIR ou /tmp). É uma pasta 0700 criada
#                    na hora e APAGADA no fim, deu certo ou não. O dump em claro nunca chega ao destino quando cifrado.
#
# Sem chave o script RECUSA copiar, a menos que você peça --sem-cifra: cópia em claro é decisão explícita, não esquecimento.

set -eu
umask 077

AQUI="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=_pg-url.sh
. "$AQUI/_pg-url.sh"

SEM_CIFRA="0"
DESTINO=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --sem-cifra) SEM_CIFRA="1" ;;
    --*)
      echo "ERRO: opção desconhecida: $1" >&2
      exit 1
      ;;
    *)
      if [ -n "$DESTINO" ]; then
        echo "ERRO: argumento inesperado: $1" >&2
        exit 1
      fi
      DESTINO="$1"
      ;;
  esac
  shift
done
DESTINO="${DESTINO:-${BACKUP_DIR:-./backups}}"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERRO: DATABASE_URL não definida. Sem ela não há o que copiar." >&2
  exit 1
fi

for FERRAMENTA in pg_dump pg_restore psql; do
  if ! command -v "$FERRAMENTA" >/dev/null 2>&1; then
    echo "ERRO: $FERRAMENTA não encontrado. Instale o cliente do PostgreSQL (versão igual ou mais nova que a do banco; a imagem do backend já traz o 18, com queda para o 17)." >&2
    exit 1
  fi
done

# --- Cifra: decide ANTES de abrir o banco, para não gastar minutos de dump e só então descobrir que falta a chave. ---
CIFRAR="1"
if [ -n "${BACKUP_KEY_FILE:-}" ]; then
  if [ ! -f "$BACKUP_KEY_FILE" ]; then
    echo "ERRO: arquivo da chave não encontrado: $BACKUP_KEY_FILE" >&2
    exit 1
  fi
elif [ -n "${BACKUP_KEY:-}" ]; then
  : # a chave vem pelo ambiente; o decrypt-backup.mjs a lê de BACKUP_KEY.
elif [ "$SEM_CIFRA" = "1" ]; then
  CIFRAR="0"
  echo "[backup] aviso: --sem-cifra, o arquivo ficará EM CLARO. Guarde-o em lugar de confiança." >&2
else
  echo "ERRO: sem chave de backup. Informe BACKUP_KEY_FILE (arquivo com a linha CHAVE: ...) ou BACKUP_KEY. Para copiar em claro de propósito, use --sem-cifra." >&2
  exit 1
fi
if [ "$CIFRAR" = "1" ]; then
  if ! command -v node >/dev/null 2>&1; then
    echo "ERRO: node não encontrado: ele é necessário para cifrar." >&2
    exit 1
  fi
  # Confere a chave agora (formato válido), antes do dump: cifrar um arquivo vazio de teste custa nada.
  CHAVE_TESTE="$(mktemp -d "${BACKUP_TMP_DIR:-${TMPDIR:-/tmp}}/innoflow-chave.XXXXXX")"
  : > "$CHAVE_TESTE/vazio"
  if ! node "$AQUI/decrypt-backup.mjs" "$CHAVE_TESTE/vazio" --cifrar ${BACKUP_KEY_FILE:+--chave "$BACKUP_KEY_FILE"} --saida "$CHAVE_TESTE/vazio.enc" >/dev/null; then
    rm -rf "$CHAVE_TESTE"
    echo "ERRO: a chave de backup informada não é válida (esperado: 64 caracteres hexadecimais). Nenhuma cópia foi feita." >&2
    exit 1
  fi
  rm -rf "$CHAVE_TESTE"
fi

# Pasta temporária 0700 (onde o dump em claro vive) e destino. A limpeza roda SEMPRE: sucesso, erro ou Ctrl+C.
TEMPORARIA=""
ENC_PARCIAL=""
limpar() {
  if [ -n "$TEMPORARIA" ]; then rm -rf "$TEMPORARIA"; fi
  if [ -n "$ENC_PARCIAL" ]; then rm -f "$ENC_PARCIAL"; fi
}
trap limpar EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

TEMPORARIA="$(mktemp -d "${BACKUP_TMP_DIR:-${TMPDIR:-/tmp}}/innoflow-backup.XXXXXX")"
chmod 700 "$TEMPORARIA"

if ! mkdir -p "$DESTINO" 2>/dev/null; then
  echo "ERRO: não consegui criar o destino '$DESTINO'. No container do EasyPanel o diretório da aplicação não é gravável pelo usuário node: use um caminho como /tmp/backups." >&2
  exit 1
fi
if [ ! -w "$DESTINO" ]; then
  echo "ERRO: o destino '$DESTINO' não é gravável por este usuário." >&2
  exit 1
fi

# Senha fora do argumento: a URL que vai ao pg_dump/psql é a sem senha (a senha vai por PGPASSWORD).
preparar_url_pg "$DATABASE_URL"
BANCO="$(identidade_banco "$URL_SEGURA")"

# O cliente tem que ser da versão do servidor ou mais novo; senão o pg_dump recusa. Melhor dizer isso claramente.
if ! SERVIDOR_NUM="$(psql --dbname="$URL_SEGURA" -X -tA -c 'SHOW server_version_num' 2>&1)"; then
  echo "ERRO: não consegui conectar ao banco ($BANCO): $SERVIDOR_NUM" >&2
  exit 1
fi
case "$SERVIDOR_NUM" in
  ''|*[!0-9]*)
    echo "ERRO: resposta inesperada do banco sobre a versão do servidor: $SERVIDOR_NUM" >&2
    exit 1
    ;;
esac
SERVIDOR_MAJOR=$((SERVIDOR_NUM / 10000))
CLIENTE_MAJOR="$(versao_major "$(pg_dump --version)")"
if [ "$CLIENTE_MAJOR" -lt "$SERVIDOR_MAJOR" ]; then
  echo "ERRO: o pg_dump deste ambiente é da versão $CLIENTE_MAJOR e o banco é o PostgreSQL $SERVIDOR_MAJOR: o cliente precisa ser da mesma versão ou mais novo. Atualize o pacote postgresql*-client da imagem (backend/Dockerfile*)." >&2
  exit 1
fi

# Mesmo formato de nome do backup do painel, hora de Brasília (sem horário de verão desde 2019). Fuso POSIX fixo em vez
# de America/Sao_Paulo: a imagem Alpine não traz o tzdata, e `TZ=America/Sao_Paulo` ali viraria UTC em silêncio.
CARIMBO="$(TZ='<-03>3' date +%Y-%m-%d-%Hh%Mm%Ss)"
NOME="backup-innoflow-$CARIMBO.dump"
DUMP="$TEMPORARIA/$NOME"

echo "[backup] banco: $BANCO (PostgreSQL $SERVIDOR_MAJOR, cliente $CLIENTE_MAJOR)"
echo "[backup] gerando o dump..."

# --no-owner / --no-privileges: o dump precisa poder ser restaurado num banco novo, com outro usuário dono. Sem isso a
# restauração de emergência falha por causa de um papel que não existe lá.
pg_dump --dbname="$URL_SEGURA" \
  --format=custom \
  --no-owner \
  --no-privileges \
  --lock-wait-timeout=120s \
  --file="$DUMP"

# Um dump truncado (disco cheio, conexão caída) existe, tem tamanho e não serve para nada. Ler o índice agora custa um
# segundo e evita descobrir isso durante um incidente.
if ! pg_restore --list "$DUMP" >/dev/null 2>&1; then
  echo "ERRO: o dump recém-criado está ILEGÍVEL. Descartado para não dar falsa segurança." >&2
  exit 1
fi

TAMANHO="$(wc -c < "$DUMP" | tr -d ' ')"
TABELAS="$(pg_restore --list "$DUMP" | grep -c ' TABLE DATA ' || true)"
echo "[backup] dump ok: $TAMANHO bytes, $TABELAS tabela(s) com dados"

# Zero tabelas com dados passa na leitura do índice, mas é um banco vazio: sintoma de banco errado.
if [ "$TABELAS" -eq 0 ]; then
  echo "ERRO: o dump não tem NENHUMA tabela com dados. Confira se a DATABASE_URL aponta para o banco certo." >&2
  exit 1
fi

if [ "$CIFRAR" = "1" ]; then
  FINAL="$DESTINO/$NOME.enc"
  if [ -e "$FINAL" ]; then
    echo "ERRO: já existe $FINAL (duas cópias no mesmo segundo?). Não vou sobrescrever; rode de novo." >&2
    exit 1
  fi
  ENC_PARCIAL="$FINAL"
  if ! node "$AQUI/decrypt-backup.mjs" "$DUMP" --cifrar ${BACKUP_KEY_FILE:+--chave "$BACKUP_KEY_FILE"} --saida "$FINAL"; then
    echo "ERRO: não consegui cifrar o dump. Nada foi entregue em $DESTINO." >&2
    exit 1
  fi
  # A prova de que o arquivo entregue ABRE com a chave: um backup que não decifra é só um arquivo ocupando espaço.
  if ! node "$AQUI/decrypt-backup.mjs" "$FINAL" ${BACKUP_KEY_FILE:+--chave "$BACKUP_KEY_FILE"} --verificar; then
    echo "ERRO: o arquivo cifrado NÃO passou na conferência de volta. Descartado." >&2
    exit 1
  fi
  ENC_PARCIAL=""
  echo "[backup] cifrado e conferido: o dump em claro foi apagado"
else
  FINAL="$DESTINO/$NOME"
  if [ -e "$FINAL" ]; then
    echo "ERRO: já existe $FINAL (duas cópias no mesmo segundo?). Não vou sobrescrever; rode de novo." >&2
    exit 1
  fi
  mv "$DUMP" "$FINAL"
fi

TAMANHO_FINAL="$(wc -c < "$FINAL" | tr -d ' ')"
echo "[backup] concluído: $FINAL ($TAMANHO_FINAL bytes)"
