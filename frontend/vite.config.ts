import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { VitePWA } from "vite-plugin-pwa"
import path from "path"
import { buildDefine } from "./buildInfo.ts"

// Alvo do proxy de desenvolvimento: a API local (entrypoints/api.ts).
const API_DEV_TARGET = process.env.VITE_DEV_API_TARGET || "http://localhost:3000"

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: "auto",
      // skipWaiting + clientsClaim: a versão nova assume o controle das abas
      // abertas assim que instala, sem esperar todas fecharem — essencial
      // aqui porque o motorista abre o PWA uma vez por recarga, não fica com
      // aba viva o dia todo esperando "a hora certa" de atualizar.
      workbox: {
        skipWaiting: true,
        clientsClaim: true,
        // Sem isto, o service worker tenta servir index.html (fallback de
        // SPA) para qualquer chamada de API que falhe offline — quem chama
        // `/api/me/wallet` offline receberia HTML em vez de erro de rede.
        navigateFallbackDenylist: [/^\/api/],
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
      output: {
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
        manualChunks(id) {
          // lucide-react: cada ícone vira seu próprio arquivo de <0,4kB
          // quando usado por 2+ chunks assíncronos. Um chunk único de ícones
          // custa poucos KB a mais pra quem não usa todos, mas elimina a
          // fragmentação.
          if (id.includes("node_modules/lucide-react")) return "vendor-icons"

          // zod + react-hook-form + resolvers: usados em login/cadastro e em
          // todos os formulários do admin — um chunk só evita duplicar zod
          // em cada form (já ficavam praticamente assim antes, sem eager
          // load: nenhum dos dois está no grafo estático de Home/Header).
          if (
            id.includes("node_modules/zod") ||
            id.includes("node_modules/react-hook-form") ||
            id.includes("node_modules/@hookform/resolvers")
          ) {
            return "vendor-forms"
          }

          // Design system local (Button/Card/Badge/Input/Select/Skeleton/
          // Table/EmptyState/ErrorState/ConfirmDialog/Pagination/Dialog/
          // DropdownMenu/Toaster): reusado por quase toda rota do PWA e do
          // Admin — hoje virava ~12 arquivos de menos de 1kB cada.
          if (id.includes("/src/components/ui/")) return "ui-kit"

          // Hooks de dados locais (useMeSessions, useSites, useReports, ...):
          // compartilhados entre páginas assíncronas, hoje fragmentados
          // 1 arquivo por combinação de rotas que os consome em comum.
          if (id.includes("/src/hooks/")) return "app-hooks"
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
