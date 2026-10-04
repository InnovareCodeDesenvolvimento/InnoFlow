# e2e-visual: regressão visual, contraste AA e linha de base (A0 da unificação do design system)

Este diretório **não faz parte** da suíte E2E de 185 testes (`frontend/e2e/`, `npm run test:e2e`). É um projeto Playwright à parte
(`frontend/playwright.visual.config.ts`) para a regressão visual **não deixar a suíte funcional lenta nem flaky**.

| Comando (a partir de `frontend/`) | O que faz |
|---|---|
| `npm run test:visual` | Fotografa as rotas e estados nos 3 viewports e **compara** com a baseline. Falha se passar do limiar. |
| `npm run test:visual:update` | **Regrava** a baseline. Só com aprovação (ver política abaixo). |
| `npm run test:contraste` | axe-core (`color-contrast`) nas mesmas rotas/viewports + relatório `CONTRASTE-ESTADO-ATUAL.md` + catraca. |
| `node scripts/relatorio-contraste.mjs --gravar` | Regrava `contraste-baseline.json` (a catraca) depois de rodar `test:contraste`. |
| `npm run build && npm run medir:tamanhos` | CSS global, JS por chunk, precache e modulepreload (gzip e bruto). `-- --comparar e2e-visual/tamanhos-baseline.json` confere os orçamentos da §3.11. |
| `node scripts/medir-lighthouse.mjs --path /login --no-build ...` | Lighthouse mobile, mediana de 5 rodadas (ver `BASELINE.md`). |

Filtros úteis: `npx playwright test --config playwright.visual.config.ts rotas --project 375 -g "adm-sessoes"`.

## O que é fotografado

- `rotas.ts`: as rotas do §1.3 da auditoria, por persona (anônimo, motorista, motorista `travado@` com recibos pré-semeados, admin), em
  **375 / 768 / 1440**. O nome do arquivo de baseline é o `id` da rota — **não renomeie** sem mover o arquivo.
- `estados.visual.ts`: estados que não são uma URL:
  - **sessão ao vivo** (`pwa-sessao-conectando`, `pwa-sessao-ao-vivo` a 02:05 de recarga = 0,24 kWh, `pwa-sessao-parar-dialogo`),
  - **recibo de recarga concluída** (`pwa-recibo-concluida`: R$ 5,00, piso da tarifa) — o recibo que a auditoria não conseguiu capturar,
  - **dois diálogos do admin** (`adm-dialogo-novo-site`, `adm-dialogo-detalhe-sessao`),
  - **formulário do documento isolado do cartão** (`pub-cartao-isolado-formulario`, handshake real com o app).

Os recibos pré-semeados (`/app/sessoes/me_seed_*`) pertencem ao motorista `travado@innoelektron.com` (F5.9, `src/mocks/meData.ts`).

## Como a captura é feita determinística (e o que NÃO dá para estabilizar)

Imposto em `estabilizar.ts` e `playwright.visual.config.ts`:

- `prefers-reduced-motion: reduce` (a landing e o `FlowCanvas` desenham UM quadro estático), `animations: "disabled"` no screenshot e CSS que
  zera animação/transição/caret.
- **Relógio fixo** em 2026-10-04 15:00 (America/Sao_Paulo): `page.clock.setFixedTime`. O mock calcula tudo por `Date.now()`; na sessão ao
  vivo o relógio é movido por **saltos explícitos**, então energia, custo e duração são exatos.
- Fuso e locale fixos; viewport fixa; `deviceScaleFactor: 1`.
- Fonte Inter **pedida e verificada** antes da foto (sem isso, ~1 captura em 40 saía na fonte de reserva).
- Tiles do OpenStreetMap trocados por um PNG sólido; qualquer outro host externo é abortado.
- Espera real por "assentar" (altura, nº de imagens e de nós iguais por ~1 s) e checagem de que o app MONTOU (a 1ª versão do harness gravou
  baseline em branco por falta dessa checagem).
- **Foto da rota inteira**: os shells do Admin/PWA rolam por dentro (`h-screen` + `<main>`), então o harness cresce a viewport até o rolador
  principal caber (`fotografar`). Sem isso a baseline guardaria só a 1ª tela.

Limites conhecidos (leia `BASELINE.md` para os números):

- A baseline é **da plataforma que a gerou** (`baseline/win32/...`). A rasterização de texto muda entre Windows/Linux/macOS: **não use
  esta baseline no CI Linux**; gere uma baseline `linux` no mesmo container do CI antes de ligar este projeto lá.
- O mock está em modo DEV (Vite dev server), não em build de produção (o MSW só existe em dev). Pixels de CSS são os mesmos; o **tamanho
  e o tempo** de carregamento NÃO são representativos (para isso, `medir-lighthouse.mjs` sobre o build).
- Mapa: os tiles são sólidos de propósito; o que se compara é layout, controles e marcadores, não o mapa do OSM.
- SSE do mock (`realtimeStream.ts`) vira conectores a cada 15 s com timer real; as capturas duram poucos segundos e não esperam isso.

## Política de atualização da baseline

A baseline é a **referência de "nada regrediu"**. Regravar para "fazer passar" destrói o propósito.

1. **Quem aprova:** só a **Lyra** (autora da mudança visual) **e/ou o Atlas**. A Íris **não** regrava baseline por conta própria.
2. **Quando:** ao fim de cada fase (F-A … F-F), **depois** que a Íris classificou cada diferença como *esperada* (decorre do escopo da fase)
   ou *regressão* (corrigir antes). Diferença esperada é registrada na seção da fase em `BASELINE.md` (rota, o que mudou, por quê).
3. **Como:** `npm run test:visual:update`, revisar `git diff --stat e2e-visual/baseline` (só devem mudar as rotas da fase), olhar as
   imagens alteradas, e commitar baseline + nota **no mesmo commit** (`chore(visual): baseline F-X aprovada por <quem>`).
4. **Nunca** regravar junto com a mudança de código na mesma passada sem a classificação acima.
5. Mudança **deliberada de comportamento** (ex.: D5 fazer `/nao-existe-xyz` deixar de cair na landing) aparece como diff em `pub-rota-inexistente`:
   é esperado, e vira nota na fase.
6. **Contraste:** a catraca (`contraste-baseline.json`) só pode **baixar**. Regravar com número maior exige decisão do Atlas.

## Estrutura

```
e2e-visual/
  constantes.ts · rotas.ts · estabilizar.ts · global-setup.ts   # infraestrutura e catálogo
  rotas.visual.ts · estados.visual.ts · contraste.visual.ts     # os testes (testMatch: *.visual.ts)
  baseline/<plataforma>/<viewport>/<id>.jpg                     # VERSIONADA
  contraste-baseline.json · tamanhos-baseline.json · lighthouse-baseline.json  # VERSIONADOS
  BASELINE.md · CONTRASTE-ESTADO-ATUAL.md                       # VERSIONADOS (relatórios)
  .auth/ · .relatorio/ · .resultados/                           # locais (gitignore)
```
