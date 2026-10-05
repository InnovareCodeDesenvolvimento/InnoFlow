# Design system InnoFlow (frontend)

Guia curto para o dono do produto e para quem entra no projeto. O plano e a auditoria que originaram tudo estão em `docs/DESIGN-SYSTEM-UNIFICACAO.md`; este arquivo é o **estado final** (fases F-A a F-F concluídas em 05/10/2026) e o que fazer no dia a dia.

## 1. A ideia em uma frase

Moldura **escura** de marca, miolo **claro** onde se lê, **lima = ação**. A landing é a referência; o PWA do motorista, o Admin, o login, o QR e a página do cartão seguem a mesma gramática.

## 2. As decisões do dono (D1–D7)

| | Decisão | Na prática |
|---|---|---|
| **D1** | Escuro emoldura, claro é onde se lê | cabeçalho/navegação/faixas em `.surface-dark`; cartões, tabelas e formulários em superfície clara. Nunca texto longo ou dado denso sobre degradê. |
| **D2** | Um CTA lima por tela | `Button variant="lime"` é **a** ação da tela (no máximo uma). Salvar/confirmar dentro de formulário e diálogo = petróleo (`primary`/`default`). Lima nunca é estado (sucesso continua verde) nem texto sobre claro. |
| **D3** | Mascote mais presente | topo do Dashboard, vazios de primeiro uso, erros, "acesso restrito", sucesso (recibo/Pix/cartão), 404, carregamento longo. **Nunca** sobre tabela, KPI, gráfico nem em vazio de filtro. Sempre sobre fundo escuro. |
| **D4** | A marca fala com o motorista | sem "painel administrativo / operadores" em login, cadastro, eletropostos e QR. |
| **D5** | 404 de verdade | rota `*` mostra `NotFound` (não redireciona). |
| **D6** | Fonte | Inter auto-hospedada (sem Google Fonts); a página do cartão usa fonte do sistema. |
| **D7** | Acessibilidade medida | contraste AA com axe **e** por pixel sobre degradê; foco por teclado visível; alvos de toque ≥ 44 px no PWA. |

## 3. Tokens (`src/index.css` + `tailwind.config.js`)

Cores são triplas `R G B` em `:root` (para `rgb(var(--x) / <alpha>)`). Escopos que trocam os tokens de lugar: `.surface-dark` (ink/superfície/borda/foco viram tons escuros; foco vira lima).

- **Marca:** `primary` (petróleo, 50…950), `accent` (verde de estado/“Flow”), `night` `#061621`, `lime` `#61DB24`, `on-lime` (texto sobre lima), `brand-teal` (só decoração).
- **Texto:** `ink` › `ink-soft` › `ink-softer` (texto secundário, AA) › `ink-subtle` (**só** ícone decorativo e placeholder — nunca texto).
- **Estado:** `success|warning|danger|info` (50/100/600/700). Folga de contraste medida: `accent`/`success` = `#1F7B25` (5,36:1 em branco), `warning-700` = `#A74C08` (5,12:1 sobre `warning-100`); `info-700` sobre `info-100` ainda é 4,79:1. `state-off` `#6B7280` é **fundo** de marcador “fora do ar”/interruptor desligado.
- **Foco:** `--color-focus` (petróleo; lima em `.surface-dark`), `--color-on-focus`.
- **Raios:** `rounded-control` 14 px (botão, campo — via `--field-radius`), `rounded-card` 20 px, `rounded-feature` 24 px (momento de marca, diálogo — `--dialog-radius`). Raios menores (`lg`/`xl`) só em peças internas (chips, telhas).
- **Sombras:** `shadow-tinted` / `shadow-tinted-card` (tingidas de petróleo), `shadow-lime`/`-lg` (só do CTA lima). Camadas flutuantes (menu, sheet, skip-link) usam `shadow-lg` neutro.
- **Movimento:** `--ease-brand`, `--dur-fast` 160 ms, `--dur-base` 250 ms, `--dur-enter` 450 ms. Tudo sob `prefers-reduced-motion`.

## 4. Componentes (`src/components/*`)

