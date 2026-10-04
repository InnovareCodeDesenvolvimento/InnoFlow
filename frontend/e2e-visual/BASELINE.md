# Linha de base A0 (04/10/2026) — unificação do design system

Autora: Íris. Congelada **antes** de qualquer mudança de código da F-A. Frontend no commit `3bc8116` (árvore de `frontend/src` limpa no momento
da captura; HEAD ainda era `3bc8116` ao final). Este arquivo é o contrato de "nada regrediu": a Lyra e a Íris comparam contra ele ao fim de cada fase.

Ambiente da medição: Windows 10, Node 24.12, Playwright 1.63 (Chromium headless), Chrome instalado para o Lighthouse 13, Xeon E5-2650 v4 (24 threads),
PC de desenvolvimento compartilhado com outros agentes (índice `benchmarkIndex` do Lighthouse 1.565–1.598 — **só compare medições com índice próximo**).

## 1. Regressão visual (`npm run test:visual`)

| Item | Valor |
|---|---|
| Imagens na baseline | **123** = 41 por viewport × (375, 768, 1440) — `baseline/win32/<viewport>/<id>.jpg` |
| Peso | **≈ 10,3 MB** (2,7 MB / 3,4 MB / 4,2 MB por viewport; landing a 375 px ≈ 430 KB é a maior) — JPEG q70 |
| Testes | 114 (34 rotas × 3 = 102, + 4 testes de estados × 3 = 12; o do fluxo de recarga gera 4 imagens) |
| Tempo | ≈ 2,7 min (3 workers) |

**Rotas (34), por persona** — `rotas.ts`: anônimo 8 (`/`, `/eletropostos`, `/login`, `/cadastro`, `/c/CP-VILA-NORTE-01`, `/c/CP-VILA-NORTE-01/1`,
`/pagamento-cartao.html` sem opener, `/nao-existe-xyz`), motorista 7 (`/app`, `/app/sessao` vazia, `/app/sessoes` vazio, `/app/mapa`, `/app/carteira`,
`/app/carteira/adicionar`, `/app/carteira/cartoes`), motorista `travado@` 5 (histórico com 3 recibos, sessão FAULTED, 3 recibos `/app/sessoes/me_seed_*`),
admin 14 (todas as `/admin/*`).

> A auditoria diz "31 rotas", mas a lista que ela enumera soma 28 (7 + 7 + 14). O harness fotografa 34 porque acrescentou as variantes do QR, o histórico
> e os recibos. **Nenhuma rota da auditoria ficou de fora.**

**Estados (7 imagens por viewport)** — `estados.visual.ts`:
`pwa-sessao-conectando`, `pwa-sessao-ao-vivo` (2 min 05 s de recarga = 0,24 kWh, R$ 2,48, "Mínimo da sessão: R$ 5,00", cronômetro 02:05),
`pwa-sessao-parar-dialogo`, **`pwa-recibo-concluida`** (o recibo que a auditoria não conseguiu: R$ 5,00, novo saldo R$ 45,00), `adm-dialogo-novo-site`,
`adm-dialogo-detalhe-sessao` e `pub-cartao-isolado-formulario` (documento isolado com o handshake real).
O recibo saiu **sem alterar o mock**: o fluxo inteiro (iniciar → ao vivo → parar → recibo) roda numa página só com o relógio movido por saltos
(`page.clock.setFixedTime`), e os recibos pré-semeados do `travado@` cobrem os outros formatos.

### 1.1 Estabilidade — o que foi medido

| Medição | Resultado |
|---|---|
| Comparações completas repetidas sem mudança (114 capturas cada), configuração final | **2 de 2 limpas**, mais **4 de 4** na configuração anterior, só mudando o limiar → 0 flakes em 6 × 114 = **684 capturas** |
| Com tolerância ZERO (`VISUAL_MAX_DIFF_RATIO=0 VISUAL_THRESHOLD=0`) | 111 de 114 idênticas; 3 com **61, 114 e 61 px** de diferença (`pub-cartao-isolado-sem-opener` a 768 e 1440; `adm-connectors` a 768) = ruído ≤ 1,1·10⁻⁴ do quadro |
| Limiar adotado | `maxDiffPixelRatio 0,0003` + `threshold 0,03` (acima do ruído medido, abaixo de qualquer mudança visual que importe) |

**Flakes que existiam e como foram eliminados** (4 em 114 na 1ª calibração; todos de texto):

1. Baseline gravada **em branco** (a tela ainda não tinha montado: o MSW sobe antes do React). Corrigido: exige conteúdo no `#root`.
2. Admin/PWA: o `fullPage` só via a 1ª tela (shells `h-screen` rolam por dentro). Corrigido: a viewport cresce até o rolador principal caber.
3. Landing e mapa: altura mudava (seção em chunk lazy e Leaflet montam depois do 1º paint). Corrigido: espera o documento "assentar" (~1 s sem mudar).
4. **Primeira captura `fullPage` saía na métrica da fonte de reserva em ~60% das vezes (só a 768 px)**; a segunda, no mesmo instante, era idêntica à baseline. DOM e
   `document.fonts` eram iguais nos dois casos. **Causa raiz não identificada** no Chromium. Contorno: uma captura descartada antes da real (10/10 estáveis depois).
   Se a baseline voltar a oscilar só em texto, é aqui que se olha.

