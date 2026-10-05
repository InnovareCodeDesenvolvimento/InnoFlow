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

### 7. Classificação da F-A (04/10/2026) — com prova, não com olho

Ferramenta: `VISUAL_GEO_DIR=<pasta> npx playwright test --config playwright.visual.config.ts rotas estados` grava, de cada rota×viewport, o DOM inteiro com o retângulo e o estilo
computado de CADA elemento (`e2e-visual/geometria.ts`) e a imagem da mesma captura; `node scripts/comparar-geometria.mjs --a <baseline> --b <novo> ...` classifica. Entradas: A0 = `src` do
commit `3bc8116`, novo = `bdbf8fc`, cada um rodado **2 vezes** (ruído medido). Árvore, texto, atributos e retângulos idênticos nos 123 pares (exceto o `pwa-mapa` a 1440 numa das execuções, ver abaixo).

| Resultado | Páginas |
|---|---:|
| IDENTICA (nada mudou) | 6 (as 2 imagens do documento isolado do cartão ×3) |
| ACEITA (só recolor de texto/ícone; todo pixel alterado dentro de um elemento recolorido) | **107** |
| REPORTAR (recolor de fundo de elemento de estado) → **aceitas pelo Atlas e regravadas** | **10** |

- `opacity 0.7→1` do selo "Desenvolvido por" (aceito pelo Atlas): atinge também o **logo da Innovare** (a `<img>` fica 100% opaca), 1 elemento por página admin.
- Ruído de rasterização que NÃO é diferença: blocos de 37 a 66 px em bordas/sombras (3 páginas) com DOM idêntico; mesmo tamanho de ruído aparece entre duas execuções do MESMO estado.
- **Instabilidade conhecida do `pwa-mapa` a 1440**: 1 de 4 execuções saiu com a métrica da fonte de reserva (169 retângulos 0,67 px mais estreitos). Não é do app; é o flake de fonte já descrito em §1.1.
- **Fundação não é 100% neutra**: o commit `9c9851d` já traz dois recolores (tokens `ink-softer`/`muted-foreground` e a legenda do `StatCard`). Revertendo TUDO que é contraste (tokens + 21 arquivos de `bdbf8fc` + legenda do `StatCard`) o `test:visual` dá 114/114 idêntico à A0; revertendo só `bdbf8fc` dava 111/114 (as 3 do `adm-dashboard`).
- Contraste (axe): 0 reprovados, 3.753 aprovados, 898 incompletos (landing/vidro: `bgGradient` 449, `pseudoContent` 312, `bgOverlap` 98...) — lista por motivo em `CONTRASTE-ESTADO-ATUAL.md`.
- Autoteste da ferramenta: um "fix de contraste" que também muda `px-3.5→px-4` na sidebar → `comparar-geometria` REPORTAR em 9/9 páginas testadas (retângulos e `padding-left/right` listados) e o `test:visual` falha nos 3 de 1440 (a 375/768 a sidebar está oculta).

- **DÍVIDA registrada (para a Lyra, F-B/F-D):** `ink-softer` é usado como cor de TEXTO e como cor de FUNDO de elemento de estado (Switch desligado, pino/marcador cinza). Escurecer o token para passar no contraste de texto escureceu os fundos também. Criar um token separado para fundos de estado (ex.: `--color-state-off`) e migrar `bg-ink-softer`, para que mudar um não arraste o outro.
- A aprovação do Atlas das 10 REPORTADAS e das notas (logo da Innovare 100% opaco, `flex-shrink` do IconBadge) está na mensagem de 04/10/2026; aqui só registro a decisão.

### 8. Classificação da F-B — Auth + Público (04/10/2026) — redesenho DELIBERADO, critério ≠ "só cor"

Estados comparados pela sonda: F-A = `9912d3d`/`add4e7d` (src idêntico) x F-B = `5d073cd`, 2 execuções de cada lado (`--ruido-a/--ruido-b`), 123 pares.

| Resultado | Páginas |
|---|---:|
| **Fora das 6 telas da F-B**: IDENTICA | 103 |
| **Fora das 6 telas da F-B**: ACEITA só por ruído de raster medido (70 px no documento isolado do cartão a 1440; 325 px em bordas/sombras de `adm-tariffs` a 1440; DOM idêntico) | 2 |
| **Dentro das 6 telas** (`auth-login`, `auth-cadastro`, `pub-eletropostos`, `pub-qr-carregador`, `pub-qr-conector`, `pub-rota-inexistente` × 3 larguras) | 18, todas REDESENHO (mudam retângulos, estrutura e pintura) |

