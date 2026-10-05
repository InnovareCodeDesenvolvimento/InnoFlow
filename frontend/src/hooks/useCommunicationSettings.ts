import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { communicationSettingsService } from "@/services/communicationSettings"
import type { TestEmailRequest, TestWhatsappRequest, UpdateCommunicationSettingsRequest } from "@/types/api"

export const communicationSettingsKeys = {
  config: ["admin", "communication-settings"] as const,
}

/**
 * Configuração efetiva dos canais. Sem refetch em foco/reconexão: o rascunho da tela é local (sobreposição sobre este dado) e o que o servidor calcula
 * (`active`, `warnings`) só muda quando o próprio admin salva. Sem retry: 403/503 não melhoram tentando de novo.
 * `gcTime` padrão serve: o DTO não carrega segredo (só `passwordSet`/`apiKeySet`/dica de 4 caracteres).
 */
export function useCommunicationSettings() {
  return useQuery({
    queryKey: communicationSettingsKeys.config,
    queryFn: () => communicationSettingsService.get(),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  })
}

/**
 * Salva e escreve a resposta (DTO atualizado) no cache — a tela reflete o novo estado na hora — e invalida para reconferir.
 *
 * `gcTime: 0`: o corpo do PUT carrega SENHA SMTP, apikey e a SENHA ATUAL do admin, e o TanStack Query guarda esse corpo em `variables` por 5 minutos depois
 * de a tela largar a mutation. Com `gcTime: 0` + `reset()` na tela, o corpo não sobrevive (mesmo cuidado do gateway, Órion B7; coberto em `useCommunicationSettings.test.tsx`).
 */
export function useUpdateCommunicationSettings() {
  const queryClient = useQueryClient()
  return useMutation({
    gcTime: 0,
    mutationFn: (payload: UpdateCommunicationSettingsRequest) => communicationSettingsService.update(payload),
    onSuccess: (dto) => {
      queryClient.setQueryData(communicationSettingsKeys.config, dto)
      void queryClient.invalidateQueries({ queryKey: communicationSettingsKeys.config })
    },
  })
}

/** "Enviar e-mail de teste". `config` (valores digitados, ainda não salvos) pode levar a SENHA SMTP: mesmo `gcTime: 0` + `reset()`. Não invalida a config (não persiste nada). */
export function useTestEmail() {
  return useMutation({ gcTime: 0, mutationFn: (payload: TestEmailRequest) => communicationSettingsService.testEmail(payload) })
}

/** "Enviar WhatsApp de teste". `config` pode levar a APIKEY: mesmo `gcTime: 0` + `reset()`. */
export function useTestWhatsapp() {
  return useMutation({ gcTime: 0, mutationFn: (payload: TestWhatsappRequest) => communicationSettingsService.testWhatsapp(payload) })
}
