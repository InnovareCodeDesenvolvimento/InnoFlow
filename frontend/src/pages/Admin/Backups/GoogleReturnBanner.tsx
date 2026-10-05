import { useEffect, useState } from "react"
import { CircleCheck, TriangleAlert, X } from "lucide-react"
import { useLocation, useNavigate } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"
import { Alert } from "@/components/ui/Alert"
import { Button } from "@/components/ui/Button"
import { backupKeys } from "@/hooks/useBackup"
import { GOOGLE_REASON_TEXT, parseGoogleReturn, withoutGoogleParams, type GoogleReturn } from "@/lib/backup"

/**
 * Volta do Google: o callback da API redireciona para `/admin/backup?google=ok` ou `?google=erro&motivo=<código>` (que a rota `backup` leva para esta tela, com a query).
 * Lê o parâmetro UMA vez (estado inicial), LIMPA a query da URL (para um F5 não repetir a mensagem) e mostra o texto por código (nunca ecoa o que veio na URL). Com `ok`, recarrega a
 * configuração: a conta conectada passa a aparecer. A mensagem fica até a pessoa dispensá-la.
 */
export function GoogleReturnBanner() {
  const location = useLocation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [result, setResult] = useState<GoogleReturn | null>(() => parseGoogleReturn(location.search))
  const hasParams = parseGoogleReturn(location.search) !== null

  useEffect(() => {
    if (!hasParams) return
    navigate({ pathname: location.pathname, search: withoutGoogleParams(location.search) }, { replace: true })
    void queryClient.invalidateQueries({ queryKey: backupKeys.config })
  }, [hasParams, location.pathname, location.search, navigate, queryClient])

  if (!result) return null

  const dismiss = (
    <Button type="button" variant="ghost" size="touch-sm" onClick={() => setResult(null)} className="shrink-0" aria-label="Dispensar a mensagem">
      <X className="h-3.5 w-3.5" aria-hidden="true" />
      Dispensar
    </Button>
  )

  if (result.ok) {
    return (
      <Alert tone="success" role="status" icon={CircleCheck} data-testid="google-return-ok">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p>
            <span className="font-bold">Conta Google conectada.</span> Agora escolha o Google Drive como destino, salve e use “Testar destino” para provar que a pasta recebe o arquivo.
          </p>
          {dismiss}
        </div>
      </Alert>
    )
  }

  return (
    <Alert tone="danger" role="alert" icon={TriangleAlert} data-testid="google-return-error" data-reason={result.reason}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-bold">Não deu para conectar a conta Google.</p>
          <p className="mt-0.5">{GOOGLE_REASON_TEXT[result.reason] ?? GOOGLE_REASON_TEXT.unknown}</p>
        </div>
        {dismiss}
      </div>
    </Alert>
  )
}
