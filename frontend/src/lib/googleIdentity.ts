/**
 * Carregador/adaptador do Google Identity Services (GIS) — fluxo de ID token
 * via botão, sem redirect e sem One Tap (`auto_select` desligado e nunca
 * chamamos `prompt()`).
 *
 * O script `https://accounts.google.com/gsi/client` é carregado SOB DEMANDA,
 * só quando uma tela de Login/Cadastro monta o botão E o backend informou um
 * Client ID — nunca no `index.html` nem no bundle inicial (a landing do QR
 * foi otimizada pra mobile e não pode pagar por isso). O CSP do nginx já
 * libera o domínio do Google (ver comentário no `nginx.conf.template`).
 */

interface GoogleCredentialResponse {
  credential?: string
}

interface GoogleButtonOptions {
  type: "standard"
  theme: "outline"
  size: "large"
  text: "continue_with"
  shape: "pill"
  locale: string
  width: number
}

interface GoogleIdApi {
  initialize: (config: { client_id: string; callback: (response: GoogleCredentialResponse) => void; auto_select: boolean }) => void
  renderButton: (parent: HTMLElement, options: GoogleButtonOptions) => void
}

declare global {
  interface Window {
    google?: { accounts?: { id?: GoogleIdApi } }
  }
}

const GSI_SRC = "https://accounts.google.com/gsi/client"

let scriptPromise: Promise<void> | null = null

/**
 * Injeta o script uma única vez (`async defer`). Rejeita em erro de rede,
 * bloqueador de anúncio ou se não responder em `timeoutMs` — quem chama
 * DEGRADA EM SILÊNCIO pro formulário normal (sem toast assustador). Depois de
 * uma falha, a próxima chamada tenta de novo (o `<script>` quebrado é removido).
 */
export function loadGoogleScript(timeoutMs = 10_000): Promise<void> {
  if (window.google?.accounts?.id) return Promise.resolve()
  if (scriptPromise) return scriptPromise

  scriptPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script")
    script.src = GSI_SRC
    script.async = true
    script.defer = true

    const fail = (reason: string) => {
      clearTimeout(timer)
      script.remove()
      scriptPromise = null
      reject(new Error(reason))
    }
    const timer = setTimeout(() => fail("timeout ao carregar o script do Google"), timeoutMs)

    script.onload = () => {
      if (window.google?.accounts?.id) {
        clearTimeout(timer)
        resolve()
      } else {
        fail("script do Google carregou sem expor accounts.id")
      }
    }
    script.onerror = () => fail("falha ao carregar o script do Google")
    document.head.appendChild(script)
  })

  return scriptPromise
}

// `initialize` deve rodar UMA vez por Client ID (chamar de novo gera aviso no
// console e reseta o estado interno do GIS) — o callback do GIS fica fixo, e
// quem de fato trata a credencial é `currentHandler`, trocável a cada mount.
let initializedClientId: string | null = null
let currentHandler: ((credential: string) => void) | null = null

export function initGoogleIdentity(clientId: string, handler: (credential: string) => void): void {
  currentHandler = handler
  const api = window.google?.accounts?.id
  if (!api || initializedClientId === clientId) return
  api.initialize({
    client_id: clientId,
    callback: (response) => {
      if (response.credential) currentHandler?.(response.credential)
    },
    auto_select: false,
  })
  initializedClientId = clientId
}

/** Solta o handler ao desmontar a tela — evita credencial cair num componente que já saiu. */
export function releaseGoogleHandler(): void {
  currentHandler = null
}

export function renderGoogleButton(parent: HTMLElement, width: number): void {
  window.google?.accounts?.id?.renderButton(parent, {
    type: "standard",
    theme: "outline",
    size: "large",
    text: "continue_with",
    shape: "pill",
    locale: "pt-BR",
    width,
  })
}
