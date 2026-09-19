import { lazy, Suspense, useEffect } from "react"
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom"
import { Loader2 } from "lucide-react"
import { Toaster } from "@/components/ui/Toaster"
import { Layout } from "@/components/layout/Layout"
import { ScrollToTop } from "@/components/layout/ScrollToTop"
import { RequireAuth } from "@/components/layout/RequireAuth"
import { RealtimeConnection } from "@/components/realtime/RealtimeConnection"
import { Home } from "@/pages/Public/Home"
import { registerInstallPromptListeners } from "@/store/installPromptStore"

// Code-splitting por rota: o painel admin (maior parte do bundle — RHF, Zod,
// Radix Dialog/Dropdown) só carrega para quem de fato entra em /admin. O PWA
// do motorista (`/c/...`, `/app/*`) segue a mesma regra — nenhuma dessas
// telas entra no bundle inicial do site público.
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

const ChargePointLanding = lazy(() => import("@/pages/Public/ChargePointLanding").then((m) => ({ default: m.ChargePointLanding })))
const AppLayout = lazy(() => import("@/pages/App/Layout").then((m) => ({ default: m.AppLayout })))
const AppHome = lazy(() => import("@/pages/App/Home").then((m) => ({ default: m.Home })))
const AppSessao = lazy(() => import("@/pages/App/Sessao").then((m) => ({ default: m.Sessao })))
const AppSessoes = lazy(() => import("@/pages/App/Sessoes").then((m) => ({ default: m.Sessoes })))
const AppSessaoDetalhe = lazy(() => import("@/pages/App/SessaoDetalhe").then((m) => ({ default: m.SessaoDetalhe })))
const AppCarteira = lazy(() => import("@/pages/App/Carteira").then((m) => ({ default: m.Carteira })))
const AppMapa = lazy(() => import("@/pages/App/Mapa").then((m) => ({ default: m.Mapa })))

function RouteFallback() {
  return (
    <div className="container-app flex items-center justify-center py-24">
      <Loader2 className="h-8 w-8 animate-spin text-primary" aria-hidden="true" />
    </div>
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
      <RealtimeConnection />
      <ScrollToTop />
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

          {/* Público */}
          <Route path="/" element={<Layout />}>
            <Route index element={<Home />} />
            <Route path="eletropostos" element={<Eletropostos />} />
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
      <Toaster />
    </BrowserRouter>
  )
}