- **(a) Nada fora das 6 mudou**: a landing (`/`) saiu **IDENTICA** nas 3 larguras (0 pixel, 0 retângulo) mesmo com `landing/Mascot.tsx` editado; admin (14 rotas), PWA (13), diálogos e documento do cartão idênticos. `test:visual` no estado F-B: **96 passed / 18 failed**, as 18 são exatamente as listadas.
- **D5**: `pub-rota-inexistente` deixou de ser a landing (`/nao-existe-xyz` agora é a 404 de marca, `h1` "Página não encontrada", CTA lima "Voltar ao início"). Mudança deliberada de comportamento, junto com `landing.spec.ts`.
- **(b) Critérios medidos no navegador** (`criterios-fb.visual.ts`, 54 testes verdes, 3 viewports):
  - D1 moldura escura + miolo claro: fração de pixels escuros/claros por tela (login 375: 18%/76%; 1440: 48%/49%; QR 14–19%/78–84%; eletropostos 13–24%/75–85%; 404: 93–98% escuro, de propósito).
  - D2 CTA lima: 1 por tela (login "Entrar", cadastro "Criar conta", QR "Entrar para carregar", 404 "Voltar ao início", eletropostos "Criar conta" no cabeçalho). `/c/<id>` sem conector é o SELETOR de conector: sem CTA (correto). O "Pular para o conteúdo" também é lima mas só aparece com foco.
  - D3 mascote: auth, QR e 404 têm; `/eletropostos` não tem (não está na tabela do D3).
  - D4: nenhum "painel administrativo/operadores" no login/cadastro. **`/eletropostos` ainda diz "Disponibilidade de conectores em tempo real, por operador."** (texto pré-existente, que um E2E exige): fora do D4, mas é linguagem de operador numa tela de motorista.
  - Rolagem horizontal: 0 em todas; nenhum elemento além da borda direita.
  - Teclado: 7 a 20 focáveis por tela; **todos** mudam de aparência ao receber foco, com contraste do anel ≥ **4,83:1** (login/cadastro; o pior caso), 5,7 a 9,6 nas demais; o foco cicla e não prende; a ordem de Tab não volta mais de 300 px para cima.
  - Contraste (axe): **0 reprovados**; incompletos 618 no total (a landing já não pesa nas 404: 898→618), nas 6 telas só `bgGradient`/`elmPartiallyObscuring` (3 a 10 nós por rota), que são texto sobre degradê escuro: **não** auditado pelo axe.
- **(c) CLS de `/eletropostos` = 0** (3 cargas × 3 viewports, dev + mock) e **0** no Lighthouse de produção (era 0,125).
- **(d) E2E 206/206 em 2 rodadas** (1,9 min cada, servidor próprio; a auditoria dizia 185, a A0 194). `modulepreload` 6→6; CSS global gzip 11.944→**13.183** (+1.239 B; orçamento +2.500); precache 1.537.209→1.557.086 B (+19.877; orçamento +40.960).
  Lighthouse mobile, mediana de 5 (bench 1420–1561 contra 1566–1598 da A0, CPU um pouco mais lenta hoje): `/` 93→92, `/login` 86→86, `/cadastro` 86→86, `/eletropostos` 84→**89**, `/app`(=login) 88→88; a11y/boas práticas iguais.
  **SEO 69→66 em `/login`, `/cadastro` e `/app`**: causa isolada, não é defeito — a auditoria `image-alt` (aprovada, peso 1) deixou de ser aplicável porque o mobile não renderiza mais uma `<img>` no login (o mascote do painel está em `lg:flex`); sobra a única falha antiga (`is-crawlable`, `robots.txt` intencional).
  `/login` pesa 363 KiB contra 481 (−118 KiB) na carga mobile.
