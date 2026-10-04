import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { useCreateTokenizationSession, useAddPaymentMethod } from "./useMePaymentMethods"
import { getApiErrorMessage } from "@/services/api"
import { isGatewayDisabledError } from "@/lib/paymentMethodDisabled"
import type { MeCardTokenizationSessionResponse, MeCreatePaymentMethodRequest } from "@/types/api"
import {
  CARD_TOKENIZATION_CHANNEL_SOURCE,
  type CardTokenizationChildMessage,
  type CardTokenizationInitMessage,
  type CardTokenizationTokenPayload,
} from "@/types/cardTokenizationChannel"

/**
 * Mensagem da aba isolada -> corpo do `POST /api/me/payment-methods`. A aba é outro documento: confere o formato antes de mandar (o servidor
 * recusa `last4` que não tenha EXATAMENTE 4 dígitos e validade pela metade, então o que não bater aqui simplesmente não vai - o cartão ainda salva).
 */
export function toCreateRequest(payload: CardTokenizationTokenPayload): MeCreatePaymentMethodRequest {
  const request: MeCreatePaymentMethodRequest = { cardToken: payload.cardToken, brand: payload.brand }
  if (typeof payload.last4 === "string" && /^\d{4}$/.test(payload.last4)) request.last4 = payload.last4
  const { expiryMonth, expiryYear } = payload
  if (Number.isInteger(expiryMonth) && expiryMonth >= 1 && expiryMonth <= 12 && Number.isInteger(expiryYear) && expiryYear >= 2000 && expiryYear <= 2200) {
    request.expiryMonth = expiryMonth
    request.expiryYear = expiryYear
  }
  return request
}

export type AddCardFlowStatus = "idle" | "opening" | "awaiting" | "saving"

/**
 * Orquestra o fluxo de cadastro de cartão do lado do app principal:
 * 1) busca a sessão de tokenização (`POST /api/me/payment-methods/tokenization-session`);
 * 2) abre `pagamento-cartao.html` numa aba/janela NOVA (decisão abaixo);
 * 3) repassa a sessão por `postMessage` assim que a aba avisa que montou (`ready`);
 * 4) recebe o `cardToken`+`brand` de volta (`token`) e chama
 *    `POST /api/me/payment-methods` — só aqui o cartão de fato é salvo.
 *
 * DECISÃO — aba nova, não iframe/modal: o ponto inteiro do documento isolado
 * é ter uma CSP PRÓPRIA por documento (ver
 * `.claude/agent-memory/nova/decisoes-f5-pagamento-cielo.md` §2). Um iframe
 * embutido na SPA continuaria sendo manipulável via DOM/JS pela PRÓPRIA SPA
 * (mesma origem = `contentWindow` acessível) — um bug de XSS na SPA
 * alcançaria o formulário de cartão do mesmo jeito. Uma aba/janela aberta por
 * `window.open` é um browsing context GENUINAMENTE separado: o app principal
 * só enxerga o que ela manda por `postMessage`, nunca o DOM dela.
 *
 * Trade-off de UX mobile (aceito, documentar para o Órion/produto revisarem):
 * navegadores mobile ignoram as `window features` de tamanho e sempre abrem
 * uma aba cheia — ótimo para o formulário (mais espaço que um modal
 * espremido), mas tira o motorista do "modo app" se o PWA estiver instalado
 * standalone no iOS (Safari pode abrir a aba fora do contêiner do PWA). É o
 * custo aceito pela isolação de CSP — não dá para ter as duas coisas com um
 * iframe, ver parágrafo acima.
 */
export function useAddCardFlow() {
  const [status, setStatus] = useState<AddCardFlowStatus>("idle")
  // `true` quando o ADMIN desligou o meio cartão (409 `PAYMENT_METHOD_DISABLED` + `GATEWAY_DISABLED`)
  // na criação da sessão de tokenização OU ao salvar o cartão. Estado local: some ao sair da tela.
  const [unavailable, setUnavailable] = useState(false)
  const childRef = useRef<Window | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const createSession = useCreateTokenizationSession()
  const addPaymentMethod = useAddPaymentMethod()

  const cleanup = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
    childRef.current = null
  }, [])

  useEffect(() => cleanup, [cleanup])

  const start = useCallback(async () => {
    if (status !== "idle") return
    setStatus("opening")
    setUnavailable(false)

    let session: MeCardTokenizationSessionResponse | undefined
    try {
      session = await createSession.mutateAsync()
    } catch (err) {
      if (isGatewayDisabledError(err)) setUnavailable(true)
      else toast.error("Não foi possível iniciar o cadastro do cartão.", { description: getApiErrorMessage(err) })
      setStatus("idle")
      return
    }

    // Listener registrado ANTES do window.open — a aba filha não tem como
    // carregar/rodar JS antes desta linha terminar, então não existe corrida
    // em que o "ready" dela chegue antes de estarmos escutando (ver
    // `types/cardTokenizationChannel.ts`).
    function handleMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return
      if (event.source !== childRef.current) return
      const data = event.data as CardTokenizationChildMessage
      if (!data || data.source !== CARD_TOKENIZATION_CHANNEL_SOURCE) return

      if (data.type === "ready") {
        const init: CardTokenizationInitMessage = { source: CARD_TOKENIZATION_CHANNEL_SOURCE, type: "init", payload: session! }
        childRef.current?.postMessage(init, window.location.origin)
        setStatus("awaiting")
        return
      }

      if (data.type === "token") {
        setStatus("saving")
        addPaymentMethod
          .mutateAsync(toCreateRequest(data.payload))
          .then(() => {
            toast.success("Cartão cadastrado.")
          })
          .catch((err: unknown) => {
            if (isGatewayDisabledError(err)) setUnavailable(true)
            else toast.error("Não foi possível salvar o cartão.", { description: getApiErrorMessage(err) })
          })
          .finally(() => {
            window.removeEventListener("message", handleMessage)
            cleanup()
            setStatus("idle")
          })
        return
      }

      if (data.type === "cancelled") {
        window.removeEventListener("message", handleMessage)
        cleanup()
        setStatus("idle")
      }
    }
    window.addEventListener("message", handleMessage)

    const opened = window.open(
      "/pagamento-cartao.html",
      "innoflow-pagamento-cartao",
      "width=460,height=760,menubar=no,toolbar=no,location=no,status=no",
    )
    if (!opened) {
      window.removeEventListener("message", handleMessage)
      toast.error("O navegador bloqueou a janela de cadastro do cartão.", {
        description: "Permita pop-ups para este site e tente novamente.",
      })
      setStatus("idle")
      return
    }
    childRef.current = opened
    setStatus("awaiting")

    // A aba pode ser fechada pelo motorista antes de terminar (arrependimento,
    // toque errado) — sem isso o botão "Adicionar cartão" ficaria girando pra
    // sempre. `closed` é a única forma confiável de detectar isso (não existe
    // evento de "child window closed").
    pollRef.current = setInterval(() => {
      if (childRef.current?.closed) {
        window.removeEventListener("message", handleMessage)
        cleanup()
        setStatus((s) => (s === "saving" ? s : "idle"))
      }
    }, 500)
  }, [status, createSession, addPaymentMethod, cleanup])

  return { start, status, isBusy: status !== "idle", unavailable }
}
