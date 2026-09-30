import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import path from "path"

/**
 * Build PRÓPRIA e MÍNIMA do documento isolado do cadastro de cartão
 * (`pagamento-cartao.html`, F5.3 — ver
 * `.claude/agent-memory/nova/decisoes-f5-pagamento-cielo.md` §2). Config
 * SEPARADA de `vite.config.ts` de propósito, não uma 2ª entry no mesmo
 * build: colocar as duas no mesmo `rollupOptions.input` foi tentado
 * primeiro e falhou na prática — o bundler (rolldown/Vite 8) fundia o
 * próprio React para dentro de um chunk do app principal ("app-hooks"),
 * mesmo com `manualChunks` tentando isolar explicitamente (2 tentativas
 * diferentes, nenhuma resolveu — medido com `vite build` + inspeção de
 * `dist/pagamento-cartao.html`, os imports do chunk isolado continuavam
 * puxando o chunk errado). Uma build separada elimina o problema pela
 * raiz: grafo de dependências INTEIRO e independente, sem qualquer chance
 * de um bundler fundir os dois — e sem `vite-plugin-pwa` (que também
 * injetava `<link rel="manifest">`/`registerSW.js` neste HTML quando ele
 * era só mais uma entry do build principal).
 *
 * `emptyOutDir: false` — esta build roda DEPOIS da principal (ver
 * `package.json`, script `build`) e escreve no MESMO `dist/`; limpar a
 * pasta aqui apagaria o que a build principal acabou de gerar.
 */
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: false,
    rollupOptions: {
      input: {
        "pagamento-cartao": path.resolve(import.meta.dirname, "pagamento-cartao.html"),
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
})
