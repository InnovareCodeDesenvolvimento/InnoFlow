import type { QueryClient } from "@tanstack/react-query"
import { publicConfigKeys } from "@/hooks/usePublicConfig"
import { publicConfigService } from "@/services/publicConfig"

/**
 * Dispara `GET /api/public/config` na hora em que o app liga (só nas rotas de Login/Cadastro — ver `main.tsx`), em paralelo com o
 * download do chunk da tela. Quando a tela monta, a config costuma já estar no cache e o botão do Google nasce no estado certo,
 * sem reservar nem colapsar espaço. Mesma chave/`staleTime`/`retry` de `usePublicConfig`, então é a MESMA consulta (sem chamada dupla).
 */
export function prefetchPublicConfig(queryClient: QueryClient) {
  return queryClient.prefetchQuery({
    queryKey: publicConfigKeys.all,
    queryFn: () => publicConfigService.get(),
    staleTime: 60 * 60 * 1000,
    retry: false,
  })
}
