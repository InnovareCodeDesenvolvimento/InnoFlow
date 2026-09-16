import { lazy, Suspense } from "react"
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom"
import { Loader2 } from "lucide-react"
import { Toaster } from "@/components/ui/Toaster"
import { Layout } from "@/components/layout/Layout"
import { ScrollToTop } from "@/components/layout/ScrollToTop"
import { RequireAuth } from "@/components/layout/RequireAuth"
import { Home } from "@/pages/Public/Home"

// Code-splitting por rota: o painel admin (maior parte do bundle — RHF, Zod,
// Radix Dialog/Dropdown) só carrega para quem de fato entra em /admin.
const Eletropostos = lazy(() => import("@/pages/Public/Eletropostos").then((m) => ({ default: m.Eletropostos })))
const Login = lazy(() => import("@/pages/Auth/Login").then((m) => ({ default: m.Login })))
const Register = lazy(() => import("@/pages/Auth/Register").then((m) => ({ default: m.Register })))
const AdminLayout = lazy(() => import("@/pages/Admin/Layout").then((m) => ({ default: m.AdminLayout })))
const AdminSites = lazy(() => import("@/pages/Admin/Sites"))
const AdminChargePoints = lazy(() => import("@/pages/Admin/ChargePoints"))
const AdminConnectors = lazy(() => import("@/pages/Admin/Connectors"))
const AdminTariffs = lazy(() => import("@/pages/Admin/Tariffs"))
const AdminAuthTokens = lazy(() => import("@/pages/Admin/AuthTokens"))

function RouteFallback() {
  return (
    <div className="container-app flex items-center justify-center py-24">
      <Loader2 className="h-8 w-8 animate-spin text-primary" aria-hidden="true" />
    </div>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <ScrollToTop />
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          {/* Auth (sem layout público) */}
          <Route path="/login" element={<Login />} />
          <Route path="/cadastro" element={<Register />} />

          {/* Painel admin (ADMIN/OPERATOR) */}
          <Route path="/admin" element={<AdminLayout />}>
            <Route index element={<Navigate to="/admin/sites" replace />} />
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
