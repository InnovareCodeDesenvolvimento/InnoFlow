import { useQuery } from "@tanstack/react-query"
import { publicConfigService } from "@/services/publicConfig"

export const publicConfigKeys = {
  all: ["public", "config"] as const,
}

/**
 * Config pública do cliente (hoje só o Client ID do Google). Muda só quando o
 * dono reconfigura o backend, então cache longo e SEM refetch em foco (o
 * default global agora é `refetchOnWindowFocus: true`, ver `main.tsx`) —
 * abrir Login → Cadastro não repete a chamada. `retry: false`: se a config
 * falhar, a tela degrada em silêncio pro formulário normal (sem o botão do
 * Google), não fica tentando de novo com skeleton na frente do usuário.
 */
export function usePublicConfig() {
  return useQuery({
    queryKey: publicConfigKeys.all,
    queryFn: () => publicConfigService.get(),
    staleTime: 60 * 60 * 1000,
    retry: false,
    refetchOnWindowFocus: false,
  })
}
