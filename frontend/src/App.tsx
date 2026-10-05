import { lazy, Suspense, useEffect } from "react"
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom"
import { Loader2 } from "lucide-react"
import { ScrollToTop } from "@/components/layout/ScrollToTop"
import { RequireAuth } from "@/components/layout/RequireAuth"
import { RouteError } from "@/components/feedback/RouteError"
import { LoadingScreen } from "@/components/feedback/LoadingScreen"
import { registerInstallPromptListeners } from "@/store/installPromptStore"
import { useAuthStore } from "@/store/authStore"

// Code-splitting por rota: o painel admin (maior parte do bundle — RHF, Zod,
// Radix Dialog/Dropdown) só carrega para quem de fato entra em /admin. O PWA
// do motorista (`/c/...`, `/app/*`) segue a mesma regra — nenhuma dessas
// telas entra no bundle inicial do site público.
// A landing "/" é pesada (canvas, mockups, animações) e só serve à rota raiz: chunk próprio, fora do bundle inicial.
// FORA do bundle inicial de propósito (medido no Lighthouse mobile da landing "/"): a casca pública (`Layout` ->
// Header/Footer -> Radix/ui-kit), o Toaster (sonner) e a conexão SSE (axios, hooks de dados) só servem a rotas que NÃO
// são a landing e eram baixados + avaliados antes de o hero aparecer (~300 KB de JS, ~80 KB gzip).
const Layout = lazy(() => import("@/components/layout/Layout").then((m) => ({ default: m.Layout })))
const Toaster = lazy(() => import("@/components/ui/Toaster").then((m) => ({ default: m.Toaster })))
const RealtimeConnection = lazy(() => import("@/components/realtime/RealtimeConnection").then((m) => ({ default: m.RealtimeConnection })))
const Home = lazy(() => import("@/pages/Public/Home").then((m) => ({ default: m.Home })))
const Eletropostos = lazy(() => import("@/pages/Public/Eletropostos").then((m) => ({ default: m.Eletropostos })))
const Login = lazy(() => import("@/pages/Auth/Login").then((m) => ({ default: m.Login })))
const Register = lazy(() => import("@/pages/Auth/Register").then((m) => ({ default: m.Register })))
const AdminLayout = lazy(() => import("@/pages/Admin/Layout").then((m) => ({ default: m.AdminLayout })))
const AdminSites = lazy(() => import("@/pages/Admin/Sites"))
const AdminChargePoints = lazy(() => import("@/pages/Admin/ChargePoints"))
const AdminConnectors = lazy(() => import("@/pages/Admin/Connectors"))
const AdminTariffs = lazy(() => import("@/pages/Admin/Tariffs"))
const AdminAuthTokens = lazy(() => import("@/pages/Admin/AuthTokens"))
const AdminDashboard = lazy(() => import("@/pages/Admin/Dashboard"))
const AdminFinanceiro = lazy(() => import("@/pages/Admin/Financeiro"))
const AdminMovimentoDiario = lazy(() => import("@/pages/Admin/MovimentoDiario"))
const AdminFaturamento = lazy(() => import("@/pages/Admin/Faturamento"))
const AdminSessoes = lazy(() => import("@/pages/Admin/Sessoes"))
const AdminPagamentos = lazy(() => import("@/pages/Admin/Pagamentos"))
const AdminAuditoria = lazy(() => import("@/pages/Admin/Auditoria"))
const AdminCarteiras = lazy(() => import("@/pages/Admin/Carteiras"))
const AdminGatewayPagamento = lazy(() => import("@/pages/Admin/GatewayPagamento"))

// Catálogo do design system (`/__ds`): SÓ em dev. `import.meta.env.DEV` é substituído por `false` no build, a expressão colapsa para `null` e o
// `import()` sai do bundle (e do precache do PWA) — conferido com grep no `dist/`. Ver `src/dev/DesignSystemCatalog.tsx`.
const DesignSystemCatalog = import.meta.env.DEV ? lazy(() => import("@/dev/DesignSystemCatalog")) : null

