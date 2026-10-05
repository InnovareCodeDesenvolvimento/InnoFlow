import { useEffect } from "react"

/**
 * Enquanto a tela está montada, pede ao navegador `Referrer-Policy: no-referrer` por `<meta name="referrer">`. Só vale para as telas que carregam um segredo na URL (o link de redefinição
 * de senha): nada que sair delas leva a URL de origem. NÃO está no `index.html` de propósito - desligar o `Referer` do site inteiro quebraria a política de uso dos tiles do mapa (que exige
 * o referer). O fragmento (`#t=`) nunca vai em `Referer` de qualquer forma; isto é o cinto além do suspensório.
 */
export function useNoReferrer(): void {
  useEffect(() => {
    const meta = document.createElement("meta")
    meta.name = "referrer"
    meta.content = "no-referrer"
    document.head.appendChild(meta)
    return () => meta.remove()
  }, [])
}
