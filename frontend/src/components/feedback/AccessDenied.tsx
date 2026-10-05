import { lazy, Suspense } from "react"
import { Link } from "react-router-dom"

// O mascote entra por import dinâmico: esta tela é montada por `RequireAuth`/`Admin/Layout`, e `RequireAuth` está no bundle inicial — importar `components/brand/Mascot`
// aqui de forma estática o levaria junto (e o chunk compartilhado com a landing para o `modulepreload` do index). Sem o mascote ainda carregado, o texto já aparece.
const MascotFace = lazy(() => import("@/components/brand/Mascot").then((m) => ({ default: m.MascotFace })))

/**
 * "Acesso restrito" (403 de tela): superfície de marca escura com o mascote (D3: no admin o mascote aparece em 404, erro e acesso restrito). Sem `cn`/`@/lib/utils`
 * de propósito (entra no bundle inicial; ver `LoadingScreen`). O texto é o mesmo de antes — só muda o visual.
 */
export function AccessDenied({ description, linkTo = "/", linkLabel = "Voltar ao início" }: { description: string; linkTo?: string; linkLabel?: string }) {
  return (
    <div className="mx-auto max-w-md px-4 py-16">
      <div className="surface-dark surface-dark-rich flex flex-col items-center rounded-feature px-6 py-10 text-center shadow-tinted-card ring-1 ring-white/10">
        <span className="flex h-16 w-16 items-center justify-center rounded-full bg-white/10 ring-1 ring-white/15" aria-hidden="true">
          <Suspense fallback={null}>
            <MascotFace size={64} />
          </Suspense>
        </span>
        <h1 className="mt-4 text-lg font-extrabold text-ink">Acesso restrito</h1>
        <p className="mb-5 mt-1 text-sm text-ink-softer">{description}</p>
        <Link to={linkTo} className="inline-flex min-h-11 items-center rounded-control border border-white/25 bg-white/10 px-5 text-sm font-semibold text-white hover:bg-white/15">
          {linkLabel}
        </Link>
      </div>
    </div>
  )
}
