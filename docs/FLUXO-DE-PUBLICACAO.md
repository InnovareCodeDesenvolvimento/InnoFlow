# Fluxo de publicação (do código ao EasyPanel)

**Regra de ouro:** o EasyPanel constrói a branch `main`. Portanto **o `main` só recebe código que o CI já validou**, inclusive o
`docker build` das 4 imagens. Antes (até 05/10/2026) o primeiro `docker build` real de uma mudança de Dockerfile era o próprio
deploy de produção; agora ele acontece numa branch, no CI.

## 1. O caminho de uma mudança

```
branch de trabalho  ──push──▶  CI completo (7 jobs + portão)  ──PR──▶  main (só com o portão verde)  ──▶  EasyPanel constrói e publica
```

1. Crie uma branch a partir do `main` e trabalhe nela. Nomes sugeridos: `staging` (a branch de integração, reaproveitável),
   `release/<tema>`, `infra/<tema>`, `fix/<tema>`.
   - **Mudança de infraestrutura** (qualquer `Dockerfile*`, `nginx.conf.template`, `docker-compose.yml`, `.github/`, `package.json`/lockfile,
     migrations do Prisma): **sempre** por branch + PR. É exatamente o que o CI prova que o EasyPanel vai conseguir construir.
   - Mudança só de código/UI: também por branch + PR; a diferença é que o risco de "builda no CI, quebra no EasyPanel" é menor.
2. `git push origin <branch>`. O CI roda em **push de qualquer branch** e em **pull request**, sem filtro de caminho.
3. Abra o PR da branch para o `main`. O CI roda de novo sobre o **resultado do merge** (o que de fato vai para o `main`).
4. Só faça o merge com o job **`CI verde (portão do main)`** verde (a proteção de branch abaixo impõe isso). Prefira "Squash and merge"
   ou "Rebase and merge" para o histórico do `main` ficar linear, um commit por entrega.
5. O push no `main` dispara o CI mais uma vez (cada commit do `main` tem veredito; o CI nunca cancela uma execução do `main`) **e** o
   deploy automático do EasyPanel.
6. Confirme o deploy (ver `docs/DEPLOY-EASYPANEL.md`): serviços `running`, `GET /health` do frontend 200, API respondendo.

Comandos:

```bash
git switch -c infra/node22 main        # ou: git switch staging && git merge --ff-only main
# ... mexe, commita ...
git push -u origin infra/node22        # o CI valida as imagens AQUI, não no EasyPanel
gh pr create --base main --fill        # ou pela interface do GitHub
gh pr checks --watch                   # espera o portão
gh pr merge --squash                   # só depois de verde
```

> Hotfix urgente segue o mesmo caminho (branch curta + PR); o CI leva alguns minutos e é mais barato que um deploy quebrado.
> Exceção consciente: com a proteção de branch ativa, só o dono (admin) consegue passar por cima dela, e deve registrar o motivo.

## 2. O que o CI valida antes de o código chegar ao `main`

| Job | O que prova | Falha típica que ele pega |
|---|---|---|
| `backend` | lint, typecheck, `prisma migrate deploy` real, suíte inteira (unit + integração) com Postgres 16 e Redis 7 reais, **cliente `pg_dump` 18** instalado para os testes de backup | migration quebrada, regressão, backup que não copia o servidor |
| `frontend` | lint, `npm run build` (tsc -b + 2 vite build), guardas do bundle (sem MSW, cartão isolado SAQ A-EP), testes unitários | erro de tipos, bundle do cartão contaminado |
| `e2e` | Playwright (smoke + fluxos do PWA e do admin contra mocks) | fluxo de tela quebrado |
| `docker-compose` | `docker compose config` | YAML/variáveis do compose |
| `docker-backend` (x3: `Dockerfile`, `.ocpp`, `.worker`) | **`docker build` da imagem**, Node 22, usuário `node`, sem devDependencies, engine do Prisma musl, **`pg_dump`/`pg_restore`/`psql` como `node` copiando um Postgres 16**, e o CMD real subindo (migrate deploy + entrypoint) | Dockerfile que não builda, cliente PG ausente/velho, boot quebrado |
| `docker-frontend` | **`docker build` da imagem** (a mesma etapa de build do EasyPanel), nginx 1.30 sobe, `/health` 200, CSP presente | build do frontend na imagem, template do nginx inválido |
| `backup-restore` (x2: PG 16 e 18) | backup cifrado + restauração completa + conferência dos dados | backup que não volta |
| **`ci-ok`** (`CI verde (portão do main)`) | todos os acima em `success` (pulado/cancelado também reprova) | — é o único check que a proteção de branch exige |

O que o CI **não** prova: memória do servidor do EasyPanel (o runner do GitHub tem ~7 GB; o servidor de vocês pode ter bem menos),
rede/registro do servidor, variáveis de ambiente reais de produção.

## 3. Proteção de branch do `main` (configurar no GitHub — não dá para fazer por código)

Repositório `InnovareCodeDesenvolvimento/InnoFlow` → **Settings → Branches → Add branch ruleset** (ou *Add classic branch protection rule*),
alvo `main`:

- [x] **Require a pull request before merging** (aprovações exigidas: 0 se trabalham sozinhos, 1 se houver revisor; o PR é o que
      dá ao CI a chance de rodar antes).
- [x] **Require status checks to pass before merging** → adicione **`CI verde (portão do main)`** (o job `ci-ok`).
      Ele só aparece na busca depois de ter rodado ao menos uma vez (faça um push numa branch primeiro).
      Marque também **Require branches to be up to date before merging**.
- [x] **Block force pushes** e **Restrict deletions**.
- [x] **Do not allow bypassing the above settings** / *Include administrators* (sem isso o dono consegue dar `git push origin main`
      direto e o CI vira só aviso).
