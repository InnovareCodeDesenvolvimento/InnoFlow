# Unificação do design system: o padrão da landing em 100% do InnoFlow

Autora: Nova (arquitetura). Data: 04/10/2026. Situação: **proposta, aguardando as decisões da §5**.
Pedido do dono (04/10/2026): "todas as demais páginas do projeto precisam seguir o mesmo padrão de template premium
da landing page, 100% do projeto".

Este documento não altera código. Ele audita as telas, extrai o design system que a landing já usa e propõe como
levá-lo ao resto do app em fases que podem ser entregues uma de cada vez.

**Legenda** (vale para o documento inteiro):

- **[lido]**: fato lido no código ou nos arquivos do repositório nesta data.
- **[medido]**: fato observado rodando o app (mock, Playwright) ou calculado a partir de valores lidos.
- **[rec]**: recomendação minha. Pode ser contestada.

---

## 0. Resumo

1. **[medido]** A landing `/` e o resto do app falam duas línguas visuais. A landing é escura (azul-noite), tem CTA
   verde-lima com texto escuro, mascote, tipografia de 800 de peso e vidro sobre fundo escuro. O resto do app é claro,
   tem botão principal azul-petróleo e títulos em 900, e não usa o mascote em lugar nenhum. O pior caso é o CTA
   principal da landing, "Ver eletropostos": ele leva a `/eletropostos`, uma página branca com cabeçalho claro e
   botão petróleo. A primeira tela depois do clique já parece outro produto.
2. **[lido]** Não é rebrand. A paleta é a mesma: a landing só compõe os tokens de `src/index.css` e acrescenta um único
   valor (`--lnd-night: #061621`). O que falta é **linguagem**: superfície escura como "moldura", lima como cor de ação,
   escala tipográfica, vidro, mascote e regras de motion.
3. **[rec]** Para todas as telas vale a regra **"moldura escura, miolo claro"**. Cabeçalhos, sidebar, barra inferior,
   painéis de marca e os momentos de marca (saldo, recarga ao vivo, recibo, estados vazios principais) ficam no escuro
   da landing. Dado denso e formulário ficam em superfície clara, como as seções claras da própria landing.
