import { type ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { AxiosError, type AxiosResponse } from "axios"
import { RemoteStartDialog } from "./RemoteStartDialog"
import type { CommandPhase } from "@/lib/remoteStart"
import type { Connector, DriverListRow } from "@/types/api"

// Funções comuns (não `vi.fn`): uma rejeição legítima, tratada pelo componente, viraria "unhandled rejection" do rastreador de mocks.
const sent: unknown[] = []
let sendResult: { ok: true } | { ok: false; error: unknown } = { ok: true }
let phase: CommandPhase | "IDLE" = "IDLE"
let sessionId: string | null = null
const mutateAsync = (payload: unknown) => {
  sent.push(payload)
  return sendResult.ok ? Promise.resolve({ correlationId: "3f9c2a10-5b7e-4d21-9a6c-000000000001", status: "PENDING" }) : Promise.reject(sendResult.error)
}

vi.mock("@/hooks/useRemoteStart", () => ({
  useRemoteStart: () => ({ mutateAsync, isPending: false, reset: () => undefined }),
  useCommandPolling: (id: string | null) => ({ phase: id ? phase : "IDLE", sessionId: id ? sessionId : null }),
}))

const carla: DriverListRow = { id: "drv_1", name: "Carla Motorista", email: "carla@x.com", walletBalanceCents: 5000, openDebtCents: 0, activeSessionId: null, createdAt: "2026-09-01T12:00:00.000Z" }
const juliana: DriverListRow = { id: "drv_3", name: "Juliana Alves", email: "ju@x.com", walletBalanceCents: 2000, openDebtCents: 1850, activeSessionId: null, createdAt: "2026-09-02T12:00:00.000Z" }
let drivers: DriverListRow[] = [carla, juliana]
vi.mock("@/hooks/useDriverSearch", () => ({
  useDriverSearch: () => ({
    searchInput: "c",
    setSearchInput: () => undefined,
    search: "c",
    needsMoreChars: false,
    minChars: 1,
    query: { data: { items: drivers, total: drivers.length, page: 1, pageSize: 5 }, isLoading: false, isError: false, error: null, refetch: () => undefined },
  }),
}))

const connector = (n: number, status: Connector["status"]): Connector => ({
  id: `c${n}`,
  operatorId: "op",
  chargePointId: "cp1",
  connectorId: n,
  type: "DC_CCS2",
  status,
  maxPowerKw: "60",
  createdAt: "2026-08-01T12:00:00.000Z",
  updatedAt: "2026-08-01T12:00:00.000Z",
})

function httpError(status: number, code: string, details?: Array<{ path?: string; message?: string }>) {
  const err = new AxiosError("falhou")
  err.response = { status, data: { error: "texto do backend", code, details } } as AxiosResponse
  return err
}

function renderDialog(connectors: Connector[] = [connector(1, "AVAILABLE"), connector(2, "CHARGING")], ui: ReactNode = null, online?: boolean) {
  const client = new QueryClient()
  const onOpenChange = vi.fn()
  const tree = (list: Connector[], on: boolean | undefined) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <RemoteStartDialog chargePointId="cp1" chargePointName="CP-VILA-NORTE-01" connectors={list} online={on} onOpenChange={onOpenChange} />
        {ui}
      </MemoryRouter>
    </QueryClientProvider>
  )
  const { rerender } = render(tree(connectors, online))
  // Simula a lista viva mudando por baixo do diálogo (tempo real / invalidate): outro status de conector e/ou `online` novo.
  return { onOpenChange, update: (list: Connector[], on?: boolean) => rerender(tree(list, on)) }
}

const flat = (s: string | null) => (s ?? "").split(String.fromCharCode(160)).join(" ")
const dialog = () => screen.getByRole("dialog", { name: "Iniciar recarga" })

async function fillForm(driverName = "Carla Motorista", reason = "Motorista sem bateria no celular, suporte por telefone") {
  await userEvent.click(within(dialog()).getByRole("radio", { name: /Conector 1/ }))
  await userEvent.click(within(dialog()).getByRole("radio", { name: new RegExp(driverName) }))
  await userEvent.type(within(dialog()).getByLabelText(/Motivo/), reason)
}

