import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { meService } from "@/services/me"
import type { MeNotificationPreferences, UpdateMeNotificationPreferencesRequest } from "@/types/api"

export const notificationKeys = {
  prefs: ["me", "notification-preferences"] as const,
}

/** `GET /api/me/notification-preferences`. Preferência muda raramente e só por esta tela: sem refetch em foco; 1 nova tentativa em falha. */
export function useMeNotificationPreferences() {
  return useQuery({
    queryKey: notificationKeys.prefs,
    queryFn: () => meService.getNotificationPreferences(),
    retry: 1,
    refetchOnWindowFocus: false,
  })
}

/** `PATCH`: o servidor devolve o objeto COMPLETO, que vai direto para o cache (sem refetch). */
export function useUpdateNotificationPreferences() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (payload: UpdateMeNotificationPreferencesRequest) => meService.updateNotificationPreferences(payload),
    onSuccess: (prefs: MeNotificationPreferences) => {
      queryClient.setQueryData(notificationKeys.prefs, prefs)
    },
  })
}
