import { createContext, useContext, useEffect } from "react"

/**
 * Registro de abas com alteração não salva, mantido pela casca (`index.tsx`). É um registro em memória lido na hora do clique, não estado de render:
 * a casca não precisa re-renderizar a cada tecla digitada numa aba.
 */
export interface DirtyRegistry {
  set: (id: string, dirty: boolean) => void
}

export const DirtyContext = createContext<DirtyRegistry | null>(null)

/** A aba avisa a casca quando há (ou deixa de haver) alteração não salva; ao desmontar, deixa de contar. */
export function useReportDirty(id: string, dirty: boolean) {
  const registry = useContext(DirtyContext)
  useEffect(() => {
    registry?.set(id, dirty)
    return () => registry?.set(id, false)
  }, [registry, id, dirty])
}
