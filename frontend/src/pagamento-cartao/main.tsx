import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./pagamento-cartao.css"
import { CardTokenizationApp } from "./CardTokenizationApp"

/**
 * Entry PRÓPRIA do Vite, com build SEPARADA da SPA principal (ver
 * `vite.pagamento-cartao.config.ts`) — NÃO importa nada de
 * `src/components|hooks|services|mocks|store|pages`
 * (o app principal): nada de axios, TanStack Query, react-router-dom,
 * Radix, MSW, sonner... zero dependência alheia a React/ReactDOM. Regra
 * reforçada por `no-restricted-imports` em `eslint.config.js`, não só por
 * convenção.
 *
 * Isso é o ponto da isolação SAQ A-EP (ver `pagamento-cartao.html` e
 * `.claude/agent-memory/nova/decisoes-f5-pagamento-cielo.md` §2) — menos
 * dependência = menos superfície pro Órion auditar, e garante que o chunk de
 * produção desta página nunca carrega código do app principal (confirmado
 * rodando `vite build` e inspecionando `dist/pagamento-cartao.html`/
 * `dist/assets/pagamento-cartao-*.js`, ver handoff da Lyra em PROGRESSO.md).
 */
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <CardTokenizationApp />
  </StrictMode>,
)
