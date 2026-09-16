import { useState } from "react"
import { Download } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/Button"
import { downloadCsv } from "@/lib/csv"

/**
 * Exporta um relatório em CSV. NUNCA usa `<a href>` puro — o JWT vai no
 * header `Authorization`, que uma navegação simples não manda (ver `lib/csv.ts`).
 */
export function ExportCsvButton({
  path,
  params,
  filename,
  label = "Exportar CSV",
}: {
  path: string
  params: Record<string, string | number | undefined>
  filename: string
  label?: string
}) {
  const [loading, setLoading] = useState(false)

  const handleClick = async () => {
    setLoading(true)
    try {
      await downloadCsv(path, params, filename)
    } catch (err) {
      toast.error("Não foi possível exportar o CSV.", { description: err instanceof Error ? err.message : undefined })
    } finally {
      setLoading(false)
    }
  }

  return (
    <Button type="button" variant="outline" size="sm" onClick={handleClick} loading={loading}>
      <Download className="h-3.5 w-3.5" aria-hidden="true" />
      {label}
    </Button>
  )
}