// 404 de verdade (decisão D5 do dono, F-B): antes a rota `*` redirecionava em silêncio para "/" e escondia link quebrado (inclusive QR impresso
// com identidade errada). Chunk lazy: não pesa no caminho crítico da landing.
const NotFound = lazy(() => import("@/components/feedback/NotFound").then((m) => ({ default: m.NotFound })))

const ChargePointLanding = lazy(() => import("@/pages/Public/ChargePointLanding").then((m) => ({ default: m.ChargePointLanding })))
const AppLayout = lazy(() => import("@/pages/App/Layout").then((m) => ({ default: m.AppLayout })))
const AppHome = lazy(() => import("@/pages/App/Home").then((m) => ({ default: m.Home })))
const AppSessao = lazy(() => import("@/pages/App/Sessao").then((m) => ({ default: m.Sessao })))
const AppSessoes = lazy(() => import("@/pages/App/Sessoes").then((m) => ({ default: m.Sessoes })))
const AppSessaoDetalhe = lazy(() => import("@/pages/App/SessaoDetalhe").then((m) => ({ default: m.SessaoDetalhe })))
const AppCarteira = lazy(() => import("@/pages/App/Carteira").then((m) => ({ default: m.Carteira })))
const AppCarteiraAdicionar = lazy(() => import("@/pages/App/CarteiraAdicionar").then((m) => ({ default: m.CarteiraAdicionar })))
const AppCartoes = lazy(() => import("@/pages/App/Cartoes").then((m) => ({ default: m.Cartoes })))
const AppMapa = lazy(() => import("@/pages/App/Mapa").then((m) => ({ default: m.Mapa })))

/**
 * Error boundary das rotas (render que lança, chunk lazy que não baixou). O `RouteError` do bundle inicial é mínimo e só carrega a tela de marca se
 * um erro acontecer. `resetKey` = pathname: navegar para outra rota limpa o erro. Erros de requisição (axios) NÃO passam por aqui — cada tela os trata
 * com `ErrorState`; o boundary só pega o que derrubaria a árvore.
 */
function RoutesBoundary({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation()
  return <RouteError resetKey={pathname}>{children}</RouteError>
}

function RouteFallback() {
  // PWA do motorista: o carregamento já é na moldura de marca (escura, anel lima) — sem o clarão branco entre a tela de login e o shell escuro.
  // O mascote NÃO entra aqui (este módulo é do bundle inicial); o shell tem o próprio fallback, com o rosto, para as trocas de página.
  const inDriverApp = useLocation().pathname.startsWith("/app")
  if (inDriverApp) return <LoadingScreen />
  return (
    <div className="container-app flex items-center justify-center py-24">
      <Loader2 className="h-8 w-8 animate-spin text-primary" aria-hidden="true" />
    </div>
  )
}

/** Enquanto o chunk da landing carrega: fundo da cor do hero (sem clarão branco) e aviso para leitores de tela. */
function LandingFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-primary-950" role="status">
      <span className="sr-only">Carregando…</span>
      <Loader2 className="h-8 w-8 animate-spin text-accent-glow" aria-hidden="true" />
    </div>
  )
}

/** Toaster só fora da landing: ela nunca dispara toast, e o sonner pesa ~33 KB no caminho crítico. Ao navegar para outra rota monta na hora. */
function AppToaster() {
  const onLanding = useLocation().pathname === "/"
  if (onLanding) return null
  return (
    <Suspense fallback={null}>
      <Toaster />
    </Suspense>
  )
}

/** A conexão SSE só existe com sessão (ver `RealtimeConnection`): quem não está logado nem baixa o código dela. */
function AppRealtime() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  if (!isAuthenticated) return null
  return (
    <Suspense fallback={null}>
      <RealtimeConnection />
    </Suspense>
  )
}