- **(e) Fluxos**: `RouteError` (`localStorage["mock:sites-malformed"]="1"` + `/eletropostos`) mostra a tela de marca com "Tentar de novo"/"Voltar ao início", sem pilha nem caminho de arquivo (a mensagem técnica aparece só em DEV, `import.meta.env.DEV`); QR → "Entrar para carregar" → login → "Cadastre-se" preserva `?redirect=` nas duas telas e, criada a conta, volta ao carregador; login com `?redirect` volta ao carregador; `//host`, `https://host` e `javascript:` são ignorados e caem em `/app`; Google (mock) entra e respeita o `?redirect` em `/login` e `/cadastro`.
- **ACHADO baixo (anterior à F-B)**: `lib/authRedirect.ts` só recusa `//`. `?redirect=/\evil.example` é aceito: o navegador lê `\` como `/` e o app navega para `/evil.example` na MESMA origem (cai na 404). Não sai do site (não é redirecionamento aberto), mas deveria ser ignorado e cair em `/app`. `test.fail` em `criterios-fb.visual.ts` acusa quando for corrigido.

### 9. Classificação da F-C — PWA do motorista (05/10/2026) — redesenho DELIBERADO

Estados comparados pela sonda: F-B (`3649fa3`) x F-C (`7d8ec46`), 2 execuções de cada lado, 123 pares. `test:visual` no estado F-C: **44 falhas** (as que a Lyra reportou, conferidas uma a uma).

| Resultado | Páginas |
|---|---:|
| **Fora do PWA**: IDENTICA | 62 |
| **Fora do PWA**: ruído de raster (`adm-charge-points`, 93 px, DOM idêntico) | 1 |
| **Fora do PWA**, mudança declarada e explicada (abaixo) | 12 |
| **PWA** (`pwa-*`: 16 rotas/estados × 3 larguras, inclui os 4 estados do fluxo de recarga) | 48, todas REDESENHO |

Fora do PWA, as 12 são exatamente (nenhuma mudança de DOM, retângulo ou estilo além da lista; 0 pixel fora das regiões dos elementos alterados com margem de 64 px para sombras):
- **Fundo de estado cinza** `rgb(95,102,115)→rgb(107,114,128)` (token `state-off`, volta ao #6B7280 original da A0): trilho do Switch desligado em `/admin/gateway-pagamento` ×3 e pino do mockup da landing em `/` ×3 (+ `/nao-existe-xyz`, hoje já 404, não conta).
- **Raio 12→14 px** na variante `lime` do botão (`--radius-control`, que na F-B perdia por ordem de CSS): `pub-qr-conector` ×3 (a 1440 a mudança fica **abaixo da tolerância** do `test:visual` e só a sonda a vê; regravei as 3 mesmo assim) e o "Criar conta" do cabeçalho de `pub-eletropostos`.
- **Texto novo** do subtítulo de `/eletropostos` ("Veja o que está livre agora, atualizado em tempo real."): o bloco de texto encolhe de 453,4 para 404,5 px de largura (a 768 e 1440). Também resolve a linguagem de operador que a F-B deixou.

Critérios medidos (régua independente da Lyra, `criterios-fc.visual.ts` + `criterios-fb.visual.ts`: **126 testes verdes**; e `verificacoes-fc.visual.ts`, minha, **todos verdes**):
- D1/D2/D3, 1 `h1`, nav com 5 destinos dentro da janela, alvos ≥ 44 px, trilho lateral a ≥ lg (mesma coluna), barra embaixo < lg (mesma linha), foco por teclado em todos os focáveis com anel de contraste ≥ 3:1.
- **Contraste de TEXTO por PIXEL, reproduzido de forma independente** (`contraste-pixel.ts`: esconde o texto, fotografa o fundo real e compara a pior pixel sob a caixa de cada texto, com oclusão tratada): **1.865 textos, 60 páginas/estados × viewports, 0 reprovados, menor razão 4,51:1** (`pwa-mapa` a 1440) — bate com os 342 textos / 4,51:1 da Lyra. Inclui conectando, ao vivo, diálogo de parar, recibo, Pix (valor, pendente, sucesso, **expirado**). axe: **0 reprovados, 3.579 aprovados, 608 incompletos**.
- **Fora da foto** (o que `test:visual` não vê): depois de rolar 3.300+ px na rota mais longa, a navegação segue `fixed` dentro da janela (barra embaixo a 375/768, trilho de 96 px a 1440), o cabeçalho segue colado e o último texto não fica atrás da barra; o véu do Dialog cobre a janela inteira (0,0 → viewport) com `rgba(6,22,33,.62)` **sem desfoque**, cabeçalho e navegação ficam por baixo dele, o foco não escapa em 12 Tab/Shift+Tab, Esc fecha e o foco volta ao disparador.
- **Escopo `html[data-area="driver"]`**: ausente na carga direta de todas as rotas públicas/auth/404/cartão isolado; liga no `/app`; **some** ao navegar (SPA) para `/eletropostos`, `/` e `/login`; `--field-radius` 0,875 rem no app e 0,75 rem fora; no Admin os campos e botões ficam 12 px, o diálogo 20 px e o véu antigo (com desfoque).
- **Mascote nunca sobre dado** (nenhum em tabela/lista/valor); texto "Ao vivo" aparece **uma vez** na sessão ao vivo; recibos do motorista **nunca** mostram o stop tardio (`lateStop` é do admin) nem "R$ 0,00" em sessão em confirmação.
- **CLS do PWA logado** (3 cargas/rota, 390 e 1440): recibos **0**; demais ≤ 0,0178 (`pwa-historico-vazio` a 390 é a mais alta, ainda ≤ 0,02). **Exceção intermitente (achado)**: `/app/sessao` com sessão FAULTED a 1440 teve CLS **0,187** em 2 de 10 e 1 de 40 cargas (um bloco de carregamento de 290 px troca por 581 px de conteúdo quando a consulta da sessão chega depois do 1º quadro); no estado F-B era **todas** as cargas. Melhorou muito mas não zerou: dar ao esqueleto a altura real do bloco.
- E2E **215/215 em 2 rodadas**; vitest **439/439**; `modulepreload` 6→6; CSS global gzip 11.944→**13.941** (+1.997; orçamento +2.500); precache +28.827 B (orçamento +40.960). Lighthouse (mediana de 5, CPU mais lenta que a da A0): `/` 93→92, `/login` 86→86, `/cadastro` 86→85, `/eletropostos` 84→**89** (CLS 0), `/app`(=login) 88→87.
- `?redirect=/\host` agora é ignorado (cai em `/app`): o `test.fail` virou teste normal e passa.

**Ruído de rasterização (novo, medido)**: 4 telas com o card escuro "brand" + rosto do mascote (`pwa-sessao-vazia`, `pwa-historico-vazio`, `pwa-cartoes`, `pwa-carteira-adicionar`) têm captura NÃO determinística (DOM, retângulos e estilos idênticos; blocos de JPEG com ±1 a 29 níveis em torno de texto e rosto; 402 a 2.662 px; ~30% das capturas sob carga). Não some com `--disable-gpu`, `--disable-lcd-text` nem com 800 ms de espera. Mitigação: `ruidoRaster` em `rotas.ts` (tolerância 0,4% nessas 4) e `retries: 3` no harness (regressão real falha nas 4 tentativas; ruído passa numa e o Playwright marca "flaky"). Resultado: **3 rodadas seguidas 114/114**.

### 10. Classificação da F-D — Admin (05/10/2026) — redesenho DELIBERADO

Estados comparados pela sonda: F-C (`7d8ec46`) x F-D (`eabd99a`), 2 execuções de cada lado, 123 pares. `test:visual` no estado F-D: **54 falhas** (a Lyra reportou 94; não consegui reproduzir esse número em nenhuma execução). As 54: as 14 rotas `adm-*` + `adm-dialogo-novo-site` + `adm-dialogo-detalhe-sessao` × 3 larguras (48), `auth-login` e `auth-cadastro` a 375 (2), `pub-eletropostos` a 375 (1) e `pwa-mapa` × 3 (3).

| Resultado (sonda, 123 pares) | Páginas |
|---|---:|
| **Admin** (14 rotas + 2 diálogos × 3 larguras): REDESENHO (estrutura, retângulos e pintura mudam: sidebar `surface-dark`, `Logo`, trilha sem título repetido, `PageHeader`, tabelas, esqueleto na forma do conteúdo) | 48 |
| IDENTICA (landing, 404, QR carregador e conector, documento isolado do cartão ×2, `pwa-*` exceto abaixo, recibos, sessão, Pix) | 57 |
| ACEITA só por ruído de raster medido (os 4 cards "brand + mascote" do PWA e 70 px do documento isolado do cartão a 1440; DOM idêntico) | 6 |
| **Promoção dos defaults** (`--field-radius`/`--dialog-radius` valem no app inteiro): `auth-login` (2 campos), `auth-cadastro` (4 campos) e os botões "Como chegar" de `pub-eletropostos` (12) vão de 12 para 14 px. A 375 as 3 falham; a 768/1440 a diferença fica abaixo da tolerância do `test:visual` e só a sonda a vê (regravei as 9 mesmo assim) | 9 |
| **`pwa-mapa` × 3**: ver "Único desvio no PWA" abaixo | 3 |

`auth-login`/`auth-cadastro`: a sonda lista **só** `border-*-radius` 12→14 nos `input` (nenhum retângulo, texto ou cor muda). `white-space: nowrap` do `Badge` aparece em 55 elementos de `pub-eletropostos`, 73 de `pwa-mapa`, 2 em `pub-qr-carregador` e 1 em `pub-qr-conector` **sem mudar nenhum retângulo nem pixel** (nenhum badge quebrava linha nessas telas): aceito como latente, e as duas telas de QR ficam IDENTICA com `--aceitar-estilo white-space`. O fim do escopo `html[data-area="driver"]` não alterou nenhuma tela do PWA além de `pwa-mapa`.

**Único desvio no PWA (`pwa-mapa`, 3 imagens)** — não declarado, imperceptível a olho (recorte antes/depois lado a lado): os 16 cards de estação perdem o anel de 1 px `rgb(241,243,245)` do `box-shadow` (antes: anel + sombra tingida; agora: só a sombra tingida), 127.798 px mudam a 375 (7,6% por qualquer diferença; 1% pelo limiar de cor do `test:visual`; bordas e sombra dos cards). Provável causa (não provada): `PublicSiteCard` usa `.card-premium` (sombra literal, **fora** de `@layer`); a regra `:root[data-area="driver"] .card-elevated`, também fora de camada, vencia essa sombra no PWA e foi removida na F-D — o card do PWA passa a ter a sombra do card público (que nunca teve anel). Ficou em **commit separado** para o Atlas poder revertê-lo.

Critérios medidos (`criterios-fd.visual.ts` da Lyra: **87 verdes**; `contraste.visual.ts`: **105 verdes**; e `verificacoes-fd.visual.ts`, minha: **183 verdes**, 105 saltados por serem repetição de viewport):
- **Contraste de TEXTO por pixel, independente** (`contraste-pixel.ts`; agora rola o `<main>` interno do Admin, mede o texto em degradê e recorta a caixa do texto pelo que a corta): ADMIN 42 telas × viewports **4.764 textos**, OPERATOR 42 × viewports **3.372**, diálogos (Novo site, Detalhe da sessão) × 3 larguras **404**: **0 reprovados, menor razão 4,51:1** (badges de aviso `warning-700` sobre `warning-100`, `Sem tarifa`/`Finalizando`; nominal 4,51, sem folga). axe: **0 reprovados, 927 incompletos** (341 no Admin) — bate com a Lyra. A afirmação "0 falhas reais" **se confirma**, mas só depois de corrigir 3 falsos positivos MEUS na ferramenta (texto em degradê `text-gradient-brand` lido como transparente = 1:1; texto cortado pela rolagem horizontal do card; linha do texto tocando a borda do diálogo). Margem fina a vigiar: `accent-600` (fim do degradê) só passa em branco puro (4,54:1).
- **Perfil OPERATOR nas 14 telas** (11 abrem sem erro, sem 4xx/5xx, 1 `h1`, 0 rolagem horizontal; as 3 só-ADMIN — Tokens, Auditoria, Gateway — mostram "Acesso restrito" de marca, 1 `h1`, mascote, e o menu do operador não as lista): verde a 375/768/1440. `lateStop` ("StopTransaction tardio") aparece no detalhe da sessão do ADMIN e **nunca** para o OPERATOR.
- **CLS do Admin**, 14 telas × 390/1440 × 3 cargas × {ADMIN, OPERATOR}: **≤ 0,0004** em tudo, exceto `adm-tariffs` ADMIN a 1440 (0,0037 em 2 de 3 cargas; irrisório). Dashboard a 1440: **0,0002** (era 0,14).
- **Fora da foto — drawer mobile** (375/768): fechado = **fora do DOM**; aberto: véu cobre a janela (`rgba(6,22,33,.62)`, **sem desfoque**), painel dentro da janela (x 87 + 288 = 375), todos os links ≥ 44 px, link navega e fecha o drawer, "Fechar menu" fecha. **Achado (anterior à F-D)**: o drawer não é `role="dialog"`, **Esc não o fecha** e o foco **não entra** nele (fica no botão que o abriu; os 11 primeiros `Tab` vão para o `<main>` atrás do véu).
- E2E **222/222 em 2 rodadas** (2,0 min cada); vitest **441/441**; `modulepreload` 6→6; CSS global gzip 11.944→**13.618** (+1.674; orçamento +2.500); precache 1.537.209→1.564.124 B (+26.915; orçamento +40.960). Lighthouse (mediana de 5, `bench` 1489–1511 contra 1566–1583 da A0: CPU ~5% mais lenta): `/` 93→92, `/login` 86→85, `/cadastro` 86→85, `/eletropostos` 84→**89**, `/app`(=login) 88→85. Admin não entra no Lighthouse (build de produção sem MSW).

Regravadas **60 imagens**: as 48 do Admin + 9 (auth ×6, `pub-eletropostos` ×3) em um commit, `pwa-mapa` ×3 em outro. Num worktree limpo do `eabd99a`: `test:visual` **114/114 em 2 rodadas, 0 flaky**.

### 11. Classificação da F-E / F-F — documento isolado do cartão e fim do vocabulário deprecado (05/10/2026)

Estados comparados pela sonda (`--ids-react --margem 32`): F-D (`eabd99a`, o `src` com que a baseline F-D foi gravada) x F-F (`2b1ad88`), 2 execuções de cada lado, 123 pares, **servidor/CPU sem concorrência** (3 execuções simultâneas de 3 workers mudam as métricas de fonte do `pub-eletropostos` a 375 de 3.509 para 3.497 px de altura; sozinho, 24 de 24 execuções deram 3.509 nas três árvores — a baseline é o modo 3.509). Das 123: **98 IDENTICA**, 7 ACEITA só por ruído de raster, **18 REPORTAR**, todas explicadas abaixo (nenhuma fora desta lista). `test:visual` em `2b1ad88` falhava em exatamente 15; as 3 restantes (`pwa-sessao-vazia`) só existem na sonda.

| Causa | Páginas | O que a sonda mostra | Veredito |
|---|---|---|---|
| **F-E** — documento isolado do cartão, moldura escura de marca, card claro sobreposto, campos 14 px, botão lima, mascote | `pub-cartao-isolado-formulario` ×3, `pub-cartao-isolado-sem-opener` ×3 | 29→31 e 10→14 elementos; `body`/`div` deixam de esticar (760→601 px e 900/1024/812→386 px, o resto é o mesmo cinza do fundo); troca `img`→`header`+`span`. Todos os pixels mudam. Texto e `aria-label` preservados. | REDESENHO deliberado; régua `criterios-fe.visual.ts` (isolamento SAQ A-EP, 1 CTA lima, campos 14 px, mascote só na moldura, foco ≥ 3:1): **15 verdes** (5 testes × 3 larguras) |
| **F-F** — `PublicSiteCard` passa de `.card-premium` para a variante `surface` do `Card` (`card-elevated`) | `pub-eletropostos` ×3, `pwa-mapa` ×3 | só `position relative→static` (+ offsets) e `box-shadow` ganha o **anel de 1 px** `rgb(241,243,245)` em 12 (eletropostos) / 16–17 (mapa) cards. O único descendente posicionado é o `sr-only` de 1×1 px (mesmo retângulo). **Todo pixel alterado cai na faixa ±48 px da borda de um card; 0 pixel no interior.** | ESPERADO (ver "pwa-mapa" abaixo) |
| **F-F** — `text-gradient-brand` → cor sólida `#1B506F` | `pub-qr-conector` ×3 | só `background-image` do `<p>` do preço (gradiente `#1B506F→#248829` some) e a cor do texto; 0 pixel fora do retângulo do preço. | ESPERADO |
| F-F — card vazio da sessão vira `cardVariants({variant:"inverse"})` | `pwa-sessao-vazia` ×3 | `position relative` + `overflow hidden` num `div`, nenhum retângulo muda; pixels 0 (1440) ou os do ruído de raster do mascote (375/768). Aceito como estilo latente. | ESPERADO (não falha o `test:visual`) |

