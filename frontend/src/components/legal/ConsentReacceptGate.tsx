import { lazy, Suspense } from "react"
import { useMeConsents } from "@/hooks/useLegal"

// O diálogo (Radix Dialog + texto + versão vigente) só é baixado para quem de fato precisa aceitar de novo; os demais carregam só esta porta, que é minúscula.
const ConsentReacceptDialog = lazy(() => import("@/components/legal/ConsentReacceptDialog"))

/**
 * Porta do pedido de novo aceite dos Termos (L1.9) no app do motorista. Consulta `GET /api/me/consents` (falha = silêncio: o aviso é secundário) e só então monta o diálogo.
 * Renderiza `null` para quem está em dia, sem esqueleto nem espaço reservado: não há nada visível a deslocar.
 */
export function ConsentReacceptGate() {
  const { data } = useMeConsents()
  if (!data || data.upToDate) return null
  return (
    <Suspense fallback={null}>
      <ConsentReacceptDialog />
    </Suspense>
  )
}
