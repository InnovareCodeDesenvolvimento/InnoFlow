import { type ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { BackupRunDTO, BackupStatusDTO } from "@/types/api"
import { backupKeys, useBackupRun, useBackupStatus, useGenerateBackupKey, useGoogleStart, useUpdateBackupConfig } from "./useBackup"

const svc = {
  getConfig: vi.fn(),
  updateConfig: vi.fn(),
  getStatus: vi.fn(),
  generateKey: vi.fn(),
  run: vi.fn(),
  verify: vi.fn(),
  testDestination: vi.fn(),
  listRuns: vi.fn(),
  getRun: vi.fn(),
  googleStart: vi.fn(),
  googleDisconnect: vi.fn(),
}
vi.mock("@/services/backup", () => ({ backupService: new Proxy({}, { get: (_t, key: string) => (...args: unknown[]) => (svc as Record<string, (...a: unknown[]) => unknown>)[key](...args) }) }))

const KEY = "aaaaaaaa-bbbbbbbb-cccccccc-dddddddd-eeeeeeee-ffffffff-00000000-11111111"
const PASSWORD = "SENHA-ATUAL-NA-MEMORIA-456"
const CRED = "CREDENCIAL-DO-BUCKET-789"

function setup<T>(useHook: () => T) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  return { queryClient, ...renderHook(useHook, { wrapper }) }
}

const run = (over: Partial<BackupRunDTO> = {}): BackupRunDTO => ({
  id: "r1", trigger: "MANUAL", status: "QUEUED", destination: "S3", createdAt: "2026-10-05T10:00:00.000Z", startedAt: null, finishedAt: null, durationMs: null, fileName: null, objectKey: null,
  sizeBytes: null, checksumSha256: null, tablesWithData: null, keyFingerprint: null, errorCode: null, errorMessage: null, ...over,
})
const status = (over: Partial<BackupStatusDTO> = {}): BackupStatusDTO => ({
  lastSuccessAt: null, lastAttemptAt: null, running: false, stale: false, neverRan: false, ageHours: null, nextRunAt: null, activeRun: null, lastBackupRun: null, lastVerifyRun: null, ...over,
})

const dumpMutationMemory = (queryClient: QueryClient) =>
  JSON.stringify(queryClient.getMutationCache().getAll().map((m) => ({ variables: m.state.variables, data: m.state.data, error: String(m.state.error ?? "") })))

describe("mutations de backup: credencial, senha e a CHAVE não ficam na memória do TanStack Query", () => {
  beforeEach(() => vi.clearAllMocks())

  it("PUT da config: depois de reset(), nada do corpo sobrevive", async () => {
    svc.updateConfig.mockResolvedValueOnce({ enabled: false })
    const { queryClient, result } = setup(useUpdateBackupConfig)
    await act(async () => {
      await result.current.mutateAsync({ s3: { secretKey: CRED }, currentPassword: PASSWORD })
    })
    await act(async () => result.current.reset())
    await waitFor(() => expect(queryClient.getMutationCache().getAll()).toHaveLength(0))
    const memory = dumpMutationMemory(queryClient)
    expect(memory).not.toContain(CRED)
    expect(memory).not.toContain(PASSWORD)
  })

  it("gerar a chave: a RESPOSTA (a chave inteira) e a senha somem com reset()", async () => {
    svc.generateKey.mockResolvedValueOnce({ key: KEY, fingerprint: "11111111", fileName: "x.txt", fileText: `CHAVE: ${KEY}`, replaced: false })
    const { queryClient, result } = setup(useGenerateBackupKey)
    let received: { key: string } | undefined
    await act(async () => {
      received = await result.current.mutateAsync({ currentPassword: PASSWORD })
    })
    expect(received?.key).toBe(KEY)
    await act(async () => result.current.reset())
    await waitFor(() => expect(queryClient.getMutationCache().getAll()).toHaveLength(0))
    expect(result.current.data).toBeUndefined()
    const memory = dumpMutationMemory(queryClient)
    expect(memory).not.toContain(KEY)
    expect(memory).not.toContain(PASSWORD)
    // e nenhum cache de QUERY guarda a chave
    expect(JSON.stringify(queryClient.getQueryCache().getAll().map((q) => q.state.data))).not.toContain(KEY)
  })

  it("google/start com senha: idem, também depois de erro", async () => {
    svc.googleStart.mockRejectedValueOnce(new Error("403"))
    const { queryClient, result } = setup(useGoogleStart)
    await act(async () => {
      await result.current.mutateAsync({ currentPassword: PASSWORD }).catch(() => undefined)
    })
    await act(async () => result.current.reset())
    await waitFor(() => expect(queryClient.getMutationCache().getAll()).toHaveLength(0))
    expect(dumpMutationMemory(queryClient)).not.toContain(PASSWORD)
  })

  it("salvar a config atualiza o cache da config e reconsulta o estado geral", async () => {
    svc.updateConfig.mockResolvedValueOnce({ enabled: true, marker: "NOVO" })
    svc.getConfig.mockResolvedValue({ enabled: true, marker: "NOVO" })
    const { queryClient, result } = setup(useUpdateBackupConfig)
    await act(async () => {
      await result.current.mutateAsync({ enabled: true, currentPassword: PASSWORD })
    })
    expect(queryClient.getQueryData(backupKeys.config)).toMatchObject({ marker: "NOVO" })
  })
})

