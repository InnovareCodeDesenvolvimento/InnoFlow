import { useCallback, useEffect, useRef, useState } from "react"
import { Skeleton } from "@/components/ui/Skeleton"
import { usePublicConfig } from "@/hooks/usePublicConfig"
import { useAuthStore } from "@/store/authStore"
import { getApiErrorCode } from "@/services/api"
import { clampGoogleButtonWidth, googleErrorMessageForCode, shouldShowGoogleButton } from "@/lib/googleAuth"
import { initGoogleIdentity, loadGoogleScript, releaseGoogleHandler, renderGoogleButton } from "@/lib/googleIdentity"
import { cn } from "@/lib/utils"
import type { User } from "@/types/api"

/**
 * Só em dev com mocks (mesma condição do `main.tsx` que liga o MSW): o script
 * real do Google não roda em `localhost` com Client ID fake, então no lugar do
 * botão oficial aparece um "Google (mock)" pra dar pra demonstrar/testar o
 * fluxo inteiro. Em produção essa constante é `false` e o ramo do mock sai do
 * bundle.
 */
const USE_MOCK_GOOGLE = import.meta.env.DEV && import.meta.env.VITE_USE_MOCKS === "true"

/** Altura reservada pro botão (44px): evita salto de layout quando o iframe do Google carrega. O botão `large` do GIS tem 40px fixos (não é configurável) — centralizado nessa faixa. */
const BUTTON_AREA = "h-11"

function GoogleGlyph() {
  return (
    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-[11px] font-black text-primary-700" aria-hidden="true">
      G
    </span>
  )
}

/**
 * Botão "Continuar com o Google" + divisor "ou continue com e-mail", pro topo
 * do card de Login e de Cadastro (cria a conta se for novo, entra se já
 * existir — o backend decide, o cliente trata igual).
 *
 * Nasce DESLIGADO: se `GET /api/public/config` devolver `googleClientId: null`
 * (ou a chamada falhar), não renderiza nada — nem botão, nem divisor. Se o
 * script do Google não carregar (bloqueador de anúncio, rede), também some em
 * silêncio, sem toast. Enquanto a config/script carregam, reserva a altura do
 * botão com skeleton (sem salto de layout).
 */