4. **[rec]** Tecnicamente, há duas mudanças de fundação:
   - **Superfície escura como escopo de tokens** (`.surface-dark`). Não é um "dark mode": dentro do escopo os mesmos
     componentes trocam de tom sozinhos.
   - **O vocabulário novo vai para `@layer components`.** Isso inverte a regra atual do `index.css` ("nunca mude a
     classe default do componente base"). A regra só existe porque o vocabulário de 17/09 fica fora de layer e ganha
     dos utilitários.
5. **[rec]** A landing é a **implementação de referência e não consome o design system**. Ela não importa
   `components/ui` (chunk `ui-kit`) e deve continuar assim, porque cada KB no caminho crítico dela foi medido.
6. Estimativa: **22 a 28 dias úteis de Lyra**, em 6 fases (F-A a F-F), cada uma entregável sozinha. A Íris valida por
   regressão visual e o Órion entra na F-E (documento isolado do cartão, com CSP própria).
7. Bloqueiam o início **só** as decisões D1 e D2 da §5. A linha de base (screenshots e Lighthouse), os tokens e os
   componentes base podem começar já.

---

## 1. Auditoria

### 1.1 Como foi medido e o que ficou de fora

**[medido]** `npm run dev:mock` (MSW), Playwright/Chromium e captura de 31 rotas em 375 px e 1440 px:

- anônimo: `/`, `/eletropostos`, `/login`, `/cadastro`, `/c/CP-VILA-NORTE-01`, `/pagamento-cartao.html`, `/nao-existe-xyz`;
- motorista `motorista@innoelektron.com`: 7 rotas `/app/*`;
- admin `admin@innoelektron.com`: as 14 rotas `/admin/*`.

Em cada captura registrei a fonte computada do `body`, os `h1` e se havia rolagem horizontal. As capturas ficaram no
scratchpad da sessão e não são versionadas. A Íris refaz a linha de base oficial na F-A.

O que **não** foi verificado:

- `/app/sessoes/:id` (recibo): o mock recém-carregado não tinha histórico para esse motorista, então não houve link
  para seguir.
- Os estados ao vivo da sessão (conectando, carregando, parando). Dependem de estado do mock acumulado na mesma
  página. As capturas da Lyra de 17/09 existem, mas não as revi.
- 768 px.
- Os tiles do mapa: saem cinza no mock porque não há rede para o OSM. Isso é do ambiente, não do design.
- Contraste com ferramenta (axe/Lighthouse). Os números de contraste abaixo são cálculos meus de luminância relativa
  WCAG a partir dos valores lidos.
- O Lighthouse atual da landing (ver risco R2).

### 1.2 Fatos transversais

| # | Fato | Tipo |
|---|---|---|
| T1 | Todas as rotas do app principal renderizam em Inter auto-hospedada (`src/assets/fonts/*.woff2`). A única exceção é `pagamento-cartao.html`, que usa a fonte do sistema (`-apple-system, …`). | [medido] |
| T2 | Nenhuma das 31 capturas tem rolagem horizontal (`scrollWidth > innerWidth` falso em todas). | [medido] |
| T3 | Não existe dark mode. `tailwind.config.js` declara `darkMode: ["class"]`, mas há **zero** usos de `dark:` em `src/`. | [lido] |
| T4 | Há **quatro cascas** diferentes: landing (`LandingHeader`/`LandingFooter`, escura), público (`components/layout/Layout.tsx` + `Header`/`Footer`, clara), PWA (`pages/App/Layout.tsx`, header claro + bottom nav clara) e Admin (`pages/Admin/Layout.tsx`, sidebar `bg-primary-950` + header claro). Além delas, Login/Cadastro e `/c/:id` têm casca própria. | [lido] |
| T5 | Rota inexistente **redireciona silenciosamente para `/`** (`<Route path="*" element={<Navigate to="/" replace />}`). Não há página 404. O E2E `landing.spec.ts:314` fixa esse comportamento ("rota inexistente continua caindo na landing"). | [lido] |
| T6 | O mascote só aparece na landing (`components/landing/Mascot.tsx`). Nenhuma outra tela o importa. | [lido] |
| T7 | E2E: **185 testes em 18 arquivos** (`playwright test --list`). Usam `getByText`/`getByRole` 637 vezes e seletor por classe só em `.lnd-eye`, `.lnd-chip` (landing) e `.leaflet-*` (mapa). **Nenhum** `toHaveScreenshot`, ou seja, não existe regressão visual automatizada hoje. | [medido] |
| T8 | O CSS global (`dist/assets/index-*.css`, build de hoje 13:26) tem **65.042 B (11.919 B gzip)** e bloqueia a renderização de todas as rotas, inclusive a landing. O CSS da landing é chunk próprio: `landing-*.css`, 19.062 B (4.258 B gzip). | [medido] |
| T9 | Títulos: a landing usa `font-extrabold` (800). O app usa `font-black` (900) em quase todo `h1`/`h2` (`PageHeader`, Login, Home do PWA, header do Admin). | [lido] |
| T10 | Botão de ação principal: na landing é `.lnd-btn-lime` (fundo `accent-glow #61DB24`, texto noite). No app é `Button variant="default"` (fundo `primary #29698E`, texto branco), às vezes com `.btn-glow-primary`. | [lido] |
| T11 | O admin mostra o título da página **duas vezes**: o header do shell (`Admin/Layout.tsx`, "PAINEL ADMINISTRATIVO / Dashboard") e o `PageHeader` (h1 "Dashboard") logo abaixo. | [medido] |
| T12 | O texto do painel de marca do Login fala com o **operador** ("O painel administrativo da InnoFlow reúne sites, eletropostos… de todos os operadores"). Desde o commit `4f1eeb9`, a landing fala **só com o motorista**. | [lido] |

### 1.3 Inventário de telas

Escala de distância até o padrão da landing:

- **0**: é o padrão.
- **1**: mesma família, só ajuste de token ou tipografia.
- **2**: a estrutura serve, falta a linguagem (moldura escura, CTA lima, mascote, vidro).
- **3**: outra linguagem, e a primeira impressão quebra.

Prioridade: **A** = alto tráfego ou porta de entrada, **B** = uso recorrente, **C** = uso interno ou raro.

#### Público e Auth

| Tela | Rota · arquivo | Casca | Usa hoje [lido] | Situação visual [medido] | Dist. | Prio |
|---|---|---|---|---|---|---|
| Landing | `/` · `pages/Public/Home.tsx` + `components/landing/*` | própria, escura | `lnd-*` (landing.css), `Mascot`, `Reveal`, `FlowCanvas` | É a referência. Hero escuro, mascote animado, CTA lima. | 0 | — |
| Eletropostos | `/eletropostos` · `pages/Public/Eletropostos.tsx` | `Layout` público claro | `PublicSiteCard`, `EmptyState`, `ErrorState`, `Skeleton`, `Pagination` | Header branco, h1 com ícone, grade de cards brancos e botão "Criar conta" petróleo. É o destino do CTA principal da landing e onde o contraste com ela mais aparece. | **3** | **A** |
| Login | `/login` · `pages/Auth/Login.tsx` | própria, split | `card-premium`, `btn-glow-primary`, `animate-float-soft` (2 blobs `blur-3xl`), `Input`, `Button` | Desktop: painel de gradiente petróleo à esquerda e formulário branco. Mobile: só o card branco. O botão Entrar é petróleo. Não tem mascote, e o texto fala com o operador (T12). | 2 | **A** |
| Cadastro | `/cadastro` · `pages/Auth/Register.tsx` | própria, split | idem ao Login | Igual ao Login. | 2 | **A** |
| Landing do QR | `/c/:ocppIdentity[/:connectorId]` · `pages/Public/ChargePointLanding.tsx` | própria | `card-premium`, `btn-glow-primary`, `text-gradient-brand`, `animate-float-soft`, `ConnectorPickerCard`, `PaymentMethodSelector` | Faixa de gradiente petróleo→verde com o slogan e o resto claro. É a primeira tela de quem escaneia um carregador, e é a tela de **conversão** do produto. | 2 | **A** |
| 404 | não existe (T5) | — | — | Redireciona para `/`. | — | B |

#### PWA do motorista (`/app/*`, casca `pages/App/Layout.tsx`)

| Tela | Arquivo | Usa hoje [lido] | Situação visual [medido] | Dist. | Prio |
|---|---|---|---|---|---|
| Casca | `pages/App/Layout.tsx` | header `bg-surface/90` com blur, bottom nav `bg-surface/95`, `pressable`, pingo `animate-pulse` | Moldura branca, logo pequeno e primeiro nome. A aba ativa é uma pílula `bg-primary/10`. Em 1440 a bottom nav continua centrada embaixo. | 2 | **A** |
| Início | `pages/App/Home.tsx` | `Card` com `bg-primary-950` (saldo), `animate-fade-in-up` + stagger, `NearbyStationsSection`, `Badge` | O card de saldo já é escuro (o único "momento de marca" do PWA). "Pronto para carregar?" e "Últimas recargas" vazios usam caixa tracejada cinza. | 2 | **A** |
| Sessão (ativa) | `pages/App/Sessao.tsx` | `card-premium`, `animate-live-glow`, `animate-radar-ping`, `text-gradient-brand` | Estado vazio capturado: ícone cinza num círculo cinza e texto, ou seja, a tela mais vazia do app. Os estados ao vivo não foram capturados (§1.1). | 2 | **A** |
| Recibo | `pages/App/SessaoDetalhe.tsx` | `card-premium`, `animate-pop-in`, `text-gradient-brand` | Não capturado. Pelo código, é card claro com check verde que "pula". | 2 | **A** |
| Histórico | `pages/App/Sessoes.tsx` | lista `pressable` + `Badge`, `EmptyState` | Lista de cards brancos. | 1–2 | B |
| Carteira | `pages/App/Carteira.tsx` | `Card bg-primary-950` (saldo), atalhos tingidos `accent/10` e `primary/10`, extrato | Boa hierarquia. Os atalhos em verde e azul claros destoam do vidro/lima da landing. | 2 | **A** |
| Adicionar saldo | `pages/App/CarteiraAdicionar.tsx` | `TopupAmountPicker`, `TopupPendingCard`, `TopupSuccessCard`, `Input`, `Button` | Formulário claro e botão "Gerar código Pix" petróleo. | 2 | **A** |
| Cartões | `pages/App/Cartoes.tsx` | `Badge`, `EmptyState`, `CardEligibilityNotice` | Lista e aviso claros. | 2 | B |
| Mapa | `pages/App/Mapa.tsx` + `components/estacoes/*` | `StationsMap` (Leaflet), `LocationPrompt`, `StationDetailSheet` (`animate-sheet-up`), segmentado de ordenação | Lista + mapa (1440: duas colunas). Marcadores verde/laranja/cinza. Prompt de localização em caixa tracejada. | 2 | **A** |

#### Documento isolado do cartão

| Tela | Arquivo | Situação [lido + medido] | Dist. | Prio |
|---|---|---|---|---|
| Cadastrar cartão | `pagamento-cartao.html` + `src/pagamento-cartao/*` (build própria `vite.pagamento-cartao.config.ts`, CSS escrito à mão `pagamento-cartao.css`, tokens **copiados de propósito**) | Fonte do sistema (não Inter), logo e card branco com sombra cinza. Visual de 16/09, anterior ao "premium". CSP própria e rígida (`nginx.conf.template`, `location = /pagamento-cartao.html`): `font-src 'self'`, `img-src 'self' data:`, `style-src 'self' 'unsafe-inline'`. | 2–3 | B |

#### Admin (`/admin/*`, casca `pages/Admin/Layout.tsx`)

| Tela | Arquivo (`pages/Admin/…`) | Usa hoje [lido] | Situação visual [medido] | Dist. | Prio |
|---|---|---|---|---|---|
| Casca | `Layout.tsx`, `components/admin/SidebarNav.tsx`, `QuickActionsBar.tsx`, `components/painel/InnovareCodeBadge.tsx` | sidebar `bg-primary-950` sólida, item ativo `bg-white/15` + `ring-white/20`, header `bg-background/85` com blur, rodapé com selo | A sidebar escura já está próxima da landing, mas o fundo é chapado (sem o gradiente noite) e o item ativo não tem acento lima. Título duplicado (T11). O header mobile mostra "InnoFlow" sem logo. | 1–2 | **A** |
| Dashboard | `Dashboard/index.tsx` | `MetricCard` (`card-premium`), `RevenueBarChart`, `PaymentSplitDonut` (SVG próprio), `PeriodSelector`, `Table`×5 | Seis KPIs brancos (só Faturamento em `text-gradient-brand`), barras petróleo e donut petróleo/verde. Limpo, mas genérico. | 2 | **A** |
| Financeiro | `Financeiro/index.tsx` | `card-premium`, `text-gradient-brand`, `ReconciliationPanel` | KPIs claros. | 2 | B |
| Faturamento | `Faturamento/index.tsx` | `Card`, `Table`, `text-gradient-brand` | Tabela e cards. | 2 | B |
| Movimento diário | `MovimentoDiario/index.tsx` | `card-premium`×3, `Table`, `ExportCsvButton` | Tabela e cards. | 2 | B |
| Sessões | `Sessoes/index.tsx` + `SessionDetailDialog`, `SessionClosureAdminSection` | `Table`, `Badge`, `pressable` | Tabela. | 1–2 | **A** |
| Pagamentos | `Pagamentos/index.tsx` | `Table`, `Badge` | Tabela. | 1–2 | B |
| Carteiras | `Carteiras/index.tsx` + `DriverWalletDrawer`, `AdjustBalanceDialog` | `Table`, `Badge`, drawer | Tabela e drawer. | 1–2 | B |
| Sites | `Sites/index.tsx` + `SiteFormDialog` | `Table`, `Button` + `btn-glow-primary` | Tabela com linhas altas (~61 px) e "Novo site" petróleo. | 1–2 | B |
| Pontos de recarga | `ChargePoints/index.tsx` + `ChargePointFormDialog`, `components/chargePoints/*` | idem + menu de comandos | Tabela. | 1–2 | B |
| Conectores | `Connectors/index.tsx` + `ConnectorFormDialog` | idem | Tabela. | 1–2 | C |
| Tarifas | `Tariffs/index.tsx` + `TariffFormDialog`, `components/tariffAssignments/*` | idem | Tabela. | 1–2 | B |
| Tokens | `AuthTokens/index.tsx` + `AuthTokenFormDialog` | idem (ADMIN-only) | Tabela. | 1–2 | C |
| Gateway de pagamento | `GatewayPagamento/*` (13 arquivos) | `PageHeader`, `MethodCard`, `StatusBanners`, `SecretField`, barra de salvar fixa | Coluna estreita, banners informativos ciano, cards de método e barra de salvar fixa embaixo. É a tela mais "formulário" do admin. | 2 | C |
| Auditoria | `Auditoria/index.tsx` + `AuditLogDetailDialog` | `Table`, `Badge` (ADMIN-only) | Tabela. | 1–2 | C |

Diálogos do admin: **14 arquivos `*Dialog.tsx`** em `pages/Admin/*` e `components/{chargePoints,tariffAssignments}/*`,
todos sobre a base `components/ui/Dialog.tsx` + `ConfirmDialog.tsx` [lido]. Eles migram juntos quando a base migra.

### 1.4 Achados específicos (fora o "não parece a landing")

1. **[medido] Contraste insuficiente na sidebar do admin.** Os títulos de grupo (`SidebarNav.tsx`, `text-white/35`, 10 px,
   sobre `#0E2A3A`) dão cerca de **3,1:1**. O papel do usuário no cartão do rodapé (`text-white/50` sobre
   `bg-white/10` + `#0E2A3A`, 11 px) dá cerca de **4,1:1**. Os dois ficam abaixo de AA (4,5:1) para texto pequeno.
2. **[medido]** `text-ink-subtle` (`#9CA3AF`) sobre branco dá cerca de **2,5:1**. É usado como **texto** em
   `MetricCard` ("vs. período anterior", "— sem variação") e em vários `placeholder`s. Placeholder tolera, texto
   informativo não.
3. **[lido]** O cabeçalho público (`components/layout/Header.tsx`) carrega um "user menu" que a landing não tem. A
   landing troca "Criar conta" por "Painel"/"Meu app" quando a pessoa está logada (`LandingHeader.tsx`). São duas
   regras para o mesmo problema.
4. **[lido]** `Login.tsx` e `Register.tsx` usam blobs com `blur-3xl` + `animate-float-soft`. A landing abandonou
   exatamente isso por custo de rasterização (comentário em `landing.css`, `.lnd-glow-*`: "antes eram divs com
   blur-3xl animadas… custavam estilo/rasterização sem ganho visível").
5. **[lido]** O selo `InnovareCodeBadge` vive no rodapé do shell admin. O rodapé da landing tem a própria placa
   "Desenvolvido por" (`LandingFooter.tsx`). Isso dá dois tratamentos da mesma assinatura.
6. **[lido]** `index.html`/manifest usam `theme_color #0E2A3A` (primary-950), mas o header do PWA é branco. No Android
   instalado, a barra de status fica escura e o header logo abaixo fica branco.

---

## 2. O padrão da landing, extraído

Tudo aqui é **[lido]** em `src/components/landing/landing.css`, `src/index.css` e nos componentes de
`src/components/landing/`. Os comentários **[rec]** dizem o que vira token compartilhado.

### 2.1 Cores e superfícies

| Papel | Valor | Onde na landing | Vira token? [rec] |
|---|---|---|---|
| Noite (fundo mais escuro) | `--lnd-night: 6 22 33` = `#061621` | `.lnd-root`, fim dos degradês, header, menu mobile | **Sim:** `--color-night`, Tailwind `night` |
| Petróleo profundo | `primary-950 #0E2A3A` | início dos degradês escuros | já existe |
| Lima de marca | `accent-glow #61DB24` | CTA (`.lnd-btn-lime`), eyebrow escuro, check dos bullets, foco em fundo escuro, pulsos | **Sim:** alias semântico `--color-lime` (= accent-glow) |
| Teal de marca | `brand-teal #0D899C` | manchas radiais, halo | já existe (só decorativo) |
| Petróleo claro p/ texto em degradê | `primary-300 #99C3DB` | `.lnd-gradient-text` (lima→primary-300) | já existe |
| Seções claras | `bg-white`, `bg-primary-50`, `from-white to-primary-50` | Recursos, Privacidade, FAQ | já existe |
| Texto sobre escuro | `#fff`, `white/80` (corpo), `white/65–75` (legenda) | todo bloco escuro | **Sim:** `--color-on-dark`, `-soft`, `-muted` |
| Linha/borda sobre escuro | `white/8–20` | header, cards de vidro, chips | **Sim:** `--color-border-on-dark` |
| Vidro | `bg-white/[0.06]` + `border-white/12` (cards), `linear-gradient(135deg, white/14, white/6)` + `border-white/20` (chips) | Benefícios, Stats, chips do hero | **Sim:** utilitários `.glass` / `.glass-strong` |

Degradês escuros:

- `.lnd-dark`: duas radiais (teal a 36% no canto superior direito, lima a 11% no inferior esquerdo) sobre o linear
  `primary-950 → night`.
- `.lnd-dark-flat`: só o linear. É o que serve para faixas e moldura.

Contraste (comentário em `landing.css` e meu cálculo): o texto noite sobre lima fica em **~10–11:1** (o arquivo diz 11,
eu calculo ~10,2; passa folgado). Lima sobre branco dá ~1,6:1, então **lima nunca é texto sobre claro**. Em seção clara
o eyebrow usa `accent-700`.

### 2.2 Tipografia

- Inter variável auto-hospedada, com fallback de métricas (`Inter Fallback`). Já é global.
- h1 do hero: `text-4xl sm:text-5xl xl:text-6xl font-extrabold leading-[1.06] tracking-tight text-balance`.
- h2 de seção (`SectionHeading.tsx`): `text-3xl sm:text-4xl font-extrabold leading-tight tracking-tight text-balance`.
- h3 de card: `text-xl font-bold`/`font-extrabold tracking-tight`.
- Corpo: `text-base sm:text-lg leading-relaxed`, `text-ink-soft` no claro e `text-white/80` no escuro.
- Eyebrow (`.lnd-eyebrow`): 0,75 rem, peso 800, `letter-spacing: .16em`, caixa alta, com um traço de 1,5 rem antes
  (`::before`).
- Números: `tabular-nums` e peso 800.
- **[rec]** Para unificar, display e títulos ficam em **800** (não 900) e títulos de card em 700. O 900 de hoje
  (`font-black`) sai do app.

### 2.3 Espaço, raio, sombra

- Container: `max-w-[1400px] px-4 sm:px-6 lg:px-8`, o mesmo do `.container-app` que já existe.
- Ritmo vertical de seção: `py-20 sm:py-28`. Grades com `gap-4 lg:gap-5`.
- Raios:
  - card de marketing `rounded-3xl` (1,5 rem, default do Tailwind, não sobrescrito no config);
  - card de conteúdo e FAQ `rounded-2xl` (1,25 rem, valor do config);
  - botão `0.875rem` (`.lnd-btn`), ou `0.75rem` no `-sm`;
  - chip `1rem`;
  - pílula `rounded-full`.
- Altura de botão: `min-height: 3rem` (padrão) e `2.75rem` (`-sm`). Os dois passam do alvo de toque de 44 px.
- Sombras: cards claros com `shadow-card`. CTA lima com sombra tingida de lima
  (`0 14px 30px -10px lima/55%` + `inset 0 0 0 1px white/25`). Chips com `0 24px 44px -22px black/70%`. Mascote com
  `drop-shadow(0 24px 24px black/45%)`.

### 2.4 Padrões de componente

| Padrão | Implementação | Comportamento |
|---|---|---|
| Cabeçalho escuro fixo | `.lnd-header` (`night/72%`, `night/94%` ao rolar, **sem** `backdrop-filter`, de propósito: custo sobre hero animado) | logo 36 px + "InnoFlow" 800, links `white/80` com hover `white/10`, CTA lima `-sm`, menu mobile em painel `night` com `rounded-2xl` |
| Hero | `.lnd-dark` + malha de pontos mascarada (`.lnd-hero-grid`) + manchas radiais estáticas + `FlowCanvas` (canvas em idle) | pílula com rosto do mascote e slogan, h1 com `lnd-gradient-text`, 2 CTAs (lima + vidro), link "Entrar" sublinhado em lima, bullets com check lima |
| Botões | `.lnd-btn` + `-lime` / `-glass` / `-ghost` / `-solid` | `:active scale(.97)`, hover `translateY(-2px)` só com `(hover: hover)`, brilho varrendo o lima (`::after`, loop) |
| Chip flutuante (vidro) | `.lnd-chip` | rótulo em caixa alta 11 px `white/65` + valor 800 tabular |
| Card bento | `rounded-3xl border p-6 sm:p-7 shadow-card`; variante "grande" com `from-primary-950 to-primary-800` e ícone gigante a 6% no canto | holofote que segue o ponteiro (`.lnd-spot`, `--mx/--my`) |
| Card de vidro | `rounded-3xl border-white/12 bg-white/[0.06]` | ícone em quadrado `accent-glow/15` + `ring-accent-glow/25` |
| Badge/chip | pílula `bg-white/10 ring-white/20` no escuro; `bg-warning-100 text-warning-700` para nota | caixa alta 12 px bold |
| Lista de benefícios | bullet = círculo lima 20 px com check noite | — |
| FAQ | `<details name="faq">` nativo, `rounded-2xl border-primary-100`, aberto `border-primary-300 bg-primary-50/50`, chevron gira 180° | acessível sem JS |
| Faixa de fatos | cards de vidro sobre `.lnd-dark-flat`, com número que conta até o valor (`useCountUp`) | `aria-hidden` no número animado, `sr-only` com o valor final |
| Rodapé | `.lnd-dark-flat`, 3 colunas, rótulos em lima caixa alta, placa branca "Desenvolvido por" | — |
| Foco em fundo escuro | `outline 2px accent-glow, offset 3px` (sobrescreve o anel primary, que some no azul) | — |
| Pular para o conteúdo | link fixo que desce no foco | — |

### 2.5 Motion

Regras do próprio `landing.css`, que viram regra do design system **[rec]**:

1. O estado base é o estado final, parado e legível. Todo movimento fica dentro de
   `@media (prefers-reduced-motion: no-preference)`.
2. A revelação por rolagem (`Reveal.tsx`) só esconde o que está **abaixo da dobra no momento da montagem**, com
   leitura e escrita de layout em lote num único `requestAnimationFrame`.
3. Loops contínuos (`lnd-float`, `lnd-breathe`, `lnd-spin`, `lnd-blink`, `lnd-dash`, `lnd-bob`, `lnd-pulse-x`,
   `lnd-sweep`) só existem no hero ou em elemento decorativo `aria-hidden`, e pausam fora da tela (`.lnd-paused` +
   IntersectionObserver).
4. As seções usam `overflow: clip`, nunca `hidden`, para não quebrar `animation-timeline`.
5. Curva da marca: `--lnd-ease: cubic-bezier(.2,.8,.2,1)`. Durações de 160 ms (botão), 250 ms (header/FAQ),
   450–700 ms (entradas).
6. Custo medido e documentado nos comentários: animar `::after` dentro de pai animado custava ~700 ms de CPU a cada
   3 s a 4x (`Hero.tsx`), e o `blur-3xl` animado foi trocado por radial estático.

O app tem um bloco `prefers-reduced-motion` **global** no fim do `index.css`, que zera duração de animação e transição.
A landing usa o modelo inverso: só anima dentro de `no-preference`. **[rec]** O design system adota o modelo da
landing para tudo o que for novo e mantém o bloco global como rede de segurança.

### 2.6 Mascote

- Fonte `Mascote_InnoFlow.png` (raiz). Os derivados são gerados por `frontend/scripts/gerar-mascote.py`:
  - corpo inteiro: `mascote-{320,480,640,900}.webp` (31 a 112 KB), recorte 1006×1358;
  - rosto: `mascote-rosto-{64,128}.webp` (3,1 KB e 7,4 KB).
- **Uma única pose** existe: joinha numa mão e carregador na outra.
- A arte é azul-marinho muito escura. O comentário em `Mascot.tsx` é explícito: "sempre sobre fundo ESCURO com brilho
  atrás (`.lnd-backlight`), nunca solta no branco sem sombra".
- O piscar existe só no hero (pálpebras desenhadas por CSS, coordenadas medidas na arte).
- **[medido]** `mascote-rosto-64.webp` tem 3.124 B, abaixo do `assetsInlineLimit` padrão do Vite (4.096 B, não
  sobrescrito em `vite.config.ts`). Por isso ele **vira data URI no bundle**: funciona offline no PWA sem precache de
  imagem, e as duas CSPs permitem `img-src data:`. Os demais derivados são arquivos, e o precache do Workbox só pega
  js/css/html (comentário em `vite.config.ts`). Logo, o corpo inteiro **não** fica disponível offline sem regra nova.

### 2.7 Claro × escuro: a regra

**[lido]** A landing alterna `escuro (hero) → escuro (fatos) → claro (tour) → escuro (vantagens) → claro (recursos) →
claro (privacidade) → claro (FAQ) → escuro (CTA) → escuro (rodapé)`. O escuro é **moldura e momento de marca**. O
claro é **onde se lê**.

**[rec] Regra para o produto inteiro:**

1. **Moldura escura:** header, sidebar, bottom nav, rodapé e painel de marca de auth usam `.surface-dark` (degradê
   `primary-950 → night`).
2. **Miolo claro:** formulários, tabelas, listas, extratos e gráficos ficam em `background`/`surface`. É por
   legibilidade (o motorista usa o celular ao ar livre, no sol do posto) e por densidade (o operador lê tabela o dia
   todo).
3. **Momento de marca escuro dentro do miolo:** no máximo **um** por tela, sempre o elemento mais importante dela.
   - PWA: card de saldo, painel da recarga ao vivo, cabeçalho do recibo, estado vazio principal.
   - Admin: o KPI-herói do Dashboard.
   - QR: o cabeçalho com nome do eletroposto.
4. **Lima = ação.** É o fundo do CTA principal e o indicador de "ativo" na navegação. Nunca é texto sobre claro e
   nunca é estado semântico (o "sucesso" continua `accent-600`).
5. Não existe "dark mode" de usuário nesta proposta (T3). Se um dia existir, o escopo `.surface-dark` é o mesmo
   mecanismo, aplicado no `<html>`.

### 2.8 O que **não** copiar para telas densas

| Recurso da landing | Por que fica de fora | Onde pode |
|---|---|---|
| `FlowCanvas`, malha de pontos, manchas radiais grandes | custo de CPU/bateria e ruído atrás de dado | landing, painel de auth, 404 |
| Loops (`float`, `breathe`, `spin`, `blink`, `sweep` do CTA lima, pulso do cabo) | distraem e gastam bateria; o admin já é "sem loop" por decisão do dono (memória de 17/09) | hero da landing, 404, painel de auth (no máximo 1 loop sutil) |
| Varredura de brilho no botão lima (`::after`) | é loop, e um CTA repetido em lista vira carnaval | só o CTA do hero público |
| Revelação por rolagem (`Reveal`) | dado operacional tem que estar lá ao abrir a tela, e listas paginadas re-revelariam a cada página | landing |
| Contagem até o valor (`useCountUp`) | num valor financeiro, uma captura no meio da animação mostra um número **errado** | landing (fatos estáticos) |
| Holofote que segue o ponteiro (`.lnd-spot`) | ruído sobre linhas de tabela, e não há ponteiro no celular | cards de marketing; no máximo cards de atalho do PWA |
| Tipografia de hero (`text-6xl`, `text-balance`) e `py-28` | come a área útil | landing, 404, auth |
| `zoom` no celular, mockups, celular 3D | marketing | landing |
| Gradiente de texto em dinheiro sobre escuro | contraste incerto em valor que precisa ser lido com certeza | landing (título) |

---

## 3. Proposta de design system unificado

### 3.1 Camadas

```
┌──────────────────────────────────────────────────────────────────────────┐
│ 4. Telas (pages/*)        compõem; não definem cor/sombra próprias       │
├──────────────────────────────────────────────────────────────────────────┤
│ 3. Shells                 PublicShell · AuthShell · DriverShell ·        │
│                           AdminShell (moldura escura)                    │
├──────────────────────────────────────────────────────────────────────────┤
│ 2. Componentes base       components/ui/*  (chunk ui-kit)                │
│    + marca                components/brand/* (Logo, Mascot, MascotFace,  │
│                           BrandBackdrop) — chunk próprio, ver R3         │
├──────────────────────────────────────────────────────────────────────────┤
│ 1. Classes de DS          index.css  @layer components                   │
│                           (.surface-dark, .glass, .eyebrow, .btn-lime…)  │
├──────────────────────────────────────────────────────────────────────────┤
│ 0. Tokens                 index.css :root (paleta + semânticos)          │
│                           + tailwind.config.js (mapeia tokens → classes) │
└──────────────────────────────────────────────────────────────────────────┘
   Landing (components/landing/*, landing.css) = implementação de referência:
   lê a camada 0, NÃO importa as camadas 2 e 3 (protege o caminho crítico).
```

### 3.2 Tokens (camada 0) [rec]

A paleta de `:root` fica como está. Por cima dela entram **tokens semânticos**, todos no mesmo formato "R G B" para
funcionar com `rgb(var(--x) / <alpha-value>)`:

```css
:root {
  /* marca */
  --color-night: 6 22 33;                 /* #061621 — promovido de --lnd-night */
  --color-lime: var(--color-accent-glow); /* ação/ativo; nunca texto sobre claro */
  --color-on-lime: var(--color-night);    /* texto do CTA lima (~10:1) */

  /* sobre superfície escura (valores usados com alpha) */
  --color-on-dark: 255 255 255;           /* texto: 100% título, 80% corpo, 70% legenda */
  --color-border-on-dark: 255 255 255;    /* usar a 12–20% */

  /* foco */
  --color-focus: var(--color-primary);    /* trocado para lima dentro de .surface-dark */

  /* raios e movimento */
  --radius-control: 0.875rem;             /* botão/input lg (= .lnd-btn) */
  --radius-card: 1.25rem;                 /* card de conteúdo */
  --radius-feature: 1.5rem;               /* card de marketing/momento de marca */
  --ease-brand: cubic-bezier(0.2, 0.8, 0.2, 1);
  --dur-fast: 160ms; --dur-base: 250ms; --dur-enter: 450ms;
}
```

`tailwind.config.js` ganha:

- `colors.night` e `colors.lime` (+ `on-lime`);
- `borderRadius.control` / `card` / `feature`;
- `transitionTimingFunction.brand`;
- `fontWeight` sem alteração, com a regra de uso 800/700 da §2.2.

A landing passa a ler `--color-night` no lugar do `--lnd-night` local. É um alias, com zero mudança visual (o que
muda na landing é **só** isso, e só na F-F).

### 3.3 Superfície escura como escopo (camada 1) [rec]

```css
@layer components {
  .surface-dark {
    color: rgb(var(--color-on-dark));
    background: linear-gradient(180deg, rgb(var(--color-primary-950)), rgb(var(--color-night)));
    /* redefinição local dos tokens que os componentes base usam */
    --color-ink: 255 255 255;
    --color-ink-soft: 224 232 238;      /* ≈ white/88 sobre o fundo, calcular AA na F-A */
    --color-ink-softer: 186 201 211;
    --color-surface: 255 255 255;       /* usado com alpha 6–10% = vidro */
    --color-border: 255 255 255;        /* usado com alpha */
    --color-focus: var(--color-accent-glow);
  }
  .surface-dark-rich { /* = .lnd-dark: + as 2 radiais (hero/auth/404) */ }
  .glass        { background: rgb(255 255 255 / .06); border: 1px solid rgb(255 255 255 / .12); }
  .glass-strong { /* = .lnd-chip */ }
  .eyebrow      { /* = .lnd-eyebrow */ }
}
```

Por que escopo e não classes `-on-dark` em cada componente: Input, Badge, Skeleton, EmptyState etc. passam a funcionar
dentro de uma moldura escura **sem variante nova**, porque leem os tokens redefinidos no escopo. O cuidado é que
redefinir `--color-surface` como branco translúcido só funciona se o componente usa `bg-surface/…` com alpha. Os
componentes que usam `bg-surface` opaco (Card, Dialog) precisam de variante explícita (`Card variant="glass"`). A
Lyra lista isso por componente na F-A.

### 3.4 Mudança de regra de cascata (deliberada) [rec]

**Hoje [lido]:** o bloco "VOCABULÁRIO PREMIUM" do `index.css` está **fora de `@layer`** e, por isso, ganha dos
utilitários. A consequência documentada no próprio arquivo é a regra "aplique por `className` em cada tela, NUNCA
mude a classe default de `Card`/`Button`/…". Se `.card-premium` virasse o default de `Card`, o
`className="bg-primary-950"` do card de saldo perderia.

**Proposta:** as classes **novas** do design system nascem em `@layer components`. Os utilitários do Tailwind
(`@layer utilities`) passam a ganhar delas, que é o comportamento esperado de um componente base que aceita
`className`. Isso **libera** os componentes base para carregarem o padrão como default: `Card` passa a ter a sombra
tingida por padrão, `Button` o raio de controle, e assim por diante. Ganho adicional: classes em `@layer components`
que nenhum arquivo usa são **removidas pelo purge** do Tailwind 3, o que ajuda o orçamento de CSS global (T8). Classes
fora de layer saem sempre.

Essa mudança contradiz uma regra escrita no código e na memória da Lyra (`feedback_componente_compartilhado_pwa_admin_cascata.md`).
Ela não é um descuido: a causa da regra antiga (CSS fora de layer) deixa de existir para o vocabulário novo. O
vocabulário antigo continua fora de layer até ser removido (§3.10).

### 3.5 Componentes base (camada 2) [rec]

| Componente | Hoje [lido] | Proposta | Notas |
|---|---|---|---|
| `Button` (`buttonVariants.ts`) | `default` petróleo, `accent`, `outline`, `ghost`, `destructive`, `link`; `h-10 rounded-lg` | variantes: `lime` (CTA principal, = `.lnd-btn-lime` **sem** a varredura em loop), `primary` (petróleo, ação padrão de formulário/confirmar), `glass` (secundário sobre escuro), `outline`, `ghost`, `destructive`, `link`. Tamanhos `sm` (h-9), `md` (h-10), `lg` (min-h-12, `rounded-control`), `icon`. Hover `translateY(-1px)` só com `(hover:hover)`, `:active scale(.97)`, sombra tingida embutida (absorve `.btn-glow-*`) | `accent` vira alias de `lime`? **Não**: `accent` é verde AA com texto branco e tem usos; marcar como deprecado e migrar caso a caso |
| `Card` | `.card-elevated` (`rounded-2xl shadow-card ring-1`) | variantes: `surface` (default; sombra tingida = `.card-premium`), `interactive` (+ hover/press), `inverse` (momento de marca: degradê `primary-950→800`, ícone-marca d'água 6%, texto `on-dark`), `glass` (dentro de `.surface-dark`), `outline` (tracejado → **só** para "drop zone", não mais para estado vazio) | `CardTitle` vai para 700, `tracking-tight` |
| `Badge` | 6 variantes claras, `text-[11px]` caixa alta | mesmas 6, mais `on-dark` (pílula `white/10 ring-white/20`) e `lime` (para "ao vivo"/"novo") | o texto de badge continua ≥ 11 px **e** passa a ter contraste verificado por variante |
| `Input`, `Select`, `Textarea` | `rounded-lg border`, foco `ring-primary/40` | `rounded-control` no `lg`, foco pelo token `--color-focus` (lima dentro de `.surface-dark`), label 600 `ink-soft`, altura mínima 44 px no mobile | o `text-[16px]` anti-zoom do iOS fica |
| `Switch` | Radix-like próprio | trilho ligado `accent-600` (estado) | não usar lima em estado |
| `Dialog` | overlay `ink/50 blur-[2px]`, conteúdo `rounded-2xl p-6` | overlay `night/70` **sem** blur (custo, mesmo motivo do header da landing), conteúdo `rounded-feature`, `DialogHeader` com selo de ícone, `DialogFooter` fixo no fundo quando o conteúdo rola, ação principal `primary` (não `lime`: diálogo não é tela) | 14 diálogos migram juntos |
| `Table` | `.table-premium`, cabeçalho `bg-muted/60` 11 px caixa alta, `py-3` | prop `density="comfortable" \| "compact"` (`py-3` / `py-2`, ≈ 44 px por linha no compacto), cabeçalho fixo opcional (`sticky top-0`, o shell já rola só o `<main>`), números `tabular-nums` alinhados à direita, coluna de ações com botões `icon` `ghost` | sem hover-spotlight, sem animação de entrada |
| `Tabs` / `Segmented` | não existe `Tabs` em `ui/` (há `@radix-ui/react-tabs` no package, mas nenhum arquivo de `src/` o importa); `PeriodSelector` e a ordenação do mapa são segmentados ad hoc | `Segmented` (pílula ativa `primary`, ou `lime` dentro de `.surface-dark`) e `Tabs` (Radix) | unifica `PeriodSelector`, ordenação do Mapa e o tour da landing (que fica com o próprio) |
| `Toast` (`Toaster.tsx`, sonner `richColors`) | cores padrão do sonner | `toastOptions.classNames` com `rounded-card`, borda por tipo usando os tokens semânticos, ícone em selo | o sonner continua fora da landing (`AppToaster`) |
| `Skeleton` | `animate-pulse bg-muted` | igual. Dentro de `.surface-dark` fica `bg-white/10` automaticamente pelo token | — |
| `EmptyState` | caixa tracejada cinza + ícone | prop `tone="quiet" \| "brand"`: `quiet` (padrão, admin e listas filtradas) = sem tracejado, ícone em selo `primary/10`, título 700; `brand` (primeiro uso no PWA) = card `inverse` + `MascotFace` + CTA `lime` | a distinção vazio-por-filtro × vazio-de-verdade fica explícita na API |
| `ErrorState` | caixa `danger-50` + ícone | mantém o semântico, e ganha `tone="page"` para erro de tela inteira (mascote + "Tentar de novo") | ver `RouteError` abaixo |
| `PageHeader` (`components/painel/`) | selo de ícone + h1 900 + descrição + ações; `animate-fade-in-up` | h1 800, eyebrow opcional (`.eyebrow`, `accent-700`), **sem** animação de entrada no admin. É o único título da página: o header do shell deixa de repetir (T11) | os E2E procuram `heading level 1` pelo nome, e o texto não muda |
| `StatCard` (hoje `relatorios/MetricCard.tsx`) | `card-premium` + stagger, gradiente opcional | renomear/mover para `ui/StatCard`. Variante `hero` = `Card inverse` com valor branco 800 (não gradiente), no máximo 1 por tela. Legenda "vs. período anterior" sai de `ink-subtle` para `ink-softer` (AA, achado 1.4-2) | sem `useCountUp` |
| **Novos** | — | `RouteError` (errorElement/ErrorBoundary por área), `NotFound` (404), `LoadingScreen` (substitui `RouteFallback`/`LandingFallback`, com fundo da área), `SectionHeading` compartilhado (cópia da API da landing, sem `Reveal`), `IconBadge` (selo de ícone usado em PageHeader, DialogHeader, EmptyState, MetricCard) | o `IconBadge` tira 4 implementações iguais |

`components/brand/` (camada 2, chunk próprio):

- `Logo` (ícone 96 webp + "InnoFlow" 800, `tone="dark"|"light"`).
- `Mascot` e `MascotFace`, movidos de `components/landing/Mascot.tsx` (a landing reexporta, ver R3).
- `BrandBackdrop`: radiais estáticas e malha de pontos opcional, **sem** canvas.

### 3.6 Shells (camada 3) [rec]

**PublicShell** (substitui `components/layout/Layout`/`Header`/`Footer`):

- Header = `LandingHeader` generalizado. Mesma aparência `night/72→94%`, logo, links "Início" e "Eletropostos",
  CTA lima "Criar conta", e "Meu app"/"Painel" quando logado (unifica o achado 1.4-3). O menu de usuário vira um
  dropdown escuro.
- Footer = `LandingFooter` sem as âncoras de seção.
- Cada página pública abre com uma **faixa-título escura compacta** (`.surface-dark-rich`, `pt-24 pb-10`): eyebrow +
  h1 800 + subtítulo. O miolo segue claro.
- Em `/eletropostos` a faixa leva os filtros/busca. Hoje a página não tem busca, mas o mapa público é o caminho
  natural, então isso fica fora de escopo e anotado.

**AuthShell** (Login, Cadastro):

- Painel de marca = `.surface-dark-rich` + mascote de corpo inteiro (desktop, `--m-h` ~440 px, flutuação lenta como
  único loop) + slogan + 3 bullets com check lima, no estilo `HERO_POINTS`.
- Mobile: faixa escura curta no topo com `MascotFace` e logo, card do formulário claro sobrepondo a faixa.
- Botão "Entrar"/"Criar conta" = `lime lg`.
- Os blobs `blur-3xl` saem (achado 1.4-4).
- O texto passa a falar com o motorista (decisão D4).

**QR (`/c/...`):** cabeçalho escuro compacto com logo, nome do eletroposto (h1) e o rosto do mascote, seguido dos
cards de conector claros. O "Iniciar recarga" é o `lime lg` da tela. O mínimo da sessão continua em destaque
(requisito de produto, `decisoes-pwa-motorista` §6).

**DriverShell (PWA):**

- Header: `.surface-dark` compacto (h-14), logo `tone="dark"`, saudação e avatar. Casa com o `theme_color` (achado 1.4-6).
- Bottom nav: `night/95%` (sem `backdrop-filter`) com rótulos `white/70`. A aba ativa ganha ícone e rótulo brancos,
  pílula `white/10` e **traço lima de 3 px** acima. O pingo de sessão ativa vira ponto lima **estático**. Hoje é
  `animate-pulse`, que é loop em nav, o que o próprio guia de 17/09 proíbe.
- Miolo claro.
- A partir de `lg`, a bottom nav vira **rail lateral escuro** (o PWA aberto no desktop hoje parece um site com barra
  de app). Isso é opcional e sai da F-C se apertar.

**AdminShell:**

- Sidebar: `.surface-dark` (degradê, não chapado).
- Item ativo: `white/10` + **barra lima de 3 px à esquerda** + ícone lima.
- Títulos de grupo `white/60` (AA) e o rótulo de papel do usuário `white/70`.
- Header claro sem título duplicado (vira trilha "Financeiro / Faturamento" em 12 px), com os atalhos rápidos de hoje.
- Mobile: header com `Logo` e drawer escuro (já é).
- Rodapé com `InnovareCodeBadge` como está.

### 3.7 Admin denso: legibilidade e AA [rec]

- Miolo sempre claro (D1), tabela em `surface`, zebra **não**, hover `muted/40` (como está).
- Densidade: `compact` como padrão nas listagens com mais de 20 linhas possíveis (Sessões, Pagamentos, Auditoria,
  Carteiras) e `comfortable` nas de cadastro (Sites, Tarifas).
- Texto de tabela `text-sm` (14 px) `ink-soft`, cabeçalho 11 px 700 `ink-softer` (4,8:1, passa). `ink-subtle` só em
  placeholder e ícone.
- Ação principal da tela (ex.: "Novo site") = `lime` (D2), uma por tela. Salvar/confirmar dentro de diálogo =
  `primary`.
- Motion no admin: só feedback de toque (`:active`), hover e transições ≤ 160 ms. Sem `animate-fade-in-up` em
  `PageHeader` e `MetricCard` (hoje têm) e sem loop.
- Toda combinação texto/fundo nova entra numa tabela de contraste na F-A, calculada e depois conferida pelo axe da Íris.

### 3.8 Dados: gráficos, paleta, mapa [rec]

- **Série única** (faturamento por dia, `RevenueBarChart`): sequencial em `primary-500/600`, como hoje. Em
  `Card inverse` usa `primary-300` + destaque lima no hover.
- **Categóricas** (`PaymentSplitDonut` e futuras), nesta ordem fixa: `primary-600`, `accent-600`, `brand-teal`,
  `warning-600`, `primary-300`. Lima **não** entra em marca fina sobre claro (contraste ~1,6:1). Lima só sobre escuro.
- **Estado** (livre/ocupado/fora do ar, nos marcadores do mapa e nos badges): verde `accent-600` / âmbar `warning-600` /
  cinza `ink-softer`. Esses já são os valores de hoje. Não usar lima, para não confundir "livre" com "ação".
- **Mapa:**
  - restyle só do container (raio `card`), dos controles de zoom (botões `glass` sobre o mapa) e do marcador (anel
    branco + sombra tingida);
  - tiles continuam OSM claros. Trocar de provedor (ex.: tiles escuros) **muda a CSP** (`img-src … https://tile.openstreetmap.org`,
    em 5 cópias da linha no `nginx.conf.template`) e passa pelo Órion. Não recomendo.

### 3.9 Mascote: onde entra [rec, sujeita a D3]

| Lugar | Variante | Tamanho | Motion |
|---|---|---|---|
| Painel de marca Login/Cadastro (desktop) | corpo inteiro + `.lnd-backlight` | `--m-h` 360–440 px | flutuação lenta (1 loop), parado com reduce |
| Faixa de auth (mobile) e cabeçalho do QR | `MascotFace` em círculo `white/10` | 40–56 px | nenhum |
| 404 e erro de tela inteira (`NotFound`, `RouteError`) | corpo inteiro sobre `.surface-dark-rich` | 280–360 px | entrada única (`lnd-rise`) |
| Estado vazio **de primeiro uso** no PWA (sem recarga em andamento, histórico vazio, sem cartão) | `MascotFace` em `Card inverse` | 64 px (inline, offline-safe) | nenhum |
| Recibo: recarga concluída | `MascotFace` + check lima | 64 px | `pop` único |
| Carregando rota (`LoadingScreen`) | **não** usar o mascote: spinner, porque o carregamento rápido piscaria o robô | — | — |
| Admin | **só** 404, erro geral e "acesso restrito". Nunca em tabela, KPI ou vazio de filtro | — | nenhum |

Regras fixas, vindas da arte (lidas em `Mascot.tsx`):

- sempre sobre escuro com brilho atrás;
- `alt` descritivo quando é conteúdo e `alt=""` + `aria-hidden` quando é decoração (o `MascotFace` já faz isso);
- `width`/`height` sempre declarados (CLS).

### 3.10 Convivência com o vocabulário antigo [rec]

1. **Aliases durante a migração.** `.card-premium`, `.card-premium-interactive`, `.btn-glow-primary/-accent`,
   `.pressable`, `.text-gradient-brand`, `.shadow-tinted-primary`, `.table-premium` e os `animate-*` **continuam
   funcionando** (fora de layer, como hoje). Ganham no comentário do `index.css` o aviso "DEPRECADO desde F-A, use
   `<Card variant=…>` / `<Button variant=…>`".
2. **Catraca (ratchet).** Um teste vitest novo (`src/test/vocabularioDeprecado.test.ts`) conta as ocorrências de cada
   classe deprecada em `src/pages` e `src/components` (fora `components/landing`) e falha se a contagem **subir**
   acima do número gravado no próprio teste. Cada fase **baixa** o número. Na F-F, zero e o bloco é apagado. Mesmo
   espírito do vitest que já barra conteúdo de operador na landing.
3. **`lnd-*` não é deprecado.** É local da landing e continua lá. A F-F pode trocar `--lnd-night` por `--color-night`.
4. **Memória e documentação.** O bloco "VOCABULÁRIO PREMIUM" do `index.css` e a memória da Lyra sobre a regra de
   cascata são atualizados **na mesma fase** que muda a regra (F-A). Senão a próxima sessão segue a regra velha.

### 3.11 Orçamentos (portões numéricos) [rec]

| Métrica | Linha de base | Orçamento |
|---|---|---|
| CSS global gzip (`index-*.css`) | 11.919 B [medido no `dist/` de hoje; refazer na F-A] | ≤ +2.500 B no fim da F-F |
| JS crítico da landing (modulepreload do `index.html`) | lista atual de `dist/index.html` | **nenhum chunk novo** na lista |
| Lighthouse mobile da landing | **refazer** com `scripts/medir-lighthouse.mjs` (mediana de 5) | não piorar a mediana em mais de 2 pontos |
| Lighthouse mobile de `/login` e `/app` | idem | idem |
| CLS por rota | refazer | ≤ 0,02 |
| Precache do PWA (Workbox) | tamanho total listado no build | ≤ +40 KB (o mascote de corpo inteiro não entra) |

---

## 4. Plano faseado

Premissas **[rec]**: a Lyra é a única de frontend. Cada fase termina com typecheck, lint, vitest, E2E completo (185),
build e as duas builds (`vite build` + `vite build --config vite.pagamento-cartao.config.ts`), além do portão visual
da Íris. Nenhuma fase depende de backend, então Vega e Cronos não entram.

### F-A: fundação (5 dias)

**Escopo:**

- A0 (Íris, **antes** de qualquer código): linha de base visual das 31 rotas em 375/768/1440, mais os estados da
  sessão ao vivo, do recibo e de um diálogo do admin. Linha de base do Lighthouse (landing, `/login`, `/app`) e do
  tamanho de CSS/JS/precache.
- Tokens semânticos (§3.2), `.surface-dark`/`.glass`/`.eyebrow` em `@layer components` (§3.3–3.4) e mapeamento no
  `tailwind.config.js`.
- `Button`, `Card`, `Badge`, `Input`/`Select`/`Textarea`, `Dialog`, `Table` (densidade), `Segmented`/`Tabs`, `Toaster`,
  `Skeleton`, `EmptyState` (`quiet`/`brand`), `ErrorState` (`page`), `PageHeader`, `StatCard`, `IconBadge`.
- `components/brand/` (Logo, Mascot, MascotFace, BrandBackdrop).
- `NotFound`, `RouteError` e `LoadingScreen` (**sem** ligar o 404 na rota `*` antes de D5).
- Catraca do vocabulário deprecado e tabela de contraste.
- **Catálogo interno** `/__ds`, montado só com `import.meta.env.DEV` (fora do build de produção). Ele dá à Íris uma
  tela única para comparar componentes a cada fase.

**Arquivos:** `src/index.css`, `tailwind.config.js`, `src/components/ui/*`, `src/components/brand/*` (novo),
`src/components/painel/PageHeader.tsx`, `src/components/relatorios/MetricCard.tsx`, `src/App.tsx` (só fallback e
catálogo), `src/test/vocabularioDeprecado.test.ts` (novo).

**Portão:**

- E2E 185/185 sem alterar spec.
- As telas mudam pouco nesta fase: os defaults dos componentes mudam, mas cor de ação e cascas não. A Íris compara a
  linha de base e **classifica** cada diferença (esperada × regressão).
- Orçamento de CSS dentro do previsto e `index.html` sem modulepreload novo.

**Riscos:**

- Mudar o default de `Card`/`Button` mexe em PWA **e** admin ao mesmo tempo. É intencional, mas a revisão visual
  tem de cobrir os dois.
- `Dialog` sem blur e com overlay mais escuro muda 14 diálogos de uma vez.

### F-B: Auth + Público (3–4 dias)

**Escopo:** `AuthShell` (Login, Cadastro, mais a faixa mobile), `PublicShell` (header/footer escuros), `/eletropostos`
(faixa-título escura + miolo claro), QR `/c/...` (cabeçalho escuro, CTA lima) e o 404 (se D5 = sim).

**Arquivos:** `pages/Auth/*`, `components/auth/GoogleAuthSection.tsx` (só tema; o botão do Google segue a marca
Google), `components/layout/*` (vira `PublicShell`), `pages/Public/Eletropostos.tsx`, `pages/Public/ChargePointLanding.tsx`,
`components/sites/PublicSiteCard.tsx`, `components/chargePoint/*`.

**Portão:**

- E2E: `landing.spec.ts:314` **muda deliberadamente** se D5 = sim (rota inexistente deixa de ir para `/`) e se o
  header público trocar o nome da navegação ("Navegação principal" é procurado por esse nome; **manter o
  `aria-label`** evita reescrever o teste).
- `login-google.spec.ts` e `auth-limites-e-segredo.spec.ts` verdes.
- CLS de `/login` = 0 (já foi conquistado no commit `f781d55`).

**Riscos:**

- O `GoogleAuthSection` reserva espaço por "dica local" (anti-CLS). O novo layout não pode mudar a altura reservada.
- O texto do painel de auth depende de D4.

### F-C: PWA do motorista (5–6 dias)

**Ordem por tráfego:** casca → Sessão (ao vivo, conectando, parando, travada F5.9) → Início → Recibo → Carteira →
Adicionar saldo (Pix) → Mapa → Histórico → Cartões.

**Escopo:**

- `DriverShell` (header e bottom nav escuros, rail lateral ≥ lg opcional).
- Painel da recarga ao vivo como **momento de marca escuro**, no estilo do chip "Recarga em andamento" do hero:
  kWh 800 branco e lima só no indicador ao vivo. `animate-live-glow` só enquanto há dado ao vivo, como já é regra.
- Estados vazios `brand` com o mascote.
- Topup Pix com cards e CTA lima.

**Arquivos:** `pages/App/*`, `components/carteira/*`, `components/sessao/*`, `components/estacoes/*`,
`components/pwa/InstallPromptCard.tsx`.

**Portão:**

- `pwa-fluxo-recarga`, `pwa-topup-pix`, `pwa-cartao-*`, `sessao-travada`, `mapa-eletropostos` e
  `pwa-gateway-desligado` verdes.
- Teste manual de sol forte não existe. Por isso a Íris mede contraste de todos os textos do miolo e da moldura.
- Precache dentro do orçamento.

**Riscos:**

- A tela de sessão tem textos ligados à F5.9 (`sessionClosureCopy.ts`) que são contrato com o dono. Muda o visual,
  **nunca o texto**.
- `StationsMap` usa `.leaflet-*` no E2E.
- O estado do mock reseta em `page.goto` (memória da Lyra), então as capturas de fluxo têm de ser feitas numa única
  página.

### F-D: Admin (6–8 dias)

**Escopo:**

- `AdminShell` (sidebar degradê, item ativo lima, contraste dos grupos, título sem duplicidade, logo no mobile).
- Dashboard: `StatCard hero` + paleta categórica.
- As 14 telas: `PageHeader`, `Table` com densidade, ação principal lima e remoção de stagger/fade.
- Os 14 diálogos.
- Gateway de pagamento: banners com os tokens e barra de salvar.

**Arquivos:** `pages/Admin/**`, `components/admin/*`, `components/painel/*`, `components/relatorios/*`,
`components/tariffAssignments/*`, `components/chargePoints/*`, `components/connectors/*`.

**Portão:**

- `admin-*` E2E (5 specs) verdes. Os `heading level 1` por nome continuam iguais.
- Comparativo visual 768/1440 de todas as tabelas, incluindo rolagem horizontal **contida no card**
  (`Table.tsx` mantém `overflow-x-auto` + `relative`, achado de Carteiras a 390 px).
- Nenhum loop contínuo no admin: grep de `animate-` no `pages/Admin` só com classes permitidas.

**Riscos:**

- Volume. É a maior fase, e por isso dá para fatiar em D1 (shell + Dashboard + Sessões) e D2 (restante).
- Densidade compacta pode cortar conteúdo em células com `whitespace-nowrap`.

### F-E: documento isolado do cartão (1–1,5 dia)

**Escopo:** `pagamento-cartao.css` ganha os tokens novos (continua **cópia**, não import: a decisão de isolamento de
F5.3 vale), cabeçalho escuro compacto com logo, card claro, botão `lime lg` e, opcionalmente, Inter auto-hospedada.

Para usar Inter, os `.woff2` entram na build isolada. A CSP desta location já tem `font-src 'self'` e não muda, mas o
peso da página sobe cerca do tamanho do subset latin. **[rec]** Manter a fonte do sistema. Esta página é de passagem
e deve ser a mais leve do produto. A diferença de fonte é aceitável.

O `MascotFace` 64 px como data URI é permitido (`img-src 'self' data:`), mas **[rec]** não usar. Página de pagamento
sem distração.

**Arquivos:** `src/pagamento-cartao/pagamento-cartao.css`, `CardForm.tsx`, `CardTokenizationApp.tsx` (só
className/markup).

**Portão:**

- **Órion** confere que a CSP da location `= /pagamento-cartao.html` ficou byte a byte igual.
- Nenhum `<link>`/`<script>`/`<style>` de terceiro no HTML.
- Nenhum import de `src/index.css` ou `components/ui` dentro de `src/pagamento-cartao/`.
- `pwa-cartao-sop-real` e `pwa-cartao-salvo` verdes.

**Risco:** alguém "resolver a duplicação" importando os tokens do app. Isso quebra o isolamento, porque esta pasta é
auto-contida de propósito.

### F-F: polimento, motion e QA visual (3 dias)

**Escopo:**

- Revisão de motion contra §2.5/§2.8 em todas as telas (reduce ligado e desligado).
- Remoção do vocabulário deprecado (catraca em zero, bloco apagado do `index.css`).
- `--lnd-night` → `--color-night` na landing.
- Toque final de microinterações (hover/press com `--ease-brand`).
- `toHaveScreenshot` do Playwright em 1 tela-âncora por área (landing hero, `/login`, `/app`, `/app/sessao`,
  `/admin/dashboard`, `/admin/sites`, mais o catálogo `/__ds`), com tolerância. Vira regressão visual permanente.
- Medição final dos orçamentos.

**Portão:** todos os orçamentos da §3.11, axe sem violação séria nas rotas-âncora e E2E 185+ verdes.

### Totais e paralelização

| Fase | Dias (Lyra) | Íris | Órion | Pode paralelizar com |
|---|---|---|---|---|
| F-A | 5 | A0 antes + comparativo depois | — | nada (é a fundação) |
| F-B | 3–4 | comparativo 375/768/1440 + axe | — | a Íris valida F-A enquanto a Lyra faz F-B |
| F-C | 5–6 | idem + fluxos de recarga em página única | — | idem |
| F-D | 6–8 | idem + tabelas a 768 | — | idem |
| F-E | 1–1,5 | E2E de cartão | **CSP + isolamento** | pode ir **antes** de F-D se o Órion estiver livre |
| F-F | 3 | baseline `toHaveScreenshot` + axe | olhar final CSP | — |
| **Total** | **≈ 23–28** | | | |

Com uma frontend só, o paralelismo real é a **Íris validando a fase N enquanto a Lyra faz a N+1**, e o Órion
entrando só na F-E. A Alexandria documenta o catálogo `/__ds` e a regra de tema depois da F-A.

---

## 5. Decisões do dono

Poucas e objetivas. Para cada uma, a minha recomendação.

| # | Pergunta | Opções | Recomendação | Bloqueia |
|---|---|---|---|---|
| **D1** | Regra de tema do produto | (a) **moldura escura, miolo claro** (§2.7); (b) PWA todo escuro como a landing, admin com miolo claro; (c) tudo claro, escuro só no header | **(a).** É o que a própria landing faz (escuro emoldura, claro é onde se lê). Mantém tabela e formulário legíveis ao sol e ao longo do dia, e não exige um segundo conjunto de cores de estado. (b) custaria revalidar o contraste de todos os estados e tende a cansar em extrato longo | F-A em diante |
| **D2** | Cor da ação principal | (a) **lima** para a ação principal de cada tela (uma por tela, PWA **e** admin), petróleo para salvar/confirmar em formulário e diálogo; (b) lima só no público/PWA, admin todo petróleo | **(a).** "100% do projeto" no padrão da landing passa pelo CTA lima. Ele é a assinatura mais visível dela. Com a regra "uma por tela" e "nunca em estado", não confunde com o verde de "livre/sucesso" | F-A (variantes do `Button`) |
| **D3** | Onde entra o mascote | tabela da §3.9 | **Aceitar a §3.9:** auth, QR, 404/erro, vazio de primeiro uso no PWA e recibo. No admin, **só** 404, erro e acesso restrito | F-B/F-C (não bloqueia F-A) |
| **D4** | Texto do painel de marca do Login/Cadastro | (a) falar com o motorista, como a landing; (b) manter o texto de operador | **(a).** Operador e motorista entram pelo mesmo formulário, e a landing já decidiu falar só com o motorista (`4f1eeb9`) | F-B |
| **D5** | Rota inexistente | (a) **página 404 de verdade** (mascote, "Voltar ao início" / "Ver eletropostos"); (b) manter o redirecionamento silencioso para `/` | **(a).** O redirecionamento esconde link quebrado (inclusive QR impresso com identidade errada, caso em que o motorista cai na landing sem saber por quê). Custo: reescrever 1 E2E como mudança deliberada | F-B |
| **D6** | Poses novas do mascote | (a) encomendar 2–3 poses (erro/confuso, comemorando, procurando) à mesma origem da arte; (b) só a pose atual + rosto | **(b) agora, (a) quando houver arte.** Não bloquear o trabalho por ilustração. O pipeline `gerar-mascote.py` já aceita outra fonte. Não gerar poses por IA sem aprovação do dono | nada |
| **D7** | Meta de Lighthouse da landing | (a) "≥ 90"; (b) "não piorar a linha de base medida" | **(b).** O `PROGRESSO.md` registra mediana **72** antes das otimizações `88fd7b4`, `d4d453a`, `dd1a114` e `133a4ac`. Não medi o número atual, e "≥ 90" pode já não ser verdade hoje. Esta unificação **não toca** o caminho crítico da landing, então o portão justo é "não piorar" | F-A (portão) |

**Pode começar já, sem nenhuma decisão:**

- A0 da Íris: linha de base visual e Lighthouse.
- Tokens semânticos, `.surface-dark`, migração para `@layer components`, catraca e tabela de contraste.
- Componentes base **exceto** a escolha de qual variante é o "primário" de cada tela (D2).
- `components/brand/` e o catálogo `/__ds`.
- `NotFound`/`RouteError`/`LoadingScreen` como componentes, sem ligar a rota `*` (D5).
- Correção de contraste da sidebar do admin (achado 1.4-1). É defeito AA, não gosto.

---

## 6. Riscos consolidados

| # | Risco | Prob. | Impacto | Mitigação |
|---|---|---|---|---|
| R1 | E2E quebrando por texto/papel ARIA alterado no redesenho | média | alto (185 testes, 637 `getByText/Role`) | regra "muda visual, não muda texto nem `aria-label`" e mudanças deliberadas listadas por fase (hoje só `landing.spec.ts:314`, condicionada a D5) |
| R2 | Meta de Lighthouse inconsistente (≥ 90 × mediana 72 registrada) | alta | médio | medir a linha de base na A0 e adotar o portão "não piorar" (D7) |
| R3 | Componente compartilhado (`components/brand`, tokens) puxar chunk novo para o caminho crítico da landing. O bundler já fundiu chunks errado duas vezes (comentários em `vite.config.ts` e `vite.pagamento-cartao.config.ts`) | média | alto | a landing **não** importa `components/ui` nem shells. `Mascot` vai para `components/brand` com a landing reexportando, e a F-A confere o modulepreload do `dist/index.html` antes/depois |
| R4 | CSS global crescer (todo utilitário novo vai para o CSS que bloqueia a landing) | média | médio | `@layer components` (purgável), orçamento de +2,5 KB gzip, apagar o vocabulário deprecado na F-F |
| R5 | Mudança de default em `Card`/`Button`/`Dialog` vazar para telas não revisadas | alta (é o objetivo) | médio | linha de base A0 e classificação de cada diferença pela Íris; o catálogo `/__ds` |
| R6 | Contraste AA em superfície escura e lima | média | alto (acessibilidade e sol) | tabela de contraste calculada na F-A, axe por fase, lima nunca como texto sobre claro |
| R7 | Isolamento do documento de cartão quebrado por "reaproveitamento" de CSS | baixa | **crítico** (escopo PCI SAQ A-EP) | F-E com Órion; regra "nenhum import de `src/index.css`/`components/ui` em `src/pagamento-cartao/`" |
| R8 | Motion em excesso no PWA/admin (bateria, distração) | média | médio | §2.8 como checklist de revisão, admin sem loop, reduce testado por fase |
| R9 | Mascote offline: o corpo inteiro não está no precache | alta | baixo | o rosto de 64 px vira data URI (inline). O corpo inteiro só em telas online (auth, 404). Se preciso, uma regra de runtime cache para `/assets/*.webp` (CacheFirst), avaliada com o Órion |
| R10 | Uma frontend só: a F-D (6–8 dias) concentra risco de prazo | média | médio | fatiar em D1/D2, porque cada fatia é entregável |

---

## 7. Fora de escopo (anotado, não proposto)

- Dark mode do usuário (T3). O mecanismo `.surface-dark` permite no futuro.
- Busca e filtros na página pública `/eletropostos` (é conteúdo, não design system).
- Rail lateral do PWA no desktop, se apertar na F-C.
- Trocar o provedor de tiles do mapa (CSP).
