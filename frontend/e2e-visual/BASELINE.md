# Linha de base A0 (04/10/2026) — unificação do design system

Autora: Íris. Congelada **antes** de qualquer mudança de código da F-A. Frontend no commit `3bc8116` (árvore de `frontend/src` limpa no momento
da captura; HEAD ainda era `3bc8116` ao final). Este arquivo é o contrato de "nada regrediu": a Lyra e a Íris comparam contra ele ao fim de cada fase.

Ambiente da medição: Windows 10, Node 24.12, Playwright 1.63 (Chromium headless), Chrome instalado para o Lighthouse 13, Xeon E5-2650 v4 (24 threads),
PC de desenvolvimento compartilhado com outros agentes (índice `benchmarkIndex` do Lighthouse 1.565–1.598 — **só compare medições com índice próximo**).

## 1. Regressão visual (`npm run test:visual`)

| Item | Valor |
|---|---|
| Imagens na baseline | **222** (132 até a §15 + **90 novas do lote 1**, §16) = 72 a 375 px, 75 a 768 e 75 a 1440 (faltam as 3 de Configurações · Geral/E-mail/WhatsApp a 375, §16) — `baseline/win32/<viewport>/<id>.jpg`, fora os `ds-*` do catálogo |
| Peso | **≈ 17,2 MB** (4,2 / 5,5 / 7,5 MB por viewport; eram 10,3 MB até a §15) — JPEG q70 |
| Testes | **189** (44 rotas × 3 = 132 + 19 testes de estados × 3 = 57; 3 são `fixme` por defeito aberto: Configurações a 375 px) |
| Tempo | ≈ 6 min (3 workers; o harness cresceu de 120 para 189 testes e a CPU é compartilhada) |

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