**`pwa-mapa`: por que seguia falhando depois da regravação sem o anel (`2b1ad88`).** A F-F **devolveu** o anel: a captura de `2b1ad88` é **idêntica pixel a pixel (0 px)** à baseline da F-C (`61e2230`) nos 3 viewports, e as imagens regravadas agora são **byte a byte iguais** às de `b87f37b`. A regravação "sem o anel" de `2b1ad88` ficou obsoleta no instante em que a F-F migrou o card; reverter o desvio da F-D (que o Atlas já tinha aceitado) não era necessário. Efeito novo: `/eletropostos` ganha o anel de 1 px que nunca teve (era `.card-premium`, sem anel) — imperceptível a olho, listado aqui para constar.

**Ruído que a sonda e o harness continuam vendo (não são mudança):**
- Telas "card escuro de marca + mascote" (`pwa-sessao-vazia`, `pwa-historico-vazio`, `pwa-cartoes`, `pwa-carteira-adicionar`): captura bimodal/multimodal. Repetindo só estas telas 6× em duas árvores diferentes (`2b1ad88` e `87d0343`), **os mesmos hashes de imagem aparecem nas duas** (ex.: `pwa-historico-vazio` a 375: `c0eb6a` e `b598d7` em ambas; `pwa-sessao-vazia` a 768: `fb0051` e `635ee9` em ambas) — logo a diferença de 205/170 px entre as árvores NÃO vem do código. É o que a Lyra viu como "REPORTAR sem causa" em `pwa-historico-vazio` e `pwa-carteira-adicionar`.
- `pwa-mapa` a 1440: **o stream SSE do mock (timer real de 15 s) troca "1 de 4" por "2 de 4 conectores livres" quando a captura cruza o tick** (7.757 px em `224,3344..511,3439`; texto muda, não é raster). Aconteceu numa regravação em lote (captura de 8,7 s sob carga) e foi refeita até igualar a baseline da F-C (4 de 4 execuções seguintes iguais). É a limitação já descrita em §1.1; `test:visual` a absorve com `retries`.

