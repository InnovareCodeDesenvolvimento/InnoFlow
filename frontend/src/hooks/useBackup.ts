import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { isBusy, runRefetchInterval, statusRefetchInterval } from "@/lib/backup"
import { backupService } from "@/services/backup"
import type { BackupStatusDTO, GenerateBackupKeyRequest, UpdateBackupConfigRequest } from "@/types/api"

export const backupKeys = {
  all: ["admin", "backup"] as const,
  config: ["admin", "backup", "config"] as const,
  status: ["admin", "backup", "status"] as const,
  runs: ["admin", "backup", "runs"] as const,
  runsPage: (page: number, pageSize: number) => ["admin", "backup", "runs", { page, pageSize }] as const,
  run: (id: string) => ["admin", "backup", "run", id] as const,
}

/**
 * Configuração (sem segredos). Sem refetch em foco/reconexão: o rascunho da tela é uma sobreposição local sobre este dado e só o próprio admin o muda (salvar,
 * gerar chave, conectar/desconectar o Google). Sem retry: 403/503 não melhoram tentando de novo. O DTO NÃO carrega segredo (só `*Set` e a impressão digital da chave).
 */
export function useBackupConfig() {
  return useQuery({
    queryKey: backupKeys.config,
    queryFn: () => backupService.getConfig(),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  })
}

/**
 * Estado geral. Faz polling (3 s) SÓ enquanto há execução ativa/trava viva (`statusRefetchInterval`); parado, atualiza ao voltar para a aba (o "sem backup há X"
 * envelhece sozinho). Quando o estado passa de "ocupado" para "ocioso" (a execução terminou, inclusive uma que ninguém acompanhava, como a de quem recarregou a página),
 * o histórico é reconsultado.
 */
export function useBackupStatus() {
  const queryClient = useQueryClient()
  return useQuery({
    queryKey: backupKeys.status,
    queryFn: async () => {
      const before = queryClient.getQueryData<BackupStatusDTO>(backupKeys.status)
      const next = await backupService.getStatus()
      if (isBusy(before) && !isBusy(next)) void queryClient.invalidateQueries({ queryKey: backupKeys.runs })
      return next
    },
    staleTime: 15_000,
    refetchInterval: (query) => statusRefetchInterval(query.state.data),
    retry: false,
  })
}

/** Histórico paginado. `placeholderData` mantém a página anterior na tela enquanto a próxima carrega (sem piscar o esqueleto). */
export function useBackupRuns(page: number, pageSize: number) {
  return useQuery({
    queryKey: backupKeys.runsPage(page, pageSize),
    queryFn: () => backupService.listRuns({ page, pageSize }),
    placeholderData: keepPreviousData,
    retry: false,
  })
}

/**
 * Acompanha UMA execução (o 202 de "Fazer backup agora"/"Conferir backup") até `SUCCESS`/`FAILED`: consulta a cada 2,5 s e PARA no estado final ou depois de 3 falhas
 * da consulta (`errorUpdateCount`: o `fetchFailureCount` do TanStack zera a cada tentativa, com `retry: false` nunca chega a 3) (não insiste num servidor fora do ar; o estado geral e o histórico seguem valendo).
 */
export function useBackupRun(id: string | null) {
  return useQuery({
    queryKey: backupKeys.run(id ?? ""),
    queryFn: () => backupService.getRun(id as string),
    enabled: id !== null,
    refetchInterval: (query) => runRefetchInterval(query.state.data, query.state.errorUpdateCount),
    // Sem cache entre execuções: cada execução nova tem o seu id; ao largar a tela o dado não precisa ficar.
    gcTime: 0,
    retry: false,
  })
}

/**
 * Salva a configuração e escreve a resposta (DTO atualizado) no cache. `gcTime: 0`: o corpo do PUT carrega credenciais do bucket, o Client Secret e a SENHA ATUAL do admin, e
 * o TanStack Query guarda esse corpo em `variables` por 5 minutos depois de a tela largar a mutation. Com `gcTime: 0` + `reset()` na tela ele não sobrevive.
 */
export function useUpdateBackupConfig() {
  const queryClient = useQueryClient()
  return useMutation({
    gcTime: 0,
    mutationFn: (payload: UpdateBackupConfigRequest) => backupService.updateConfig(payload),
    onSuccess: (dto) => {
      queryClient.setQueryData(backupKeys.config, dto)
      void queryClient.invalidateQueries({ queryKey: backupKeys.config })
      // Ligar/desligar, frequência e horário mudam o "próximo agendado" e o "atrasado".
      void queryClient.invalidateQueries({ queryKey: backupKeys.status })
    },
  })
}

/**
 * Gera a chave. A RESPOSTA carrega a chave inteira (`mutation.data`) e o corpo carrega a senha: `gcTime: 0` e a tela chama `reset()` assim que copia o resultado para o
 * estado local. Não invalida nada aqui: quem chama invalida a config depois de guardar a chave no estado local.
 */
export function useGenerateBackupKey() {
  const queryClient = useQueryClient()
  return useMutation({
    gcTime: 0,
    mutationFn: (payload: GenerateBackupKeyRequest) => backupService.generateKey(payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: backupKeys.config })
    },
  })
}

/** "Fazer backup agora": 202 com a execução em `QUEUED`. O acompanhamento é do `useBackupRun`. Atualiza o estado geral (aparece `activeRun`). */
export function useRunBackup() {
  const queryClient = useQueryClient()
  return useMutation({
    gcTime: 0,
    mutationFn: () => backupService.run(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: backupKeys.status })
      void queryClient.invalidateQueries({ queryKey: backupKeys.runs })
    },
  })
}

/** "Conferir backup": idem `useRunBackup`. */
export function useVerifyBackup() {
  const queryClient = useQueryClient()
  return useMutation({
    gcTime: 0,
    mutationFn: () => backupService.verify(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: backupKeys.status })
      void queryClient.invalidateQueries({ queryKey: backupKeys.runs })
    },
  })
}

/** "Testar destino": o resultado (`ok` ou não) é guardado no estado local da tela; não persiste nada, não invalida nada. */
export function useTestBackupDestination() {
  return useMutation({ gcTime: 0, mutationFn: () => backupService.testDestination() })
}

/** "Conectar com Google": o corpo carrega a senha atual (`gcTime: 0` + `reset()`). A resposta é só a URL do consentimento. */
export function useGoogleStart() {
  return useMutation({ gcTime: 0, mutationFn: (payload: { currentPassword: string }) => backupService.googleStart(payload) })
}

/** "Desconectar": revoga e limpa a conexão. A resposta é o DTO atualizado da config. */
export function useGoogleDisconnect() {
  const queryClient = useQueryClient()
  return useMutation({
    gcTime: 0,
    mutationFn: (payload: { currentPassword: string }) => backupService.googleDisconnect(payload),
    onSuccess: (dto) => {
      queryClient.setQueryData(backupKeys.config, dto)
      void queryClient.invalidateQueries({ queryKey: backupKeys.config })
    },
  })
}
