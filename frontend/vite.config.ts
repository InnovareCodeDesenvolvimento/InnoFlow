import { defineConfig, type Plugin } from "vite"
import react from "@vitejs/plugin-react"
import { VitePWA } from "vite-plugin-pwa"
import path from "path"
import { rmSync } from "node:fs"
import { buildDefine } from "./buildInfo.ts"

// Alvo do proxy de desenvolvimento: a API local (entrypoints/api.ts).
const API_DEV_TARGET = process.env.VITE_DEV_API_TARGET || "http://localhost:3000"

/**
 * `public/mockServiceWorker.js` é o worker do MSW — existe SÓ para `dev:mock` e para os E2E (que rodam em dev,
 * `playwright.config.ts`), e o `msw init` o gera/espera exatamente em `public/` (ver `"msw".workerDirectory` no
 * package.json). O Vite copia TODO `public/` para o `dist/`, então ele ia parar no site de produção E no precache do
 * service worker do PWA (achado do portão final da F5): ~9 KB de código de mock servido e baixado por todo motorista,
 * e um worker que intercepta fetch publicado sem necessidade.
 *
 * Por que tirar aqui (e não mover o arquivo): mover quebraria o `msw init`/`dev:mock`. O arquivo continua em `public/`
 * para o dev; só é removido do `dist/` no build. `closeBundle` com `order: "pre"` roda ANTES do `closeBundle` do
 * vite-plugin-pwa (que é quem varre `dist/` para montar o precache) — e o `globIgnores` do workbox, abaixo, é a 2ª
 * trava caso a ordem dos plugins mude um dia. O CI ainda confere o `dist/` (job `frontend`, passo "dist sem mock").
 */
function semMockServiceWorkerNoBuild(): Plugin {
  let outDir = "dist"
  return {
    name: "inno:sem-mock-service-worker",
    apply: "build",
    configResolved(cfg) {
      outDir = path.resolve(cfg.root, cfg.build.outDir)
    },
    closeBundle: {
      order: "pre",
      handler() {
        rmSync(path.join(outDir, "mockServiceWorker.js"), { force: true })
      },
    },
  }
}

/**
 * A landing "/" é um chunk lazy (`pages/Public/Home`, nomeado `landing-*` em `chunkFileNames`). Lazy tira ~16 KB gzip
 * do bundle de quem abre /login ou /app, mas cria uma corrente de requisições para quem abre "/":
 * HTML -> entry -> (só então) landing.js + landing.css. Medido no Lighthouse mobile isso custou ~0,4 s de FCP.
 * Este plugin quebra a corrente: o HTML já pede o chunk (modulepreload) e o CSS (preload, sem bloquear a
 * renderização das outras rotas) em paralelo com o entry. Custo aceito: ~20 KB gzip, baixados em baixa prioridade e
 * guardados no cache HTTP (nome com hash) por quem abre outra rota primeiro.
 *
 * Só no build (no dev não há bundle). Se o chunk não existir (renomeado), não injeta nada: a landing continua
 * funcionando, só sem o atalho.
 */
function preloadLandingChunk(): Plugin {
  return {
    name: "inno:preload-landing-chunk",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        const bundle = ctx.bundle ?? {}
        const tags: Array<{ tag: string; attrs: Record<string, string | boolean>; injectTo: "head" }> = []
        const chunks = new Map<string, { imports: string[] }>()
        for (const file of Object.values(bundle)) if (file.type === "chunk") chunks.set(file.fileName, file)
        const wanted = new Set<string>()
        // O chunk da landing E as dependências ESTÁTICAS dele (recursivo). Só o chunk não bastava: o navegador só descobre
        // os imports dele (ex.: `logo-icon-sm-*.js`, `appInfo-*.js`, minúsculos) DEPOIS de baixar e analisar a landing —
        // mais uma viagem de rede (RTT) na corrente crítica do hero. Pré-carregados aqui, vêm em paralelo.
        const visit = (name: string) => {
          if (wanted.has(name)) return
          wanted.add(name)
          for (const dep of chunks.get(name)?.imports ?? []) visit(dep)
        }
        for (const name of chunks.keys()) {
          if (/^assets\/landing-[\w-]+\.js$/.test(name) && !name.includes("below")) visit(name)
        }
        for (const name of wanted) {
          // O que o próprio index.html já pré-carrega (dependências do entry) não se repete.
          if (html.includes(`/${name}"`)) continue
          tags.push({ tag: "link", attrs: { rel: "modulepreload", crossorigin: true, href: `/${name}` }, injectTo: "head" })
        }
        for (const file of Object.values(bundle)) {
          if (file.type === "asset" && /^assets\/landing-[\w-]+\.css$/.test(file.fileName)) {
            tags.push({ tag: "link", attrs: { rel: "preload", as: "style", href: `/${file.fileName}` }, injectTo: "head" })
          }
        }
        return tags
      },
    },
  }
}