export function GoogleAuthSection({ onSuccess }: { onSuccess: (user: User) => void }) {
  const { data: config, isLoading: configLoading } = usePublicConfig()
  const googleLogin = useAuthStore((s) => s.googleLogin)

  const enabled = shouldShowGoogleButton(config)
  const clientId = config?.googleClientId ?? null

  const [scriptReady, setScriptReady] = useState(false)
  const [rendered, setRendered] = useState(false)
  const [failed, setFailed] = useState(false)
  const [width, setWidth] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const containerRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)

  const handleCredential = useCallback(
    async (credential: string) => {
      setError(null)
      setSubmitting(true)
      try {
        const user = await googleLogin(credential)
        onSuccess(user)
      } catch (err) {
        setError(googleErrorMessageForCode(getApiErrorCode(err)))
      } finally {
        setSubmitting(false)
      }
    },
    [googleLogin, onSuccess],
  )

  // O GIS guarda o callback da PRIMEIRA `initialize` — o handler vivo passa
  // por esta ref pra nunca chamar uma closure velha.
  const handlerRef = useRef(handleCredential)
  useEffect(() => {
    handlerRef.current = handleCredential
  }, [handleCredential])

  // Largura medida do container → largura do botão (o GIS não é fluido).
  useEffect(() => {
    const el = containerRef.current
    if (!el || !enabled) return
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width ?? 0
      setWidth((prev) => (Math.abs(prev - next) >= 4 ? next : prev))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [enabled])

  // Carrega o script só agora (tela de auth + Client ID presente). Falha = some em silêncio.
  useEffect(() => {
    if (!enabled || USE_MOCK_GOOGLE) return
    let cancelled = false
    loadGoogleScript()
      .then(() => !cancelled && setScriptReady(true))
      .catch(() => !cancelled && setFailed(true))
    return () => {
      cancelled = true
      releaseGoogleHandler()
    }
  }, [enabled])

  // Inicializa (uma vez por Client ID) e desenha o botão oficial na largura medida.
  useEffect(() => {
    const host = hostRef.current
    if (USE_MOCK_GOOGLE || !scriptReady || !clientId || !host || width <= 0) return

    initGoogleIdentity(clientId, (credential) => void handlerRef.current(credential))

    // BUG REAL corrigido 19/09/2026 (achado em produção, com Client ID real): o
    // GIS monta o botão (div + iframe) de forma SÍNCRONA dentro de
    // `renderButton`. Antes, o observer era ligado DEPOIS do render — a
    // mutação já tinha acontecido, ele nunca disparava, e o botão real ficava
    // com `opacity-0` por baixo do skeleton para sempre (o double de teste
    // montava de forma assíncrona e escondeu isso). Agora: liga o observer
    // ANTES de renderizar E confere no frame seguinte (cobre o caso do GIS
    // ter montado antes de qualquer observer existir).
    const markRendered = () => {
      if (host.childElementCount > 0) {
        setRendered(true)
        observer.disconnect()
      }
    }
    const observer = new MutationObserver(markRendered)
    observer.observe(host, { childList: true })

    host.replaceChildren()
    renderGoogleButton(host, clampGoogleButtonWidth(width))
    const frame = requestAnimationFrame(markRendered)

    // Se nada aparecer em 5s, considera quebrado e some (não deixa um buraco).
    const timer = setTimeout(() => {
      if (host.childElementCount === 0) setFailed(true)
    }, 5_000)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
      clearTimeout(timer)
    }
  }, [scriptReady, clientId, width])

  // Config já carregou e não tem Client ID (ou o script falhou): feature desligada.
  if ((!configLoading && !enabled) || failed) return null

  const ready = USE_MOCK_GOOGLE ? enabled : rendered

  return (
    <div className="mt-6 space-y-4">
      <div ref={containerRef} className={cn("relative w-full", BUTTON_AREA)} aria-busy={!ready}>
        {!ready && <Skeleton className="absolute inset-0 rounded-full" />}

        {USE_MOCK_GOOGLE ? (
          enabled && (
            <button
              type="button"
              onClick={() => void handleCredential("mock-google-credential")}
              disabled={submitting}
              className={cn(
                "pressable flex w-full items-center justify-center gap-2.5 rounded-full border border-border bg-white px-4 text-sm font-semibold text-ink transition-colors hover:bg-muted disabled:cursor-wait disabled:opacity-60",
                BUTTON_AREA,
              )}
            >
              <GoogleGlyph />
              Continuar com o Google (mock)
            </button>
          )
        ) : (
          <div ref={hostRef} className={cn("flex items-center justify-center transition-opacity", BUTTON_AREA, !rendered && "opacity-0")} />
        )}

        {submitting && <div className="absolute inset-0 cursor-wait rounded-full bg-white/60" aria-hidden="true" />}
      </div>

      {submitting && (
        <p role="status" className="text-center text-xs font-medium text-ink-softer">
          Entrando com o Google…
        </p>
      )}

      {error && (
        <p role="alert" className="rounded-lg bg-danger-50 px-3 py-2 text-sm font-medium text-danger-700">
          {error}
        </p>
      )}

      {USE_MOCK_GOOGLE && enabled && (
        <button
          type="button"
          onClick={() => void handleCredential("bloqueado")}
          disabled={submitting}
          className="mx-auto block text-xs font-medium text-ink-softer underline underline-offset-2 hover:text-ink disabled:opacity-60"
        >
          Simular conta de operação (mock)
        </button>
      )}

      <div className="flex items-center gap-3">
        <span className="h-px flex-1 bg-border" aria-hidden="true" />
        <span className="text-xs font-semibold text-ink-softer">ou continue com e-mail</span>
        <span className="h-px flex-1 bg-border" aria-hidden="true" />
      </div>
    </div>
  )
}
