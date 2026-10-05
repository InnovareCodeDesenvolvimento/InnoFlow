import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import type { Role } from "@/types/api"
import { isOnboardingOff, readTourRecord, shouldAutoStart, writeTourRecord, type TourStatus } from "./onboardingStorage"
import { TourContext, type TourContextValue } from "./tourContext"
import { TourErrorBoundary } from "./TourErrorBoundary"
import { summarizeNav, type NavGroupLike } from "./tourNav"
import { TOUR_VERSIONS, tourIdForRole } from "./tourMeta"

/** O tour (overlay, balão, mascote animado, roteiro de textos, CSS) é um chunk LAZY: só é baixado quando o tour abre, depois da primeira pintura do shell. Este arquivo só conhece `tourMeta` (ids e versões). */
const OnboardingTour = lazy(() => import("./OnboardingTour"))

/** Deixa a página assentar antes de o mascote aparecer (e não disputa o primeiro render com o carregamento da tela). */
export const AUTOSTART_DELAY_MS = 900

interface TourProviderProps {
  /** `undefined` = ninguém logado: não há tour. */
  userId: string | undefined
  role: Role | undefined
  /** Menu do usuário (só para o Admin): decide quais passos existem (OPERATOR não tem os só-ADMIN) e alimenta os textos que listam áreas. */
  nav?: readonly NavGroupLike[]
  children: ReactNode
}

/**
 * Dono do estado do tour de UMA área (PWA do motorista ou painel). Coloque-o ACIMA do shell (para o shell e os botões "Rever tour" falarem com ele via `useTour`).
 * Abre sozinho só quando o usuário não tem registro da versão atual do roteiro (ver `onboardingStorage.ts`); ao terminar/pular grava o registro e fecha.
 */
export function TourProvider({ userId, role, nav, children }: TourProviderProps) {
  const tourId = tourIdForRole(role)
  const version = tourId ? TOUR_VERSIONS[tourId] : undefined
  const [open, setOpen] = useState(false)
  const navSummary = useMemo(() => summarizeNav(nav ?? []), [nav])

  useEffect(() => {
    if (!userId || !tourId || version === undefined) return
    if (!shouldAutoStart(readTourRecord(userId, tourId), version, isOnboardingOff())) return
    const id = window.setTimeout(() => setOpen(true), AUTOSTART_DELAY_MS)
    return () => window.clearTimeout(id)
  }, [userId, tourId, version])

  const restart = useCallback(() => setOpen(true), [])
  // O chunk do tour não carregou (aba velha pós-deploy, rede): o tour some em silêncio e o shell segue (ver `TourErrorBoundary`).
  const handleLoadError = useCallback(() => setOpen(false), [])

  const handleClose = useCallback(
    (status: TourStatus) => {
      if (userId && tourId && version !== undefined) writeTourRecord(userId, tourId, { version, status, at: new Date().toISOString() })
      setOpen(false)
    },
    [userId, tourId, version],
  )

  const value = useMemo<TourContextValue>(() => ({ active: open, available: !!tourId && !!userId, tourId, restart }), [open, userId, tourId, restart])

  return (
    <TourContext.Provider value={value}>
      {children}
      {open && tourId ? (
        <TourErrorBoundary onError={handleLoadError}>
          <Suspense fallback={null}>
            <OnboardingTour tourId={tourId} role={role} nav={navSummary} onClose={handleClose} />
          </Suspense>
        </TourErrorBoundary>
      ) : null}
    </TourContext.Provider>
  )
}