export default function App() {
  // Captura `beforeinstallprompt` uma única vez, na raiz — o evento pode
  // disparar em qualquer tela (landing `/c/...`, sessão ativa) bem antes do
  // motorista chegar ao recibo, que é onde de fato oferecemos a instalação
  // (ver `InstallPromptCard`/`installPromptStore`).
  useEffect(() => registerInstallPromptListeners(), [])

  return (
    <BrowserRouter>
      <AppRealtime />
      <ScrollToTop />
      <RoutesBoundary>
        <Suspense fallback={<RouteFallback />}>
          <Routes>
            {/* Auth (sem layout público) */}
            <Route path="/login" element={<Login />} />
            <Route path="/cadastro" element={<Register />} />

            {/* PWA do motorista — landing pública pós-QR + área autenticada DRIVER-only */}
            <Route path="/c/:ocppIdentity" element={<ChargePointLanding />} />
            <Route path="/c/:ocppIdentity/:connectorId" element={<ChargePointLanding />} />
            <Route path="/app" element={<AppLayout />}>
              <Route index element={<AppHome />} />
              <Route path="sessao" element={<AppSessao />} />
              <Route path="sessoes" element={<AppSessoes />} />
              <Route path="sessoes/:id" element={<AppSessaoDetalhe />} />
              <Route path="mapa" element={<AppMapa />} />
              <Route path="carteira" element={<AppCarteira />} />
              <Route path="carteira/adicionar" element={<AppCarteiraAdicionar />} />
              {/* Cartão salvo (F5.3) — formulário de cartão em si NÃO mora aqui, vive isolado em pagamento-cartao.html (ver useAddCardFlow). */}
              <Route path="carteira/cartoes" element={<AppCartoes />} />
            </Route>

            {/* Painel admin (ADMIN/OPERATOR) */}
            <Route path="/admin" element={<AdminLayout />}>
              <Route index element={<Navigate to="/admin/dashboard" replace />} />
              <Route path="dashboard" element={<AdminDashboard />} />
              <Route path="financeiro" element={<AdminFinanceiro />} />
              <Route path="movimento-diario" element={<AdminMovimentoDiario />} />
              <Route path="faturamento" element={<AdminFaturamento />} />
              <Route path="sessoes" element={<AdminSessoes />} />
              <Route path="pagamentos" element={<AdminPagamentos />} />
              {/* Motorista é conta de rede: OPERATOR e ADMIN consultam (OPERATOR só buscando); o ajuste de saldo é ADMIN-only no servidor e na UI. */}
              <Route path="carteiras" element={<AdminCarteiras />} />
              <Route path="sites" element={<AdminSites />} />
              <Route path="charge-points" element={<AdminChargePoints />} />
              <Route path="connectors" element={<AdminConnectors />} />
              <Route path="tariffs" element={<AdminTariffs />} />
              {/* AuthToken não tem operatorId — a API restringe a rota inteira a ADMIN (ver authTokens.routes.ts). */}
              <Route
                path="auth-tokens"
                element={
                  <RequireAuth roles={["ADMIN"]}>
                    <AdminAuthTokens />
                  </RequireAuth>
                }
              />
              {/* Conta Cielo é ÚNICA da plataforma (a carteira é da rede): só ADMIN configura (F5.5); o servidor confere de novo (403). */}
              <Route
                path="gateway-pagamento"
                element={
                  <RequireAuth roles={["ADMIN"]}>
                    <AdminGatewayPagamento />
                  </RequireAuth>
                }
              />
              {/* AuditLog é ADMIN-only por decisão de produto (rastreabilidade da rede inteira, ver decisoes-audit-log.md). */}
              <Route
                path="auditoria"
                element={
                  <RequireAuth roles={["ADMIN"]}>
                    <AdminAuditoria />
                  </RequireAuth>
                }
              />
            </Route>

            {/* Landing pública: casca própria (cabeçalho escuro com âncoras + rodapé), fora do `Layout` das demais páginas públicas. */}
            <Route
              path="/"
              element={
                <Suspense fallback={<LandingFallback />}>
                  <Home />
                </Suspense>
              }
            />

            {/* Público (casca clara: Header + Footer) */}
            <Route element={<Layout />}>
              <Route path="eletropostos" element={<Eletropostos />} />
            </Route>

            {DesignSystemCatalog && <Route path="/__ds" element={<DesignSystemCatalog />} />}

            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </RoutesBoundary>
      <AppToaster />
    </BrowserRouter>
  )
}
