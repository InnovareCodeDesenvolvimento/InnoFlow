import type { ReactNode } from "react"
import { AdminErrorState as ErrorState } from "@/components/admin/AdminStates"
import { useCommunicationSettings } from "@/hooks/useCommunicationSettings"
import { MSG_FORBIDDEN, parseCommunicationError } from "@/lib/communicationSettings"
import { getApiErrorStatus } from "@/services/api"
import type { CommunicationSettingsDTO } from "@/types/api"

/**
 * Carrega a configuração de comunicação (compartilhada pelas abas E-mail, WhatsApp e Alertas: mesma chave de cache, uma requisição) e trata os três estados: carregando
 * (esqueleto com a FORMA da aba pronta, passado por quem usa), erro (com "tentar de novo", exceto 403) e pronto. A resposta nunca é "vazia": o servidor sempre devolve o DTO.
 */
export function CommunicationTabLoader({ skeleton, children }: { skeleton: ReactNode; children: (dto: CommunicationSettingsDTO) => ReactNode }) {
  const { data: dto, isLoading, isError, error, refetch } = useCommunicationSettings()
  const forbidden = getApiErrorStatus(error) === 403

  if (isLoading) return <>{skeleton}</>
  if (isError || !dto) {
    return <ErrorState message={forbidden ? MSG_FORBIDDEN : parseCommunicationError(error).message} onRetry={forbidden ? undefined : () => void refetch()} />
  }
  return <>{children(dto)}</>
}
