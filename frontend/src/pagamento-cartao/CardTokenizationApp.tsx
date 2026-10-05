import { useEffect, useRef, useState } from "react"
import { CardForm } from "./CardForm"
import { SopInvalidFieldsError, SopTokenizationError, tokenizeCard, type CardFormInput } from "./sopClient"
import type { MeCardTokenizationSessionResponse } from "@/types/api"
import { CARD_TOKENIZATION_CHANNEL_SOURCE, type CardTokenizationChildMessage, type CardTokenizationInitMessage } from "@/types/cardTokenizationChannel"
// Rosto do mascote (64 px, 3 KB) como DATA URI embutida no bundle (`?inline`): a CSP desta página é `img-src 'self' data:` e não pode ganhar origem nova. Só imagem estática —
// o guarda de isolamento (`eslint.config.js`) barra `@/components|hooks|lib|...`, não `@/assets`.
import mascotFace from "@/assets/landing/mascote-rosto-64.webp?inline"

type Status = "no-opener" | "connecting" | "timeout" | "ready" | "submitting" | "done"

const READY_TIMEOUT_MS = 8000

function postToParent(message: CardTokenizationChildMessage) {
  window.opener?.postMessage(message, window.location.origin)
}

/** Rosto do mascote em círculo escuro. `variant`: `wait` (anel lima girando), `ok` (check lima) ou nenhum (erro/aviso). Decorativo: o texto ao lado diz tudo. */
function Hero({ variant }: { variant?: "wait" | "ok" }) {
  return (
    <div className={`pc-hero${variant === "wait" ? " pc-hero-wait" : ""}`} aria-hidden="true">
      <img src={mascotFace} alt="" width={64} height={64} />
      {variant === "ok" && (
        <span className="pc-hero-check">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12.5l4.5 4.5L19 7.5" />
          </svg>
        </span>
      )}
    </div>
  )
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
      // Saem daqui: cardToken + brand + last4 + validade (PAN TRUNCADO). Número inteiro/CVV/nome nunca chegam ao app principal (ver types/cardTokenizationChannel.ts).
      postToParent({
        source: CARD_TOKENIZATION_CHANNEL_SOURCE,
        type: "token",
        payload: { cardToken: result.cardToken, brand: values.brand, last4: result.last4, expiryMonth: result.expiryMonth, expiryYear: result.expiryYear },
      })
      setStatus("done")
    } catch (err) {
      // A Cielo valida os campos e devolve a mensagem pronta, em português (`onInvalid`): mostrar como veio. Qualquer outra falha: texto genérico + código curto (sem dado de cartão) para o suporte.
      if (err instanceof SopInvalidFieldsError) setFormError(err.message)
      else if (err instanceof SopTokenizationError && err.message === "SOP_SESSAO_EXPIRADA")
        setFormError('A sessão de cadastro expirou. Feche esta aba e toque em "Adicionar cartão" novamente no aplicativo.')
      else if (err instanceof SopTokenizationError) setFormError(`Não foi possível validar o cartão agora. Tente novamente em instantes. (código ${err.message})`)
      else setFormError("Não foi possível validar o cartão. Confira os dados e tente novamente.")
      setStatus("ready")
    }
  }

  return (
    <>
      {/* Moldura escura de marca (F-E): o rosto do mascote + o nome. Decorativo e sem rede: data URI. */}
      <header className="pc-band">
        <div className="pc-brand">
          <span className="pc-face">
            <img src={mascotFace} alt="" width={44} height={44} />
          </span>
          <strong>InnoFlow</strong>
        </div>
      </header>

      <main className="pc-shell">
        <div className="pc-card">
          {status === "no-opener" && (
            <div className="pc-center">
              <Hero />
              <h1 className="pc-title">Esta página não pode ser aberta diretamente</h1>
              <p>Volte ao aplicativo InnoFlow e toque em "Adicionar cartão".</p>
            </div>
          )}

          {status === "connecting" && (
            <div className="pc-center">
              <Hero variant="wait" />
              <h1 className="pc-title">Conectando…</h1>
              <p>Aguardando o InnoFlow enviar os dados do cadastro.</p>
            </div>
          )}

          {status === "timeout" && (
            <div className="pc-center">
              <Hero />
              <h1 className="pc-title">Não foi possível conectar</h1>
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
              <Hero variant="ok" />
              <h1 className="pc-title">Cartão validado ✓</h1>
              <p>Pode fechar esta aba e voltar para o aplicativo.</p>
              <button type="button" className="pc-button" onClick={() => window.close()}>
                Fechar
              </button>
            </div>
          )}
        </div>
      </main>
    </>
  )
}