**O que NÃO dá para estabilizar / limites** (leia antes de confiar no verde):

- **A baseline vale só para Windows/Chromium 1.63.** Sem Linux não há prova de que um container de CI reproduza os pixels; gere uma baseline `linux` antes de ligar no CI.
- O app roda em **dev server com MSW** (o MSW não existe no build). Pixels de CSS são os mesmos; **tempo e tamanho de carregamento não** (use as seções 3 e 4).
- Tiles do mapa substituídos por um PNG sólido: o mapa do OSM **não** é comparado, só layout/controles/marcadores.
- O stream SSE do mock vira conectores a cada 15 s (timer real). As capturas duram poucos segundos e não esperam isso. Se um dia uma captura passar de ~5 s, a lista de estações pode mudar.
- Cada teste pressupõe o mock recém-carregado: o estado do mock zera a cada `goto`. Fluxos de mais de uma página precisam ser UMA página (como o da recarga).

### 1.2 Sensibilidade — o que o limiar pega e o que não pega (`sensibilidade.visual.ts`, 18 verificações verdes)

Mutações de CSS injetadas em `/admin/dashboard`:

| Mutação | 375 | 768 | 1440 |
|---|---|---|---|
| Texto secundário um degrau mais escuro | pega | pega | pega |
| +1 px de padding nos botões | pega | pega | pega |
| Sombra dos cards removida | pega | pega | pega |
| Um tom na cor primária de **um** botão | pega | **não pega** | **não pega** |
| Raio dos cards 1,25 → 1,125 rem (12 cards) | **não pega** | **não pega** | **não pega** |

Ou seja: **mudança de layout, de tipografia, de cor em vários nós e de sombra é pega; mudança de 1–2 px de raio ou de 1 tom em área pequena não é.** Raio de borda e
diferenças mínimas de cor de um único botão precisam de revisão humana no `/__ds` (catálogo da F-A) e dos cálculos da tabela de contraste.

## 2. Contraste AA (`npm run test:contraste`) — `CONTRASTE-ESTADO-ATUAL.md`

105 medições (35 rotas/estados × 3 viewports). **445 nós reprovados, 3.308 aprovados, 898 que o axe NÃO conseguiu avaliar.** A catraca (`contraste-baseline.json`)
só deixa o número de reprovados por rota×viewport **baixar**.

Os três achados da Nova **confirmados pelo axe**:

| Achado da auditoria | Medido pelo axe | Onde |
|---|---|---|
| `text-white/35` na sidebar ≈ 3,1:1 | **3,09:1** (`#62757f` sobre `#0e2a3a`, 10 px bold) | 56 nós; títulos de grupo da sidebar, em todas as rotas admin |
| `text-white/50` no papel do usuário ≈ 4,1:1 | **4,07:1** (`#939fa7` sobre `#263f4e`, 11 px) | 14 nós ("Administrador" no cartão do rodapé da sidebar) |
| `text-ink-subtle` sobre branco ≈ 2,5:1 | **2,53:1** (`#9ca3af` sobre `#fff`) | 36 nós só nos 3 recibos; 24 em dashboard/financeiro; **pior caso 1,80:1** (selo "Desenvolvido por", 8 px, sobre `#f9fafb`) |

**Achados NOVOS que a auditoria não tinha:**

- **`text-ink-softer` (`#6b7280`) reprova sobre fundos cinza**: 4,47:1 em `#f5f6f8` e 4,39:1 em `#f3f4f6` (11 px bold; cabeçalhos de tabela, labels) — **148 nós**, falta 0,03 a 0,11 para
  o AA. A auditoria dava 4,8:1 para esse texto, mas isso vale só sobre branco. Em tintas (`#e4efe6`, `#e4ecf0`) cai a 4,04–4,09.
- O selo `v0.1.0` do rodapé admin (`text-ink-soft` 10 px sobre `bg-muted`) = **4,07:1**, 39 nós.
- `pub-eletropostos`: 10 nós reprovados em todos os viewports; `pwa-mapa`: 12–13.
- **Pontos cegos do axe (leia):** a **landing** (e a rota inexistente, que cai nela) tem **0 reprovados e 104–118 `incompletos`**: o fundo é degradê/vidro e o axe não calcula. **A landing NÃO está
  auditada para contraste.** O mesmo vale para PWA a 1440 px (9–26 incompletos por rota).

## 3. Desempenho (`lighthouse-baseline.json`) — mediana de 5 rodadas, Lighthouse 13 mobile, **build de produção + `vite preview`**

