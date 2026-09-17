import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import "./index.css"
import App from "./App.tsx"

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      retry: 1,
      // Ligado (era `false`) a partir do SSE (`RealtimeConnection`): o push
      // já mantém a tela em dia enquanto ela existe, mas o stream some de
      // formas que parecem sucesso quando a aba/PWA volta de segundo plano
      // (iOS suspende a conexão, o navegador não avisa nada quebrou) — o
      // refetch ao focar é a rede de segurança que pega exatamente essa
      // lacuna. Barato: só refaz a busca de queries que já passaram do
      // `staleTime` (60s aqui), não de tudo que está montado na tela.
      refetchOnWindowFocus: true,
    },
  },
})

function renderApp() {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </StrictMode>,
  )
}

/**
 * `VITE_USE_MOCKS=true` liga o MSW (`src/mocks/`) e todo `/api/...` é
 * respondido em memória, no formato exato do contrato real — usado nesta
 * fase porque o backend (Postgres/Redis) não está acessível deste ambiente
 * de dev (ver PROGRESSO.md). Import dinâmico: `msw` nunca entra no bundle de
 * produção, mesmo se a env for esquecida ligada em algum `.env` local.
 */
if (import.meta.env.DEV && import.meta.env.VITE_USE_MOCKS === "true") {
  const { worker } = await import("./mocks/browser")
  await worker.start({ onUnhandledRequest: "bypass" })
}

renderApp()
