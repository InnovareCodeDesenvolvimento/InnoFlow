import { Component, lazy, Suspense, type ErrorInfo, type ReactNode } from "react"

/**
 * Error boundary de rota/área. O app usa `BrowserRouter` (não o roteador de dados), então `errorElement` não existe: a forma de ligar é este
 * componente ao redor de `<Routes>`. `resetKey` (ex.: o pathname) limpa o erro quando a rota muda.
 *
 * Este arquivo NÃO importa nada pesado de propósito (vive no bundle inicial, que a landing carrega): a tela de erro de verdade
 * (`RouteErrorView`: mascote, botões lima/vidro) é um chunk lazy, baixado só se algum erro acontecer. Se até esse chunk falhar (rede caiu junto
 * com o erro), cai num fallback mínimo em HTML puro, com os mesmos dois caminhos de saída.
 */
const RouteErrorView = lazy(() => import("./RouteErrorView").then((m) => ({ default: m.RouteErrorView })))

interface BoundaryState {
  error: unknown
}

export class RouteError extends Component<{ children: ReactNode; resetKey?: string }, BoundaryState> {
  state: BoundaryState = { error: null }

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { error }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    // Sem serviço de telemetria no front hoje: o console é o único rastro (sem dado de usuário — só o erro e a pilha de componentes).
    console.error("[RouteError]", error, info.componentStack)
  }

  componentDidUpdate(prev: { resetKey?: string }) {
    if (this.state.error !== null && prev.resetKey !== this.props.resetKey) this.setState({ error: null })
  }

  render() {
    if (this.state.error === null) return this.props.children
    return (
      <Suspense fallback={<MinimalError />}>
        <RouteErrorView error={this.state.error} onRetry={() => this.setState({ error: null })} />
      </Suspense>
    )
  }
}

/** Fallback sem estilo de marca (enquanto o chunk da tela de erro carrega, ou se ele falhar). */
function MinimalError() {
  return (
    <div role="alert" style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, padding: 24, textAlign: "center", background: "#0E2A3A", color: "#fff", fontFamily: "system-ui, sans-serif" }}>
      <p style={{ fontSize: 20, fontWeight: 800 }}>Não foi possível abrir esta tela</p>
      <p style={{ opacity: 0.8 }}>Tente de novo; se continuar, volte ao início.</p>
      <p style={{ display: "flex", gap: 12 }}>
        <button type="button" onClick={() => window.location.reload()} style={{ padding: "10px 18px", borderRadius: 12, border: 0, fontWeight: 700, background: "#61DB24", color: "#061621" }}>
          Tentar de novo
        </button>
        <a href="/" style={{ padding: "10px 18px", borderRadius: 12, fontWeight: 700, color: "#fff", border: "1px solid rgba(255,255,255,.3)" }}>
          Voltar ao início
        </a>
      </p>
    </div>
  )
}