- [ ] (opcional) **Require linear history**.

Limite do plano: **em repositório privado, proteção de branch/rulesets exigem GitHub Pro/Team** (no plano gratuito só valem em repositório
público). Se for o caso, o fluxo acima continua valendo como disciplina (nunca `git push origin main`), mas sem trava técnica — avalie o plano.

No EasyPanel nada muda: cada App continua apontando para a branch `main`. (Opcional: um App de homologação apontando para `staging`
dá um ambiente de teste de verdade; o CI já cobre o build e o boot das imagens, então só vale a pena se o servidor tiver folga de memória.)

## 4. Se o deploy falhar no EasyPanel

**Primeiro:** o CI desse mesmo commit está verde? (`gh run list --branch main --limit 3` ou a aba *Actions*.)

- CI **vermelho** → é código/Dockerfile; o log do job que falhou já diz o que é. Corrija numa branch, não no `main`.
- CI **verde** e o EasyPanel falha → é o **ambiente do servidor** (memória, disco, rede, registro). Siga abaixo.

### 4.1 Como obter o FIM do log

1. EasyPanel → o App que falhou → aba de **implantações/deploys** (o nome varia por versão) → abra a implantação com erro → role até o **fim**.
   Copie as últimas ~100 linhas **e** a primeira linha com `error`/`ERR`/`Killed`.
2. Se o painel cortar o log: no servidor, por SSH, reproduza o build com o log inteiro:
   `git clone --depth 1 https://github.com/InnovareCodeDesenvolvimento/InnoFlow && cd InnoFlow/frontend && docker build --progress=plain --no-cache -t teste .`
   (no backend: `cd backend && docker build --progress=plain --no-cache -f Dockerfile -t teste .`).
3. O frontend agora imprime, **no início do build**, a memória que o builder tinha (`[build] memoria: limite=... livre=...`) e, **se falhar,
   um bloco `[build] FALHOU ... Causa mais provável` no fim** (`frontend/scripts/build-docker.sh`). Procure essas linhas primeiro.

### 4.2 O que procurar e o que rodar

| Sintoma no log | Causa provável | O que fazer / rodar |
|---|---|---|
| Log termina em `npm run build` **sem erro**; `Killed`; `exit code: 137` | **Sem memória** — o kernel matou o processo (quem morre não escreve erro). O push no `main` dispara o deploy dos **4 Apps** (api, ocpp, worker, frontend), provavelmente **builds simultâneos** no mesmo servidor (confirme no painel) | No servidor: `dmesg -T \| grep -iE 'out of memory\|killed process'`, `free -m`, `docker stats --no-stream`. Solução: mais RAM, **swap** (`fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile`), e **não** deixar os 4 builds simultâneos (dispare um App por vez / escalone os deploys). Medido: o build do frontend pede ~0,6 GB no pico, o do backend ~0,6 GB cada |
| `FATAL ERROR: ... JavaScript heap out of memory`; `exit code: 134` | Heap do Node (o `tsc` precisa de ~450 MB de heap; o teto agora é 1536 MB) | Subir `BUILD_MAX_OLD_SPACE_MB` (ARG do `frontend/Dockerfile`) **e** conferir que o servidor tem essa memória. Se o `tsc` cresceu muito, investigar o que entrou |
| `npm error` / `npm ERR!` com `ETIMEDOUT`, `ECONNRESET`, `ENOTFOUND`, `EAI_AGAIN` | Rede/registro do npm do servidor | Repetir o deploy; no servidor `curl -I https://registry.npmjs.org/`; ver DNS |
| `npm error ERESOLVE` / `EBADPLATFORM` / `Cannot find native binding` / `*-linux-x64-musl` | Dependência/lockfile (Alpine usa musl) | O CI (`docker-frontend`) já builda na mesma base; se o CI está verde, repetir o deploy; senão corrigir o lockfile numa branch |
| `error TS2322` (ou outro `TSxxxx`) | Erro de tipos — mas o CI verde diz que o commit está certo; veja se o EasyPanel buildou **outro commit** | Conferir o SHA do deploy; `npm run build` local |
| `failed to read dockerfile` / `failed to solve ... not found` | Build Path/Arquivo do App errados | `docs/DEPLOY-EASYPANEL.md`, seção 1 (Build Path `backend` ou `frontend`; Arquivo certo) |
| `toomanyrequests`, `pull access denied`, `TLS handshake timeout` ao puxar `node:22-alpine`/`nginx:1.30-alpine` | Limite do Docker Hub / rede | Esperar e repetir; `docker login` no servidor |
| `no space left on device` | Disco do servidor cheio | `docker system df`; `docker builder prune -af`; `docker image prune -af` |
| Build passou e o container sobe e **cai** | Não é build: runtime | Logs do serviço no EasyPanel; envs obrigatórias (`CORS_ALLOWED_ORIGINS`, `JWT_SECRET`...) em `docs/DEPLOY-EASYPANEL.md`; o backend roda `prisma migrate deploy` no boot |

### 4.3 Voltar atrás

- Um build que **falha** não deveria derrubar o serviço (o EasyPanel só troca o container quando a imagem nova existe) — confirme que o
  App segue `running` com a versão anterior (comportamento esperado, **não verificado aqui**).
- Se uma versão publicada quebrou: `git revert <sha-ruim>` numa branch → PR → merge (o CI valida a reversão também). É o caminho
  garantido; se o painel oferecer *redeploy* da implantação anterior, serve para estancar mais rápido.
- Migration do Prisma já aplicada **não** volta sozinha com o `revert` do código: veja `docs/RUNBOOK-BACKUP-RESTAURACAO.md` antes de qualquer
  ação no banco.