- **`ui/`** — `Button` (`lime` ação · `primary`=`default` salvar/confirmar · `glass` sobre escuro · `accent` · `outline` · `ghost` · `destructive` · `link`), `Card` (`surface` · `inverse` momento de marca, 1 por tela · `glass` · `outline`), `Badge`, `IconBadge`, `Input`/`Select`/`Textarea` (raio e foco por token), `Dialog`/`ConfirmDialog` (véu noite 62% **sem desfoque**), `Segmented` (grupo de botões com `aria-pressed`), `Switch`, `Table` (`density="comfortable|compact"`), `StatCard` (`variant="hero"`), `EmptyState` (`quiet` padrão · `brand` primeiro uso com mascote · `outline` legado), `ErrorState` (`art` = mascote; `tone="page"` tela inteira), `Skeleton`, `Pagination`, `Toaster`, `Alert` (aviso em linha: `tone` info/warning/danger/success/neutral/muted × `size` md bloco/sm nota; o `role` é de quem usa), `InlineCode` (variável/comando no meio do texto). `Button` ganhou `size="touch"`/`"touch-sm"` (44 px abaixo de `sm`, 40/32 depois — telas de formulário no celular) e `"field"` (mesma altura do `Input`, para o botão ao lado do campo); `CardTitle` aceita `as="h2"` quando o card é seção de 1º nível logo abaixo do h1.
- **`brand/`** — `Logo`, `Mascot`/`MascotFace`, `BrandBackdrop`. **Duas cópias do `Mascot` de propósito** (landing × brand) para a landing não compartilhar chunk com o app; `Mascot.parity.test.ts` impede que divirjam. Imagens do `brand` importam com `?url`.
- **`feedback/`** — `NotFound`, `RouteError` (boundary leve) + `RouteErrorView`, `LoadingScreen` (mascote só após 700 ms), `AccessDenied` (403 de marca).
- **Shells** — público (`layout/Header|Footer|PageBand`), auth (`auth/AuthShell`), PWA (`pages/App/Layout` + `pwa/AppBand`; trilho lateral ≥ lg), Admin (`pages/Admin/Layout`, `admin/SidebarNav`; trilha no cabeçalho, **sem heading** — o h1 é o do `PageHeader`).
- **Busca de motorista (Admin):** `hooks/useDriverSearch` (regra única: debounce, OPERATOR ≥ 3 letras, `minChars` por tela) + `admin/DriverSearchField` — usados por Carteiras e pelo diálogo "Iniciar recarga" (`chargePoints/remoteStart/`, só ADMIN). Escolha única em lista = `remoteStart/RadioRow` (radio nativo `sr-only` + cartão de 44 px; desabilitado escreve o motivo, sem opacidade).
- **Admin:** raiz da página = `<div className="space-y-6">` sem `max-w-*` (largura = a do shell, igual em todas as telas), `painel/PageHeader`, `admin/AdminStates` (`AdminErrorState`, `AdminFirstUseState` = erro/vazio com mascote).
- **Menu do Admin abaixo de `lg`:** `admin/AdminDrawer` — diálogo de verdade (Radix: `role="dialog"` nomeado "Menu", foco entra, Tab preso, resto `aria-hidden`, Esc fecha, foco volta a "Abrir menu"); novo painel lateral/menu em overlay deve ser Radix Dialog, nunca `div fixed`.
- **Documento do cartão** (`src/pagamento-cartao/`): **CSS copiado e dedicado** (`--pc-*`), nunca importa nada do app (ver §8).

Classes utilitárias de marca (em `@layer components`): `.surface-dark`, `.surface-dark-rich`, `.glass`, `.glass-strong`, `.eyebrow`, `.brand-*`, `.press` (toque), `.card-elevated`. Animações (no Tailwind): `animate-enter`, `-pop`, `-sheet`, `-radar`, `-live` (+ `fade-in`/`scale-in` do Dialog). **`radar` e `live` são loops e só existem no PWA; o Admin não tem nenhum** (`src/test/adminSemLoops.test.ts`).

O vocabulário antigo de 17/09 (`card-premium`, `pressable`, `text-gradient-brand`, `btn-glow-*`, `animate-fade-in-up`, `stagger-*`…) foi **apagado**; `src/test/vocabularioDeprecado.test.ts` falha se alguém reintroduzir (a classe ficaria sem estilo, em silêncio).

## 5. Como criar uma tela nova