Regravadas **15 imagens** (`pub-cartao-isolado-*` ×6, `pub-eletropostos` ×3, `pub-qr-conector` ×3, `pwa-mapa` ×3) num worktree limpo de `2b1ad88` com `VISUAL_MAX_DIFF_RATIO=0 VISUAL_THRESHOLD=0`. Cada imagem regravada confere com 0 px contra a captura da sonda.

### 12. Classificação do acabamento pós-F-D — folga de contraste, drawer do Admin e `/app/sessao` (05/10/2026)

Estados comparados pela sonda (`--ids-react --margem 32`): `2b1ad88` x `87d0343`, 2 execuções de cada lado, sem concorrência, 123 pares: **64 IDENTICA, 50 ACEITA, 9 REPORTAR**. As 9: 7 de recolor de FUNDO (abaixo) e 2 de ruído de raster do mascote. `test:visual` em `87d0343` falhava em 32 (as listadas pela Lyra); a sonda vê **48** imagens mudarem de pixel (as outras 16 ficam abaixo da tolerância do `test:visual`).

**Tudo o que mudou de cor/estilo computado, sem exceção** (diferença entre todos os nós dos 123 DOMs, todas as propriedades de cor e de geometria; `scripts` da sonda + tabela de transições):

| Transição | Nós | Páginas |
|---|---:|---:|
| `color`/`-webkit-text-fill-color`/`text-decoration-color`/`outline-color` `rgb(180,83,9)` → `rgb(167,76,8)` (`warning-700` #B45309 → #A74C08) | 339 | 54 |
| `stroke` do mesmo `warning-700` | 213 | 27 |
| `background-color` `rgb(36,136,41)` → `rgb(31,123,37)` (`accent`/`success` #248829 → #1F7B25) | 30 | 7 |
| `background-color` `rgba(36,136,41,.4)` → `rgba(31,123,37,.4)` (landing) e `stroke` do mesmo verde (arco do medidor do `adm-dashboard`) | 3 + 3 | 3 + 3 |
| `background-color` do `warning-700` (marcadores do mapa) | 5 | 1 |

Nenhuma outra propriedade mudou: **0 retângulo, 0 propriedade de geometria, 0 texto**. O fundo recolorido (os 7 REPORTAR) fica em `adm-dashboard` ×3 (o arco do medidor e o ponto da legenda), `pub-landing` ×3 (6 selos do mock do celular) e `pwa-mapa` a 1440 (marcadores): **todo pixel alterado cai dentro de um elemento de texto/ícone/fundo recolorido** (0 fora, com margem de 32 px para o espalhamento do JPEG — a 16 px sobravam 31–562 px em volta dos mesmos elementos, diferença ≤ 34 níveis). Aceitos como recolor de fundo do mesmo token, como na F-A.

- **Drawer do Admin (Radix Dialog) e `/app/sessao` com esqueleto**: nenhuma das 123 fotos muda por causa deles. O drawer fechado está **fora do DOM** e o esqueleto some antes da foto; o que o Radix muda no DOM são os ids `useId` (`_r_N_`, `radix-_r_N_`) de `adm-dialogo-novo-site` (12 ids), `adm-dialogo-detalhe-sessao` (1) e `adm-gateway-pagamento` (4) × 3 larguras: **bijeção 1:1 conferida em todas** (`--ids-react`), nenhum `for`/`aria-*` perdeu o par. `buttonVariants.ts` só mudou comentário.
- **Ruído, não mudança** — o que a Lyra viu como REPORTAR "sem causa" em `pwa-historico-vazio` (205 px a 375) e `pwa-carteira-adicionar`: DOM, retângulos e estilos idênticos; 4 blocos 16×16 no mascote e na borda da faixa, ≤ 32 níveis. Repetindo a tela 6× em cada uma das duas árvores, **os mesmos hashes de imagem aparecem nas duas** (§11): é o modo de captura, não o código. O mesmo vale para `pwa-sessao-vazia` a 768 (170 px, caixa 32×8) e `pwa-cartoes` a 1440 (4.682 px, o rosto do mascote).

Contraste, depois do recolor (a Lyra pediu 0 reprovados; **confere**):
- **Por pixel, independente** (`contraste-pixel.ts`, `verificacoes-fc`/`verificacoes-fd`): PWA **1.875 textos, 0 reprovados, menor razão 4,76:1** ("Saldo disponível" no card petróleo); Admin (ADMIN 42 telas × larguras + OPERATOR 42 + 2 diálogos × 3 larguras) **8.540 textos, 0 reprovados, menor razão 4,79:1** (`info-700` sobre `info-100`, "Em recarga"). Antes: 4,51:1. Os 3 casos abaixo de 5 que a Lyra declarou como não tratados (4,76 / 4,79 / branco sobre `danger` 4,83) são exatamente os piores medidos: passam AA, sem folga de 0,5.
- **axe** (`test:contraste`): **0 reprovados, 3.257 aprovados, 937 incompletos**, catraca verde; `CONTRASTE-ESTADO-ATUAL.md` regerado por mim é **idêntico** ao que a Lyra deixou na árvore.
- Folga fora da foto: `criterios-pos-fd.visual.ts` (drawer como diálogo acessível: `role=dialog`, foco entra e fica preso, resto `aria-hidden`, Esc fecha e devolve o foco, crescer a janela fecha; `/app/sessao` com consulta tardia: altura do esqueleto = a do bloco real e CLS ~0) e `criterios-fe.visual.ts`: **26 verdes, 4 saltados por viewport**.

Regravadas **48 imagens** com tolerância zero, só as classificadas (adm-charge-points, -connectors, -dashboard, -dialogo-detalhe-sessao, -financeiro, -gateway-pagamento, -sessoes, -tariffs; pub-eletropostos, -landing, -qr-carregador, -qr-conector; pwa-mapa, -recibo-stop-nao-confirmado-cartao/-carteira, -sessao-ao-vivo, -sessao-parar-dialogo, -travado-historico — as larguras em que a sonda viu pixel mudar); cada uma confere 0 px com a captura da sonda (exceto `adm-charge-points` a 768: 54 px, ≤ 2 níveis, o ruído já medido). **As 4 telas de mascote ruidosas NÃO foram regravadas** (passam dentro da tolerância e das tentativas).

Fechamento: `test:visual` **114/114 em 3 execuções seguidas** (2 com a configuração padrão — 0 "flaky" — e 1 com `VISUAL_RETRIES=0`, 2,7–2,8 min cada).

**Armadilha do harness que apareceu nesta rodada:** 3 execuções simultâneas (3 workers cada) do `test:visual`/da sonda **mudam as métricas de fonte** (`pub-eletropostos` a 375: altura 3.497 em vez de 3.509; `auth-cadastro` a 375 com 14 retângulos 0,4–0,9 px mais estreitos). Classificar com a CPU livre ou repetir.

### Registro por fase (continuação)

| Fase | Data | Diferenças esperadas (rota · o que mudou) | Regressões achadas | Baseline regravada por |
|---|---|---|---|---|
| A0 | 04/10/2026 | — (linha de base original) | — | Íris (única gravação inicial) |
| F-A | 04/10/2026 | **107 imagens regravadas** (ver §7): só recolor de TEXTO/ÍCONE (tokens `ink-softer`/`muted-foreground` #6B7280→#5F6673, 26 usos de `ink-subtle` como texto→`ink-softer`, sidebar `white/35→60` e `white/50→70`, selo "Desenvolvido por" sem `opacity-70`, ícone de busca/"R$" do Input, legenda do `StatCard`). Geometria idêntica nos 123 pares. | **10 imagens reportadas e DEPOIS aceitas pelo Atlas** (recolor de FUNDO de elemento de estado por efeito colateral do token, `bg-ink-softer`): trilho do Switch desligado (`/admin/gateway-pagamento` ×3), pino cinza do mockup da landing (`/` e `/nao-existe-xyz` ×3 cada, 6 imagens) e marcador/legenda "Fora do ar" do mapa (`/app/mapa` a 1440). Regravadas num worktree limpo do HEAD (`9912d3d`): `test:visual` **114/114 em 2 rodadas**. Mudança latente aceita com nota: `flex-shrink 1→0` no `IconBadge` do EmptyState (já nas 107). | Lyra/Atlas (aprovação do Atlas, 04/10/2026), classificado e gravado pela Íris (107 em `6ada5dc`, +10 no commit seguinte) |
| F-B | 04/10/2026 | **18 imagens regravadas** (REDESENHO deliberado, §8): `auth-login`, `auth-cadastro`, `pub-eletropostos`, `pub-qr-carregador`, `pub-qr-conector`, `pub-rota-inexistente` × 375/768/1440. `pub-rota-inexistente` mudou de comportamento (D5: landing → 404). | nenhuma na F-B. Achado baixo anterior: `?redirect=/\host` (§8). `/eletropostos` ainda fala "por operador". | Lyra/Atlas (pedido do Atlas), classificado e gravado pela Íris |
| F-C | 05/10/2026 | **54 imagens regravadas**: as 16 rotas/estados `pwa-*` × 3 larguras (48, REDESENHO; inclui os 4 estados do fluxo de recarga: conectando, ao vivo, diálogo de parar, recibo concluído), `pub-eletropostos` ×3 (subtítulo novo + raio 14 do CTA) e `pub-qr-conector` ×3 (raio 14 do CTA lima). | nenhuma regressão. Achado: CLS intermitente 0,187 em `/app/sessao` (FAULTED) a 1440. Ruído de raster em 4 telas (tolerância + retries). | Lyra/Atlas (pedido do Atlas), classificado e gravado pela Íris |
| F-D | 05/10/2026 | **60 imagens regravadas** (§10): Admin — as 14 rotas `adm-*` + `adm-dialogo-novo-site` + `adm-dialogo-detalhe-sessao` × 3 larguras (48, REDESENHO); promoção dos defaults de raio 12→14 px em `auth-login` e `auth-cadastro` × 3 (campos) e `pub-eletropostos` × 3 (botões "Como chegar"); `pwa-mapa` × 3 (anel de 1 px dos cards de estação some, em commit separado). | nenhuma no Admin. Achados: `pwa-mapa` perdeu o anel dos cards (não declarado, imperceptível); drawer mobile sem `role=dialog`, sem Esc e sem foco para dentro (anterior à F-D). Falsos positivos meus na ferramenta de contraste corrigidos (degradê, recorte). | Lyra/Atlas (pedido do Atlas), classificado e gravado pela Íris |
| F-E/F-F | 05/10/2026 | **15 imagens regravadas** (§11): documento isolado do cartão ×6 (F-E, redesenho), `pub-eletropostos` ×3 e `pwa-mapa` ×3 (F-F: card de estação passa a `card-elevated`, anel de 1 px; `pwa-mapa` volta byte a byte ao da F-C) e `pub-qr-conector` ×3 (preço sem gradiente). | nenhuma regressão. Achado: a regravação de `pwa-mapa` "sem o anel" (`2b1ad88`) foi invalidada pela F-F; `/eletropostos` ganha o anel que nunca teve. | Lyra/Atlas (pedido do Atlas), classificado e gravado pela Íris |
| Acabamento pós-F-D | 05/10/2026 | **48 imagens regravadas** (§12): só recolor — `warning-700` #B45309→#A74C08 (texto/ícone, 339 nós) e `accent`/`success` #248829→#1F7B25 (fundo de 30 nós: arco/ponto do `adm-dashboard`, selos do mock da landing, marcadores do mapa). 0 retângulo, 0 propriedade de layout, 0 texto; drawer Radix e esqueleto de `/app/sessao` não aparecem em nenhuma foto (só o deslocamento dos ids `useId`, bijeção conferida). | nenhuma. Contraste por pixel 0 reprovados (PWA 1.875 textos, menor 4,76; Admin 8.540, menor 4,79) e axe 0/3.257/937. | Lyra/Atlas (pedido do Atlas), classificado e gravado pela Íris |
