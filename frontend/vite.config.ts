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