**ATENÇÃO: a regra de orçamento mudou em 05/10/2026 (§17): a tabela acima é a A0 (histórico); a baseline vigente de `tamanhos-baseline.json` e a regra por chunk estão na §17.** Até 04/10 os orçamentos da §3.11 conferiam com `node scripts/medir-tamanhos.mjs --comparar e2e-visual/tamanhos-baseline.json` (CSS global ≤ +2.500 B gz; precache ≤ +40 KB; sem chunk novo no
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

### 13. Baseline do catálogo `/__ds` (05/10/2026) — `npm run test:visual:catalogo`

**68 imagens** (24 a 375, 22 a 768, 22 a 1440; ≈ 1,3 MB, JPEG q70, em `baseline/win32/<viewport>/ds-*.jpg`) gravadas por mim com `npm run test:visual:catalogo:update` no `HEAD` da Lyra (`87d0343` + as baselines acima). Uma foto por seção (13) + hover do botão lima, foco do campo, diálogo aberto e toast; seção mais alta que a janela vira vários blocos (`-1`, `-4-2`...): a 375 são "ErrorState e LoadingScreen", "404 e erro de tela inteira" e "Estados vazios". Conferi a mão 2 imagens (`ds-tokens` a 1440, `ds-dialogo-aberto` a 375: os tokens novos `accent-600` #1F7B25 e o véu sem desfoque aparecem). **Não é uma classificação**: o catálogo não tinha baseline antes, então não há "antes" para comparar.

**Verde de verdade: gravação + 8 comparações seguidas, `VISUAL_RETRIES=0`, 3 workers, 45/45 em todas.** Chegar nisso custou, e o motivo vale registrar:
- A primeira versão do teste (fotografar a seção inteira com `locator.screenshot()`) **nunca ficou verde duas vezes seguidas**: 1 a 4 das 45 falhavam POR EXECUÇÃO contra uma baseline gravada instantes antes, sempre nas seções mais altas que a janela. Mesmo com 1 worker e sem carga (3 de 6, 2 de 6 e 2 de 6 em 3 execuções só das duas piores).
- **Causa raiz:** o Playwright, para fotografar um elemento maior que a janela, rola e captura além dela; as unidades `svh` do `LoadingScreen` inline (`min-h-[56svh]`) e do `ErrorState` (`min-h-[60svh]`) mudam no meio da captura. Visto: o card do LoadingScreen com 420 px numa foto e 455 px na outra, e o recorte deslocado em 1 px ou 34–36 px (o título da seção cortado numa foto, inteiro na outra). A "Estados vazios" (826 px numa janela de 812) só falhava a 375 pelo mesmo motivo. Confirmei medindo `innerHeight`/altura dos filhos antes e depois de rolar e de fotografar: com o bloco DENTRO da janela, tudo estável.
- **Não resolveram** (medidos, não suposição): esperar o layout assentar (10 amostras de 100 ms), alinhar o bloco à grade de pixels, fixar a rolagem, `fullPage`+`clip` (piorou: 16 de 45) e afrouxar o limiar de pixels (com `threshold` 0,2/0,02 de razão ainda falhava 1 em 6).
- **Resolveu:** nunca pedir foto maior que a janela. `fotografarEmBlocos` desce para os filhos (e para os filhos dos filhos, se preciso) até caber. Sem nenhuma tolerância extra.
- **Se um dia o catálogo ganhar uma seção mais alta que a janela**, ela vira blocos sozinha (a conta é por viewport). Se alguém trocar de volta para a foto única, o sintoma é este: falha intermitente só nessa seção.

Os testes do catálogo estão **fora** do `npm run test:visual` (`rotas estados`) de propósito; rode `npm run test:visual:catalogo` quando mexer em `components/ui`, tokens ou `src/dev/DesignSystemCatalog.tsx`.

### 14. Classificação do redesenho de `/admin/gateway-pagamento` — commit `7dfc401` da Lyra (05/10/2026)

Estados comparados pela sonda (`--ids-react --margem 32`, só esta rota × 375/768/1440): `631f038` (antes) x `7dfc401` (depois), **2 execuções de cada lado**, sem concorrência de harness (a CPU da máquina não estava livre: 58% antes da 1ª rodada do `test:visual`, 29% antes da 2ª, por causa de outros agentes). Veredito da sonda: **3 REPORTAR, 0 IDENTICA** — esperado, é um redesenho; o que importa é que tudo o que mudou está abaixo e nada fora disso. As duas execuções de cada lado são byte a byte iguais entre si (md5), e a baseline que estava no repositório confere com a captura de `631f038` em **0 px**: a baseline anterior era válida e o redesenho é a única diferença.

| Medida | 375 | 768 | 1440 |
|---|---|---|---|
| Altura do documento antes → depois | 3.271 → 3.536 (+265) | 2.277 → 2.442 (+165) | 2.089 → 2.198 (+109) |
| Largura da raiz da página | 343 = 343 | 672 = 672 | **896 → 1.120** (some o `max-w-4xl` e a margem de 112 px: é a largura do shell, igual a Tarifas/Financeiro) |
| Rolagem horizontal (`main` e documento) | 0 / 0 | 0 / 0 | 0 / 0 |
| Controles do miolo abaixo de 44 px de altura | **14 → 3** (os 2 interruptores têm trilho de 24 e alvo ampliado, medido pelo ponteiro; o 3º é o selo "Desenvolvido por" do rodapé) | 16 = 16 | 16 = 16 |

**Tudo o que mudou, conferido por texto, geometria e foto (nada fora desta lista):**
- **Declarado e confirmado:** raiz sem `max-w`; `Alert` (aviso do webhook, banner da origem, nota do ambiente) e `InlineCode`; barra de salvar em `Card` (estática no fim da página, 108 px de altura a 375; ver "grudada" abaixo); títulos de seção `h3 → h2` (Ambiente, Credenciais da Cielo, Testar conexão, Webhook; Pix e Cartão já eram h2); alvos de toque de 44 px a 375 (botões "Informar", "Testar conexão", "Copiar", "Gerar segredo", "Descartar", "Salvar alterações" passam de 32–40 para 44 px e os campos de 38 para 46); aviso de conta Cielo compartilhada no webhook.
- **Mudou e não estava no resumo (decorre do mesmo redesenho; só registrar):** (a) o texto de apoio da seção Webhook deixa de dizer "Cadastre a URL e o header abaixo no Site da Cielo, para a plataforma ser avisada…" e passa a "Dados que o servidor ainda guarda para o webhook — somente para consulta ou para limpar. O InnoFlow não usa webhook nesta conta."; (b) "…é o que a Cielo **vai enviar** no header…" vira "…é o que a Cielo **enviaria** no header…"; (c) os nomes dos segredos ("MerchantKey", "Client Secret…", "Segredo do header") deixam de ser `span` e viram `label` ligado ao campo; (d) a nota "A prontidão considera só o que já está salvo…" ganha uma caixa cinza (`Alert` muted) em vez de linha solta; (e) a 375 o selo "Não configurada" do "Segredo do header" passa para baixo do rótulo; (f) campos de URL/cabeçalho do webhook de 38 → 42 px (≥ 768); (g) os cartões Pix/Cartão têm 4 px a menos de padding lateral (a 768, "Pix" em x=96, antes 100); (h) a barra de salvar deixa de ter a borda superior de 1 px (agora é card).
- **Não mudou:** ordem das seções (H1, Pix, Cartão, Ambiente, Credenciais, Testar conexão, Webhook), lista de controles (mesmos `aria-label`), textos das outras seções, larguras a 375 e a 768, controles cortados (0 elementos com borda direita > largura da janela, nas duas árvores). Os campos "URL do webhook" e "Nome do header" têm 192 px a 375 e truncam o valor (o URL aparece como `https://api.innofl…`): igual ao de antes, não é regressão.
- Mudanças em componentes compartilhados do commit (`Card`/`CardTitle as`, `Dialog` (alvo do X), `Switch` (alvo 60×48), `buttonVariants` (tamanhos `touch`, `touch-sm`, `field`)): **nenhuma das outras imagens muda** (`test:visual` 117/117, abaixo). O `Dialog` e o `Switch` só ampliam área de toque por pseudo-elemento (invisível).

**Prova do que a foto não mostra** (`verificacoes-gateway.visual.ts`, 60 testes, 3 larguras): barra de salvar **estática** sem alteração (a 375 fica em y=2.756 com o `main` rolado ao topo, abaixo da dobra de 812: não tapa nada) e **`sticky`** com alteração (fundo em y=736 de 768 do `main`; ao topo, já visível); interruptor com alvo >= 44 px **medido pelo ponteiro** (`elementFromPoint` 10 px acima e abaixo do trilho); 1 `h1`; ordem das seções; 0 rolagem lateral; todo controle do miolo >= 44 px a 375.

**Baselines regravadas — 3 imagens** (`adm-gateway-pagamento` ×375/768/1440), num worktree limpo de `7dfc401` com `VISUAL_MAX_DIFF_RATIO=0 VISUAL_THRESHOLD=0`: cada uma confere **0 px** com a captura da sonda nas duas execuções (md5 igual). **Baselines novas — 6 imagens**: o gateway não tinha baseline de diálogo; `adm-dialogo-gateway-producao` (confirmação de produção: palavra digitada) e `adm-dialogo-gateway-salvar` (resumo + aviso de produção + senha) × 3 larguras, no mesmo fluxo (1 teste em `estados.visual.ts`). Estabilidade medida: 5 comparações seguidas com tolerância ZERO e `retries 0`, 15/15 idênticas. Sensibilidade: trocar o `tone` do `Alert` do diálogo e tirar o `size="touch"` dos botões faz os 3 testes falharem (22.018, 8.671 e 7.268 px). A baseline total passa de **123 → 129** imagens (43 por largura) e de 114 → 117 testes.

**Contraste** (a Lyra pediu 0 reprovados; **confere**):
- **Por pixel, 24 estados × 3 larguras = 72 medições, 6.685 textos, 0 reprovados** (menor razão **4,83:1**, branco sobre `danger` no botão "Selecionar produção" — o mesmo 4,83 já conhecido). Estados: as 7 contas de gateway do mock (nada configurado, pronto, produção, sem chave, 503 no GET, segredos ilegíveis, sandbox restrito), diálogo de produção vazio e confirmável, produção pendente com a barra grudada, diálogo de salvar vazio e com senha, par incompleto (erro na barra), segredo aberto e gerado, resultado do teste de conexão (OK, credencial recusada, não configurado, ilegível, 503), aviso "o teste usa o que está salvo", senha errada, 503 ao salvar, 409 com pagamentos em andamento. Ressalva: os 3 estados de resultado do teste com o host longo a 375 foram medidos ignorando esse texto (o "reprovo" dele vem do vazamento abaixo, não de cor); o estado de carregamento (esqueleto) não foi medido.
- **axe** (`test:contraste`): **0 reprovados, 3.254 aprovados, 937 incompletos**; catraca verde. **3.257 → 3.254 explicado:** o único nó que sai é o `<p aria-live>` "Nenhuma alteração pendente." da barra de salvar, nas 3 larguras (−1 em cada; lista de nós aprovados antes × depois conferida). Na versão antiga a barra era sempre grudada no pé da janela e entrava na 1ª tela; agora ela fica no fim da página, fora da área visível do `main`, e o axe só avalia o que está na janela. Não é piora de contraste (a medição por pixel acima percorre a página inteira e mede essa frase). Os 937 incompletos não mudaram.
- **Achado (não bloqueia a baseline; não aparece em nenhuma foto): o resultado do "Testar conexão" vaza do cartão a 375 px.** O host do passo ("apiquerysandbox.cieloecommerce.cielo.com.br · HTTP 400 · 120 ms") é um `<p text-xs>` sem quebra de palavra: mede 269 px num espaço de 237 e atravessa a borda do cartão do passo. É **pré-existente** (28 px de vazamento em `631f038`, 32 px agora, por causa do padding do `Alert`), por isso não é regressão da `7dfc401`, mas o redesenho declarou "sem rolagem horizontal". Cobertura: teste marcado `fail` a 375 em `verificacoes-gateway.visual.ts` até a correção (quebra de palavra no `<p>` do host); o `main` não rola de lado (o texto fica visível por cima da borda).

Fechamento: `test:visual` **117/117 em 2 rodadas seguidas, 0 flaky**, configuração padrão, num worktree limpo de `f9de24b` + as imagens/teste desta rodada (3,1 e 3,4 min). A árvore principal tem trabalho concorrente da Lyra (`/app/perfil`: rota nova em `rotas.ts` sem baseline, `Layout.tsx` do PWA, mocks) que não foi classificado aqui.

### 15. Classificação do "Meu perfil" (`/app/perfil`) e da pílula avatar+nome no cabeçalho do app — commit `7c923d1` da Lyra (05/10/2026)

Estados comparados pela sonda (`--ids-react --margem 32`, todas as rotas e estados): `f9de24b` (antes) x `7c923d1` (depois), **2 execuções de cada lado**, 123 pares (a rota nova `pwa-perfil` só existe do lado novo: 3 fotos sem "antes"). Resultado: **74 IDENTICA, 1 ACEITA (ruído, `adm-charge-points` a 768), 48 REPORTAR**. As 48 são exatamente as **16 rotas/estados `pwa-*` × 3 larguras** (`pwa-inicio`, `-mapa`, `-carteira`, `-carteira-adicionar`, `-cartoes`, `-historico-vazio`, `-sessao-vazia`, `-recibo-fechada-pelo-servidor`, `-recibo-stop-nao-confirmado-cartao`/`-carteira`, `-travado-historico`, `-travado-sessao-faulted` e os 4 estados do fluxo de recarga: `-sessao-conectando`, `-sessao-ao-vivo`, `-sessao-parar-dialogo`, `-recibo-concluida`). **Nenhuma rota de auth, pública ou do Admin mudou** (os usuários novos do mock não aparecem em nenhuma tela do Admin).

**Prova de que só a região do cabeçalho mudou** (`prova_header`, comparação nó a nó dos DOMs completos + pixels, nas 48):
- **Fora do `<header>`: 0 nós diferentes em 47 das 48** (mesma árvore, mesmo texto, atributos, retângulo, estilos de layout e cores, caminho a caminho). A 48ª é o ruído do SSE do mock descrito abaixo.
- **Retângulo do `<header>` idêntico em todas** (`0,0,<largura>,56`) e **altura do documento idêntica em todas**: nada abaixo do cabeçalho se desloca.
- **O que muda dentro dele:** o `<span>` do 1º nome (`text-xs`, cor `rgb(186,201,211)`, x=143,7) vira um `<a href="/app/perfil" aria-label="Meu perfil, <Nome>">` de **87,9 × 44 px** (x=143,7, y=5,5; o alvo de toque cabe nos 56 px do cabeçalho) com um avatar de iniciais de 32 × 32 (decorativo, `aria-hidden`, `bg-white/10` + anel de 1 px) e o nome, que passa de x=143,7 para **x=189,7**. O botão "Sair" não se move (x=315 a 375; x=1380 a 1440) e a pílula termina em x=232, longe dele.
- **Pixels:** em **44 das 48** a diferença (> 16 níveis) cabe inteira na caixa `144,11 – 223,44` (ou `144,16 – 218,33`), dentro do cabeçalho; as outras 4 são ruído já conhecido, provado abaixo:
  - `pwa-mapa` a 1440: o SSE do mock troca "1 de 4" por "2 de 4 conectores livres" e "0/1" por "1/1" (3 nós de texto) quando a captura cruza o tick de 15 s. A captura A1 pegou "1 de 4"; A2, B1 e B2 pegaram "2 de 4" (A2 x B2: 0 px abaixo do cabeçalho; a baseline que estava no repositório confere com a A2 em 0 px).
  - `pwa-carteira-adicionar` a 375 (212 px abaixo do cabeçalho): é A1 x A2 (a mesma árvore, sem mudança, difere 212 px); B1 x B2 = 0.
  - `pwa-historico-vazio` a 375 (5 px) e a 1440 (3 px, todos de 17 níveis, ao lado do mascote): modo de captura do card escuro com mascote (§11): A1 x B2 = 0 px a 375; a 1440 o máximo de diferença em todo o trecho abaixo do cabeçalho é 17 níveis.
- Nenhum outro estilo mudou: 0 diferença de `color`/`background`/geometria fora da pílula. O contraste da pílula: o nome (`ink-softer` sobre o petróleo do cabeçalho) é o mesmo texto e a mesma cor de antes; a inicial do avatar passou no axe (nó novo "aprovado" em todas as rotas, ver abaixo).

**Baselines regravadas — 48 imagens** (as 16 × 3 acima) **+ 3 novas** (`pwa-perfil` × 375/768/1440, persona `driver`, 1ª baseline, sem "antes"), num worktree limpo do HEAD, `VISUAL_MAX_DIFF_RATIO=0 VISUAL_THRESHOLD=0`. Detalhe que custou: 6 das 48 (`pwa-carteira-adicionar` a 768/1440, `pwa-historico-vazio` e `pwa-sessao-vazia` a 1440, `pwa-cartoes` e `pwa-sessao-vazia` a 768) NÃO eram reescritas pela atualização porque essas rotas têm `ruidoRaster` (tolerância de 0,4% que vale também com `VISUAL_MAX_DIFF_RATIO=0`) e a diferença do cabeçalho (≈ 1.073 px) cabe nela: **apaguei as 6 e regravei**, senão a baseline ficaria com o cabeçalho antigo e `test:visual` passaria sem provar nada. Das 51 imagens, **46 conferem 0 px com a captura da sonda** (B1 ou B2); 5 ficam a 151 px / ≤ 5 níveis (3 telas) ou no outro modo do mascote (`pwa-cartoes` a 375 e a 1440): é o ruído medido na §9/§11. Ao regravar vi que o modo de `pwa-sessao-vazia` a 375 e de `pwa-cartoes` a 1440 muda de uma execução para outra (7.994 px / 29 níveis e 4.682 px / 29 níveis entre os dois modos); regravei até cair no modo da sonda.

**Régua da Lyra** (`criterios-perfil.visual.ts`): **8 verdes** (320/390/768/1440 × 2 contas; 16 saltados por projeto, por desenho).

**Contraste** (a Lyra pediu 0 reprovados; **confere**):
- **Por pixel, 15 estados × 3 larguras = 45 medições, 1.698 textos, 0 reprovados, menor razão 4,83:1** (`verificacoes-perfil.visual.ts`): tela normal, dados com erros de validação, falha de rede/5xx/429 ao salvar, "Dados salvos.", erros de validação da senha, 403 de senha atual errada, "Mostrar senhas", conta com CPF mascarado e "Alterar CPF" aberto, falha ao carregar (rede e 5xx), conta só-Google ("Definir senha") e a pílula em `/app`.
- **axe** (`test:contraste`): **0 reprovados, 3.386 aprovados, 952 incompletos**; catraca verde (a mesma contagem que a Lyra mediu). **3.254 → 3.386 (+132) e 937 → 952 (+15) explicados:** (a) a rota nova `pwa-perfil` = **+96 aprovados e +15 incompletos** (32 e 5 por largura); (b) **+36 aprovados** (12 por largura, 1 por rota `pwa-*` com cabeçalho na janela) = a inicial do avatar, que o axe passa a avaliar e aprova (conferido listando os nós aprovados de `/app` antes x depois: `<span class="ml-1 truncate text-xs text-ink-softer">Carla</span>` vira avatar `aria-hidden` + `<span class="truncate">Carla</span>`; a diferença é só esse nó novo, 375 e 1440).
- **Correção na minha ferramenta, achada nesta rodada:** `contraste-pixel.ts` dava falso positivo ("1,9:1", "1,07:1") em texto cuja 1ª linha de pixels ficava sob o cabeçalho sticky do app (o fundo petróleo do cabeçalho entrava na conta). A checagem de oclusão amostrava os cantos da caixa a 1 px para dentro; passa a amostrar a 0,5 px.

**Geometria que a foto não mostra** (`verificacoes-perfil.visual.ts`, seção 2): cabeçalho de **56 px** em `/app`, `/app/mapa`, `/app/carteira`, `/app/carteira/cartoes`, `/app/carteira/adicionar`, `/app/sessoes` e `/app/perfil`, nas 3 larguras, com a pílula de **44 px** de altura, sem invadir o "Sair" e sem rolagem horizontal; e, a 375, um nome longo ("Maximiliano-Bartolomeu") trunca e não empurra o "Sair" para fora da janela.

Fechamento: `test:visual` **120/120 em 2 rodadas seguidas, 0 flaky**, configuração padrão e `--update-snapshots=none`, num worktree limpo de `47b2291` (HEAD no momento) + as 51 imagens desta rodada (3,3 e 3,5 min; CPU a 57–58% por outros agentes). A árvore principal tem trabalho concorrente (Admin "Comunicação", diálogos de recarga remota/estorno) que não foi classificado aqui.

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
| Catálogo /__ds | 05/10/2026 | **68 imagens gravadas** (§13), 1ª baseline do catálogo (sem "antes"). Harness ajustado: seção mais alta que a janela é fotografada em blocos. | nenhuma regressão de produto. Defeito do teste do catálogo (flaky por `svh` + captura maior que a janela) corrigido e medido: 8 comparações seguidas 45/45, `retries 0`. | Íris (gravação e classificação; a Lyra só propõe) |
| Gateway de pagamento | 05/10/2026 | **3 imagens regravadas + 6 novas** (§14): `adm-gateway-pagamento` ×3 (redesenho da `7dfc401`: raiz sem `max-w` — 896 → 1.120 px a 1440 —, `Alert`/`InlineCode`, barra de salvar em card, h3 → h2, alvos de 44 px a 375, aviso de conta Cielo compartilhada no webhook) e `adm-dialogo-gateway-producao` / `adm-dialogo-gateway-salvar` ×3 (1ª baseline, sem "antes"). | nenhuma regressão da `7dfc401`. Achado pré-existente: o host do resultado do teste de conexão vaza do cartão a 375 px (28 → 32 px; teste `fail` até corrigir). Contraste por pixel 0 reprovados (72 medições, 6.685 textos, menor 4,83) e axe 0/3.254/937 (−3 explicado). | Lyra/Atlas (pedido do Atlas), classificado e gravado pela Íris |
| Meu perfil + cabeçalho do app | 05/10/2026 | **48 imagens regravadas + 3 novas** (§15): as 16 rotas/estados `pwa-*` × 3 (o `<span>` do nome vira a pílula avatar + nome, link "Meu perfil" de 88 × 44 px no cabeçalho de 56 px; o resto da tela e a altura do documento idênticos) e `pwa-perfil` × 3 (1ª baseline, sem "antes"). | nenhuma regressão. Cabeçalho idêntico em altura e retângulo nas 48; 0 nós diferentes fora dele (47 de 48; a 48ª é o tick do SSE do mock). Contraste por pixel 0 reprovados (45 medições, 1.698 textos, menor 4,83) e axe 0/3.386/952 (+132/+15 explicados). Ferramenta de contraste corrigida (falso positivo sob cabeçalho sticky). | Lyra/Atlas (pedido do Atlas), classificado e gravado pela Íris |
| Lote 1 (05/10/2026) | 05/10/2026 | **37 imagens regravadas** (§16): sidebar do Admin a 1440 (16), Pagamentos e detalhe da sessão (6), login/cadastro (6), rodapé legal da landing e de /eletropostos (6), Meu perfil (3), mais **6 da rodada de textos** (Devoluções); **90 novas**: recuperação de senha (15), Configurações (9), Backups refeito (9), Chargebacks e Devoluções (6), tour do Inno e Primeiros passos (18), diálogos de recarga remota, estorno, chargeback e devolução (33). | **REGRESSÃO devolvida à Lyra (não regravada):** Configurações · Geral/E-mail/WhatsApp a 375 px (título do card espremido pelos selos: h2 com 0, 80 e 109 px). Achados: `/eletropostos` a 375 px com texto de 4,42:1 (pré-existente); `app-hooks` +61% (27 → 44 KB gzip). | Lyra/Atlas (pedido do Atlas), classificado e gravado pela Íris |

### 16. Classificação do lote 1 (05/10/2026): Configurações, Backups, Chargebacks, Devoluções, LGPD, tour do Inno, recuperação de senha, recarga remota e estorno

**Método.** Sonda `comparar-geometria` (`--ids-react --margem 32`, **2 execuções de cada lado**, sem outro harness rodando): ANTES = `b8d10de` (o `src` que gerou a baseline de `pwa-perfil`) **com `SecretField.tsx` devolvido ao lugar** (o commit `2a93a37` moveu o arquivo para `components/admin/` sem atualizar os 2 imports do gateway: nesse commit a tela do gateway nem compila; só o meu ANTES foi consertado, nada no repositório) × DEPOIS = `7132bf7`. 132 pares: **45 IDENTICA, 15 ACEITA (ruído de raster medido: telas de mascote e nome do cabeçalho do PWA), 72 REPORTAR**, todos explicados abaixo. A rodada de textos (`2e4e731`) foi classificada à parte (última linha desta seção). Duas ferramentas minhas, só no scratchpad (não versionadas): *prova da sidebar* (DOM fora do `aside` por multiconjunto de assinaturas, pixels fora da coluna da sidebar, rodapé deslocado) e *prova de deslocamento* (cada nó do ANTES procurado no DEPOIS com mesma tag/texto/atributos/x/largura/estilo: só `dy` muda; o resto é a lista do que ENTROU ou SAIU).

| Causa | Imagens afetadas | O que a prova mostra | Veredito |
|---|---|---|---|
| **(a) Sidebar do Admin** — Configurações no lugar de Comunicação, + Backups, Chargebacks, Devoluções de saldo | 1440: as 14 rotas `adm-*` + `adm-dialogo-novo-site` + 2 do gateway = **16 regravadas** (+ `adm-pagamentos` e o detalhe da sessão, que mudam por (b)). **375 e 768: 0 px de diferença em 32 de 36 imagens** (a sidebar é um drawer fechado: os 4 itens entram no DOM, nenhum pixel muda) | Fora do `aside`: 0 nós diferentes em 12 das 14 rotas. Exceções, nenhuma visual: `adm-dashboard` ganha 1 `<p role=status class=sr-only>` (1×1 px; a região de aviso do card Primeiros passos) e `adm-auditoria` ganha 6 `<option>` no seletor de ação (Crédito de Pix, Config. gateway, Senha redefinida, Exclusão de conta, Estorno, Chargeback; seletor fechado, 0 px). Ids `useId` deslocados em gateway e diálogos (bijeção conferida). A 1440 a coluna da sidebar muda (4 itens, +192 px de altura da lista) e, nas 5 rotas curtas (Tokens, Pontos de recarga, Conectores, Sites, Tarifas) + `adm-dialogo-novo-site`, **a foto cresce de 1091 para 1283 px** (o harness cresce a janela até o rolador de maior altura, que é a lista da sidebar numa janela de 900 px): cabeçalho e `main` idênticos (0 px; ±3 níveis em 3 linhas acima do rodapé, que desceu), a faixa nova é fundo liso e o rodapé é idêntico; no diálogo de novo site o diálogo, centrado, desce 96 px | REDESENHO DECLARADO |
| **(b) Pagamentos e detalhe da sessão** | `adm-pagamentos` ×3, `adm-dialogo-detalhe-sessao` ×3 = **6 regravadas** | Só ENTRA: link Chargebacks, botão "Buscar venda da Cielo", coluna "Ações" com 11 botões "Registrar chargeback" (Pagamentos); bloco Devoluções com Estornar, Cobrado/Estornado/Estornável e "Nenhuma devolução registrada" (detalhe). **Nada sai.** O diálogo do detalhe agora passa de 90% da janela e rola por dentro, então a foto passa a ter a altura dele (375: 955 → 1.133; 768: 2.017 → 1.050; 1440: 1.631 → 1.038) | REDESENHO DECLARADO |
| **(c) Rodapé legal** — links Termos de Uso e Política de Privacidade | `pub-landing` ×3 e `pub-eletropostos` ×3 = **6 regravadas** | Landing: 4 nós entram (`nav`, 2 links, wrapper) e 791 deslocam só em y (+40 px a 375, +8 a 768/1440). `/eletropostos`: +60 / +12 px; o logo ganha `aria-label="InnoFlow, início"` (0 px). `pub-qr-carregador`, `pub-qr-conector`, 404 e documento do cartão: IDENTICA (não usam esse rodapé) | REDESENHO DECLARADO |
| **(d) Login e cadastro** | `auth-login` ×3, `auth-cadastro` ×3 = **6 regravadas** | Login: entra o link "Esqueci minha senha" (151 × 44, entre a senha e Entrar; +44 px no card; +7 px de documento a 375) e o `nav` legal; o contêiner raiz vira `<main>`. Cadastro: entra a caixa de aceite dos Termos (`label` + checkbox + 2 links, +62,5 px) e o `nav` legal. SAIU: 0 nós. O resto só desloca em y (a 1440 o conjunto se recentra: dy −22 / −31) | REDESENHO DECLARADO |
| **(e) Meu perfil** | `pwa-perfil` ×3 = **3 regravadas** | Acima das seções novas nada muda (90 nós com dy = 0); entram 85 nós: Ajuda (Rever tour), Notificações e Privacidade e dados; documento +1.455 / +1.387 / +1.387 px | REDESENHO DECLARADO |
| **PWA fora do perfil** (15 telas × 3) e demais rotas | 0 regravadas | IDENTICA ou ACEITA só por ruído (151 px a 144,16–183,23 no nome do cabeçalho, ≤ 5 níveis; mascote; SSE do `pwa-mapa` a 1440, "1 de 4" → "2 de 4") | RUÍDO |
| **Rodada de textos `2e4e731`** (chave dos segredos agora vem do JWT_SECRET) | `adm-devolucoes-contas-excluidas` ×3 e `adm-dialogo-devolver-saldo-form` ×3 = **6 regravadas** (eram baselines novas de hoje) | 1 nó de texto muda (o aviso "Chave ilegível: a chave de segredos do servidor mudou (o JWT…"); a 768/1440 todo pixel alterado cai na caixa do `<p>`; a 375 o `<p>` ganha uma linha (+20 px) e o que está abaixo desce. Gateway, Configurações e Backups: só renumeração de ids, nenhuma imagem muda | TEXTO DECLARADO |

**Baselines NOVAS (90)** — 1ª foto, sem "antes"; todas olhadas em folhas de contato e **a 0 px com 2 capturas da sonda**; gravadas com tolerância zero e `retries 0`; **3 rodadas de comparação seguidas verdes** (config padrão, `retries 0`) por grupo:
- recuperação de senha (5 ids × 3): `auth-esqueci-senha`, `-redefinir-senha-sem-token`, `-esqueci-enviado` (contagem "Reenviar em 60 s" com o relógio fixo), `-redefinir-formulario`, `auth-login-aviso-senha-alterada`;
- Configurações: `adm-configuracoes-alertas` ×3 e `-geral`, `-email`, `-whatsapp` **só a 768 e 1440**;
- Backups refeito (`4204d84`): `adm-backups` (conta `admin@`, primeiro uso) e `adm-backups-s3-pronto` (`backup-s3@`, tudo configurado, sem execução ativa nem polling), ×3;
- `adm-chargebacks` e `adm-devolucoes-contas-excluidas` ×3;
- tour do Inno (foto **só da janela**, `soJanela`; login pela UI com o interruptor de onboarding desligado de propósito): `onb-motorista-boas-vindas`, `-mapa`, `-qr`, `onb-painel-boas-vindas`, `-menu`, `-passo3` (a 1440 é o passo "Dashboard e ao vivo"; abaixo de 1024 px é "Atalhos rápidos") e `adm-dashboard-primeiros-passos` ×3;
- diálogos do Admin: Iniciar recarga `-form`, `-confirmacao`, `-aguardando`, `-aceito`, `-recusado`, `-offline` ×3; `adm-dialogo-estorno-form`, `-estorno-confirmacao`, `-chargeback-registrar`, `-chargeback-detalhe`, `-devolver-saldo-form` ×3.

**REGRESSÃO devolvida à Lyra — NÃO regravada:** *Admin > Configurações · Geral, E-mail e WhatsApp a 375 px.* Medido (geometria da sonda): o selo ("VEM DO SERVIDOR (VARIÁVEIS LEGAL_*)", "NÃO CONFIGURADO") não quebra linha e espreme a coluna do título do cabeçalho do card: **h2 "Dados da empresa" com 0 px de largura** (texto desenhado por baixo do selo e a descrição em uma palavra por linha), "E-mail transacional (SMTP)" com 80 px e "WhatsApp (Evolution API)" com 109 px, num card de 303 px. A 768 e 1440 o h2 mede 303 a 686 px. As 3 rotas ficam `pendente` a 375 (`Rota.pendente` → `fixme` com o motivo) e `verificacoes-lote1.visual.ts` tem o teste com `test.fail` a 375 (ao corrigir: tirar a marca e a `pendente` e gravar as 3 imagens).

**Ficaram SEM baseline, de propósito:** (1) `/termos` e `/privacidade`: o texto é minuta (`status: "draft"`) e em dev/mock a página mostra "Aviso interno (só em dev/mock)" e "Nota para a revisão jurídica", que o build de produção não mostra: a foto fixaria um estado que o usuário nunca vê (voltam quando o texto for o final e o mock puder desligar as notas); (2) bloqueio de cartão por chargeback (`chargeback@`: cartões, carteira, adicionar saldo, QR): a régua `criterios-chargeback` (4 larguras × 4 telas, contraste por pixel) já cobre, e a persona exige login pela UI e navegação interna (o mock zera num `goto`); (3) estados do Backups com execução ativa ou polling (instáveis por desenho); (4) seletor de ação da Auditoria aberto (lista nativa do navegador, fora da foto da página); (5) demais estados dos diálogos (erros de senha, 503, 409, desfecho, desbloqueio): cobertos pelas réguas da Lyra (`verificacoes-estorno`: contraste por pixel + axe) e fotografá-los multiplicaria a baseline sem proteger layout novo.

**Pendente da próxima rodada de textos/rótulos (instrução do Atlas):** `adm-charge-points` (o rótulo "Offline" na lista de carregadores) e `adm-gateway-pagamento` (textos do gateway) **já tinham sido regravados a 1440 (commit da sidebar, `38d38e2`) antes do aviso**; ao entrar a rodada, reclassificar e regravar de novo. O diálogo de exclusão de conta do PWA não tem baseline.

**Contraste.** *Por pixel* (`VISUAL_CONTRASTE=1`, 222 capturas + 15 do Backups refeito): **0 reprovados nas telas novas e nas alteradas** (90 novas: 3.488 textos; `adm-backups*`: menor 5,18:1; tour: menor 8,33:1; rodapé legal 5,53:1; Admin a 1440 menor 4,79:1). As únicas reprovações são pré-existentes e fora do lote: a landing (texto sobre degradê/vidro; a landing não é auditada por pixel; 1,24 a 2,92:1 nos heróis) e `pub-eletropostos` a 375 ("Rede InnoFlow" 4,42:1; DOM idêntico ao ANTES, só ganha o rodapé). *axe* (`test:contraste`, worktree limpo no HEAD): **0 reprovados, 4.282 aprovados, 1.148 incompletos** (eram 3.386 / 952: **+896 / +196** = 27 medições novas, +783 / +184, e 17 existentes, +113 / +12: `pwa-perfil` +30 por largura, login +3, cadastro +5, rodapé legal da landing e de /eletropostos, `adm-pagamentos` −3 a 1440 porque a tabela cresceu e menos linhas cabem na janela do axe); catraca `contraste-baseline.json` com as 27 chaves novas (0). `CONTRASTE-ESTADO-ATUAL.md` regerado em worktree limpo e commitado por `hash-object`.

**Fechamento.** `test:visual` (189 testes) em worktree limpo do HEAD, config padrão (`retries 3`) e `--update-snapshots=none`: **rodada 1 = 185 passed, 1 flaky, 3 skipped; rodada 2 = 186 passed, 0 flaky, 3 skipped**. O flaky é `pwa-mapa` a 1440 (o SSE do mock troca "1 de 4" por "2 de 4" quando a captura cruza o tick de 15 s, §11; passou na 2ª tentativa). Com tolerância ZERO as novas ainda oscilam em 2 imagens (`adm-dialogo-estorno-form` a 768: 132 px de ≤ 4 níveis; `auth-esqueci-enviado` a 375: 40 px, 1 vez em 3): ruído de JPEG abaixo do limiar de produção. As 6 imagens da rodada de textos foram regravadas depois dessas 2 rodadas e não passaram por elas (conferidas só pela captura da própria gravação e pelo bbox dos pixels).

**Armadilhas desta rodada:** (1) o hook de contraste (`VISUAL_CONTRASTE=1`) cresce a janela para 2.600 px e muda a posição de rolagem do diálogo de baixo nos empilhados (confirmar estorno): com ele ligado, a imagem da sonda NÃO serve de referência de pixel para essas; (2) `fotografar` sem `soJanela` num tour cresce a janela e a foto do painel sai com 3.843 px; (3) `--update-snapshots=all` com `-g` regrava também imagens que NÃO eram o alvo quando o teste gera várias (o do tour gera 3): copie só as listadas; (4) commits de outros agentes entram no meio da sequência: confira `git show --name-only` de cada commit para ver que só levou baseline.

### 17. Orçamentos de tamanho — nova política (05/10/2026)

Com o dono ciente. O produto cresceu muito desde a A0 (de 71 para 115 entradas no precache: Configurações, Backups, Chargebacks, Devoluções, LGPD, tour, recuperação de senha, recarga remota): o teto rígido "+40 KB no total do precache" estourou sem que nenhuma rota tivesse feito algo errado e deixou de apontar QUEM inchou. A regra do `--comparar` passa a ser **por chunk**, contra uma baseline re-ancorada hoje (`tamanhos-baseline.json`; os números da A0 ficam no campo `a0` do JSON).

| Métrica | A0 (04/10) | Baseline nova (05/10, frontend de `49f3e90`) |
|---|---:|---:|
| CSS global (`index-*.css`) bruto / gzip | 65.042 / 11.944 B | **76.084 / 14.296 B** (+2.352 B gz; o teto antigo era +2.500) |
| JS total | 64 arquivos, 471.054 B gz | 106 arquivos, 616.125 B gz |
| Precache do `sw.js` | 71 entradas, 1.537.209 B bruto / 675.341 B gz | **115 entradas, 1.941.685 B bruto / 807.451 B gz** (+26,3% / +19,5%) |
| `modulepreload` do `index.html` | 6 chunks | **6 chunks, o mesmo conjunto** (`appInfo`, `landing`, `rolldown-runtime`, `vendor-core` ×2, `vendor-icons`). O relato de 7 (um chunk `legalPaths`) não aparece no build de hoje: medido |
| Maiores chunks (gzip) | vendor-core 91.977, pagamento-cartao 71.304, ui-kit 53.107, StationsMap 44.328 | vendor-core 91.997, pagamento-cartao 75.165, ui-kit 55.483, StationsMap 44.326, **app-hooks 43.959 (era 27.172: +61%)**, vendor-forms 35.596, Backups 16.480 (novo) |

**A regra** (`node scripts/medir-tamanhos.mjs --comparar e2e-visual/tamanhos-baseline.json`, sai com 1 se violar):
1. **CSS global gzip ≤ baseline + 1.500 B** (bloqueia todas as rotas: continua apertado; a rodada atual consumiu 2.352 B da folga antiga).
2. **`modulepreload`**: nenhum chunk fora do conjunto da baseline (nome sem hash) e nunca mais de 6.
3. **Precache por chunk** (JS e CSS de `assets/`, nome sem hash, gzip 9): chunk **crítico** (no `modulepreload` ou `vendor-*`/`ui-kit`/`app-hooks`/`index`) ≤ ⌈baseline × 1,03 + 512 B⌉; chunk de **rota/lazy** existente ≤ ⌈baseline × 1,10 + 1.024 B⌉; chunk **novo** só se não for crítico e ≤ 40 KB gzip. O estouro reprova **com o nome do chunk**.
4. **Teto geral do precache**: bruto e gzip ≤ baseline × 1,15 (rede de segurança).

A baseline é **re-ancorada a cada rodada que o dono aprovar** (`--json`) e a mudança vira linha neste arquivo. Verificado: contra a própria baseline passa (102 chunks, 0 acima do limite); contra a A0 reprova com `app-hooks`, `ui-kit`, `index` (js e css), `vendor-icons`, `ChargePoints`, `Sessoes`, `Pagamentos`, `Dashboard`, o CSS global e os 2 tetos gerais; uma baseline adulterada (landing fora do `modulepreload`, CSS −2.000 B) reprova nas regras que mexem nela. **Achado para a Lyra/Vega:** `app-hooks` é carregado por quase toda rota e cresceu 16,8 KB gzip desde a A0 (hooks, serviços e mocks das telas novas entram nele): vale ver o que o `manualChunks` do `vite.config.ts` põe lá, porque o orçamento "crítico" (+3%) vai travá-lo daqui em diante.

### 18. Fechamento do lote 1 (05/10/2026): rótulo "Offline" na lista de carregadores e Configurações a 375 px

**Método.** Sonda `comparar-geometria` (`--ids-react --margem 32`, **2 execuções de cada lado**, 3 workers, nada rodando ao lado, máquina livre), 3 estados no mesmo `node_modules` copiado: **A** = `be3f9c8` (antes de tudo) · **M** = `02aadb6` (só o rótulo "Offline"; no worktree, SEM commitar, tirei a marca `pendente` das 3 rotas de Configurações para ela capturar o defeito antigo a 375) · **B** = `830a20c` (HEAD, com a correção `d908934`). 222 / 225 / 225 páginas. A → M: **189 IDENTICA, 11 ACEITA (ruído do cabeçalho do PWA, 151 px; mascote), 22 REPORTAR**. M → B: **208 IDENTICA, 13 ACEITA (ruído), 4 REPORTAR**. As execuções repetidas do MESMO estado também discordam entre si em 14 a 16 páginas (A1×A2, M1×M2, B1×B2; quase todas `pwa-*`, o ruído de rasterização das §9/§11): é por isso que `--ruido-a/--ruido-b` entram na conta.

#### (a) `02aadb6` — rótulo "Offline" na célula Status (`OfflineMark`: ponto + texto, só com `online === false` e cadastro ativo)

Os 22 REPORTAR, um a um: `adm-charge-points` ×3 + os 6 diálogos de recarga remota ×3 = 21, mais `pub-eletropostos` a 375 (ruído: ver abaixo). Medido por imagem (A → M, pixels diferentes):

| Imagem | 375 | 768 | 1440 |
|---|---:|---:|---:|
| `adm-charge-points` | **0** (DOM +9 nós, tudo fora da janela: a coluna Status está em x=722) | **3.483** (rótulo em x=730..751, y=576..719) | **183.566** (tabela reflui, ver abaixo) |
| `adm-dialogo-recarga-remota-form` / `-confirmacao` / `-offline` | 0 | 0 | 89.025 / 95.307 / 89.223 |
| `adm-dialogo-recarga-remota-aguardando` | **4.560** (bbox 96,704..159,799) | 0 | 100.217 |
| `adm-dialogo-recarga-remota-aceito` | **4.349** | **2.001** | 106.048 |
| `adm-dialogo-recarga-remota-recusado` | **3.393** | **983** | 102.284 |

**Regravadas: 13** = a lista da Lyra, conferida, nem mais nem menos: `adm-charge-points` 768 e 1440; `-aguardando` 375/1440; `-aceito` 375/768/1440; `-recusado` 375/768/1440; `-form`, `-confirmacao`, `-offline` só 1440. **Não regravadas, de propósito (0 px):** `adm-charge-points` a 375 e os diálogos `-form`/`-confirmacao`/`-offline` a 375 e 768 e `-aguardando` a 768: o DOM ganha os 9 nós, a foto não muda. A 375/768 a tabela rola por dentro; o rótulo só aparece na foto quando a coluna Status entra na janela (a 768, x < 768) ou quando o diálogo deixa a linha offline à mostra sob o véu (a 375, só nos 3 diálogos curtos `-aguardando`, `-aceito` e `-recusado`, que não cobrem a linha de baixo).

**O que mudou, por prova de deslocamento** (cada nó do A procurado no M por tag/texto/atributos/x/largura; sem nó que SAIA e nenhum estilo não declarado a 375/768):
- **A 375 e 768:** 438 → 447 nós, 0 SAIU, 9 ENTROU (3 wrappers `div.flex-wrap` por linha onde antes só havia o selo "Ativo", mais `span "Offline"` e o ponto de 6 × 6 `bg-warning-700` nas **2 linhas offline** — `CP-OUTLET-CAMPINAS-01` e `CP-ANHANGUERA-01`). dy = 0 em 436 nós e −10 em 2 (os 2 selos "Ativo" dessas linhas sobem 10 px: a célula passou a ter 2 linhas, selo + rótulo). Estilo: o selo "Ativo" passa de `inline-flex` a `flex` e `min-width 0 → auto` em 5 nós, só porque virou filho do wrapper flex. Documento de mesma altura (932 e 1.024).
- **A 1440** (documento de 1.283 px antes e depois, que é a lista da sidebar): a coluna **Status passa de 87,3 para 114,5 px** e as outras encolhem para compensar (Identidade 182,5 → 174,7; Fabricante 192,7 → 186,6; Site 188,3 → 174,8...), por isso 46 nós SAEM e 55 ENTRAM por mudarem de x/largura (os mesmos th/td, com o texto igual). As 2 linhas offline ficam **8 e 16 px mais altas** (nomes de 2 linhas + Ativo + Offline): dh = 0 em 384 nós, +8 em 4, +16 em 4; o conteúdo centrado das outras células sobe/desce metade (dy = 4 em 21 nós, 12 em 21, 8 em 2, 16 em 5) e o resto da tabela desce. É o "~8 px mais altas e deslocam o resto" declarado pela Lyra, confirmado.
- **Diálogos:** o diálogo em si não muda em nenhum estado (o DOM do diálogo e os retângulos dele idênticos); só a lista do fundo, sob o véu, que reflui igual à tela de cima.
- **`adm-gateway-pagamento` ×3, `adm-backups`, `adm-configuracoes-*` e as demais 190 imagens: IDENTICA ou ACEITA por ruído** (o aviso da §16 de reclassificar `adm-gateway-pagamento` a 1440 não gerou diferença: os textos do gateway já estavam no `HEAD` da regravação).
- **`pub-eletropostos` a 375 aparece como REPORTAR em A → M e em M → B, sem que nenhum commit o toque:** é o tick de 15 s do SSE do mock (um card de estação muda de altura: `grid-template-rows` 237 ↔ 217 px, +11,5 px de documento) e **M1 × M2 já discordam sozinhos nessa página** (mesmo código, 2 execuções). É o mesmo ruído do `pwa-mapa` a 1440 (§11); a imagem da baseline NÃO muda por causa dele.

Gravadas em worktree limpo de `830a20c` (`VISUAL_MAX_DIFF_RATIO=0 VISUAL_THRESHOLD=0`, `retries 0`, `--update-snapshots=changed`: só as 13 acima foram reescritas). **As 13 conferem 0 px com as duas capturas da sonda de B** (B1 e B2). Estabilidade: 3 rodadas dos 12 testes com a configuração de produção (`maxDiffPixelRatio 0,0003`, `threshold 0,03`), `retries 0`: **12/12, 12/12, 12/12**. Com tolerância ZERO as 3 rodadas deixaram **uma** reprovada: `adm-charge-points` a 768 com **27 px** diferentes (de 786.432: 3,4·10⁻⁵, abaixo do ruído medido de 1,1·10⁻⁴ da §1.1; já era a tela citada como ruído de raster na §15).