1. **Qual área?** PWA (`pages/App`), Admin (`pages/Admin`), público (`pages/Public`/`pages/Auth`). Reaproveite o shell: não crie cabeçalho próprio.
2. **Estrutura:** PWA = `AppBand` (título, herói) + miolo claro; Admin = `PageHeader` (único h1) + conteúdo. **Um h1 por tela.**
3. **Dados:** trate **carregando** (`Skeleton` com a *forma* do conteúdo — evita CLS), **erro** (`ErrorState`/`AdminErrorState`), **vazio** (`EmptyState quiet` para filtro; `brand` + mascote para primeiro uso).
4. **Ação principal:** um `Button variant="lime"`; o resto `outline`/`ghost`; salvar em diálogo = `primary`.
5. **Texto e `aria-label`** são contrato dos E2E (buscam por texto/papel): mude o visual, não o texto.
6. **Tokens, não valores:** `rounded-card`, `shadow-tinted`, `text-ink-softer`, `bg-state-off`; nada de hex solto. `ink-subtle` só em ícone `aria-hidden`.
7. **Movimento:** no máximo `animate-enter` no bloco-herói; lista não anima por linha; sem loop fora do PWA.
8. **Teste:** E2E do fluxo + (se a tela entra no harness) `rotas.ts` para ela ganhar baseline.

## 6. Comandos (a partir de `frontend/`)

| Para | Comando |
|---|---|
| tipos / lint / unidade | `npx tsc -b` · `npm run lint` · `npx vitest run` |
| E2E completo (mock MSW) | `npm run test:e2e` |
| Regressão visual (3 larguras × 34 rotas + estados) | `npm run test:visual` |
| Catálogo `/__ds` (só dev) | `npm run test:visual:catalogo` |
| Contraste (axe + catraca) | `npm run test:contraste` |
| Régua por fase | `npx playwright test --config playwright.visual.config.ts criterios-fb criterios-fc criterios-fd criterios-fe` |
| Tamanhos / orçamentos | `npm run build && node scripts/medir-tamanhos.mjs --comparar e2e-visual/tamanhos-baseline.json` |
| Lighthouse (mediana de 5) | `npm run build && MSYS_NO_PATHCONV=1 node scripts/medir-linha-de-base.mjs --comparar e2e-visual/lighthouse-baseline.json --json saida.json` |
| Ver o catálogo | `npm run dev:mock` → `http://localhost:5173/__ds` |

Orçamentos (A0 = linha de base de 03–04/10/2026): CSS global gzip **≤ +2500 B**, precache **≤ +40 KB**, **`modulepreload` do `index.html` = 6**, CLS por rota ≤ 0,02, Lighthouse da landing sem piorar mais de 2 pontos. Sempre reinicie o dev server depois de mexer no `tailwind.config.js` (o servidor antigo ignora a mudança).

## 7. Política da baseline visual

- A baseline mora em `e2e-visual/baseline/<plataforma>/<largura>/` (JPEG q70) e **só vale para a plataforma em que foi gravada** (hoje `win32`; Linux/CI precisaria de baseline própria).
- **Nunca regrave para “passar”.** Mudança de aparência intencional → a **Íris classifica** cada diferença (aceita / identica / reportar) com prova (DOM + geometria + máscara de pixels) e só então grava; quem implementa **propõe**, não grava.
- O harness não vê o que está fora da janela (sidebar em 375/768, nav fixa): isso fica com as réguas `criterios-f*` e com o axe.
- Toda fase termina com: tsc, lint, vitest, E2E 2×, `test:visual` (lista das telas que mudam), contraste (0 reprovados), tamanhos, Lighthouse, screenshots revisados.

## 8. Regras de segurança que o design system não pode quebrar

- **Página do cartão** (`pagamento-cartao.html`, SAQ A-EP): CSS **dedicado**, sem import de `src/index.css`/`components/ui`; só `react`, `@/types/**` e `@/assets/**` (guarda por *allowlist* no `eslint.config.js`); sem `localStorage`/`sessionStorage`/cookie; nenhum recurso de terceiro; a CSP do nginx é revisada pelo Órion. O CI confere o bundle do cartão (sem libs do app, sem caminho mock, fora do precache).
- Dinheiro, saldo e sessão **nunca** vêm de cache do service worker (`NetworkOnly` em `/api/*`).
- Texto de privacidade/LGPD e mensagens de erro de pagamento são contrato com o dono: o visual muda, o texto não.

## 9. Mapa rápido

`src/index.css` (tokens, escopos, `@layer components`) · `tailwind.config.js` (cores, raios, sombras, animações) · `src/components/ui|brand|feedback` · `src/dev/DesignSystemCatalog.tsx` (catálogo, **só dev**, fora do build) · `e2e-visual/` (harness, réguas, baseline) · `src/test/vocabularioDeprecado.test.ts`, `adminSemLoops.test.ts`, `catalogoFora.test.ts` (guardas).
