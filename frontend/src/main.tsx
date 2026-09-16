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
      refetchOnWindowFocus: false,
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
