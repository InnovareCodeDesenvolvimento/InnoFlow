#!/bin/sh
# Build de producao do frontend DENTRO do `docker build` (Dockerfile, estagio builder): roda `npm run build` com o heap do Node
# fixado e, se falhar, escreve no FIM do log o que provavelmente aconteceu e o que fazer. Nao muda a saida do build (dist/).
#
# POR QUE existe: no EasyPanel o build ja morreu no passo `npm run build` e o log colado terminava ali, sem erro (o processo e
# morto pelo kernel quando falta memoria, e quem morre nao escreve nada). Quem le o fim do log precisa ver (1) quanta memoria o
# builder tinha ANTES de comecar e (2) a causa mais provavel se der errado.
#
# MEDIDO (Windows, Node 22, 24 nucleos; o Linux/musl pode diferir um pouco):
#   - `tsc -b` do frontend, a frio: PASSA com --max-old-space-size=448, ABORTA com 384 (V8 "heap out of memory", exit 134).
#     Pico de memoria do processo ~570 MB. O backend (`tsc`) tem o mesmo piso (~450 MB).
#   - `vite build` (rolldown): usa menos de 96 MB de heap JS (passa com --max-old-space-size=96); o resto (~480-620 MB de pico) e
#     memoria NATIVA do rolldown/Tailwind, que --max-old-space-size nao governa. Limitar threads (RAYON/TOKIO) nao baixou o pico.
#   - As tres etapas (tsc -b, vite build, vite build do cartao) rodam em sequencia, entao o pico do build e o MAIOR, nao a soma.
# O V8 do Node 22 costuma derivar o teto padrao do heap da memoria do container (~1/4 dela; conhecido do V8, NAO medido num
# container aqui): com 2 GB cairia para ~512 MB — a poucos MB do piso do tsc, e o piso sobe conforme o codigo cresce. Por isso o teto e explicito. 1536 MB = ~3,4x o piso medido; nao reserva memoria
# (so tira o limite artificial), se o servidor nao tem, o kernel mata o processo e a mensagem abaixo diz isso.
set -u

MAX_MB="${BUILD_MAX_OLD_SPACE_MB:-1536}"
export NODE_OPTIONS="--max-old-space-size=${MAX_MB}${NODE_OPTIONS:+ ${NODE_OPTIONS}}"

# ---- memoria disponivel ANTES de comecar (fica no log mesmo se o build for morto) ----
mem_mb=""
if [ -r /sys/fs/cgroup/memory.max ]; then            # cgroup v2
  v="$(cat /sys/fs/cgroup/memory.max 2>/dev/null)"
  case "$v" in ''|max|*[!0-9]*) ;; *) mem_mb=$((v / 1048576)) ;; esac
elif [ -r /sys/fs/cgroup/memory/memory.limit_in_bytes ]; then   # cgroup v1
  v="$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null)"
  case "$v" in ''|*[!0-9]*) ;; *) [ "${#v}" -lt 13 ] && mem_mb=$((v / 1048576)) ;; esac   # 13+ digitos = "sem limite"
fi
livre_mb=""
if [ -r /proc/meminfo ]; then
  kb="$(sed -n 's/^MemAvailable:[[:space:]]*\([0-9][0-9]*\) kB.*/\1/p' /proc/meminfo)"
  [ -n "$kb" ] && livre_mb=$((kb / 1024))
fi
echo "[build] node $(node -v) | npm $(npm -v) | heap do Node (NODE_OPTIONS): ${MAX_MB} MB"
echo "[build] memoria: limite do container=${mem_mb:-sem limite}${mem_mb:+ MB} | livre no servidor=${livre_mb:-?}${livre_mb:+ MB} (o build precisa de ~1 GB livre no pico)"
for m in "$mem_mb" "$livre_mb"; do
  if [ -n "$m" ] && [ "$m" -lt 1024 ]; then
    echo "[build] AVISO: menos de 1 GB de memoria disponivel (${m} MB). O build pode ser morto pelo sistema (exit 137)."
    echo "[build]        Se acontecer: aumente a memoria do servidor, ou nao faca build de outros servicos ao mesmo tempo."
    break
  fi
done

# ---- o build, com o log tambem guardado para a analise (sem pipefail: o codigo de saida vai por arquivo) ----
LOG="$(mktemp)"
RC_FILE="$(mktemp)"
{ npm run build 2>&1; echo $? > "$RC_FILE"; } | tee "$LOG"
rc="$(cat "$RC_FILE" 2>/dev/null || echo 1)"
rm -f "$RC_FILE"

if [ "$rc" -eq 0 ]; then
  rm -f "$LOG"
  echo "[build] OK"
  exit 0
fi

echo ""
echo "[build] ============================================================"
echo "[build] FALHOU (codigo de saida $rc). Causa mais provavel:"
if [ "$rc" -eq 137 ] || grep -Eq '(^|[^a-z])Killed($|[^a-z])|SIGKILL|signal 9' "$LOG"; then
  echo "[build]  -> SEM MEMORIA no builder (o sistema matou o processo; por isso o log acaba sem mensagem de erro)."
  echo "[build]     O que fazer: aumentar a memoria do servidor de build do EasyPanel (ou criar swap), e nao buildar outros servicos"
  echo "[build]     ao mesmo tempo. Memoria vista no inicio deste build: limite=${mem_mb:-sem limite} MB, livre=${livre_mb:-?} MB."
elif [ "$rc" -eq 134 ] || grep -Eq 'heap out of memory|JavaScript heap|Allocation failed' "$LOG"; then
  echo "[build]  -> O heap do Node estourou o teto de ${MAX_MB} MB (V8 'heap out of memory')."
  echo "[build]     O que fazer: subir BUILD_MAX_OLD_SPACE_MB (ARG no Dockerfile do frontend; o padrao 1536 e ~3x o piso medido do tsc)"
  echo "[build]     E verificar se o servidor tem essa memoria. Se o tsc cresceu muito, vale investigar o que entrou no codigo."
elif grep -Eq 'error TS[0-9]+' "$LOG"; then
  echo "[build]  -> ERRO DE TIPOS do TypeScript (tsc -b). As linhas 'error TSxxxx' acima dizem arquivo e linha."
  echo "[build]     O que fazer: corrigir o codigo (rode 'npm run build' na sua maquina — se passa ai e falha aqui, compare as versoes)."
elif grep -Eq 'ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|registry' "$LOG"; then
  echo "[build]  -> REDE/REGISTRY (npm nao alcancou o registro). O que fazer: tentar o deploy de novo; se repetir, ver DNS/saida do servidor."
elif grep -Eq 'Cannot find native binding|Cannot find module .*(rolldown|lightningcss|oxide)|@rolldown/binding|lightningcss\.linux|MODULE_NOT_FOUND' "$LOG"; then
  echo "[build]  -> DEPENDENCIA NATIVA ausente/incompativel (rolldown/Tailwind no Alpine/musl). O que fazer: conferir o passo 'npm install' acima"
  echo "[build]     e se package-lock.json traz os pacotes '*-linux-x64-musl'."
else
  echo "[build]  -> nao reconheci o padrao. Leia as ultimas linhas ANTES deste bloco (primeira linha com 'error'/'ERR')."
fi
echo "[build] Checklist completo: docs/FLUXO-DE-PUBLICACAO.md, secao 'Se o deploy falhar no EasyPanel'."
echo "[build] ============================================================"
rm -f "$LOG"
exit "$rc"
