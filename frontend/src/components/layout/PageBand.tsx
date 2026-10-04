import type { ReactNode } from "react"
import { BrandBackdrop } from "@/components/brand/BrandBackdrop"
import { cn } from "@/lib/utils"

/**
 * Faixa-título escura das páginas públicas (design system unificado, §3.6): `surface-dark-rich` compacta com rótulo (eyebrow), o `h1` e o subtítulo.
 * O miolo da página segue claro. Altura FIXA por breakpoint (sem depender do conteúdo carregado) para a faixa nunca deslocar o que vem depois (CLS).
 * `children` = slot à direita (ação/estatística), opcional.
 */
export function PageBand({ eyebrow, title, description, children, className }: { eyebrow?: string; title: ReactNode; description?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <section className={cn("surface-dark surface-dark-rich relative overflow-hidden", className)}>
      <BrandBackdrop />
      <div className="container-app relative z-10 flex flex-col gap-4 py-8 sm:flex-row sm:items-end sm:justify-between sm:py-10">
        <div className="min-w-0">
          {eyebrow && <p className="eyebrow mb-2 text-lime">{eyebrow}</p>}
          <h1 className="text-balance text-3xl font-extrabold leading-tight tracking-tight text-white sm:text-4xl">{title}</h1>
          {description && <p className="mt-2 max-w-2xl text-base leading-relaxed text-ink-soft">{description}</p>}
        </div>
        {children}
      </div>
    </section>
  )
}
