import { useEffect } from "react"
import { LegalDocument } from "@/components/legal/LegalDocument"
import { PRIVACIDADE, TERMOS } from "@/content/legal"

/** Título da aba enquanto a página está aberta; restaurado ao sair (as outras rotas públicas não definem o próprio). */
function useDocumentTitle(title: string) {
  useEffect(() => {
    const previous = document.title
    document.title = title
    return () => {
      document.title = previous
    }
  }, [title])
}

/** `/termos` - Termos de Uso (sem login). O texto mora em `content/legal/termos.ts`. */
export function Termos() {
  useDocumentTitle("Termos de Uso | InnoFlow")
  return <LegalDocument doc={TERMOS} />
}

/** `/privacidade` - Política de Privacidade (sem login). O texto mora em `content/legal/privacidade.ts`. */
export function Privacidade() {
  useDocumentTitle("Política de Privacidade | InnoFlow")
  return <LegalDocument doc={PRIVACIDADE} />
}
