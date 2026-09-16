import { API_BASE_URL, TOKEN_STORAGE_KEY } from "@/services/api"

/**
 * Baixa um export CSV autenticado. Um `<a href="...">` puro NÃO manda o
 * header `Authorization` — o navegador faz uma navegação simples, sem
 * interceptor nenhum, e a API devolveria 401. Por isso baixamos via `fetch`
 * (que carrega o token do `localStorage`, igual ao interceptor do `api.ts`)
 * e disparamos o download a partir de um `Blob` + `URL.createObjectURL`.
 */
export async function downloadCsv(
  path: string,
  params: Record<string, string | number | undefined>,
  filename: string,
): Promise<void> {
  const base = API_BASE_URL || window.location.origin
  const url = new URL(path, base)
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value))
  })
  url.searchParams.set("format", "csv")

  const token = localStorage.getItem(TOKEN_STORAGE_KEY)
  const response = await fetch(url.toString(), {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })

  if (!response.ok) {
    throw new Error(`Não foi possível gerar o CSV (HTTP ${response.status}).`)
  }

  const blob = await response.blob()
  const objectUrl = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = objectUrl
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(objectUrl)
}