| Rota | Perf | FCP ms | LCP ms | TBT ms | CLS | KiB | A11y | SEO | BP |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `/` (landing) | **93** [92–93] | 1.952 | 3.019 | 50 | 0 | 286 | 100 | 100 | 100 |
| `/login` | **86** [85–87] | 2.351 | 3.805 | 38 | 0 | 481 | 98 | 69 | 96 |
| `/cadastro` | 86 [86–87] | 2.347 | 3.824 | 31 | 0 | 481 | 98 | 69 | 96 |
| `/eletropostos` | 84 [84–85] | 2.196 | 3.481 | 14 | **0,125** | 444 | 96 | 100 | 96 |
| `/app` (**ver abaixo**) | 88 [87–88] | 2.235 | 3.564 | 54 | 0 | 448 | 98 | 69 | 96 |

- **`/app` exige login e não há backend nem MSW no build de produção**: o Lighthouse vê o redirecionamento para `/login`. O número de `/app` é o do `/login` pós-redirect, **não** a tela do motorista logado.
  Para medir o PWA logado é preciso um backend ou um build com mocks (não existe hoje). Está rotulado no JSON.
- **O "72" do PROGRESSO.md/da auditoria (D7) está obsoleto**: a landing hoje mede **93**. O portão "não piorar mais de 2 pontos" parte de 93 (mínimo aceitável 91).
- **`/eletropostos` já estoura o orçamento de CLS da §3.11 (≤ 0,02): 0,125** na linha de base. Não é regressão da unificação — é dívida existente, e a F-B vai tocar nessa tela.
- SEO 69 em `/login`, `/cadastro` e `/app` (provavelmente `noindex` intencional; não verifiquei a causa).
- Variação: TBT é bimodal neste ambiente (landing 27–89 ms); perf varia ≤ 2 pontos. Compare mediana, não rodada.

## 4. Tamanhos (`tamanhos-baseline.json`, `npm run medir:tamanhos`) — gzip nível 9

| Métrica | Bruto | Gzip |
|---|---:|---:|
| **CSS global** (`index-*.css`) — bloqueia todas as rotas | **65.042 B** | **11.944 B** (a auditoria mediu 11.919 com outra ferramenta; o bruto é idêntico) |
| CSS da landing (`landing-*.css`) | 19.062 B | 4.201 B |
| CSS do mapa | 14.808 B | 6.313 B |
| JS total (64 chunks) | 1.473.596 B | 471.054 B |
| Maiores: `vendor-core` / `pagamento-cartao` / `ui-kit` / `StationsMap` | 296.731 / 230.361 / 168.480 / 152.059 | 91.977 / 71.304 / 53.107 / 44.328 |
| Landing: `landing` + `landing-below` | 40.401 + 33.764 | 16.036 + 8.627 |
| **Precache do `sw.js`** (71 entradas) | **1.537.209 B** | 675.341 B |
| `modulepreload` do `index.html` | **6 chunks**: `appInfo`, `landing`, `rolldown-runtime`, `vendor-core` ×2, `vendor-icons` | |

Orçamentos da §3.11 conferem com `node scripts/medir-tamanhos.mjs --comparar e2e-visual/tamanhos-baseline.json` (CSS global ≤ +2.500 B gz; precache ≤ +40 KB; sem chunk novo no
`modulepreload`). Nota: o log do vite-plugin-pwa diz "1225,37 KiB" para o mesmo precache; a soma dos arquivos listados no `sw.js` dá 1.501 KiB (o log provavelmente não conta os ícones PNG).
Compare sempre com esta ferramenta, não com o log.

## 5. Suíte E2E (`npm run test:e2e`)

**194 testes em 18 arquivos** (a auditoria dizia 185 em 18: a Lyra acrescentou 9 em `df2aded`/`3bc8116`). `getByText`/`getByRole` somam **661** (a auditoria: 637), maior
dependência: `admin-gateway-pagamento` (170), `admin-vinculo-tarifa` (116), `admin-carteiras` (59), `landing` (58).

| Rodada | Resultado | Tempo |
|---|---|---|
| 1 | **194 passed**, exit 0 | 1,9 min |
| 2 | **194 passed**, exit 0 | 1,8 min |

0 flakes, 0 reexecuções (`retries: 0` fora de CI).

## 6. Como a fase usa isto

1. Antes de fechar a fase: `npm run test:visual`, `npm run test:contraste`, `npm run build && node scripts/medir-tamanhos.mjs --comparar e2e-visual/tamanhos-baseline.json`,
   `node scripts/medir-linha-de-base.mjs --comparar e2e-visual/lighthouse-baseline.json --json <saida>` e `npm run test:e2e`.
2. Cada diferença visual é classificada pela Íris: **esperada** (escopo da fase) ou **regressão**. Registre abaixo; só então a Lyra/Atlas regravam a baseline (política no `README.md`).
3. Mudanças **deliberadas já conhecidas**: `pub-rota-inexistente` muda se a D5 virar página 404; `landing.spec.ts:314` idem.

### Registro por fase

| Fase | Data | Diferenças esperadas (rota · o que mudou) | Regressões achadas | Baseline regravada por |
|---|---|---|---|---|
| A0 | 04/10/2026 | — (linha de base original) | — | Íris (única gravação inicial) |
