import { useEffect, useRef, useState } from "react"
import { CardForm } from "./CardForm"
import { tokenizeCard, type CardFormInput } from "./sopClient"
import type { MeCardTokenizationSessionResponse } from "@/types/api"
import { CARD_TOKENIZATION_CHANNEL_SOURCE, type CardTokenizationChildMessage, type CardTokenizationInitMessage } from "@/types/cardTokenizationChannel"
import logoIcon from "@/assets/logo-icon-sm.png"

type Status = "no-opener" | "connecting" | "timeout" | "ready" | "submitting" | "done"

const READY_TIMEOUT_MS = 8000

function postToParent(message: CardTokenizationChildMessage) {
  window.opener?.postMessage(message, window.location.origin)
}

/**
 * Documento isolado inteiro (F5.3, SAQ A-EP) — ver comentário no topo de
 * `pagamento-cartao.html` e `.claude/agent-memory/nova/
 * decisoes-f5-pagamento-cielo.md` §2. Máquina de estados simples, sem
 * biblioteca de state machine (não vale a dependência para 6 estados):
 *
 *   no-opener → (nunca deveria acontecer fora de teste manual; aba aberta direto na URL)
 *   connecting → aguardando o app principal responder ao "ready" com "init"
 *   timeout → 8s sem resposta (aba aberta sozinha, app principal fechado, etc.)
 *   ready → formulário visível, sessão de tokenização em mãos
 *   submitting → tokenizando (mock ou SDK real, ver `sopClient.ts`)
 *   done → token enviado ao pai, instrui a fechar a aba
 */
export function CardTokenizationApp() {
  const [status, setStatus] = useState<Status>(window.opener ? "connecting" : "no-opener")
  const [session, setSession] = useState<MeCardTokenizationSessionResponse | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  // Guarda contra o StrictMode montar/desmontar em dev (mandaria "ready" duas vezes) — não muda o comportamento em produção.
  const readySentRef = useRef(false)

  useEffect(() => {
    if (!window.opener) return

    function handleMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return
      if (event.source !== window.opener) return
      const data = event.data as CardTokenizationInitMessage
      if (!data || data.source !== CARD_TOKENIZATION_CHANNEL_SOURCE || data.type !== "init") return
      setSession(data.payload)
      setStatus("ready")
    }
    window.addEventListener("message", handleMessage)

    if (!readySentRef.current) {
      readySentRef.current = true
      postToParent({ source: CARD_TOKENIZATION_CHANNEL_SOURCE, type: "ready" })
    }

    const timeout = setTimeout(() => {
      setStatus((current) => (current === "connecting" ? "timeout" : current))
    }, READY_TIMEOUT_MS)

    return () => {
      window.removeEventListener("message", handleMessage)
      clearTimeout(timeout)
    }
  }, [])

  // Avisa o pai se o motorista simplesmente fechar a aba sem terminar — ele para de "aguardar" (ver `useAddCardFlow.ts`, que também faz polling de `closed` como rede de segurança).
  useEffect(() => {
    function handleUnload() {
      if (status !== "done") postToParent({ source: CARD_TOKENIZATION_CHANNEL_SOURCE, type: "cancelled" })
    }
    window.addEventListener("beforeunload", handleUnload)
    return () => window.removeEventListener("beforeunload", handleUnload)
  }, [status])

  async function handleSubmit(values: CardFormInput) {
    if (!session) return
    setFormError(null)
    setStatus("submitting")
    try {
      const result = await tokenizeCard(session, values)
      // SÓ cardToken+brand saem daqui — número/validade/CVV/nome nunca chegam ao app principal (ver types/cardTokenizationChannel.ts).
      postToParent({ source: CARD_TOKENIZATION_CHANNEL_SOURCE, type: "token", payload: { cardToken: result.cardToken, brand: values.brand } })
      setStatus("done")
    } catch {
      setFormError("Não foi possível validar o cartão. Confira os dados e tente novamente.")
      setStatus("ready")
    }
  }

  return (
    <div className="pc-shell">
      <div className="pc-header">
        <img src={logoIcon} alt="" />
        <strong>InnoFlow</strong>
      </div>

      <div className="pc-card">
        {status === "no-opener" && (
          <div className="pc-center">
            <h1 className="pc-title" style={{ marginBottom: 8 }}>
              Esta página não pode ser aberta diretamente
            </h1>
            <p>Volte ao aplicativo InnoFlow e toque em "Adicionar cartão".</p>
          </div>
        )}

        {status === "connecting" && (
          <div className="pc-center">
            <h1 className="pc-title" style={{ marginBottom: 8 }}>
              Conectando…
            </h1>
            <p>Aguardando o InnoFlow enviar os dados do cadastro.</p>
          </div>
        )}

        {status === "timeout" && (
          <div className="pc-center">
            <h1 className="pc-title" style={{ marginBottom: 8 }}>
              Não foi possível conectar
            </h1>
            <p>Feche esta aba e toque em "Adicionar cartão" novamente no aplicativo.</p>
          </div>
        )}

        {(status === "ready" || status === "submitting") && (
          <>
            <h1 className="pc-title">Cadastrar cartão</h1>
            <p className="pc-subtitle">Seus dados vão direto para a operadora do cartão — o InnoFlow nunca recebe o número nem o CVV.</p>
            <CardForm onSubmit={handleSubmit} submitting={status === "submitting"} formError={formError} />
          </>
        )}

        {status === "done" && (
          <div className="pc-center">
            <h1 className="pc-title" style={{ marginBottom: 8 }}>
              Cartão validado ✓
            </h1>
            <p style={{ marginBottom: 16 }}>Pode fechar esta aba e voltar para o aplicativo.</p>
            <button type="button" className="pc-button" onClick={() => window.close()}>
              Fechar
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
