import { cn } from "@/lib/utils"

/**
 * Fundo de marca ESTÁTICO para superfícies escuras (hero de auth, 404, erro): duas manchas radiais (teal e lima) e, opcionalmente, a malha de
 * pontos. Sem canvas e sem `blur-3xl` animado — a landing abandonou os dois por custo de rasterização (ver landing.css). `aria-hidden` sempre;
 * o pai precisa ser `relative overflow-hidden` e o conteúdo vai por cima (`relative z-10`).
 */
export function BrandBackdrop({ dots = false, className }: { dots?: boolean; className?: string }) {
  return (
    <div className={cn("pointer-events-none absolute inset-0 overflow-hidden", className)} aria-hidden="true">
      <div className="brand-glow-teal absolute -right-24 -top-24 h-[28rem] w-[28rem]" />
      <div className="brand-glow-lime absolute -bottom-32 -left-24 h-[24rem] w-[24rem]" />
      {dots && (
        <div
          className="absolute inset-0 opacity-[0.35]"
          style={{
            backgroundImage: "radial-gradient(rgb(255 255 255 / 0.18) 1px, transparent 1px)",
            backgroundSize: "28px 28px",
            maskImage: "radial-gradient(70% 60% at 50% 40%, #000 30%, transparent 75%)",
            WebkitMaskImage: "radial-gradient(70% 60% at 50% 40%, #000 30%, transparent 75%)",
          }}
        />
      )}
    </div>
  )
}