export default defineConfig({
  plugins: [
    react(),
    semMockServiceWorkerNoBuild(),
    preloadLandingChunk(),
    VitePWA({
      registerType: "autoUpdate",
      // "script-defer": <script defer src="/registerSW.js"> (o "auto" injetava um <script> SÍNCRONO no <head>, que bloqueia o parse
      // do HTML; medido no Lighthouse como recurso que bloqueia a renderização, ~150 ms simulados).
      injectRegister: "script-defer",
      // skipWaiting + clientsClaim: a versão nova assume o controle das abas
      // abertas assim que instala, sem esperar todas fecharem — essencial
      // aqui porque o motorista abre o PWA uma vez por recarga, não fica com
      // aba viva o dia todo esperando "a hora certa" de atualizar.
      workbox: {
        skipWaiting: true,
        clientsClaim: true,
        // Sem a 1ª entrada, o service worker tenta servir index.html
        // (fallback de SPA) para qualquer chamada de API que falhe offline —
        // quem chama `/api/me/wallet` offline receberia HTML em vez de erro
        // de rede. A 2ª entrada é F5.3 (cadastro de cartão, SAQ A-EP, ver
        // `.claude/agent-memory/nova/decisoes-f5-pagamento-cielo.md` §2):
        // `navigateFallback` do Workbox intercepta TODA navegação (não só as
        // que "parecem" SPA) e serve `index.html` — sem este denylist, abrir
        // `/pagamento-cartao.html` com o PWA instalado (service worker já
        // ativo) devolveria a home do site em vez do documento isolado,
        // quebrando a isolação de CSP inteira em silêncio. CONFIRMADO
        // empiricamente (não só lido na doc do Workbox): `vite build` +
        // `vite preview` + Service Worker registrado de verdade — sem esta
        // linha, `navigator.serviceWorker.controller` ativo e a navegação
        // pra `/pagamento-cartao.html` voltava o HTML/título/conteúdo da
        // Home (`index.html` precacheado), não o formulário de cartão.
        navigateFallbackDenylist: [/^\/api/, /^\/pagamento-cartao\.html$/, /^\/robots\.txt$/, /^\/sitemap\.xml$/],
        // Worker do MSW (só dev/E2E) nunca entra no precache — 2ª trava além do plugin
        // `semMockServiceWorkerNoBuild` acima, que já o apaga do dist/.
        // Landing "/" (chunks `landing*`, ver `manualChunks` abaixo) fora do precache: é página de divulgação, o
        // motorista do PWA abre em /app e não precisa baixar ~90 KB dela na instalação do service worker. Ela continua
        // funcionando offline depois da 1ª visita, pela regra `static-assets` (CacheFirst para /assets/*.js|css).
        // As imagens (webp) e o og-innoflow.jpg nunca entram: o precache padrão só pega js/css/html.
        globIgnores: ["**/mockServiceWorker.js", "**/assets/landing*"],
        runtimeCaching: [
          {
            // CRÍTICO: saldo de carteira e status de sessão NUNCA podem vir
            // de um cache do service worker — é dado financeiro, não
            // conteúdo estático. Declarado explícito (não o default
            // implícito do Workbox) para não depender de comportamento
            // "por acaso" correto.
            urlPattern: /^\/api\/.*/,
            handler: "NetworkOnly",
          },
          {
            // Só assets com hash no nome (JS/CSS do build, que trocam de
            // nome a cada deploy) — nunca HTML/JSON, que precisam ser
            // sempre buscados de novo.
            urlPattern: /\/assets\/.*\.(?:js|css)$/,
            handler: "CacheFirst",
            options: {
              cacheName: "static-assets",
              expiration: { maxEntries: 60, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
        ],
      },
      includeAssets: ["favicon.png", "apple-touch-icon.png"],
      manifest: {
        name: "InnoFlow",
        short_name: "InnoFlow",
        description: "Carregue um futuro melhor — recarga de veículos elétricos.",
        theme_color: "#0E2A3A",
        background_color: "#0E2A3A",
        display: "standalone",
        start_url: "/app",
        scope: "/",
        lang: "pt-BR",
        icons: [
          { src: "/pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "/pwa-512x512.png", sizes: "512x512", type: "image/png" },
          { src: "/pwa-maskable-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
    }),
  ],
  // Versão e data do build viram constantes no bundle (ver lib/appInfo.ts e
  // o selo InnovareCodeBadge) — mesmo padrão do ParquedasFeiras.
  define: buildDefine,
  build: {
    rollupOptions: {
      // SÓ `index.html` (SPA principal) — de propósito. `pagamento-cartao.html`
      // (documento isolado do cadastro de cartão, F5.3, SAQ A-EP) NÃO entra
      // como uma 2ª entry aqui: build própria em `vite.pagamento-cartao.config.ts`
      // (ver esse arquivo para o porquê — resumo: com as duas entries no
      // MESMO build, o bundler (rolldown/Vite 8) fundia o próprio React para
      // dentro de um chunk do app principal, "app-hooks", mesmo com
      // `manualChunks` explícito tentando isolar — medido com `vite build` +
      // inspeção de `dist/pagamento-cartao.html`, não resolvido por 2
      // tentativas de bucket manual diferentes). Build separada elimina o
      // problema pela raiz: grafos de dependência inteiramente distintos,
      // sem chance de um bundler fundir os dois.
      output: {
        // Nomes dos chunks da landing "/" (lazy: `pages/Public/Home` e o `BelowFold` abaixo da dobra). Precisam de
        // prefixo próprio por dois motivos: (1) `pages/App/Home` (o PWA do motorista) também se chama "Home" —
        // só o caminho distingue; (2) o `globIgnores` do Workbox (abaixo) tira `assets/landing*` do precache.
        // Tentativa descartada: `manualChunks` para a landing — fez o bundler fundir React/utilitários no chunk
        // "landing" e o ENTRY passou a importá-lo de forma estática (modulepreload no index.html), isto é, a
        // landing inteira entrou no bundle inicial de /login etc. (medido: index.html listava landing*.js).
        chunkFileNames: (chunk) => {
          const f = chunk.facadeModuleId ?? ""
          if (f.includes("/src/pages/Public/Home")) return "assets/landing-[hash].js"
          if (f.includes("/src/components/landing/BelowFold")) return "assets/landing-below-[hash].js"
          return "assets/[name]-[hash].js"
        },
        // O CSS da landing nasce no chunk "Home" (só ele importa CSS próprio): mesmo prefixo, mesmo motivo.
        assetFileNames: (asset) =>
          (asset.names ?? []).includes("Home.css") ? "assets/landing-[hash][extname]" : "assets/[name]-[hash][extname]",
        // Sem isto, o code-splitting automático fragmenta em dezenas de
        // chunks de poucos bytes cada (um ícone lucide-react por arquivo,
        // um componente de UI por arquivo, um hook por arquivo) toda vez que
        // o módulo é compartilhado por 2+ rotas carregadas via `lazy()`.
        // Cada chunk é uma requisição HTTP separada — sob throttling de rede
        // simulado (Lighthouse mobile), o round-trip de cada uma pesa mais
        // que o parsing/JS em si (bootup-time medido: só ~0,4s). Consolidar
        // em poucos chunks reduz o NÚMERO de requisições no carregamento
        // inicial das rotas do motorista, sem tocar no code-splitting por
        // ROTA (Admin continua isolado do PWA, ver App.tsx).
        //
        // MEDIDO (vite preview + lighthouse mobile, --emulated-form-factor,
        // rota /c/:ocppIdentity, 2 rodadas antes/depois pra descartar
        // ruído): antes — 27 requisições, TTI ~3,3-3,5s, score ~0,82-0,85.
        // Depois — 18 requisições, TTI ~3,0-3,2s, score ~0,86-0,88. Peso
        // total de bytes ficou praticamente igual (~+5%, gzip absorve boa
        // parte da consolidação). Ganho real vem de menos round-trips, não
        // de menos JS — bate com o diagnóstico original da Lyra.
        //
        // Tentativa inicial incluía também um bucket "vendor-radix" — nunca
        // gerava chunk próprio porque @radix-ui só é importado a partir de
        // Dialog.tsx/DropdownMenu.tsx (já dentro de "ui-kit"): com um único
        // consumidor, o bundler sempre funde de volta. Removido por ser
        // morto — não é bug, é como esse app usa Radix hoje.
        // `codeSplitting.groups` (e não `manualChunks`) porque aqui a PRIORIDADE importa. Com `manualChunks` cada nome vira
        // um grupo de mesma prioridade e o grupo "dono" de um módulo dependia da ordem: `ui-kit`/`app-hooks` absorviam o
        // React, o zustand e o query-core por serem dependência compartilhada, e o ENTRY (portanto a landing "/") passava
        // a importar ~280 KB de Radix/axios/sonner/tailwind-merge que ela não usa (medido: modulepreload de `ui-kit` +
        // `app-hooks` no index.html de "/"). Com prioridade, o `vendor-core` é extraído primeiro e os buckets de baixo só
        // pegam o que sobrar — e continuam consolidando as rotas lazy (ver o comentário acima).
        codeSplitting: {
          groups: [
            // Núcleo que TODA rota (inclusive a landing, a mais sensível a peso) precisa para renderizar.
            {
              name: "vendor-core",
              test: /node_modules[/\\](react|react-dom|scheduler|react-router|react-router-dom|zustand|@tanstack[/\\](react-query|query-core))[/\\]/,
              priority: 40,
            },
            // Estado global (authStore etc.) e a chave do token: o entry e a landing importam o `authStore`. Sem isto ele era
            // capturado como "dependência" do `app-hooks` e arrastava o bucket inteiro (~190 KB) para o caminho crítico.
            { name: "vendor-core", test: /[/\\]src[/\\](store|lib[/\\]storageKeys)/, priority: 40 },
            // lucide-react: cada ícone vira seu próprio arquivo de <0,4kB quando usado por 2+ chunks assíncronos. Um chunk
            // único de ícones custa poucos KB a mais, mas elimina a fragmentação.
            { name: "vendor-icons", test: /node_modules[/\\]lucide-react/, priority: 30 },
            // zod + react-hook-form + resolvers: login/cadastro e todos os formulários do admin; nenhum está no grafo
            // estático de Home/Header.
            { name: "vendor-forms", test: /node_modules[/\\](zod|react-hook-form|@hookform[/\\]resolvers)/, priority: 30 },
            // Design system local (Button/Card/Badge/Input/Select/.../Dialog/DropdownMenu/Toaster): reusado por quase toda
            // rota do PWA e do Admin — sem o bucket virava ~12 arquivos de menos de 1 kB.
            { name: "ui-kit", test: /[/\\]src[/\\]components[/\\]ui[/\\]/, priority: 20 },
            // Hooks de dados locais (useMeSessions, useSites, useReports, ...): compartilhados entre páginas assíncronas.
            { name: "app-hooks", test: /[/\\]src[/\\]hooks[/\\]/, priority: 10 },
          ],
        },
      },
    },
  },
  resolve: {
    alias: {
      // import.meta.dirname (não __dirname) — exigido pelo configLoader
      // "native" do Vite 8.
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  server: {
    // Sem proxy, uma chamada relativa a /api cairia no fallback de SPA do
    // dev server (200 + index.html) em vez de falhar de verdade quando a
    // API está fora do ar — mesmo raciocínio do ParquedasFeiras.
    proxy: {
      "/api": { target: API_DEV_TARGET, changeOrigin: true },
    },
  },
})