describe("polling (relógio falso)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })
  afterEach(() => vi.useRealTimers())

  it("execução acompanhada: consulta a cada 2,5 s e PARA no estado final", async () => {
    svc.getRun
      .mockResolvedValueOnce(run({ status: "QUEUED" }))
      .mockResolvedValueOnce(run({ status: "RUNNING" }))
      .mockResolvedValue(run({ status: "SUCCESS", objectKey: "a/b" }))
    const { result } = setup(() => useBackupRun("r1"))

    await waitFor(() => expect(result.current.data?.status).toBe("QUEUED"))
    expect(svc.getRun).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_600)
    })
    await waitFor(() => expect(result.current.data?.status).toBe("RUNNING"))
    expect(svc.getRun).toHaveBeenCalledTimes(2)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_600)
    })
    await waitFor(() => expect(result.current.data?.status).toBe("SUCCESS"))
    expect(svc.getRun).toHaveBeenCalledTimes(3)

    // estado final: nenhuma consulta nova, por mais que o tempo passe
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(svc.getRun).toHaveBeenCalledTimes(3)
  })

  it("sem id não consulta nada", async () => {
    setup(() => useBackupRun(null))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(svc.getRun).not.toHaveBeenCalled()
  })

  it("3 falhas seguidas da consulta: para de insistir", async () => {
    svc.getRun.mockRejectedValue(new Error("rede"))
    const { result } = setup(() => useBackupRun("r1"))
    await waitFor(() => expect(result.current.isError).toBe(true))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_600 * 3)
    })
    const calls = svc.getRun.mock.calls.length
    expect(calls).toBeGreaterThanOrEqual(3)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(svc.getRun.mock.calls.length).toBe(calls)
  })

  it("estado geral: polling de 3 s só enquanto há execução ativa; ocioso não consulta de novo", async () => {
    svc.getStatus
      .mockResolvedValueOnce(status({ activeRun: run({ status: "RUNNING" }), running: true }))
      .mockResolvedValue(status({ lastSuccessAt: "2026-10-05T10:05:00.000Z" }))
    const { result } = setup(useBackupStatus)
    await waitFor(() => expect(result.current.data?.running).toBe(true))
    expect(svc.getStatus).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100)
    })
    await waitFor(() => expect(result.current.data?.running).toBe(false))
    expect(svc.getStatus).toHaveBeenCalledTimes(2)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(svc.getStatus).toHaveBeenCalledTimes(2)
  })
})