beforeEach(() => {
  sent.length = 0
  sendResult = { ok: true }
  phase = "IDLE"
  sessionId = null
  drivers = [carla, juliana]
})

describe("RemoteStartDialog — dinheiro de uma PESSOA: preencher, CONFIRMAR, só então enviar", () => {
  it("só conector AVAILABLE é escolhível; os outros ficam desabilitados com o status escrito", () => {
    renderDialog([connector(1, "AVAILABLE"), connector(2, "CHARGING"), connector(3, "PREPARING"), connector(4, "FAULTED")])
    expect(within(dialog()).getByRole("radio", { name: /Conector 1/ })).toBeEnabled()
    for (const n of [2, 3, 4]) expect(within(dialog()).getByRole("radio", { name: new RegExp(`Conector ${n}`) })).toBeDisabled()
    expect(within(dialog()).getByText("Carregando")).toBeInTheDocument()
    expect(within(dialog()).getByText("Preparando")).toBeInTheDocument()
  })

  it("sem nenhum livre: avisa na tela", () => {
    renderDialog([connector(1, "CHARGING")])
    expect(within(dialog()).getByText(/Nenhum conector está livre agora/)).toBeInTheDocument()
  })

  it("um único conector livre já vem escolhido", () => {
    renderDialog([connector(1, "FAULTED"), connector(2, "AVAILABLE")])
    expect(within(dialog()).getByRole("radio", { name: /Conector 2/ })).toBeChecked()
  })

  it("formulário vazio: 'Revisar' mostra o que falta (conector, motorista, motivo) e NÃO envia nem avança", async () => {
    renderDialog([connector(1, "AVAILABLE"), connector(2, "AVAILABLE")])
    await userEvent.click(within(dialog()).getByRole("button", { name: /Revisar recarga/ }))
    expect(within(dialog()).getByText(/Escolha o conector/)).toBeInTheDocument()
    expect(within(dialog()).getByText(/Escolha o motorista/)).toBeInTheDocument()
    expect(within(dialog()).getByText(/Informe o motivo/)).toBeInTheDocument()
    expect(within(dialog()).queryByTestId("remote-start-summary")).toBeNull()
    expect(sent).toHaveLength(0)
  })

  it("contador do motivo: 0/200 · mínimo 10 → anda com a digitação; motivo curto é recusado com quantos faltam", async () => {
    renderDialog()
    expect(screen.getByTestId("reason-counter")).toHaveTextContent("0/200 · mínimo 10")
    await userEvent.click(within(dialog()).getByRole("radio", { name: /Conector 1/ }))
    await userEvent.click(within(dialog()).getByRole("radio", { name: /Carla Motorista/ }))
    await userEvent.type(within(dialog()).getByLabelText(/Motivo/), "curto")
    expect(screen.getByTestId("reason-counter")).toHaveTextContent("5/200")
    await userEvent.click(within(dialog()).getByRole("button", { name: /Revisar recarga/ }))
    expect(within(dialog()).getByText(/faltam 5/)).toBeInTheDocument()
    expect(sent).toHaveLength(0)
  })

  it("revisar → mostra 'Vai debitar a carteira de Carla Motorista', saldo e dívida; NADA enviado antes de confirmar", async () => {
    renderDialog()
    await fillForm()
    await userEvent.click(within(dialog()).getByRole("button", { name: /Revisar recarga/ }))

    expect(flat(screen.getByTestId("remote-start-summary").textContent)).toBe("Vai debitar a carteira de Carla Motorista")
    expect(flat(screen.getByTestId("remote-start-balance").textContent)).toBe("R$ 50,00")
    expect(screen.getByTestId("remote-start-debt")).toHaveTextContent("Nenhuma")
    expect(within(dialog()).getByText(/Motorista sem bateria no celular/)).toBeInTheDocument()
    expect(sent).toHaveLength(0)

    await userEvent.click(within(dialog()).getByRole("button", { name: "Iniciar recarga" }))
    expect(sent).toEqual([{ connectorId: 1, userId: "drv_1", reason: "Motorista sem bateria no celular, suporte por telefone" }])
    expect(within(dialog()).getByRole("heading", { name: "Acompanhando a recarga" })).toBeInTheDocument()
  })

  it("'Voltar' na confirmação preserva o que foi preenchido", async () => {
    renderDialog()
    await fillForm()
    await userEvent.click(within(dialog()).getByRole("button", { name: /Revisar recarga/ }))
    await userEvent.click(within(dialog()).getByRole("button", { name: /Voltar/ }))
    expect(within(dialog()).getByRole("radio", { name: /Conector 1/ })).toBeChecked()
    expect(within(dialog()).getByRole("radio", { name: /Carla Motorista/ })).toBeChecked()
    expect(within(dialog()).getByLabelText(/Motivo/)).toHaveValue("Motorista sem bateria no celular, suporte por telefone")
  })

  it("motorista com dívida: aviso na confirmação ANTES de enviar, e a recusa do servidor vem por code (DRIVER_HAS_OPEN_DEBT)", async () => {
    sendResult = { ok: false, error: httpError(409, "DRIVER_HAS_OPEN_DEBT") }
    renderDialog()
    await fillForm("Juliana Alves")
    await userEvent.click(within(dialog()).getByRole("button", { name: /Revisar recarga/ }))
    expect(within(dialog()).getByText(/de dívida em aberto/)).toBeInTheDocument()
    expect(screen.getByTestId("remote-start-debt")).toHaveTextContent("18,50")

    await userEvent.click(within(dialog()).getByRole("button", { name: "Iniciar recarga" }))
    const alert = await screen.findByTestId("remote-start-error")
    expect(alert).toHaveTextContent(/dívida em aberto e não pode iniciar recargas/)
    expect(alert).not.toHaveTextContent("texto do backend")
    expect(within(dialog()).getByTestId("remote-start-summary")).toBeInTheDocument() // continua na confirmação, dá para voltar
  })

  it("400 do servidor no motivo: volta ao formulário com a mensagem NO CAMPO", async () => {
    sendResult = { ok: false, error: httpError(400, "VALIDATION_ERROR", [{ path: "reason", message: "x" }]) }
    renderDialog()
    await fillForm()
    await userEvent.click(within(dialog()).getByRole("button", { name: /Revisar recarga/ }))
    await userEvent.click(within(dialog()).getByRole("button", { name: "Iniciar recarga" }))
    expect(await within(dialog()).findByText(/O servidor recusou o motivo/)).toBeInTheDocument()
    expect(within(dialog()).getByLabelText(/Motivo/)).toBeInTheDocument()
  })

  it.each([
    ["REJECTED", "O carregador recusou o início da recarga."],
    ["TIMEOUT", "Sem resposta do carregador."],
    ["UNAVAILABLE", "Resultado indisponível."],
  ] as const)("desfecho %s aparece na região aria-live com o texto certo", async (p, title) => {
    phase = p
    renderDialog()
    await fillForm()
    await userEvent.click(within(dialog()).getByRole("button", { name: /Revisar recarga/ }))
    await userEvent.click(within(dialog()).getByRole("button", { name: "Iniciar recarga" }))
    const status = await screen.findByTestId("remote-start-status")
    expect(status).toHaveAttribute("aria-live", "polite")
    expect(status).toHaveTextContent(title)
  })

  it("aceito: aviso verde com link para Sessões e 'Concluir' fecha", async () => {
    phase = "ACCEPTED"
    const { onOpenChange } = renderDialog()
    await fillForm()
    await userEvent.click(within(dialog()).getByRole("button", { name: /Revisar recarga/ }))
    await userEvent.click(within(dialog()).getByRole("button", { name: "Iniciar recarga" }))
    expect(await within(dialog()).findByRole("link", { name: "Ver sessões" })).toHaveAttribute("href", "/admin/sessoes")
    await userEvent.click(within(dialog()).getByRole("button", { name: "Concluir" }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("recusado: 'Tentar de novo' volta à confirmação", async () => {
    phase = "REJECTED"
    renderDialog()
    await fillForm()
    await userEvent.click(within(dialog()).getByRole("button", { name: /Revisar recarga/ }))
    await userEvent.click(within(dialog()).getByRole("button", { name: "Iniciar recarga" }))
    expect(within(dialog()).queryByRole("link", { name: "Ver sessões" })).toBeNull()
    await userEvent.click(await within(dialog()).findByRole("button", { name: /Tentar de novo/ }))
    expect(within(dialog()).getByTestId("remote-start-summary")).toBeInTheDocument()
  })
})

describe("carregador OFFLINE (`online === false`, calculado pelo servidor)", () => {
  it("avisa com o texto combinado, NENHUM conector é escolhível (nem o AVAILABLE) e 'Revisar' fica desabilitado - sem depender de erro do servidor", async () => {
    renderDialog([connector(1, "AVAILABLE"), connector(2, "AVAILABLE")], null, false)
    expect(within(dialog()).getByTestId("remote-start-offline")).toHaveTextContent("Este carregador está offline. Não é possível iniciar uma recarga agora.")
    for (const n of [1, 2]) expect(within(dialog()).getByRole("radio", { name: new RegExp(`Conector ${n}`) })).toBeDisabled()
    expect(within(dialog()).queryByText(/Nenhum conector está livre/)).toBeNull() // o motivo real é o offline
    expect(within(dialog()).getByRole("button", { name: /Revisar recarga/ })).toBeDisabled()
    expect(sent).toHaveLength(0)
  })

  it("com UM conector livre ele NÃO vem escolhido (online vem escolhido; offline não)", () => {
    renderDialog([connector(1, "AVAILABLE")], null, false)
    expect(within(dialog()).getByRole("radio", { name: /Conector 1/ })).not.toBeChecked()
  })

  it("online true ou desconhecido (undefined) NÃO mostra o aviso e deixa escolher", () => {
    renderDialog([connector(1, "AVAILABLE"), connector(2, "AVAILABLE")], null, true)
    expect(within(dialog()).queryByTestId("remote-start-offline")).toBeNull()
    expect(within(dialog()).getByRole("radio", { name: /Conector 1/ })).toBeEnabled()
  })

  it("online ausente (servidor antigo): segue como antes, o servidor decide (CHARGE_POINT_OFFLINE por code)", async () => {
    sendResult = { ok: false, error: httpError(409, "CHARGE_POINT_OFFLINE") }
    renderDialog([connector(1, "AVAILABLE")])
    expect(within(dialog()).queryByTestId("remote-start-offline")).toBeNull()
    await fillForm()
    await userEvent.click(within(dialog()).getByRole("button", { name: /Revisar recarga/ }))
    await userEvent.click(within(dialog()).getByRole("button", { name: "Iniciar recarga" }))
    expect(await screen.findByTestId("remote-start-error")).toHaveTextContent("O carregador está offline")
  })

  it("corrida: ONLINE ao abrir, mas o servidor responde CHARGE_POINT_OFFLINE ao confirmar - o tratamento por code continua valendo", async () => {
    sendResult = { ok: false, error: httpError(409, "CHARGE_POINT_OFFLINE") }
    renderDialog([connector(1, "AVAILABLE")], null, true)
    await fillForm()
    await userEvent.click(within(dialog()).getByRole("button", { name: /Revisar recarga/ }))
    await userEvent.click(within(dialog()).getByRole("button", { name: "Iniciar recarga" }))
    expect(await screen.findByTestId("remote-start-error")).toHaveTextContent("O carregador está offline — o comando não pode ser enviado")
  })

  it("o carregador cai COM o formulário aberto: o aviso aparece e a escolha some; se voltar, o formulário volta ao normal", async () => {
    const { update } = renderDialog([connector(1, "AVAILABLE"), connector(2, "AVAILABLE")], null, true)
    await userEvent.click(within(dialog()).getByRole("radio", { name: /Conector 1/ }))
    expect(within(dialog()).getByRole("radio", { name: /Conector 1/ })).toBeChecked()
    update([connector(1, "AVAILABLE"), connector(2, "AVAILABLE")], false)
    expect(within(dialog()).getByTestId("remote-start-offline")).toBeInTheDocument()
    expect(within(dialog()).getByRole("radio", { name: /Conector 1/ })).toBeDisabled()
    expect(within(dialog()).getByRole("button", { name: /Revisar recarga/ })).toBeDisabled()
    update([connector(1, "AVAILABLE"), connector(2, "AVAILABLE")], true)
    expect(within(dialog()).queryByTestId("remote-start-offline")).toBeNull()
    expect(within(dialog()).getByRole("radio", { name: /Conector 1/ })).toBeChecked() // a escolha anterior volta (é derivada, não perdida)
  })
})

describe("aceito: link direto para a sessão, espera pela sessão e fallback para a lista", () => {
  async function toProgress() {
    const ctx = renderDialog([connector(1, "AVAILABLE"), connector(2, "AVAILABLE")], null, true)
    await fillForm()
    await userEvent.click(within(dialog()).getByRole("button", { name: /Revisar recarga/ }))
    await userEvent.click(within(dialog()).getByRole("button", { name: "Iniciar recarga" }))
    return ctx
  }

  it("ACCEPTED com sessionId: 'Ver sessão' vai DIRETO ao detalhe (?sessao=<id>) e o texto fala da sessão", async () => {
    phase = "ACCEPTED"
    sessionId = "cmsess123"
    await toProgress()
    const link = await within(dialog()).findByRole("link", { name: "Ver sessão" })
    expect(link).toHaveAttribute("href", "/admin/sessoes?sessao=cmsess123")
    expect(within(dialog()).queryByRole("link", { name: "Ver sessões" })).toBeNull()
    expect(screen.getByTestId("remote-start-status")).toHaveTextContent("a sessão já foi criada")
  })

  it("STARTING (aceito, sessão ainda não nasceu): 'Aguardando a sessão iniciar…' na região aria-live, SEM link e SEM tratar como concluído", async () => {
    phase = "STARTING"
    await toProgress()
    const status = await screen.findByTestId("remote-start-status")
    expect(status).toHaveAttribute("aria-live", "polite")
    expect(status).toHaveAttribute("data-phase", "STARTING")
    expect(status).toHaveTextContent("Aguardando a sessão iniciar…")
    expect(within(dialog()).queryByRole("link")).toBeNull()
    expect(within(dialog()).getByRole("button", { name: "Fechar janela" })).toBeInTheDocument() // ainda não terminou
  })

  it("ACCEPTED sem sessionId (a sessão não chegou em 60 s / 404 depois do aceito): cai no link para a LISTA 'Ver sessões'", async () => {
    phase = "ACCEPTED"
    sessionId = null
    await toProgress()
    expect(await within(dialog()).findByRole("link", { name: "Ver sessões" })).toHaveAttribute("href", "/admin/sessoes")
    expect(within(dialog()).queryByRole("link", { name: "Ver sessão" })).toBeNull()
  })
})

describe("o acompanhamento NÃO some quando o status do conector muda depois do envio (bug achado: a escolha derivada virava null)", () => {
  it("depois de enviar, o conector passa a CHARGING (invalidate/tempo real): confirmação e acompanhamento continuam na tela, com o mesmo conector", async () => {
    phase = "POLLING"
    const { update } = renderDialog([connector(1, "AVAILABLE"), connector(2, "AVAILABLE")], null, true)
    await fillForm()
    await userEvent.click(within(dialog()).getByRole("button", { name: /Revisar recarga/ }))
    await userEvent.click(within(dialog()).getByRole("button", { name: "Iniciar recarga" }))
    expect(within(dialog()).getByRole("heading", { name: "Acompanhando a recarga" })).toBeInTheDocument()

    update([connector(1, "CHARGING"), connector(2, "AVAILABLE")], true)
    expect(within(dialog()).getByRole("heading", { name: "Acompanhando a recarga" })).toBeInTheDocument()
    expect(within(dialog()).getByText(/conector 1 · carteira de Carla Motorista/)).toBeInTheDocument()
    expect(screen.getByTestId("remote-start-status")).toBeInTheDocument()
  })
})
